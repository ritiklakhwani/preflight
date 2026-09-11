/**
 * `pnpm analyse <address> [chainId]`.
 *
 * A thin wrapper so the analysis package's CLI does not have to depend on the
 * gate package to find its credentials. Boot first, then hand off.
 */
import './boot.js';
import '../packages/analysis/src/cli.js';
