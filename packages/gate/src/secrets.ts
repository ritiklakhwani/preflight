/**
 * NEW during ETHOnline 2026.
 *
 * Credentials held as ciphertext, decrypted at runtime against the Ledger Key
 * Ring.
 *
 * This is the second half of the Ledger integration and the one their track
 * names directly: make `wallet-cli ring` the key backend for the `.env` the
 * repo already has. Before this, an Etherscan key and a model key sat in
 * plaintext in a file on disk. After it, the repository carries `secrets/*.enc`
 * and the plaintext exists only in process memory.
 *
 * The property that makes this usable on a server, and the reason we checked it
 * before designing anything: `ring encrypt` and `ring decrypt` need no device.
 * The trustchain is provisioned once by `ring init` with the Ledger attached,
 * and every operation after that runs against locally stored member
 * credentials. Verified with the Nano unplugged on 2026-09-06.
 *
 * What they do need is a passphrase, and they refuse to prompt without a TTY.
 * `bin/preflight-mcp` injects WALLET_PASS from the OS keychain at spawn, which
 * is what wallet-cli's own error message recommends. It is never written to a
 * file and never appears in the MCP client configuration.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolveWalletCli } from './device.js';

const run = promisify(execFile);

/**
 * Scoped key names rather than one key for everything, so a credential can be
 * rotated or revoked on its own. Ledger's own documentation calls these scoped
 * capabilities and this makes the phrase literal.
 */
export const RING_KEYS: { env: string; ringKey: string; file: string }[] = [
  { env: 'ETHERSCAN_API_KEY', ringKey: 'preflight-etherscan', file: 'secrets/etherscan.enc' },
  { env: 'GRAPH_API_KEY', ringKey: 'preflight-graph', file: 'secrets/graph.enc' },
  { env: 'ANTHROPIC_API_KEY', ringKey: 'preflight-anthropic', file: 'secrets/anthropic.enc' },
  { env: 'OPENAI_API_KEY', ringKey: 'preflight-openai', file: 'secrets/openai.enc' },
];

/**
 * Put the Key Ring passphrase in the environment if it is not already there.
 *
 * wallet-cli needs it for every ring operation and refuses to prompt without a
 * TTY. `bin/preflight-mcp` already injects it for the MCP server, but that
 * covered exactly one entry point, and the benchmark, the probes and the
 * analyse CLI all went without. They did not fail loudly either: the decrypt
 * failed, the plaintext was no longer in `.env` to fall back to, and every
 * network signal quietly reported that it could not run. A benchmark of twenty
 * addresses scored every one of them clean.
 *
 * Resolving it here means any entry point that loads credentials gets the
 * passphrase, rather than each one remembering to arrange it.
 */
async function ensureWalletPass(): Promise<void> {
  if (process.env['WALLET_PASS']?.trim()) return;

  const lookup: [string, string[]] | null =
    process.platform === 'darwin'
      ? ['security', ['find-generic-password', '-a', 'default', '-s', 'ledger-wallet-cli', '-w']]
      : process.platform === 'linux'
        ? ['secret-tool', ['lookup', 'service', 'ledger-wallet-cli', 'account', 'default']]
        : null;
  if (!lookup) return;

  try {
    const { stdout } = await run(lookup[0], lookup[1], { maxBuffer: 8 * 1024 });
    const pass = stdout.trim();
    if (pass) process.env['WALLET_PASS'] = pass;
  } catch {
    // No keychain entry is not an error here. The decrypt will fail with a
    // message that says so, which is more useful than one raised from here.
  }
}

export async function decryptSecret(ringKey: string, file: string): Promise<string> {
  const bin = resolveWalletCli();
  if (!bin) throw new Error('wallet-cli not found');

  const { stdout } = await run(bin, ['ring', 'decrypt', '--key', ringKey, '--input', file], {
    // A credential is small. A large response means something is wrong.
    maxBuffer: 64 * 1024,
  });
  const value = stdout.trim();
  if (!value) throw new Error(`ring decrypt returned nothing for ${ringKey}`);
  if (value.startsWith('{') && value.includes('"ok":false')) {
    throw new Error(`ring decrypt failed for ${ringKey}: ${value.slice(0, 160)}`);
  }
  return value;
}

export interface RingLoadResult {
  /** Decrypted from ciphertext in this repository. */
  loaded: string[];
  /** No ciphertext present for these. */
  skipped: string[];
  /**
   * Ciphertext present and undecryptable, but the environment already had a
   * value, so nothing is lost.
   *
   * This is the normal case for anyone who is not us. The `.enc` files are
   * committed and useless without our trustchain, so a judge cloning the repo
   * and adding their own keys to `.env` hits this on every credential. The
   * first version reported it as three failures with the full wallet-cli
   * command line in each, which reads like a broken install seconds after
   * someone has cloned the project.
   */
  fellBack: string[];
  /** Undecryptable, with no value in the environment to fall back to. */
  errors: string[];
}

/**
 * Populates process.env from any encrypted credential present.
 *
 * The Key Ring wins over `.env` when both exist, because the point of the
 * integration is that the encrypted copy is the real one. A decrypt that fails
 * leaves whatever was already in the environment, so a broken trustchain
 * degrades to the previous behaviour rather than taking the server down.
 */
export async function loadRingSecrets(root: string): Promise<RingLoadResult> {
  const result: RingLoadResult = { loaded: [], skipped: [], fellBack: [], errors: [] };
  await ensureWalletPass();

  for (const { env, ringKey, file } of RING_KEYS) {
    const path = `${root}/${file}`;
    if (!existsSync(path)) {
      result.skipped.push(env);
      continue;
    }
    try {
      process.env[env] = await decryptSecret(ringKey, path);
      result.loaded.push(env);
    } catch (err) {
      // A failed decrypt is only a problem if it leaves us without the value.
      if (process.env[env]?.trim()) {
        result.fellBack.push(env);
        continue;
      }
      const why = err instanceof Error ? err.message : String(err);
      // wallet-cli echoes the whole command line it ran. Keep the reason.
      const reason = /wrong password/i.test(why)
        ? 'wrong Key Ring passphrase'
        : /not found|ENOENT/i.test(why)
          ? 'wallet-cli not found'
          : why.split('\n').find((l) => /\bmessage\b|error/i.test(l))?.trim() ?? why.slice(0, 120);
      result.errors.push(`${env}: ${reason}, and no value in the environment to fall back to`);
    }
  }
  return result;
}
