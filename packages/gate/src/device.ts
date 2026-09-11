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
          '--device-timeout', String(timeoutMs),
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

    // wallet-cli's own timeout flag did not take effect in v2.1.0, so this is
    // the one that actually bounds the wait.
    const timer = setTimeout(
      () =>
        finish(
          DENIED(
            explain(`no confirmation within ${Math.round(timeoutMs / 1000)}s`, lastState),
          ),
        ),
      timeoutMs + 2_000,
    );

    child.stdout.on('data', (c) => {
      stdout += String(c);
      watch(String(c));
    });
    child.stderr.on('data', (c) => {
      stderr += String(c);
      watch(String(c));
    });

    child.on('error', (err) => finish(DENIED(`could not run wallet-cli: ${err.message}`)));

    child.on('close', () => {
      // Both streams, not one or the other. The previous version passed
      // `stdout || stderr`, so once stdout carried anything at all, and it
      // always carries the progress lines, stderr was never read. A genuine
      // approval arriving there would have been refused, which is the same
      // class of bug as accepting a non-approval, pointing the other way.
      const result = parseWalletCli(`${stdout}\n${stderr}`);
      if (result.ok) {
        finish({ required: true, approved: true, method: 'device' });
      } else {
        finish(DENIED(explain(result.message, lastState)));
      }
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
 * The reason a person actually needs.
 *
 * Prefer whatever the device last said about itself over our own generic
 * wording, because wallet-cli's messages are already written for a human and
 * ours are written for a log. "Ledger is locked. Enter your PIN on the device"
 * tells someone what to do next; "no confirmation within 40s" does not.
 */
function explain(fallback: string, state: DeviceProgress | null): string {
  if (!state) return fallback;
  if (state.locked) {
    return `${state.message} Unlock it, then run this check again.`;
  }
  return `${state.message} (${fallback})`;
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
export function parseWalletCli(output: string): { ok: boolean; message: string } {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as {
        ok?: boolean;
        error?: { message?: string };
      };
      if (parsed.ok === true) return { ok: true, message: 'confirmed on device' };
      if (parsed.ok === false) {
        return { ok: false, message: parsed.error?.message ?? 'declined on device' };
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
  };
}
