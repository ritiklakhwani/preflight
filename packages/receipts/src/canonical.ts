import { keccak256, stringToBytes } from 'viem';
import type { Hex, Receipt } from './types.js';

/**
 * Canonical JSON per docs/CAPLINE_SPEC.md: object keys sorted (UTF-16 code unit
 * order, i.e. plain Array.prototype.sort), no whitespace, array order kept.
 * Undefined object members are dropped like JSON.stringify does, so an absent
 * `meta` and `meta: undefined` hash the same. Bigints and non-finite numbers
 * throw: amounts must already be decimal strings, and a silent coercion here
 * would change what the owner signs.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonicalJson: bigint not allowed, encode amounts as decimal strings');
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(obj).sort()) {
        const v = obj[k];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/** keccak256(utf8(canonicalJson(receipts))). This is what the owner signs in Release. */
export function receiptsHash(receipts: Receipt[]): Hex {
  return keccak256(stringToBytes(canonicalJson(receipts)));
}
