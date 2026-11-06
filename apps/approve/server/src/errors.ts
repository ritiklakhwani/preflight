// Turns contract reverts into one sentence the owner can act on.
import { BaseError, ContractFunctionRevertedError } from 'viem';

const MESSAGES: Record<string, string> = {
  BadSignature: 'The vault rejected the signature. Use the passkey this agent was registered with.',
  Expired: 'The approval expired before it landed onchain. Ask the agent to request again.',
  IsDropped: 'This agent is dropped. Undrop it before releasing funds.',
  InsufficientBalance: 'The vault does not hold enough for this amount.',
  UnknownAgent: 'This agent is not registered in the vault.',
  AlreadyRegistered: 'This agent is already registered.',
  ReentrancyGuardReentrantCall: 'Reentrant call blocked.',
};

export function revertName(err: unknown): string | undefined {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      return reverted.data.errorName;
    }
  }
  // Fallback for errors that lost their type crossing package boundaries.
  const text = err instanceof Error ? err.message : String(err);
  return Object.keys(MESSAGES).find((name) => text.includes(name));
}

export function readableError(err: unknown): string {
  const name = revertName(err);
  if (name && MESSAGES[name]) return MESSAGES[name];
  if (err instanceof BaseError) return err.shortMessage;
  const text = err instanceof Error ? err.message : String(err);
  if (/insufficient funds/i.test(text)) return 'The relayer is out of gas money.';
  return text.split('\n')[0]!.slice(0, 200);
}
