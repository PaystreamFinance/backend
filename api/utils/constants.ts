import { Keypair } from '@solana/web3.js'

export const API_ENDPOINTS = {
  JUP_SWAP_ORDER_URL: 'https://api.jup.ag/swap/v2/order',
  JUP_SWAP_EXECUTE_URL: 'https://api.jup.ag/swap/v2/execute',
  JITO_TIP_FLOOR_URL: 'https://bundles.jito.wtf/api/v1/bundles/tip_floor',
}

export const SOL_WRAPPED_MINT = 'So11111111111111111111111111111111111111112'

// USDC Mint Address and Decimals (Solana Mainnet)
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const USDC_DECIMALS = 6

// USDT Mint Address and Decimals (Solana Mainnet)
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
export const USDT_DECIMALS = 6

export const LAMPORTS_PER_SOL = 1_000_000_000

export const SOLANA_NETWORK = (
  Bun.env.SOLANA_NETWORK || 'MAINNET'
).toUpperCase()

const DEFAULT_MAINNET_RPC_URL = Bun.env.SOLANA_MAINNET_RPC_URL ||
  'https://api.mainnet-beta.solana.com'
const DEFAULT_DEVNET_RPC_URL = 'https://api.devnet.solana.com'

export const SOLANA_RPC_URL =
  Bun.env.SOLANA_RPC_URL ||
  (SOLANA_NETWORK === 'DEVNET'
    ? Bun.env.SOLANA_DEVNET_RPC_URL || DEFAULT_DEVNET_RPC_URL
    : Bun.env.SOLANA_MAINNET_RPC_URL || DEFAULT_MAINNET_RPC_URL)

const isDevnet = SOLANA_NETWORK === 'DEVNET'

// CAIP2 chain identifiers for Solana networks
// Mainnet: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
// Devnet: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
export const SOLANA_CAIP2 = isDevnet
  ? 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
  : 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

export const DUMMY_KEYPAIR = Keypair.generate()

// Jupiter API Configuration
export const JUPITER_API_KEY = Bun.env.JUPITER_API_KEY || ''

// Helius Sender Configuration
export const HELIUS_SENDER_ENDPOINT = Bun.env.HELIUS_SENDER_ENDPOINT || 'http://ewr-sender.helius-rpc.com/fast'

// Helius API Configuration
export const HELIUS_API_KEY = Bun.env.HELIUS_API_KEY || ''
export const HELIUS_RPC_URL = SOLANA_NETWORK === 'DEVNET'
  ? 'https://devnet.helius-rpc.com'
  : 'https://mainnet.helius-rpc.com'

// Jito Tip Accounts (for Jupiter swaps)
export const JITO_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
]

// Bundle Simulation Configuration
export const LOG_SIMULATION = Bun.env.LOG_SIMULATION === 'true' || false

// Jito Block Engine Endpoints
// Mainnet endpoints - Singapore is default
export const JITO_MAINNET_ENDPOINTS = [
  'singapore.mainnet.block-engine.jito.wtf', // Default
  'mainnet.block-engine.jito.wtf',
  'amsterdam.mainnet.block-engine.jito.wtf',
  'dublin.mainnet.block-engine.jito.wtf',
  'frankfurt.mainnet.block-engine.jito.wtf',
  'london.mainnet.block-engine.jito.wtf',
  'ny.mainnet.block-engine.jito.wtf',
  'slc.mainnet.block-engine.jito.wtf',
  'tokyo.mainnet.block-engine.jito.wtf',
]

// Testnet endpoints
export const JITO_TESTNET_ENDPOINTS = [
  'testnet.block-engine.jito.wtf',
  'dallas.testnet.block-engine.jito.wtf',
  'ny.testnet.block-engine.jito.wtf',
]

// Get endpoints based on network
export const JITO_ENDPOINTS = SOLANA_NETWORK === 'DEVNET'
  ? JITO_TESTNET_ENDPOINTS
  : JITO_MAINNET_ENDPOINTS

// Jito Auth Keypair for authenticated bundle submission
export const JITO_AUTH_KEYPAIR = (() => {
  const keypairJson = Bun.env.JITO_AUTH_KEYPAIR
  if (!keypairJson) return null
  try {
    const secretKey = new Uint8Array(JSON.parse(keypairJson))
    return Keypair.fromSecretKey(secretKey)
  } catch {
    return null
  }
})()
