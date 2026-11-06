import { generateKeyPairSync, sign, verify, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  P256_HALF_N,
  P256_N,
  base64urlEncode,
  bigintTo32,
  buildAuth,
  bytesToHex,
  challengeMatches,
  clientDataIndices,
  derToRS,
  flagProblem,
  hexToBytes,
  normaliseS,
  parseDerSignature,
  spkiToXY,
  verifyAssertion,
} from '../web/src/webauthn.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

function p1363(r: bigint, s: bigint): Buffer {
  return Buffer.concat([hexToBytes(bigintTo32(r)), hexToBytes(bigintTo32(s))]);
}

describe('DER signature parsing', () => {
  it('matches the raw r||s encoding Node produces', () => {
    for (let i = 0; i < 40; i++) {
      const msg = Buffer.from(`message ${i}`);
      const der = sign('sha256', msg, { key: privateKey, dsaEncoding: 'der' });
      const { r, s } = parseDerSignature(der);
      const back = p1363(r, s);
      expect(verify('sha256', msg, { key: publicKey, dsaEncoding: 'ieee-p1363' }, back)).toBe(true);
    }
  });

  it('normalises to low-s and the signature still verifies', () => {
    let sawHigh = false;
    for (let i = 0; i < 60; i++) {
      const msg = Buffer.from(`low-s ${i}`);
      const der = sign('sha256', msg, { key: privateKey, dsaEncoding: 'der' });
      const raw = parseDerSignature(der);
      if (raw.s > P256_HALF_N) sawHigh = true;
      const { r, s } = derToRS(der);
      expect(BigInt(s) <= P256_HALF_N).toBe(true);
      expect(verify('sha256', msg, { key: publicKey, dsaEncoding: 'ieee-p1363' }, p1363(BigInt(r), BigInt(s)))).toBe(true);
    }
    // 60 random signatures without one high-s is a 1 in 2^60 event.
    expect(sawHigh).toBe(true);
  });

  it('handles leading-zero padded and short integers', () => {
    // r = 0x80.. needs a 0x00 pad in DER; s = 1 is one byte long.
    const r = 0x80n << 248n;
    const der = new Uint8Array([0x30, 0x26, 0x02, 0x21, 0x00, 0x80, ...new Array(31).fill(0), 0x02, 0x01, 0x01]);
    expect(parseDerSignature(der)).toEqual({ r, s: 1n });
    expect(derToRS(der).s).toBe(bigintTo32(1n));
  });

  it('rejects malformed input', () => {
    expect(() => parseDerSignature(new Uint8Array([0x31, 0x00]))).toThrow();
    expect(() => parseDerSignature(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01]))).toThrow();
  });

  it('normaliseS flips only the upper half', () => {
    expect(normaliseS(P256_HALF_N)).toBe(P256_HALF_N);
    expect(normaliseS(P256_HALF_N + 1n)).toBe(P256_N - (P256_HALF_N + 1n));
    expect(normaliseS(5n)).toBe(5n);
  });
});

describe('clientDataJSON indices', () => {
  const digest = `0x${createHash('sha256').update('d').digest('hex')}` as const;
  const challenge = base64urlEncode(hexToBytes(digest));
  const cdj = `{"type":"webauthn.get","challenge":"${challenge}","origin":"https://approve.example","crossOrigin":false}`;

  it('finds type and challenge offsets', () => {
    const { challengeIndex, typeIndex } = clientDataIndices(cdj);
    expect(typeIndex).toBe(1);
    expect(cdj.slice(challengeIndex, challengeIndex + 13)).toBe('"challenge":"');
    expect(cdj.slice(challengeIndex + 13, challengeIndex + 13 + challenge.length)).toBe(challenge);
    expect(challengeMatches(cdj, digest)).toBe(true);
    expect(challengeMatches(cdj, `0x${'00'.repeat(32)}`)).toBe(false);
  });

  it('works when the browser orders fields differently', () => {
    const other = `{"challenge":"${challenge}","origin":"x","type":"webauthn.get"}`;
    const { challengeIndex, typeIndex } = clientDataIndices(other);
    expect(challengeIndex).toBe(1);
    expect(other.slice(typeIndex)).toMatch(/^"type":"webauthn\.get"/);
  });

  it('buildAuth assembles a JSON-safe WebAuthnAuth', () => {
    const der = sign('sha256', Buffer.from('x'), { key: privateKey, dsaEncoding: 'der' });
    const auth = buildAuth({
      signature: der,
      authenticatorData: new Uint8Array(37).fill(1),
      clientDataJSON: new TextEncoder().encode(cdj),
    });
    expect(auth.typeIndex).toBe('1');
    expect(auth.clientDataJSON).toBe(cdj);
    expect(auth.authenticatorData).toBe(`0x${'01'.repeat(37)}`);
    expect(BigInt(auth.s) <= P256_HALF_N).toBe(true);
  });
});

describe('SPKI public key', () => {
  it('extracts x and y from an ES256 SPKI key', () => {
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const jwk = publicKey.export({ format: 'jwk' });
    const { qx, qy } = spkiToXY(spki);
    expect(Buffer.from(hexToBytes(qx)).toString('base64url')).toBe(jwk.x);
    expect(Buffer.from(hexToBytes(qy)).toString('base64url')).toBe(jwk.y);
  });
});

describe('verifyAssertion (phone self-check)', () => {
  async function fixture() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const qx = bytesToHex(raw.slice(1, 33));
    const qy = bytesToHex(raw.slice(33));
    const authData = new Uint8Array(37);
    authData[32] = 0x1d; // UP, UV, BE, BS: what an iCloud passkey sends
    const clientDataJSON = '{"type":"webauthn.get","challenge":"abc","origin":"https://example.org"}';
    const ch = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientDataJSON)));
    const msg = new Uint8Array(69);
    msg.set(authData);
    msg.set(ch, 37);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, msg));
    const auth = {
      r: bytesToHex(sig.slice(0, 32)),
      s: bytesToHex(sig.slice(32)),
      authenticatorData: bytesToHex(authData),
      clientDataJSON,
    };
    return { auth, qx, qy };
  }

  it('accepts a signature from the stored key', async () => {
    const { auth, qx, qy } = await fixture();
    expect(await verifyAssertion(auth, qx, qy)).toBe(true);
  });

  it('rejects a signature from a different key', async () => {
    const a = await fixture();
    const b = await fixture();
    expect(await verifyAssertion(a.auth, b.qx, b.qy)).toBe(false);
  });

  it('flags a missing user-verification bit', () => {
    expect(flagProblem(`0x${'00'.repeat(32)}01${'00'.repeat(4)}`)).toMatch(/Face ID/);
    expect(flagProblem(`0x${'00'.repeat(32)}1d${'00'.repeat(4)}`)).toBeUndefined();
  });
});
