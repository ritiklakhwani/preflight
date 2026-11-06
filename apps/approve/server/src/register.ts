// Registers an agent in the vault with the owner's passkey public key.
// Usage: pnpm --filter @preflight/approve register <chain> <agent> <qx> <qy> <amount>
// amount is in human units (e.g. 10 for 10 USDT). Uses DEPLOYER_PRIVATE_KEY,
// which funds the vault side; it gains no control over the agent.
import { erc20Abi, getAddress, isAddress, isHex, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getChain, publicClient, requireVault, vaultAbi, walletClient } from '@preflight/capline';

function fail(msg: string): never {
  console.error(msg);
  console.error('usage: register <whitechain|base> <agent> <qx> <qy> <amount>');
  process.exit(1);
}

const [chain, agentArg, qx, qy, amountArg] = process.argv.slice(2);
if (chain !== 'whitechain' && chain !== 'base') fail('chain must be whitechain or base');
if (!agentArg || !isAddress(agentArg)) fail('agent must be an address');
const is32 = (v: string | undefined): v is Hex => !!v && isHex(v) && v.length === 66;
if (!is32(qx) || !is32(qy)) fail('qx and qy must be 32-byte hex (0x + 64 chars)');
if (!amountArg || !/^\d+(\.\d+)?$/.test(amountArg)) fail('amount must be a number in token units');

const pkRaw = process.env.DEPLOYER_PRIVATE_KEY;
if (!pkRaw) fail('DEPLOYER_PRIVATE_KEY is not set');
const pk = (pkRaw.startsWith('0x') ? pkRaw : `0x${pkRaw}`) as Hex;

const agent = getAddress(agentArg);
const cfg = getChain(chain);
const vault = requireVault(chain);
const pub = publicClient(chain);
const wallet = walletClient(chain, pk);
const owner = privateKeyToAccount(pk).address;

const decimals = await pub.readContract({ address: cfg.token, abi: erc20Abi, functionName: 'decimals' });
const amount = parseUnits(amountArg, decimals);
console.log(`chain ${chain}, vault ${vault}, token ${cfg.token} (${decimals} decimals)`);
console.log(`funding ${amountArg} from ${owner} for agent ${agent}`);

const allowance = await pub.readContract({
  address: cfg.token,
  abi: erc20Abi,
  functionName: 'allowance',
  args: [owner, vault],
});
if (allowance < amount) {
  const approveHash = await wallet.writeContract({
    address: cfg.token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [vault, amount],
    account: wallet.account!,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  console.log(`approve tx ${approveHash}`);
}

const hash = await wallet.writeContract({
  address: vault,
  abi: vaultAbi,
  functionName: 'register',
  args: [agent, qx, qy, cfg.token, amount],
  account: wallet.account!,
  chain: wallet.chain,
});
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`register tx ${hash} status ${receipt.status}`);
if (receipt.status !== 'success') process.exit(1);
