import { Connection } from '@solana/web3.js'
import { SOLANA_RPC_URL } from '../utils/constants'

export const connection = new Connection(SOLANA_RPC_URL, 'confirmed')
