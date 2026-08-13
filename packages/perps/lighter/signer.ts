import { resolve } from 'path'
import { log } from '../logger'

// ---------- public types ----------

export interface LighterApiKey {
  privateKey: string
  publicKey: string
}

export interface LighterSignedTx {
  txType: number
  txInfo: string
  txHash: string
  messageToSign: string | null
}

export interface LighterCredentials {
  apiPrivateKey: string
  apiPublicKey: string
  apiKeyIndex: number
  accountIndex: number
}

// ---------- subprocess-based FFI ----------
// The Go signer .so installs signal handlers that kill Bun's event loop on Linux.
// Running it in a child process completely isolates the two runtimes.

let workerProc: ReturnType<typeof Bun.spawn> | null = null
let requestId = 0
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
let responseBuffer = ''
let workerReady: Promise<void> | null = null

function ensureWorker(): Promise<void> {
  if (workerReady) return workerReady

  workerReady = new Promise<void>((resolveReady, rejectReady) => {
    const workerPath = resolve(import.meta.dir, 'ffi-worker.ts')
    log.info(`[lighter-signer] Spawning FFI worker: ${workerPath}`)

    workerProc = Bun.spawn(['bun', 'run', workerPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    })

    const reader = (workerProc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let readyResolved = false

    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          responseBuffer += decoder.decode(value, { stream: true })
          let newlineIdx: number
          while ((newlineIdx = responseBuffer.indexOf('\n')) !== -1) {
            const line = responseBuffer.slice(0, newlineIdx).trim()
            responseBuffer = responseBuffer.slice(newlineIdx + 1)
            if (!line) continue

            try {
              const msg = JSON.parse(line)

              // id=0 is the ready signal
              if (msg.id === 0 && !readyResolved) {
                readyResolved = true
                log.info('[lighter-signer] FFI worker ready')
                resolveReady()
                continue
              }

              const pending = pendingRequests.get(msg.id)
              if (pending) {
                pendingRequests.delete(msg.id)
                if (msg.error) {
                  pending.reject(new Error(msg.error))
                } else {
                  pending.resolve(msg.result)
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      } catch (e) {
        // Worker died
        log.error('[lighter-signer] FFI worker stdout read error:', e)
      }

      // Worker exited — reject all pending requests
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error('FFI worker exited'))
        pendingRequests.delete(id)
      }
      workerProc = null
      workerReady = null
      if (!readyResolved) {
        rejectReady(new Error('FFI worker exited before ready'))
      }
    }

    readLoop()
  })

  return workerReady
}

async function call(fn: string, args?: any[]): Promise<any> {
  await ensureWorker()
  if (!workerProc) throw new Error('FFI worker not running')

  const id = ++requestId
  const msg = JSON.stringify({ id, fn, args: args ?? [] }) + '\n'

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject })
    ;(workerProc!.stdin as import('bun').FileSink).write(msg)
  })
}

// ---------- public API ----------

export async function generateAPIKey(): Promise<LighterApiKey> {
  return await call('generateAPIKey')
}

export async function createClient(
  url: string,
  privateKey: string,
  chainId: number,
  apiKeyIndex: number,
  accountIndex: number,
): Promise<void> {
  await call('createClient', [url, privateKey, chainId, apiKeyIndex, accountIndex])
}

export async function checkClient(
  apiKeyIndex: number,
  accountIndex: number,
): Promise<void> {
  await call('checkClient', [apiKeyIndex, accountIndex])
}

export async function signChangePubKey(
  pubKeyHex: string,
  nonce: number,
  apiKeyIndex: number,
  accountIndex: number,
): Promise<LighterSignedTx> {
  return await call('signChangePubKey', [pubKeyHex, nonce, apiKeyIndex, accountIndex])
}

export async function signCreateOrder(params: {
  marketIndex: number
  clientOrderIndex: number
  baseAmount: number
  price: number
  isAsk: boolean
  orderType: number
  timeInForce: number
  reduceOnly: boolean
  triggerPrice: number
  orderExpiry: number
  nonce: number
  apiKeyIndex: number
  accountIndex: number
}): Promise<LighterSignedTx> {
  return await call('signCreateOrder', [params])
}

export async function signCancelOrder(
  marketIndex: number,
  orderIndex: number,
  nonce: number,
  apiKeyIndex: number,
  accountIndex: number,
): Promise<LighterSignedTx> {
  return await call('signCancelOrder', [marketIndex, orderIndex, nonce, apiKeyIndex, accountIndex])
}

export async function signUpdateLeverage(
  marketIndex: number,
  initialMarginFraction: number,
  marginMode: number,
  nonce: number,
  apiKeyIndex: number,
  accountIndex: number,
): Promise<LighterSignedTx> {
  return await call('signUpdateLeverage', [marketIndex, initialMarginFraction, marginMode, nonce, apiKeyIndex, accountIndex])
}

export async function signTransfer(
  toAccountIndex: number,
  assetIndex: number,
  fromRouteType: number,
  toRouteType: number,
  amount: number,
  usdcFee: number,
  memo: string,
  nonce: number,
  apiKeyIndex: number,
  accountIndex: number,
): Promise<LighterSignedTx> {
  return await call('signTransfer', [toAccountIndex, assetIndex, fromRouteType, toRouteType, amount, usdcFee, memo, nonce, apiKeyIndex, accountIndex])
}

export async function signWithdraw(
  assetIndex: number,
  routeType: number,
  amount: number,
  nonce: number,
  apiKeyIndex: number,
  accountIndex: number,
): Promise<LighterSignedTx> {
  return await call('signWithdraw', [assetIndex, routeType, amount, nonce, apiKeyIndex, accountIndex])
}

export async function createAuthToken(
  deadline: number,
  apiKeyIndex: number,
  accountIndex: number,
): Promise<string> {
  return await call('createAuthToken', [deadline, apiKeyIndex, accountIndex])
}
