import { describe, expect, it } from 'vitest';
import { concat, encodeAbiParameters, keccak256, toFunctionSelector, toHex, type Address, type Hex } from 'viem';
import {
  addressLink,
  authFromJson,
  authToJson,
  dropDigest,
  formatAmount,
  getChain,
  parseAmount,
  releaseDigest,
  txLink,
  undropDigest,
  vaultAbi,
  withdrawDigest,
} from '../src/index.js';

const vault = '0x1111111111111111111111111111111111111111' as Address;
const agent = '0x2222222222222222222222222222222222222222' as Address;
const receiptsHash = keccak256(toHex('[]'));
const base = { chain: 'whitechain' as const, vault, agent, amount: 5_000_000n, nonce: 0n, expiry: 1_900_000_000n, receiptsHash };

describe('EIP-712 digests', () => {
  it('is deterministic', () => {
    expect(releaseDigest(base)).toBe(releaseDigest({ ...base }));
    expect(releaseDigest(base)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('changes with chainId, nonce, receiptsHash, amount and vault', () => {
    const d = releaseDigest(base);
    expect(releaseDigest({ ...base, chain: 'base' })).not.toBe(d);
    expect(releaseDigest({ ...base, chain: 1 })).not.toBe(d);
    expect(releaseDigest({ ...base, nonce: 1n })).not.toBe(d);
    expect(releaseDigest({ ...base, receiptsHash: keccak256(toHex('x')) })).not.toBe(d);
    expect(releaseDigest({ ...base, amount: 5_000_001n })).not.toBe(d);
    expect(releaseDigest({ ...base, vault: agent })).not.toBe(d);
  });

  it('accepts a raw chain id equal to the key', () => {
    expect(releaseDigest({ ...base, chain: 1874 })).toBe(releaseDigest(base));
  });

  it('matches a hand-rolled EIP-712 encoding of the spec type strings', () => {
    const domainSep = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [
          keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
          keccak256(toHex('CaplineVault')),
          keccak256(toHex('1')),
          1874n,
          vault,
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' }],
        [
          keccak256(toHex('Release(address agent,uint256 amount,uint64 nonce,uint64 expiry,bytes32 receiptsHash)')),
          agent,
          base.amount,
          base.nonce,
          base.expiry,
          receiptsHash,
        ],
      ),
    );
    expect(releaseDigest(base)).toBe(keccak256(concat(['0x1901', domainSep, structHash])));
  });

  it('separates action types with the same fields', () => {
    const p = { chain: 'whitechain' as const, vault, agent, nonce: 3n, expiry: 100n };
    expect(dropDigest(p)).not.toBe(undropDigest(p));
    expect(withdrawDigest({ ...p, to: agent, amount: 1n })).not.toBe(dropDigest(p));
  });
});

describe('amounts', () => {
  it('round trips', () => {
    for (const s of ['0', '1', '5', '0.25', '1234.567891']) {
      expect(formatAmount('whitechain', parseAmount('whitechain', s))).toBe(s);
    }
    expect(parseAmount('base', '5')).toBe(5_000_000n);
  });

  it('refuses junk and over-precise input', () => {
    expect(() => parseAmount('whitechain', '-1')).toThrow();
    expect(() => parseAmount('whitechain', '1e6')).toThrow();
    expect(() => parseAmount('whitechain', '0.0000001')).toThrow();
  });
});

describe('abi', () => {
  const names = vaultAbi.filter((x) => x.type === 'function').map((x) => x.name);
  it('has the calls other workstreams use', () => {
    for (const n of ['release', 'drop', 'undrop', 'withdraw', 'register', 'deposit', 'getAgent', 'releaseDigest']) {
      expect(names).toContain(n);
    }
  });

  it('encodes the WebAuthnAuth tuple in the release selector', () => {
    const release = vaultAbi.find((x) => x.type === 'function' && x.name === 'release')!;
    expect(toFunctionSelector(release as never)).toBe(
      toFunctionSelector('release(address,uint256,uint64,bytes32,(bytes32,bytes32,uint256,uint256,bytes,string))'),
    );
  });
});

describe('helpers', () => {
  it('builds explorer links', () => {
    const h = `0x${'ab'.repeat(32)}` as Hex;
    expect(txLink('whitechain', h)).toBe(`https://explorer.testnet.whitechain.io/tx/${h}`);
    expect(addressLink('base', agent)).toBe(`https://basescan.org/address/${agent}`);
  });

  it('applies overrides', () => {
    expect(getChain('whitechain', { vault }).vault).toBe(vault);
    expect(getChain('base', { rpcUrl: 'http://x' }).chain.rpcUrls.default.http[0]).toBe('http://x');
  });

  it('serialises WebAuthnAuth through JSON', () => {
    const auth = {
      r: `0x${'01'.repeat(32)}` as Hex,
      s: `0x${'02'.repeat(32)}` as Hex,
      challengeIndex: 23n,
      typeIndex: 1n,
      authenticatorData: '0x00' as Hex,
      clientDataJSON: '{}',
    };
    expect(authFromJson(JSON.parse(JSON.stringify(authToJson(auth))))).toEqual(auth);
  });
});
