const SOLANA_NETWORK = (
  process.env.SOLANA_NETWORK || 'MAINNET'
).toUpperCase()

const DEFAULT_MAINNET_RPC_URL = process.env.SOLANA_MAINNET_RPC_URL ||
  'https://api.mainnet-beta.solana.com'
const DEFAULT_DEVNET_RPC_URL = 'https://api.devnet.solana.com'

export const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ||
  (SOLANA_NETWORK === 'DEVNET'
    ? process.env.SOLANA_DEVNET_RPC_URL || DEFAULT_DEVNET_RPC_URL
    : process.env.SOLANA_MAINNET_RPC_URL || DEFAULT_MAINNET_RPC_URL)
