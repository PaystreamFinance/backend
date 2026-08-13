/**
 * Lighter FFI Worker — runs in a child process to isolate Go's runtime
 * from Bun's event loop. Communicates via newline-delimited JSON on stdin/stdout.
 *
 * Protocol:
 *   Request:  { "id": number, "fn": string, "args": any[] }
 *   Response: { "id": number, "result"?: any, "error"?: string }
 */
import { dlopen, FFIType, ptr, CString } from 'bun:ffi'
import { resolve } from 'path'

const I = FFIType.i64
const P = FFIType.pointer

function getWrapperPath(): string {
  const platform = process.platform
  const arch = process.arch
  const ffiDir = resolve(import.meta.dir, 'ffi')

  if (platform === 'darwin' && arch === 'arm64') {
    return resolve(ffiDir, 'lighter-wrapper.dylib')
  }
  if (platform === 'linux' && arch === 'x64') {
    return resolve(ffiDir, 'lighter-wrapper-linux-amd64.so')
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`)
}

const { symbols: lib } = dlopen(getWrapperPath(), {
  WrapGenerateAPIKey: { args: [P], returns: FFIType.void },
  WrapCreateClient: { args: [P, P, I, I, I], returns: P },
  WrapCheckClient: { args: [I, I], returns: P },
  WrapSignChangePubKey: { args: [P, P, I, I, I], returns: FFIType.void },
  WrapSetCreateOrderParams: {
    args: [I, I, I, I, I, I, I],
    returns: FFIType.void,
  },
  WrapExecCreateOrder: {
    args: [P, I, I, I, I, I, I],
    returns: FFIType.void,
  },
  WrapSignCancelOrder: { args: [P, I, I, I, I, I], returns: FFIType.void },
  WrapSignUpdateLeverage: { args: [P, I, I, I, I, I, I], returns: FFIType.void },
  WrapCreateAuthToken: { args: [P, I, I, I], returns: FFIType.void },
  WrapSignWithdraw: { args: [P, I, I, I, I, I, I], returns: FFIType.void },
  WrapSetTransferParams: { args: [I, I, I, I, I, I], returns: FFIType.void },
  WrapExecTransfer: { args: [P, P, I, I, I], returns: FFIType.void },
})

// --- helpers ---

function toCString(s: string): Buffer {
  return Buffer.from(s + '\0', 'utf-8')
}

function readCString(pointer: number | bigint): string | null {
  if (!pointer || pointer === 0 || pointer === 0n) return null
  return String(new CString(Number(pointer) as any))
}

function readPointerAt(buf: Buffer, byteOffset: number): bigint {
  return buf.readBigUInt64LE(byteOffset)
}

// --- FFI implementations ---

function generateAPIKey() {
  const resultBuf = Buffer.alloc(24)
  lib.WrapGenerateAPIKey(ptr(resultBuf))
  const privateKeyPtr = readPointerAt(resultBuf, 0)
  const publicKeyPtr = readPointerAt(resultBuf, 8)
  const errPtr = readPointerAt(resultBuf, 16)
  const err = readCString(errPtr)
  if (err) throw new Error(`GenerateAPIKey failed: ${err}`)
  const privateKey = readCString(privateKeyPtr)
  const publicKey = readCString(publicKeyPtr)
  if (!privateKey || !publicKey) throw new Error('GenerateAPIKey returned null keys')
  return { privateKey, publicKey }
}

function createClient(url: string, privateKey: string, chainId: number, apiKeyIndex: number, accountIndex: number) {
  const cUrl = toCString(url)
  const cKey = toCString(privateKey)
  const errPtr = lib.WrapCreateClient(ptr(cUrl), ptr(cKey), BigInt(chainId), BigInt(apiKeyIndex), BigInt(accountIndex))
  const err = readCString(errPtr as unknown as bigint)
  if (err) throw new Error(`CreateClient failed: ${err}`)
  return null
}

function checkClient(apiKeyIndex: number, accountIndex: number) {
  const errPtr = lib.WrapCheckClient(BigInt(apiKeyIndex), BigInt(accountIndex))
  const err = readCString(errPtr as unknown as bigint)
  if (err) throw new Error(`CheckClient failed: ${err}`)
  return null
}

function parseSignedTxResponse(buf: Buffer) {
  const txType = buf.readUInt8(0)
  const txInfoPtr = readPointerAt(buf, 8)
  const txHashPtr = readPointerAt(buf, 16)
  const messageToSignPtr = readPointerAt(buf, 24)
  const errPtr = readPointerAt(buf, 32)
  const err = readCString(errPtr)
  if (err) throw new Error(err)
  return {
    txType,
    txInfo: readCString(txInfoPtr) ?? '',
    txHash: readCString(txHashPtr) ?? '',
    messageToSign: readCString(messageToSignPtr),
  }
}

function signChangePubKey(pubKeyHex: string, nonce: number, apiKeyIndex: number, accountIndex: number) {
  const resultBuf = Buffer.alloc(40)
  const cPubKey = toCString(pubKeyHex)
  lib.WrapSignChangePubKey(ptr(resultBuf), ptr(cPubKey), BigInt(nonce), BigInt(apiKeyIndex), BigInt(accountIndex))
  return parseSignedTxResponse(resultBuf)
}

function signCreateOrder(p: any) {
  const resultBuf = Buffer.alloc(40)
  // Use SignCreateGroupedOrders (6 args) instead of SignCreateOrder (13 args).
  // On x86_64 Linux, the C-to-Go call with 13+ args corrupts stack values
  // because 8 args must go on the stack. SignCreateGroupedOrders has only
  // 6 args — same pattern as SignUpdateLeverage which works perfectly.
  lib.WrapSetCreateOrderParams(
    BigInt(p.marketIndex), BigInt(p.clientOrderIndex), BigInt(p.baseAmount),
    BigInt(p.price), BigInt(p.isAsk ? 1 : 0), BigInt(p.orderType), BigInt(p.timeInForce),
  )
  lib.WrapExecCreateOrder(
    ptr(resultBuf),
    BigInt(p.reduceOnly ? 1 : 0), BigInt(p.triggerPrice), BigInt(p.orderExpiry),
    BigInt(p.nonce), BigInt(p.apiKeyIndex), BigInt(p.accountIndex),
  )
  return parseSignedTxResponse(resultBuf)
}

function signCancelOrder(marketIndex: number, orderIndex: number, nonce: number, apiKeyIndex: number, accountIndex: number) {
  const resultBuf = Buffer.alloc(40)
  lib.WrapSignCancelOrder(ptr(resultBuf), BigInt(marketIndex), BigInt(orderIndex), BigInt(nonce), BigInt(apiKeyIndex), BigInt(accountIndex))
  return parseSignedTxResponse(resultBuf)
}

function signUpdateLeverage(marketIndex: number, initialMarginFraction: number, marginMode: number, nonce: number, apiKeyIndex: number, accountIndex: number) {
  const resultBuf = Buffer.alloc(40)
  lib.WrapSignUpdateLeverage(ptr(resultBuf), BigInt(marketIndex), BigInt(initialMarginFraction), BigInt(marginMode), BigInt(nonce), BigInt(apiKeyIndex), BigInt(accountIndex))
  return parseSignedTxResponse(resultBuf)
}

function createAuthToken(deadline: number, apiKeyIndex: number, accountIndex: number) {
  const resultBuf = Buffer.alloc(16)
  lib.WrapCreateAuthToken(ptr(resultBuf), BigInt(deadline), BigInt(apiKeyIndex), BigInt(accountIndex))
  const strPtr = readPointerAt(resultBuf, 0)
  const errPtr = readPointerAt(resultBuf, 8)
  const err = readCString(errPtr)
  if (err) throw new Error(`CreateAuthToken failed: ${err}`)
  const token = readCString(strPtr)
  if (!token) throw new Error('CreateAuthToken returned null')
  return token
}

function signWithdraw(assetIndex: number, routeType: number, amount: number, nonce: number, apiKeyIndex: number, accountIndex: number) {
  const resultBuf = Buffer.alloc(40)
  lib.WrapSignWithdraw(ptr(resultBuf), BigInt(assetIndex), BigInt(routeType), BigInt(amount), BigInt(nonce), BigInt(apiKeyIndex), BigInt(accountIndex))
  return parseSignedTxResponse(resultBuf)
}

function signTransfer(toAccountIndex: number, assetIndex: number, fromRouteType: number, toRouteType: number, amount: number, usdcFee: number, memo: string, nonce: number, apiKeyIndex: number, accountIndex: number) {
  const resultBuf = Buffer.alloc(40)
  const cMemo = toCString(memo)
  lib.WrapSetTransferParams(BigInt(toAccountIndex), BigInt(assetIndex), BigInt(fromRouteType), BigInt(toRouteType), BigInt(amount), BigInt(usdcFee))
  lib.WrapExecTransfer(ptr(resultBuf), ptr(cMemo), BigInt(nonce), BigInt(apiKeyIndex), BigInt(accountIndex))
  return parseSignedTxResponse(resultBuf)
}

// --- dispatch ---

const handlers: Record<string, (...args: any[]) => any> = {
  generateAPIKey,
  createClient: (args: any[]) => createClient(args[0], args[1], args[2], args[3], args[4]),
  checkClient: (args: any[]) => checkClient(args[0], args[1]),
  signChangePubKey: (args: any[]) => signChangePubKey(args[0], args[1], args[2], args[3]),
  signCreateOrder: (args: any[]) => signCreateOrder(args[0]),
  signCancelOrder: (args: any[]) => signCancelOrder(args[0], args[1], args[2], args[3], args[4]),
  signUpdateLeverage: (args: any[]) => signUpdateLeverage(args[0], args[1], args[2], args[3], args[4], args[5]),
  createAuthToken: (args: any[]) => createAuthToken(args[0], args[1], args[2]),
  signWithdraw: (args: any[]) => signWithdraw(args[0], args[1], args[2], args[3], args[4], args[5]),
  signTransfer: (args: any[]) => signTransfer(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8], args[9]),
}

function respond(id: number, result?: any, error?: string) {
  const msg = JSON.stringify({ id, result, error }) + '\n'
  process.stdout.write(msg)
}

// Signal parent we're ready
respond(0, 'ready')

// Read JSON lines from stdin
const decoder = new TextDecoder()
let buffer = ''

process.stdin.on('data', (chunk: Buffer) => {
  buffer += decoder.decode(chunk, { stream: true })
  let newlineIdx: number
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim()
    buffer = buffer.slice(newlineIdx + 1)
    if (!line) continue

    try {
      const req = JSON.parse(line)
      const { id, fn, args } = req
      const handler = handlers[fn]
      if (!handler) {
        respond(id, undefined, `Unknown function: ${fn}`)
        continue
      }
      try {
        const result = fn === 'generateAPIKey' ? handler() : handler(args)
        respond(id, result)
      } catch (e: any) {
        respond(id, undefined, e.message || String(e))
      }
    } catch (e: any) {
      // Parse error — can't respond without id
      process.stderr.write(`[lighter-ffi-worker] Parse error: ${e.message}\n`)
    }
  }
})
