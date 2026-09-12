/**
 * NEW during ETHOnline 2026.
 *
 * Four signals derived from the ported Etherscan analysis. They need no
 * subgraph, so they are the floor: a verdict is still meaningful when The
 * Graph is unreachable.
 *
 * Design note on unverified contracts. When source is unavailable, signals 2-4
 * cannot be evaluated. They report `fired: false` with an evidence line saying
 * why, and they deliberately keep their full weight in the denominator. The
 * alternative - dropping them via `error` - would make a single fired signal
 * produce a score of 100, so every unverified contract would read as HIGH.
 * Not being able to see a risk is not the same as having found one.
 */
import type { Evidence } from '@preflight/core';
import type { Signal, SignalContext } from './types.js';

const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  10: 'https://optimistic.etherscan.io',
  137: 'https://polygonscan.com',
  11155111: 'https://sepolia.etherscan.io',
};

function explorerLink(ctx: SignalContext): string | undefined {
  const base = EXPLORERS[ctx.chainId];
  return base ? `${base}/address/${ctx.address}#code` : undefined;
}

/** Emitted by signals 2-4 when there is no source to read. */
function notAssessable(ctx: SignalContext): Evidence[] {
  return [
    {
      label: 'not assessable',
      value: 'contract source is not verified, so this check could not run',
      link: explorerLink(ctx),
    },
  ];
}

export const unverifiedSource: Signal = {
  name: 'unverified-source',
  weight: 0.5,
  describe: 'The contract has no verified source on the block explorer.',
  async run(ctx) {
    if (ctx.analysis.error) {
      return { fired: false, evidence: [], error: ctx.analysis.error };
    }
    // A wallet has no source by definition. Firing here would report a
    // missing thing that was never supposed to exist, and it is not-a-contract
    // that carries the real finding about this address.
    if (ctx.analysis.isContract === false) {
      return {
        fired: false,
        evidence: [
          { label: 'source', value: 'not applicable, the address is a wallet rather than a contract' },
        ],
      };
    }
    if (ctx.analysis.verified) {
      return {
        fired: false,
        evidence: [
          {
            label: 'source',
            value: `verified as ${ctx.analysis.contractName ?? 'unnamed'}, ${ctx.analysis.compilerVersion ?? 'unknown compiler'}`,
            link: explorerLink(ctx),
            // The contract name is whatever the deployer submitted to the explorer.
            untrusted: true,
          },
        ],
      };
    }
    return {
      fired: true,
      evidence: [
        {
          label: 'source',
          value: 'no verified source published; behaviour cannot be read before signing',
          link: explorerLink(ctx),
        },
      ],
    };
  },
};

export const privilegedControl: Signal = {
  name: 'privileged-control',
  weight: 0.2,
  describe:
    'A privileged role can change the contract or move funds: an upgradeable proxy, or owner-gated mint, pause, withdraw or fee functions.',
  async run(ctx) {
    const { isProxy, ownerOnlyFunctions, verified, implementationAddress } = ctx.analysis;
    if (!verified) return { fired: false, evidence: notAssessable(ctx), assessed: false };

    const evidence: Evidence[] = [];
    if (isProxy) {
      const base = EXPLORERS[ctx.chainId];
      evidence.push({
        label: 'proxy',
        value: implementationAddress
          ? `delegates to ${implementationAddress}, which an admin can replace`
          : 'delegatecall or ERC-1967 pattern present; implementation can be replaced',
        link: implementationAddress && base
          ? `${base}/address/${implementationAddress}#code`
          : explorerLink(ctx),
      });
    }
    if (ownerOnlyFunctions.length > 0) {
      evidence.push({
        label: 'privileged functions',
        value: ownerOnlyFunctions.join(', '),
        link: explorerLink(ctx),
        // Function names come from the ABI, which the deployer wrote.
        untrusted: true,
      });
    }

    if (evidence.length === 0) {
      return {
        fired: false,
        evidence: [{ label: 'privileged functions', value: 'none found in the ABI' }],
      };
    }
    return { fired: true, evidence };
  },
};

export const transferRestrictions: Signal = {
  name: 'transfer-restrictions',
  weight: 0.15,
  describe:
    'Transfers can be blocked for specific addresses or halted entirely: a blacklist, a trading gate, or a bot guard.',
  async run(ctx) {
    if (!ctx.analysis.verified) return { fired: false, evidence: notAssessable(ctx), assessed: false };
    if (!ctx.analysis.hasTransferRestrictions) {
      return { fired: false, evidence: [{ label: 'transfers', value: 'no address-level gate found' }] };
    }
    return {
      fired: true,
      evidence: [
        {
          label: 'transfers',
          value: 'source contains a blacklist, trading gate or bot guard on the transfer path',
          link: explorerLink(ctx),
        },
      ],
    };
  },
};

export const selfDestruct: Signal = {
  name: 'self-destruct',
  weight: 0.45,
  describe: 'The contract can destroy itself, stranding anything held or approved against it.',
  async run(ctx) {
    if (!ctx.analysis.verified) return { fired: false, evidence: notAssessable(ctx), assessed: false };
    if (!ctx.analysis.hasSelfDestruct) {
      return { fired: false, evidence: [{ label: 'selfdestruct', value: 'not present' }] };
    }
    return {
      fired: true,
      evidence: [
        {
          label: 'selfdestruct',
          value: 'selfdestruct or suicide reachable in the source',
          link: explorerLink(ctx),
        },
      ],
    };
  },
};

export const STRUCTURAL_SIGNALS: Signal[] = [
  unverifiedSource,
  privilegedControl,
  transferRestrictions,
  selfDestruct,
];
