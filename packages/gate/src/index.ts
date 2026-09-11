/**
 * The gate: the policy that decides when a human has to be involved.
 *
 * Kept separate from the device call so the rule is readable on its own, and
 * so the engine has one function to call rather than a decision to make.
 */
import type { Verdict } from '@preflight/core';
import { confirmOnDevice, type DeviceOptions, type GateOutcome } from './device.js';

export {
  confirmOnDevice,
  resolveWalletCli,
  parseWalletCli,
  deviceAttached,
  readProgress,
  humanise,
} from './device.js';
export type { GateOutcome, DeviceOptions, DeviceProgress } from './device.js';
export { loadRingSecrets, decryptSecret, RING_KEYS } from './secrets.js';
export type { RingLoadResult } from './secrets.js';

/**
 * Severities below this proceed without a person. The threshold is the whole
 * policy, and it is deliberately the same word the agent sees in the verdict.
 */
export const GATE_SEVERITY: Verdict['severity'] = 'high';

/**
 * Set PREFLIGHT_GATE=off to run without a device, for CI or for a machine that
 * has none. It is opt-out rather than opt-in on purpose: forgetting to enable a
 * guard rail should not be possible, and the verdict records that it was
 * skipped so nobody can later claim a human approved something.
 */
export function gateEnabled(): boolean {
  return (process.env['PREFLIGHT_GATE'] ?? '').trim().toLowerCase() !== 'off';
}

export async function runGate(
  severity: Verdict['severity'],
  opts: DeviceOptions = {},
): Promise<GateOutcome> {
  if (severity !== GATE_SEVERITY) {
    return { required: false, approved: true, method: 'auto' };
  }
  if (!gateEnabled()) {
    return {
      required: true,
      approved: false,
      method: 'auto',
      reason: 'device confirmation disabled by PREFLIGHT_GATE=off; not approved by a human',
    };
  }
  return confirmOnDevice(opts);
}
