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
 * How long a person gets to reach the device and press.
 *
 * Deliberately under a minute. The MCP SDK times a request out at 60 seconds by
 * default, so a gate that waits the full minute loses the race with its own
 * caller: the agent gives up before the answer arrives, and pressing the button
 * accomplishes nothing. Measured, not guessed. This leaves roughly thirteen
 * seconds of headroom once the kill timer's grace period is counted.
 *
 * wallet-cli's own --device-timeout appears not to work in v2.1.0, so this is
 * enforced by killing the process.
 */
const DEFAULT_TIMEOUT_MS = 45_000;

export interface DeviceOptions {
  /** Session label from `wallet-cli session view`. */
  account?: string;
  /** How long a human gets to reach the device and press. */
  timeoutMs?: number;
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
  const timeoutMs = opts.timeoutMs ?? Number(env('GATE_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS);
  const bin = resolveWalletCli();
  if (!bin) return DENIED('WALLET_CLI_PATH is set but does not exist');

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
      () => finish(DENIED(`no confirmation within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs + 2_000,
    );

    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));

    child.on('error', (err) => finish(DENIED(`could not run wallet-cli: ${err.message}`)));

    child.on('close', () => {
      const result = parseWalletCli(stdout || stderr);
      if (result.ok) {
        finish({ required: true, approved: true, method: 'device' });
      } else {
        finish(DENIED(result.message));
      }
    });
  });
}

/**
 * wallet-cli emits one JSON object per line and the interesting one is last.
 * The exit code is not usable: a missing device produces ok:false and exit 0.
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
        status?: string;
      };
      if (typeof parsed.ok === 'boolean') {
        return {
          ok: parsed.ok,
          message: parsed.error?.message ?? (parsed.ok ? 'confirmed on device' : 'declined'),
        };
      }
      if (parsed.status === 'success') return { ok: true, message: 'confirmed on device' };
    } catch {
      continue;
    }
  }
  // Unreadable output is not an approval.
  return { ok: false, message: 'wallet-cli produced no readable result' };
}
