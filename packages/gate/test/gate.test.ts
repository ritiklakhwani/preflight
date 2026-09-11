import { afterEach, describe, expect, it } from 'vitest';
import { GATE_SEVERITY, gateEnabled, runGate } from '../src/index.js';
import { parseWalletCli, readProgress } from '../src/device.js';

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

describe('the wait is capped by the caller\'s remaining budget', () => {
  // The regression this exists for: a fixed forty-second wait was added to a
  // variable analysis, the sum exceeded the MCP client's sixty-second limit,
  // and the agent got a transport timeout instead of a refusal. A timeout is
  // not an answer.
  const originalTimeout = process.env['GATE_TIMEOUT_MS'];
  afterEach(() => {
    if (originalTimeout === undefined) delete process.env['GATE_TIMEOUT_MS'];
    else process.env['GATE_TIMEOUT_MS'] = originalTimeout;
  });

  it('answers inside a small budget whether or not a device is attached', async () => {
    // Deliberately independent of machine state. An earlier version of this
    // asserted the no-device path and passed only until someone plugged a
    // Ledger in, which is a test that measures the desk rather than the code.
    const started = Date.now();
    const r = await runGate('high', { budgetMs: 1_000 });
    expect(r.approved).toBe(false);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('a small budget cannot be widened by GATE_TIMEOUT_MS', async () => {
    // budgetMs narrows and never widens. Someone setting a long timeout must
    // not be able to push the call past the deadline it has to meet.
    process.env['GATE_TIMEOUT_MS'] = '120000';
    const started = Date.now();
    const r = await runGate('high', { budgetMs: 1_000 });
    expect(r.approved).toBe(false);
    expect(Date.now() - started).toBeLessThan(8_000);
  });
});

describe('what the device says about itself', () => {
  const locked = JSON.stringify({
    type: 'device-state',
    state: { code: 'awaiting_approval', reason: 'unlock' },
    message: 'Ledger is locked. Enter your PIN on the device.',
  });
  const waiting = JSON.stringify({
    type: 'device-state',
    state: { code: 'awaiting_approval' },
    message: 'Confirm the address on your device.',
  });

  it('recognises a locked device', () => {
    const p = readProgress(locked);
    expect(p?.locked).toBe(true);
    expect(p?.message).toContain('PIN');
  });

  it('recognises a device waiting for a press', () => {
    expect(readProgress(waiting)?.locked).toBe(false);
  });

  it('ignores lines that are not progress', () => {
    expect(readProgress('{"ok":true}')).toBeNull();
    expect(readProgress('not json at all')).toBeNull();
  });

  it('reads an approval from either stream', () => {
    // The bug this replaces: the parser was handed `stdout || stderr`, so once
    // stdout carried the progress lines, which it always does, stderr was
    // never examined. An approval arriving there would have been refused.
    expect(parseWalletCli(`${locked}\n\n{"ok":true}`).ok).toBe(true);
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

describe('what counts as an approval', () => {
  it('rejects wallet-cli\'s generic success envelope', () => {
    // status:"success" means the command ran. `session view` returns it and
    // that command never touches the device. Accepting it meant "the process
    // exited normally" was being read as "a human pressed a button", on the
    // one path where that distinction is the entire product.
    const envelope = '{"status":"success","command":"session view","network":"all"}';
    expect(parseWalletCli(envelope).ok).toBe(false);
  });

  it('accepts only an explicit ok:true', () => {
    expect(parseWalletCli('{"ok":true,"data":{}}').ok).toBe(true);
  });

  it('carries the raw output back when it refuses, so a wrong assumption is diagnosable', () => {
    const r = parseWalletCli('{"status":"success","command":"receive"}');
    expect(r.message).toContain('receive');
  });
});
