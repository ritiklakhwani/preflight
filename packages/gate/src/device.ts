/**
 * NEW during ETHOnline 2026.
 *
 * The hardware confirmation. This is the difference between Preflight being a
 * guard rail and being a warning label.
 *
 * A HIGH verdict previously printed a policy line saying a human must approve
 * before signing. Nothing enforced it, and an agent that can read a policy line
 * can also ignore one. Here the approval leaves software entirely: `wallet-cli`
 * asks a Ledger device to display something on its own screen, and a person has
 * to press a button on the physical device before this function returns
 * approved.
 *
 * The property that matters, and the one worth testing on camera: unplug the
 * device and the flow breaks. If a verdict still proceeds with the Nano
 * disconnected, the confirmation is theatre.
 *
 * ---------------------------------------------------------------------------
 * Two things measured against wallet-cli v2.1.0 that shaped this
 *
 * With no device attached, `receive --verify` exits 1 and prints
 * `{"ok":false,"error":{"message":"No Ledger device found..."}}`. Both signals
 * agree, but the JSON is treated as the authority because it carries the reason
 * and the exit code does not.
 *
 * `--device-timeout` appears to be ignored. A call passing 6000 waited the full
 * default of 60 seconds before failing. So the timeout is enforced here by
 * killing the process, and the flag is still passed in case it starts working.
 *
 * Neither command fails fast when no device is attached: both scan for about a
 * minute first. That is why deviceAttached() reads the USB tree directly before
 * anything blocks on wallet-cli.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

export interface GateOutcome {
  /** Whether the severity demanded a device confirmation at all. */
  required: boolean;
  approved: boolean;
  method: 'auto' | 'device';
  /** Present whenever approval was withheld, so the caller can say why. */
  reason?: string;
}

/**
 * Every path that is not an explicit approval returns false. A missing device,
 * a missing binary, a timeout, a crash, unparseable output: all denied. The
 * only way through is a person pressing a button.
 */
const DENIED = (reason: string): GateOutcome => ({
  required: true,
  approved: false,
  method: 'device',
  reason,
});

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * MCP clients are GUI applications and do not inherit a login shell, so
 * `wallet-cli` is usually absent from their PATH. Same problem the MCP launcher
 * solves, same shape of answer.
 */
export function resolveWalletCli(): string | null {
  const override = env('WALLET_CLI_PATH');
  if (override) return existsSync(override) ? override : null;

  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    if (existsSync(`${dir}/wallet-cli`)) return `${dir}/wallet-cli`;
  }

  // nvm nests binaries under a version directory, so check the newest first.
  const nvm = `${homedir()}/.nvm/versions/node`;
  if (existsSync(nvm)) {
    try {
      for (const version of readdirSync(nvm).sort().reverse()) {
        const candidate = `${nvm}/${version}/bin/wallet-cli`;
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Unreadable directory is not fatal; fall through to PATH.
    }
  }

  // Last resort: let the shell find it. Works when a login shell is inherited.
  return 'wallet-cli';
}

/**
 * Ledger's USB vendor id is 0x2c97. `ioreg` prints vendor ids in decimal, so
 * both spellings are matched along with the vendor name string itself.
 */
const LEDGER_USB = /ledger|0x2c97|idVendor.*\b11415\b/i;

/** The probe is a speed optimisation. If it cannot answer quickly, stop asking. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Is a Ledger attached right now?
 *
 * Asked before blocking on wallet-cli, because wallet-cli does not fail fast
 * when no device is present. Measured on 2026-09-11: `receive --verify` scans
 * for 61 seconds before giving up, and `genuine-check` for 62.
 *
 * That is unaffordable. The whole preflight_check call has to finish inside the
 * MCP client's 60 second request timeout, and the analysis ahead of this
 * already spends around twelve seconds. Waiting out a dead USB scan left under
 * a second of margin, so the refusal an agent needs could arrive after the
 * agent had stopped listening. Reading the USB tree instead takes 47ms.
 *
 * Returns null when the question could not be answered, and callers treat null
 * as "go ask wallet-cli". Failing open is the deliberate direction: a probe
 * that cannot run must never be able to refuse a device that is really there.
 * Set PREFLIGHT_SKIP_USB_PROBE to disable it outright.
 */
export async function deviceAttached(): Promise<boolean | null> {
  if (env('PREFLIGHT_SKIP_USB_PROBE')) return null;

  const probe: [string, string[]] | null =
    process.platform === 'darwin'
      ? ['ioreg', ['-p', 'IOUSB', '-l']]
      : process.platform === 'linux'
        ? ['lsusb', []]
        : null;
  if (!probe) return null;

  return new Promise<boolean | null>((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(probe[0], probe[1], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, PROBE_TIMEOUT_MS);

    child.stdout.on('data', (c) => (out += String(c)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A non-zero exit means the probe itself failed, which is not evidence
      // about the device.
      resolve(code === 0 ? LEDGER_USB.test(out) : null);
    });
  });
}

/**
 * How long a person gets to press, once we know a device is actually there.
 *
 * The MCP SDK times a request out at 60 seconds by default, and the analysis
 * ahead of this spends around twelve, so the whole confirmation has to fit in
 * the rest. Forty leaves eight seconds of margin after the kill timer's grace
 * period, which is ample for a person already holding the device.
 *
 * This is only ever reached when someone is present and slow. The absent-device
 * case no longer spends it: deviceAttached() answers that in milliseconds and
 * refuses immediately, which is what freed the budget to be generous here.
 *
 * wallet-cli's own --device-timeout appears not to work in v2.1.0, so this is
 * enforced by killing the process.
 */
const DEFAULT_TIMEOUT_MS = 40_000;

export interface DeviceOptions {
  /** Session label from `wallet-cli session view`. */
  account?: string;
  /** How long a human gets to reach the device and press. */
  timeoutMs?: number;
  /**
   * A ceiling the wait may not exceed, whatever it is otherwise configured to
   * be. The engine passes what is left of the caller's request budget, so a
   * slow analysis shortens the wait rather than overrunning the caller.
   *
   * Separate from timeoutMs on purpose: this narrows, never widens. Setting
   * GATE_TIMEOUT_MS still works and still cannot push the call past its
   * deadline.
   */
  budgetMs?: number;
}

/**
 * Asks the device to display its receive address for confirmation.
 *
 * `receive --verify` was chosen over `send` deliberately. Both require a
 * physical press, but `send` needs testnet gas and may need blind signing
 * enabled, which is two more things to fail during a demo. This needs neither
 * and still cannot succeed without the device.
 */
export async function confirmOnDevice(opts: DeviceOptions = {}): Promise<GateOutcome> {
  const account = opts.account ?? env('LEDGER_ACCOUNT_LABEL') ?? 'ethereum-1';
  const configured = opts.timeoutMs ?? Number(env('GATE_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Math.min(configured, opts.budgetMs ?? Number.POSITIVE_INFINITY);
  const bin = resolveWalletCli();
  if (!bin) return DENIED('WALLET_CLI_PATH is set but does not exist');

  // Cheap question first. wallet-cli spends a minute discovering the same
  // answer, and we do not have a minute.
  if ((await deviceAttached()) === false) {
    return DENIED(
      'no Ledger detected over USB. Connect the device, unlock it, and run this check again',
    );
  }

  return new Promise<GateOutcome>((resolve) => {
    let child;
    try {
      child = spawn(
        bin,
        [
          'receive',
          '--account', account,
          '--verify',
          '--output', 'json',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      resolve(DENIED(`could not run wallet-cli: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    /** The device's own last words, used as the reason if nothing is approved. */
    let lastState: DeviceProgress | null = null;

    // Narrate progress as it happens. Waiting up to forty seconds in silence
    // and then failing is the difference between a tool that seems broken and
    // one that is telling you to unlock your Ledger.
    const watch = (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const progress = readProgress(line.trim());
        if (!progress) continue;
        if (progress.message !== lastState?.message) {
          process.stderr.write(`[gate] ${progress.message}\n`);
        }
        lastState = progress;
      }
    };

    const finish = (outcome: GateOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(outcome);
    };


    /**
     * Out of time, but not yet out of answers.
     *
     * The first version resolved here and killed the child in the same breath,
     * which threw away whatever wallet-cli was in the middle of writing. We
     * watched it happen: the timer settled the promise as a refusal, and the
     * close handler then found a complete result already sitting in stdout.
     *
     * That run was a refusal either way, so the outcome was right by luck. A
     * press landing in the same instant would have been discarded, and a
     * discarded approval is the failure this whole file exists to prevent.
     *
     * So expiry stops the waiting and nothing else. The child is asked to
     * stop, its output is read one last time, and the close handler decides.
     */
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill('SIGTERM');
      // Backstop: if the process will not close, settle without it rather than
      // hang past the caller's deadline.
      setTimeout(() => {
        finish(
          DENIED(explain(`no confirmation within ${Math.round(timeoutMs / 1000)}s`, lastState)),
        );
      }, 1_500);
    }, timeoutMs + 2_000);

    child.stdout.on('data', (c) => {
      stdout += String(c);
      watch(String(c));
    });
    child.stderr.on('data', (c) => {
      stderr += String(c);
      watch(String(c));
    });

    child.on('error', (err) => finish(DENIED(`could not run wallet-cli: ${err.message}`)));

    child.on('close', (code, signal) => {
      // Both streams, not one or the other. The previous version passed
      // `stdout || stderr`, so once stdout carried anything at all, and it
      // always carries the progress lines, stderr was never read. A genuine
      // approval arriving there would have been refused, which is the same
      // class of bug as accepting a non-approval, pointing the other way.
      const result = parseWalletCli(`${stdout}\n${stderr}`);

      // How it ended, which we were not recording. wallet-cli writes an
      // {"ok":...} line and exits 6 when it gives up on its own, so output
      // that stops at a progress line means the process died instead of
      // answering. Without the exit code that case is indistinguishable from
      // a parse failure, and we spent a test run unable to tell them apart.
      if (env('PREFLIGHT_GATE_DEBUG')) {
        process.stderr.write(
          `[gate] exit=${code ?? 'null'} signal=${signal ?? 'none'}\n` +
            `[gate] raw stdout:\n${stdout}\n[gate] raw stderr:\n${stderr}\n`,
        );
      }

      // An approval found here counts even when the clock has already run out.
      // It means the press happened; we were simply still reading.
      if (result.ok) {
        finish({ required: true, approved: true, method: 'device' });
        return;
      }

      // When wallet-cli said what happened, that is the reason. Preferring the
      // last progress line over it reported 'wallet-cli exited 1 without an
      // answer' for a refusal that arrived as UserRefusedOnDevice, which is
      // both wrong and the opposite of useful.
      if (result.explicit) {
        finish(DENIED(result.message));
        return;
      }

      if (expired) {
        finish(
          DENIED(explain(`no confirmation within ${Math.round(timeoutMs / 1000)}s`, lastState)),
        );
        return;
      }

      const how = signal
        ? `wallet-cli was killed by ${signal}`
        : `wallet-cli exited ${code ?? 'unknown'} without an answer`;
      finish(DENIED(explain(result.message, lastState, how)));
    });
  });
}

/**
 * wallet-cli narrates what the device is doing, one JSON object per line.
 *
 * We ignored this stream entirely and it cost a test run. The device was
 * locked, wallet-cli said so in plain English in a `device-state` line, and the
 * gate discarded it and reported `no approval in wallet-cli output:` followed
 * by 200 characters of truncated JSON. The person standing at the device was
 * told nothing they could act on, while the answer sat in the output unread.
 *
 * Two states matter. `reason: "unlock"` means the Ledger is locked and no
 * amount of waiting helps until a PIN is entered. Anything else under
 * `awaiting_approval` means the prompt is on screen and a press is what is
 * missing.
 */
/**
 * Ledger's SDK reports refusal as an identifier, not a sentence. Someone
 * reading a refusal should not have to know that `UserRefusedOnDevice` is what
 * pressing the left button looks like from here.
 */
const DEVICE_ERRORS: Record<string, string> = {
  UserRefusedOnDevice: 'Rejected on the device. Nothing was approved.',
  UserRefusedAddress: 'Address rejected on the device. Nothing was approved.',
  LockedDeviceError: 'The Ledger is locked. Unlock it, then run this check again.',
  TransportRaceCondition: 'The device was busy. Close other Ledger apps and try again.',
};

/**
 * Families, matched on a keyword, because enumerating Ledger's error names by
 * hand does not work.
 *
 * Two attempts at an exact table both missed. The real disconnect error is
 * `DeviceDisconnectedBeforeSendingApdu`, not `DisconnectedDevice`, and a
 * refusal surfaced as `UserRefusedOnDevice` rather than anything about the
 * address. Each miss leaked a protocol identifier into a message someone reads
 * while standing over a Ledger wondering what went wrong.
 *
 * Matching the meaningful word instead covers the variants without needing to
 * know them in advance, and the fallback below keeps anything unmatched
 * readable rather than shouting an identifier.
 */
const ERROR_FAMILIES: [RegExp, string][] = [
  [/refus|reject|deni/i, 'Rejected on the device. Nothing was approved.'],
  [/disconnect|unplug/i, 'The device was disconnected before it answered. Reconnect it and try again.'],
  [/lock/i, 'The Ledger is locked. Unlock it, then run this check again.'],
  [/busy|race|already open/i, 'The device was busy. Close other Ledger apps and try again.'],
  [/timeout|timed out/i, 'The device did not answer in time.'],
  [/app|application/i, 'Open the Ethereum app on the device, then try again.'],
];

/** `DeviceDisconnectedBeforeSendingApdu` reads as a sentence, not a symbol. */
function fromIdentifier(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}.` : name;
}

export function humanise(message: string): string {
  const raw = message.trim();
  if (DEVICE_ERRORS[raw]) return DEVICE_ERRORS[raw]!;

  // Only a bare identifier is ever rewritten. Matching families against real
  // prose is worse than the problem it solves: "No Ledger device found. Unlock
  // the device and try again" contains the word unlock, so a keyword match
  // replaced an accurate message about a missing device with a wrong one about
  // a locked device. wallet-cli writes good sentences. Leave them alone.
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(raw)) return raw;

  for (const [pattern, text] of ERROR_FAMILIES) {
    if (pattern.test(raw)) return text;
  }
  return fromIdentifier(raw);
}

/**
 * The reason a person actually needs.
 *
 * Prefer whatever the device last said about itself over our own generic
 * wording, because wallet-cli's messages are already written for a human and
 * ours are written for a log. "Ledger is locked. Enter your PIN on the device"
 * tells someone what to do next; "no confirmation within 40s" does not.
 */
function explain(fallback: string, state: DeviceProgress | null, how?: string): string {
  if (state?.locked) return `${state.message} Unlock it, then run this check again.`;
  // The device's own words, plus how the process ended. Never the raw JSON:
  // dumping 200 characters of truncated protocol at someone standing over a
  // Ledger tells them nothing they can act on.
  if (state) return how ? `${state.message} ${how}.` : `${state.message} (${fallback})`;
  return how ? `${fallback}. ${how}.` : fallback;
}

export interface DeviceProgress {
  /** wallet-cli's own wording, which is already written for a human. */
  message: string;
  locked: boolean;
}

export function readProgress(line: string): DeviceProgress | null {
  try {
    const parsed = JSON.parse(line) as {
      type?: string;
      message?: string;
      state?: { code?: string; reason?: string };
    };
    if (parsed.type !== 'device-state') return null;
    return {
      message: parsed.message ?? parsed.state?.code ?? 'device state changed',
      locked: parsed.state?.reason === 'unlock',
    };
  } catch {
    return null;
  }
}

/**
 * wallet-cli emits one JSON object per line and the interesting one is last.
 *
 * Only an explicit `ok: true` is an approval. Nothing else is, and the reason
 * is worth stating because the first version of this got it wrong.
 *
 * It also accepted `status: "success"`, which looked like a reasonable
 * fallback and is not. That field is wallet-cli's generic envelope meaning the
 * command ran: `session view` returns it and that command never touches the
 * device. So the parser was treating "the process exited normally" as "a human
 * pressed a button", on the one path in this project where that distinction is
 * the entire product.
 *
 * Found by an agent reading this file during a live test, which is a better
 * argument for shipping readable source than anything in the README.
 *
 * If a genuine approval turns out not to carry `ok: true`, this will refuse a
 * real press. That is the safe direction to be wrong in, and the raw output
 * comes back in the reason so the shape can be corrected in one pass.
 */
export function parseWalletCli(output: string): {
  ok: boolean;
  message: string;
  /** True when wallet-cli stated an outcome, rather than us inferring one. */
  explicit: boolean;
} {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as {
        ok?: boolean;
        status?: string;
        verified?: boolean;
        source?: string;
        error?: { message?: string };
      };
      if (parsed.ok === true) {
        return { ok: true, message: 'confirmed on device', explicit: true };
      }
      if (parsed.ok === false) {
        return {
          ok: false,
          message: humanise(parsed.error?.message ?? 'declined on device'),
          explicit: true,
        };
      }
      // The shape a real press actually produces, measured on wallet-cli
      // v2.1.0 against a Nano S Plus:
      //
      //   {"status":"success","command":"receive","verified":true,
      //    "source":"device","address":"0x8E2D...","timestamp":"..."}
      //
      // `status` alone proves nothing: it is the generic "the command ran"
      // envelope, and `session view` returns it without ever reaching the
      // device. Requiring ok:true instead was the previous correction, and it
      // went too far, because receive --verify never emits ok:true. It refused
      // genuine approvals for an entire evening of testing.
      //
      // The proof of a human press is the pair below. `verified` says the
      // address was confirmed rather than merely derived, and `source` says a
      // device did the confirming rather than a cache or a session. Both, on a
      // success envelope, and nothing less.
      if (parsed.status === 'success' && parsed.verified === true && parsed.source === 'device') {
        return { ok: true, message: 'verified on device', explicit: true };
      }
    } catch {
      continue;
    }
  }
  // No explicit approval anywhere in the output. Carry a slice of what was
  // actually said, so a wrong assumption about the success shape is one test
  // away from being fixed rather than a mystery.
  const tail = lines.slice(-2).join(' ').slice(0, 200);
  return {
    ok: false,
    message: tail
      ? `no approval in wallet-cli output: ${tail}`
      : 'wallet-cli produced no readable result',
    explicit: false,
  };
}
