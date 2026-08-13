import protobuf from 'protobufjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as nacl from 'tweetnacl'

const __filename = fileURLToPath(import.meta.url)
const SCHEMA_PATH = join(dirname(__filename), 'zo-schema.proto')

export interface ZoProtoTypes {
  root: protobuf.Root
  Action: protobuf.Type
  Receipt: protobuf.Type
  Side: protobuf.Enum
  FillMode: protobuf.Enum
}

let cached: Promise<ZoProtoTypes> | null = null

/**
 * Load and cache the 01 (Nord) protobuf schema. Call once; subsequent calls
 * return the same root. Loads synchronously-ish via protobuf.load at first use.
 */
export function loadZoSchema(): Promise<ZoProtoTypes> {
  if (!cached) {
    cached = protobuf.load(SCHEMA_PATH).then(root => ({
      root,
      Action: root.lookupType('Action'),
      Receipt: root.lookupType('Receipt'),
      Side: root.lookupEnum('Side'),
      FillMode: root.lookupEnum('FillMode'),
    }))
  }
  return cached
}

/** Ed25519 keypair container for session keys (raw bytes). */
export interface ZoKeypair {
  publicKey: Uint8Array   // 32 bytes
  secretKey: Uint8Array   // 64 bytes (nacl format — seed+pub concatenated)
}

/** Generate a fresh Ed25519 keypair for use as a 01 session key. */
export function generateZoSessionKeypair(): ZoKeypair {
  const kp = nacl.sign.keyPair()
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

/** Reconstruct a keypair from the 64-byte nacl secretKey. */
export function keypairFromSecret(secretKey: Uint8Array): ZoKeypair {
  const kp = nacl.sign.keyPair.fromSecretKey(secretKey)
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

/**
 * Recursively convert BigInt values in the input object to decimal strings.
 * protobufjs does not accept BigInt directly for int64 fields; normalize to
 * decimal strings so encoding is consistent across supported releases.
 */
function normalizeBigInts<T>(value: T): T {
  if (typeof value === 'bigint') return (value.toString() as unknown) as T
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return value.map(normalizeBigInts) as unknown as T
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(value as Record<string, any>)) {
    out[k] = normalizeBigInts(v)
  }
  return out as T
}

/**
 * Encode an `Action` message as length-delimited protobuf bytes.
 * This is the `raw = varint_len | payload` that all signature schemes sign over.
 */
export function encodeAction(types: ZoProtoTypes, actionObj: Record<string, any>): Uint8Array {
  const msg = types.Action.create(normalizeBigInts(actionObj))
  return types.Action.encodeDelimited(msg).finish()
}

/** Decode a binary Receipt (length-delimited) returned by POST /action. */
export function decodeReceipt(types: ZoProtoTypes, bytes: Uint8Array): any {
  const msg = types.Receipt.decodeDelimited(bytes)
  return types.Receipt.toObject(msg, { longs: String, enums: String, bytes: Array })
}

/**
 * Append a 64-byte Ed25519 signature to the length-delimited `raw` bytes.
 * Result is the final body to POST to /action.
 */
export function packEnvelope(raw: Uint8Array, sig64: Uint8Array): Uint8Array {
  if (sig64.length !== 64) throw new Error(`Expected 64-byte signature, got ${sig64.length}`)
  const out = new Uint8Array(raw.length + 64)
  out.set(raw, 0)
  out.set(sig64, raw.length)
  return out
}

/**
 * Hex-encode bytes as lowercase ASCII string (no `0x` prefix) — matches the
 * Nord SDK's `Uint8Array.prototype.toHex()` usage.
 */
export function hexEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/**
 * `session_sign(x) = ed25519_sign(x)` — session key signs the raw bytes
 * directly. Returns 64-byte signature.
 */
export function sessionSign(raw: Uint8Array, sessionSecretKey: Uint8Array): Uint8Array {
  return nacl.sign.detached(raw, sessionSecretKey)
}

/**
 * Scale a decimal value into a raw uint64 by the given number of decimals.
 * e.g. (74500.5, priceDecimals=1) → 745005n. Rounds toward zero.
 *
 * 01 uses raw integer `price` / `size` on PlaceOrder, scaled by the
 * `priceDecimals` / `sizeDecimals` from /info for that market.
 */
export function toScaledU64(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`toScaledU64: invalid value ${value}`)
  }
  const scaled = Math.trunc(value * Math.pow(10, decimals))
  return BigInt(scaled)
}
