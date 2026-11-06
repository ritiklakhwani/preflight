import { parseAbi } from 'viem';

export { erc20Abi } from 'viem';

// Hand-written from docs/CAPLINE_SPEC.md. Cross-check with
// contracts/abi/CaplineVault.json when the contract changes.
export const vaultAbi = parseAbi([
  'struct WebAuthnAuth { bytes32 r; bytes32 s; uint256 challengeIndex; uint256 typeIndex; bytes authenticatorData; string clientDataJSON; }',
  'struct Agent { bytes32 qx; bytes32 qy; address token; uint256 balance; uint64 nonce; bool dropped; uint64 lastReleaseBlock; bytes32 lastReceiptsHash; }',

  'function register(address agent, bytes32 qx, bytes32 qy, address token, uint256 amount)',
  'function deposit(address agent, uint256 amount)',
  'function release(address agent, uint256 amount, uint64 expiry, bytes32 receiptsHash, WebAuthnAuth auth)',
  'function drop(address agent, uint64 expiry, WebAuthnAuth auth)',
  'function undrop(address agent, uint64 expiry, WebAuthnAuth auth)',
  'function withdraw(address agent, address to, uint256 amount, uint64 expiry, WebAuthnAuth auth)',

  'function getAgent(address agent) view returns (Agent)',
  'function agents(address agent) view returns (Agent)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function releaseDigest(address agent, uint256 amount, uint64 nonce, uint64 expiry, bytes32 receiptsHash) view returns (bytes32)',
  'function dropDigest(address agent, uint64 nonce, uint64 expiry) view returns (bytes32)',
  'function undropDigest(address agent, uint64 nonce, uint64 expiry) view returns (bytes32)',
  'function withdrawDigest(address agent, address to, uint256 amount, uint64 nonce, uint64 expiry) view returns (bytes32)',

  'event Registered(address indexed agent, address indexed token, bytes32 qx, bytes32 qy, uint256 amount)',
  'event Deposited(address indexed agent, address indexed from, uint256 amount)',
  'event Released(address indexed agent, uint256 amount, uint64 nonce, bytes32 receiptsHash)',
  'event Dropped(address indexed agent, uint64 nonce)',
  'event Undropped(address indexed agent, uint64 nonce)',
  'event Withdrawn(address indexed agent, address indexed to, uint256 amount, uint64 nonce)',

  'error AlreadyRegistered()',
  'error UnknownAgent()',
  'error Expired()',
  'error BadSignature()',
  'error IsDropped()',
  'error InsufficientBalance()',
  // From OpenZeppelin bases, listed so viem can decode these reverts too.
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
]);
