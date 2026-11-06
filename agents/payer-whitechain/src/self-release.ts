// Shows the agent has no special power over the vault: it calls
// release(itself, amount, expiry, 0x0, garbage auth) and the vault reverts with
// BadSignature. Simulates by default; SELF_RELEASE_SEND=1 also sends the tx so
// the revert is visible on the explorer.

import {
  BaseError,
  ContractFunctionRevertedError,
  bytesToHex,
  createWalletClient,
  getAddress,
  http,
  zeroHash,
} from 'viem';
import { randomBytes } from 'node:crypto';
import { vaultAbi as abi } from '@preflight/capline';
import { RPC, agentAccount, agentAddress, publicClient, toBaseUnits, txLink, whitechain } from './tools.js';

async function main() {
  const vaultEnv = process.env.CAPLINE_VAULT_WHITECHAIN;
  if (!vaultEnv) throw new Error('CAPLINE_VAULT_WHITECHAIN is not set');
  const vault = getAddress(vaultEnv);
  const me = agentAddress();
  const amount = await toBaseUnits(process.env.SELF_RELEASE_AMOUNT || '500');
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 600);

  // Garbage owner authorisation: random r/s, a made up WebAuthn payload.
  const auth = {
    r: bytesToHex(randomBytes(32)),
    s: bytesToHex(randomBytes(32)),
    challengeIndex: 23n,
    typeIndex: 1n,
    authenticatorData: bytesToHex(randomBytes(37)),
    clientDataJSON: '{"type":"webauthn.get","challenge":"agent-wants-more-money","origin":"https://evil.example"}',
  };
  const args = [me, amount, expiry, zeroHash, auth] as const;

  console.log('Capline demo: the agent tries to release funds to itself\n');
  console.log(`vault   ${vault}`);
  console.log(`agent   ${me}`);
  console.log(`call    release(agent, ${process.env.SELF_RELEASE_AMOUNT || '500'} USDT, expiry, 0x0, <forged passkey signature>)\n`);

  try {
    await publicClient.simulateContract({ address: vault, abi, functionName: 'release', args, account: me });
    console.log('UNEXPECTED: simulation succeeded. The vault accepted a forged signature.');
    process.exitCode = 2;
    return;
  } catch (e) {
    const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? reverted.reason ?? 'unknown';
      console.log(`reverted: ${name}${reverted.data?.args?.length ? ` ${JSON.stringify(reverted.data.args)}` : ''}`);
      if (name === 'BadSignature') console.log('The agent cannot move vault funds without the owner\'s passkey.');
      if (name === 'UnknownAgent') console.log('This wallet is not registered in the vault yet; register it to see BadSignature.');
    } else {
      console.log(`call failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  if (process.env.SELF_RELEASE_SEND === '1') {
    // Fixed gas so the wallet does not refuse to send a tx that estimation says reverts.
    const wallet = createWalletClient({ account: agentAccount(), chain: whitechain, transport: http(RPC) });
    const hash = await wallet.writeContract({ address: vault, abi, functionName: 'release', args, gas: 500_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`\nsent on chain: status ${receipt.status}`);
    console.log(txLink(hash));
  }
}

main().catch((e) => {
  console.error(`\nerror: ${(e as Error).message}`);
  process.exit(1);
});
