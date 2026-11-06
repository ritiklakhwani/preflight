// WebAuthn calls. Both must run straight from a tap with no await before
// them: Safari drops the user gesture otherwise and refuses Face ID.
import { authFromJson, type WebAuthnAuth } from '@preflight/capline';
import { setPasskey, type StoredPasskey } from './storage.js';
import {
  base64urlDecode,
  base64urlEncode,
  buildAuth,
  challengeMatches,
  flagProblem,
  hexToBytes,
  spkiToXY,
  verifyAssertion,
  type Hex,
} from './webauthn.js';

export const passkeySupported = () =>
  typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

export async function createPasskey(): Promise<StoredPasskey> {
  if (!passkeySupported()) throw new Error('This browser has no passkey support.');
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Capline' }, // rp.id defaults to this page's domain
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'capline-owner',
        displayName: 'Capline owner',
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 = P-256, what the vault verifies
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred', requireResidentKey: false },
      attestation: 'none',
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was created.');
  const res = cred.response as AuthenticatorAttestationResponse;
  const spki = typeof res.getPublicKey === 'function' ? res.getPublicKey() : null;
  if (!spki) throw new Error('This browser did not return the public key. Update iOS or Chrome and try again.');
  if (typeof res.getPublicKeyAlgorithm === 'function' && res.getPublicKeyAlgorithm() !== -7) {
    throw new Error('The authenticator did not create a P-256 key.');
  }
  const { qx, qy } = spkiToXY(new Uint8Array(spki));
  const stored: StoredPasskey = {
    credentialId: base64urlEncode(new Uint8Array(cred.rawId)),
    qx,
    qy,
    rpId: location.hostname,
    createdAt: Math.floor(Date.now() / 1000),
  };
  setPasskey(stored);
  return stored;
}

/** Face ID over the 32-byte EIP-712 digest; returns the auth the vault checks. */
export async function signDigest(
  digest: Hex,
  passkey: Pick<StoredPasskey, 'credentialId' | 'qx' | 'qy'>,
): Promise<WebAuthnAuth> {
  const { credentialId } = passkey;
  if (!passkeySupported()) throw new Error('This browser has no passkey support.');
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(digest),
      allowCredentials: [{ type: 'public-key', id: base64urlDecode(credentialId) }],
      userVerification: 'required',
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Signing was cancelled.');
  const res = cred.response as AuthenticatorAssertionResponse;
  const json = buildAuth({
    signature: new Uint8Array(res.signature),
    authenticatorData: new Uint8Array(res.authenticatorData),
    clientDataJSON: new Uint8Array(res.clientDataJSON),
  });
  if (!challengeMatches(json.clientDataJSON, digest)) throw new Error('The passkey signed something else. Not sent.');
  const flags = flagProblem(json.authenticatorData);
  if (flags) throw new Error(`${flags} Not sent.`);
  // Same check the vault runs, against the key this phone registered. A miss
  // here means the stored key is not the one that signed, so say that plainly.
  let ok = false;
  try {
    ok = await verifyAssertion(json, passkey.qx, passkey.qy);
  } catch {
    ok = true; // WebCrypto unavailable or picky: let the vault be the judge.
  }
  if (!ok) throw new Error('This signature does not match the passkey key saved on this phone. Not sent.');
  return authFromJson(json);
}

/** WebAuthn errors are cryptic; map the common ones to plain words. */
export function passkeyError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'NotAllowedError') return 'Cancelled or timed out.';
  if (e?.name === 'InvalidStateError') return 'This passkey already exists on this device.';
  if (e?.name === 'SecurityError') return 'Passkeys need HTTPS on the domain the passkey was made for.';
  return e?.message ?? String(err);
}
