/**
 * 01 (Nord / zo) error translation. Engine rejections surface as Nord `Error`
 * enum names — see `packages/perps/clients/zo-schema.proto` `enum Error`.
 * The @n1xyz/nord-ts SDK wraps them as `"Failed to <action>: <ENUM>"`, our
 * provider wraps them as `"01 <Action> rejected: \"<ENUM>\""`; both include
 * the unique enum name verbatim, so a substring match is unambiguous.
 */

/**
 * Nord engine error enum names we translate. Constrained so a typo in a key
 * (or a mismatch against `SESSION_REJECTION_ENUMS`) fails at compile time.
 * Add entries here as new codes become user-visible.
 */
type ZoEngineError =
  | 'BALANCE_INSUFFICIENT'
  | 'USER_NOT_FOUND'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_INVALID_OWNER'
  | 'SESSION_NOT_FOUND'
  | 'INVALID_SIGNATURE'
  | 'EXPIRY_TIMESTAMP_IN_PAST'
  | 'MARKET_NOT_FOUND'
  | 'TOKEN_NOT_FOUND'
  | 'TOKEN_NOT_READY'
  | 'ORDER_SIZE_ZERO'
  | 'MINIMUM_SIZE_DECIMALS'
  | 'WITHDRAW_AMOUNT_TOO_SMALL'
  | 'DUST_ACCOUNT'
  | 'MAINTENANCE'
  | 'TOO_MANY_OPEN_ORDERS'
  | 'TIMESTAMP_OUT_OF_THRESHOLD'
  | 'TIMESTAMP_STALE'
  | 'INDEX_PRICE_OUT_OF_RANGE'
  | 'IMMEDIATE_ORDER_GOT_NO_FILLS'
  | 'FAILED_TO_FILL_LIMIT'
  | 'TRIGGER_INVALID_PRICE'
  | 'TRIGGER_NOT_FOUND'
  | 'TRIGGER_ALREADY_EXISTS'
  | 'BANKRUPTCY_INSUFFICIENT_COVERAGE'

const ENUM_MESSAGES: Record<ZoEngineError, string> = {
  BALANCE_INSUFFICIENT: 'Insufficient balance on 01 for this action.',
  USER_NOT_FOUND: 'No 01 account found. Please deposit first to create your 01 account.',
  ACCOUNT_NOT_FOUND: 'No 01 account found. Please deposit first to create your 01 account.',
  ACCOUNT_INVALID_OWNER: 'This 01 account is not owned by the signed-in wallet.',
  SESSION_NOT_FOUND: 'Your 01 session expired. Please retry — a fresh session will be created automatically.',
  INVALID_SIGNATURE: 'Signature rejected by 01. Please retry.',
  EXPIRY_TIMESTAMP_IN_PAST: 'Your 01 session expired. Please retry.',
  MARKET_NOT_FOUND: 'Requested market is not listed on 01.',
  TOKEN_NOT_FOUND: 'Requested token is not listed on 01.',
  TOKEN_NOT_READY: 'Market is not ready on 01 yet. Try again shortly.',
  ORDER_SIZE_ZERO: 'Order size too small for this market.',
  MINIMUM_SIZE_DECIMALS: 'Order size is below the market minimum.',
  WITHDRAW_AMOUNT_TOO_SMALL: 'Withdrawal amount is below the minimum allowed by 01.',
  DUST_ACCOUNT: 'Remaining balance would fall below 01\'s minimum — try a smaller amount.',
  MAINTENANCE: '01 is in maintenance. Please try again in a few minutes.',
  TOO_MANY_OPEN_ORDERS: 'Too many open orders on 01. Cancel some before placing new ones.',
  TIMESTAMP_OUT_OF_THRESHOLD: 'Clock drift between client and 01. Please retry.',
  TIMESTAMP_STALE: 'Clock drift between client and 01. Please retry.',
  INDEX_PRICE_OUT_OF_RANGE: 'Market price moved past the allowed range — widen slippage or retry.',
  IMMEDIATE_ORDER_GOT_NO_FILLS: 'Order did not fill at the current market price — widen slippage or retry.',
  FAILED_TO_FILL_LIMIT: 'Order could not fill at the requested price — widen slippage or retry.',
  TRIGGER_INVALID_PRICE: 'Trigger price is invalid for the current market.',
  TRIGGER_NOT_FOUND: 'No matching trigger was found on 01.',
  TRIGGER_ALREADY_EXISTS: 'A trigger at this price already exists on 01.',
  BANKRUPTCY_INSUFFICIENT_COVERAGE: 'Account under-collateralized on 01; cannot proceed.',
}

const SESSION_REJECTION_ENUMS: readonly ZoEngineError[] = [
  'SESSION_NOT_FOUND',
  'INVALID_SIGNATURE',
  'EXPIRY_TIMESTAMP_IN_PAST',
  'ACCOUNT_INVALID_OWNER',
]

const RAW_SUBSTRING_MESSAGES: Array<{ hint: string; message: string }> = [
  { hint: 'insufficient funds', message: 'Wallet does not have enough funds for this transaction.' },
  { hint: 'insufficient lamports', message: 'Wallet does not have enough SOL to cover transaction fees.' },
  { hint: '0x1', message: 'SPL token balance is insufficient for this transaction.' },
  { hint: 'signature verification failed', message: 'Signature rejected. Please retry.' },
  { hint: 'blockhash not found', message: 'Solana RPC timed out. Please retry.' },
]

/** HTTP status overrides for failure modes that are clearly not 400 (client error). */
const ENUM_STATUS: Partial<Record<ZoEngineError, number>> = {
  MAINTENANCE: 503,
  TIMESTAMP_OUT_OF_THRESHOLD: 500,
  TIMESTAMP_STALE: 500,
  SESSION_NOT_FOUND: 401,
  INVALID_SIGNATURE: 401,
  EXPIRY_TIMESTAMP_IN_PAST: 401,
}

function errorToString(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}

function matchEngineError(raw: string): ZoEngineError | null {
  for (const name in ENUM_MESSAGES) {
    // Nord enum names are unique uppercase identifiers — substring match is unambiguous.
    if (raw.includes(name)) return name as ZoEngineError
  }
  return null
}

/** True iff the error indicates Nord rejected the session itself (vs. an operational failure). */
export function isZoSessionError(err: unknown): boolean {
  const raw = errorToString(err)
  if (/\b401\b/.test(raw) || /unauthori[sz]ed/i.test(raw)) return true
  const match = matchEngineError(raw)
  return match !== null && SESSION_REJECTION_ENUMS.includes(match)
}

function matchRawSubstring(raw: string): string | null {
  const lower = raw.toLowerCase()
  for (const { hint, message } of RAW_SUBSTRING_MESSAGES) {
    if (lower.includes(hint)) return message
  }
  return null
}

export interface ZoErrorResponse {
  body: { status: 'error'; message: string; error: string }
  status: number
}

/**
 * Translate an error thrown by the 01 deposit/withdraw/trade flows into an
 * API response body + HTTP status. Unknown errors default to 500.
 */
export function formatZoErrorResponse(err: unknown, fallback: string): ZoErrorResponse {
  const raw = errorToString(err)
  const match = matchEngineError(raw)
  const friendly = match ? ENUM_MESSAGES[match] : matchRawSubstring(raw)
  const status = match ? (ENUM_STATUS[match] ?? 400) : 500
  return {
    body: {
      status: 'error',
      message: friendly ?? fallback,
      error: raw,
    },
    status,
  }
}
