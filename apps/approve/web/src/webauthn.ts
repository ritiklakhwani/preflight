// Pure WebAuthn helpers: no DOM access, so they run under vitest in Node too.
// The vault verifies with OpenZeppelin WebAuthn/P256, which rejects high-s
// signatures, so every signature is normalised before it leaves the phone.

export type Hex = `0x${string}`;

/** secp256r1 group order. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const P256_HALF_N = P256_N / 2n;

/** WebAuthnAuth as JSON (bigints as decimal strings) for the HTTP API. */
export interface WebAuthnAuthJson {
  r: Hex;
  s: Hex;
  challengeIndex: string;
  typeIndex: string;
  authenticatorData: Hex;
  clientDataJSON: string;
}

export function bytesToHex(b: Uint8Array): Hex {
  let out = '0x';
  for (const x of b) out += x.toString(16).padStart(2, '0');
  return out as Hex;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error('bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bigintTo32(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, '0')}` as Hex;
}

export function base64urlEncode(b: Uint8Array): string {
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readInt(der: Uint8Array, at: number): { value: bigint; next: number } {
  if (der[at] !== 0x02) throw new Error('DER: expected INTEGER');
  const len = der[at + 1];
  if (len === undefined || len === 0 || len > 33) throw new Error('DER: bad INTEGER length');
  const start = at + 2;
  const end = start + len;
  if (end > der.length) throw new Error('DER: truncated');
  let v = 0n;
  for (let i = start; i < end; i++) v = (v << 8n) | BigInt(der[i]!);
  return { value: v, next: end };
}

/** Parses an ASN.1 DER ECDSA signature (SEQUENCE { r INTEGER, s INTEGER }). */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw new Error('DER: expected SEQUENCE');
  const seqLen = der[1];
  if (seqLen === undefined || seqLen + 2 !== der.length) throw new Error('DER: bad SEQUENCE length');
  const r = readInt(der, 2);
  const s = readInt(der, r.next);
  if (s.next !== der.length) throw new Error('DER: trailing bytes');
  return { r: r.value, s: s.value };
}

/** (r, n - s) is the same signature; the vault only accepts s <= n/2. */
export function normaliseS(s: bigint): bigint {
  return s > P256_HALF_N ? P256_N - s : s;
}

export function derToRS(der: Uint8Array): { r: Hex; s: Hex } {
  const { r, s } = parseDerSignature(der);
  return { r: bigintTo32(r), s: bigintTo32(normaliseS(s)) };
}

/** Byte offsets the contract uses to find the fields inside clientDataJSON. */
export function clientDataIndices(clientDataJSON: string): { challengeIndex: number; typeIndex: number } {
  const challengeIndex = clientDataJSON.indexOf('"challenge":"');
  const typeIndex = clientDataJSON.indexOf('"type":"');
  if (challengeIndex < 0 || typeIndex < 0) throw new Error('clientDataJSON is missing type or challenge');
  return { challengeIndex, typeIndex };
}

/**
 * ES256 public keys from getPublicKey() are SPKI DER; the uncompressed point
 * 0x04 || x || y is always the tail, so the last 64 bytes are x and y.
 */
export function spkiToXY(spki: Uint8Array): { qx: Hex; qy: Hex } {
  if (spki.length < 65 || spki[spki.length - 65] !== 0x04) throw new Error('Not an uncompressed P-256 key');
  const xy = spki.slice(spki.length - 64);
  return { qx: bytesToHex(xy.slice(0, 32)), qy: bytesToHex(xy.slice(32)) };
}

/** Builds the JSON-safe auth from raw assertion parts. */
export function buildAuth(parts: {
  signature: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
}): WebAuthnAuthJson {
  const clientDataJSON = new TextDecoder().decode(parts.clientDataJSON);
  const { r, s } = derToRS(parts.signature);
  const { challengeIndex, typeIndex } = clientDataIndices(clientDataJSON);
  return {
    r,
    s,
    challengeIndex: String(challengeIndex),
    typeIndex: String(typeIndex),
    authenticatorData: bytesToHex(parts.authenticatorData),
    clientDataJSON,
  };
}

/** Checks that the authenticator signed exactly the digest we asked for. */
export function challengeMatches(clientDataJSON: string, digest: Hex): boolean {
  try {
    const parsed = JSON.parse(clientDataJSON) as { challenge?: string };
    return parsed.challenge === base64urlEncode(hexToBytes(digest));
  } catch {
    return false;
  }
}
