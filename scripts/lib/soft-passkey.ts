/**
 * A software P-256 key that stands in for the owner's phone passkey in
 * scripted runs (scripts/e2e-whitechain.ts, scripts/rehearse.ts).
 *
 * It produces WebAuthn assertions byte for byte like a browser does: the same
 * clientDataJSON shape, authenticatorData = sha256(rpId) || flags || counter,
 * a DER signature over sha256(authenticatorData || sha256(clientDataJSON)),
 * then the phone's own buildAuth (DER parsing, low-s, challenge/type indexes).
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { authFromJson, type WebAuthnAuth } from '../../packages/capline/src/index.js';
import { base64urlEncode, buildAuth, hexToBytes, spkiToXY } from '../../apps/approve/web/src/webauthn.js';

type Hex = `0x${string}`;

export const RP_ID = 'ritiklakhwani.github.io';
export const ORIGIN = `https://${RP_ID}`;

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

/** A P-256 key that signs WebAuthn assertions the way a phone passkey does. */
export class SoftwarePasskey {
  readonly qx: Hex;
  readonly qy: Hex;
  private readonly privateKey: KeyObject;
  private counter = 0;

  constructor(
    readonly rpId: string = RP_ID,
    readonly origin: string = ORIGIN,
  ) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = privateKey;
    // Same path as the phone: SPKI DER from the authenticator, x || y is the tail.
    ({ qx: this.qx, qy: this.qy } = spkiToXY(new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }))));
  }

  /** navigator.credentials.get({ challenge: digest, userVerification: 'required' }) */
  sign(digest: Hex): WebAuthnAuth {
    const clientDataJSON = JSON.stringify({
      type: 'webauthn.get',
      challenge: base64urlEncode(hexToBytes(digest)),
      origin: this.origin,
      crossOrigin: false,
    });
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const flags = Buffer.from([0x05]); // UP | UV: user present and verified (Face ID / PIN)
    const authenticatorData = Buffer.concat([sha256(this.rpId), flags, counter]);
    // ES256: ECDSA P-256 over SHA-256, DER encoded, either s half (browsers do not normalise).
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    // From here on this is exactly the phone's code (apps/approve/web/src/webauthn.ts).
    return authFromJson(
      buildAuth({
        signature: new Uint8Array(signature),
        authenticatorData: new Uint8Array(authenticatorData),
        clientDataJSON: new TextEncoder().encode(clientDataJSON),
      }),
    );
  }
}
