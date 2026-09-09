import { afterEach, describe, expect, it } from 'vitest';
import { GATE_SEVERITY, gateEnabled, runGate } from '../src/index.js';
import { parseWalletCli } from '../src/device.js';

const original = process.env['PREFLIGHT_GATE'];
afterEach(() => {
  if (original === undefined) delete process.env['PREFLIGHT_GATE'];
  else process.env['PREFLIGHT_GATE'] = original;
});

describe('gate policy', () => {
  it('does not involve a person below the threshold', async () => {
    for (const severity of ['clean', 'low', 'medium'] as const) {
      const r = await runGate(severity);
      expect(r).toEqual({ required: false, approved: true, method: 'auto' });
    }
  });

  it('gates exactly at high', () => {
    expect(GATE_SEVERITY).toBe('high');
  });

  it('refuses rather than waves through when the gate is switched off', async () => {
    // Disabling the guard rail must not look like approval. Nobody pressed
    // anything, so nothing was approved, and the verdict says so.
    process.env['PREFLIGHT_GATE'] = 'off';
    expect(gateEnabled()).toBe(false);
    const r = await runGate('high');
    expect(r.required).toBe(true);
    expect(r.approved).toBe(false);
    expect(r.reason).toContain('disabled');
  });

  it('is on unless explicitly switched off', () => {
    delete process.env['PREFLIGHT_GATE'];
    expect(gateEnabled()).toBe(true);
    process.env['PREFLIGHT_GATE'] = 'on';
    expect(gateEnabled()).toBe(true);
  });
});

describe('reading wallet-cli output', () => {
  it('treats a missing device as a refusal, with the reason it gave', () => {
    // Verbatim from wallet-cli v2.1.0 with the Nano unplugged. It also exits 1,
    // but the JSON is what carries the reason.
    const real =
      '{"type":"pre-verify-address","command":"receive","address":"0x8E2D0425c3aa61d811d546b605ABD745E054Ef49"}\n' +
      '{"ok":false,"error":{"command":"receive","code":"unknown","message":"No Ledger device found. Unlock the device and try again."}}';
    expect(parseWalletCli(real)).toEqual({
      ok: false,
      message: 'No Ledger device found. Unlock the device and try again.',
    });
  });

  it('reads the last JSON line, since the address is announced before the result', () => {
    const out = '{"type":"pre-verify-address","address":"0x1"}\n{"ok":true,"data":{}}';
    expect(parseWalletCli(out).ok).toBe(true);
  });

  it('fails closed on silence', () => {
    expect(parseWalletCli('').ok).toBe(false);
  });

  it('fails closed on output it cannot parse', () => {
    // A crash, a stack trace, a truncated pipe. None of them are approval.
    expect(parseWalletCli('Segmentation fault').ok).toBe(false);
    expect(parseWalletCli('{"ok":').ok).toBe(false);
    expect(parseWalletCli('{"unrelated":true}').ok).toBe(false);
  });
});
