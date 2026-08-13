// Utility functions for error handling
import { log } from './log'

export interface ParsedPrivyError {
  message: string
  error: string
  details?: string
  code?: string
  rawError?: any
}

/**
 * Parses Privy API error responses and extracts meaningful error information
 * to be sent to the frontend
 */
export function parsePrivyError(error: any): ParsedPrivyError {
  // Handle case where error is already a parsed object with error field
  if (error && typeof error === 'object') {
    // First, try to extract the error string from various nested structures
    let errorString: string | undefined
    let errorCode: string | undefined

    // Privy APIError structure: error.error = { error: string, code: string }
    if (error.error && typeof error.error === 'object' && error.error.error) {
      errorString = error.error.error
      errorCode = error.error.code
    }
    // error.error is a string directly
    else if (error.error && typeof error.error === 'string') {
      errorString = error.error
      errorCode = error.code
    }
    // Response body with error field
    else if (error.response?.data?.error) {
      errorString = error.response.data.error
      errorCode = error.response.data.code
    }
    // Error instance with message
    else if (error.message) {
      errorString = error.message
      errorCode = error.code
    }

    if (errorString) {
      const summary = extractErrorSummary(errorString)
      return {
        message: summary,
        error: summary,
        details: summary, // Only show clean summary, not raw error
        code: errorCode || 'transaction_failure',
      }
    }
  }
  
  // Fallback for string errors
  if (typeof error === 'string') {
    const summary = extractErrorSummary(error)
    return {
      message: summary,
      error: summary,
      details: summary,
      code: 'unknown_error',
    }
  }
  
  // Last resort fallback
  return {
    message: 'An unknown error occurred',
    error: 'An unknown error occurred',
    details: 'An unknown error occurred',
    code: 'unknown_error',
  }
}

/**
 * Extracts a user-friendly summary from detailed error messages
 */
function extractErrorSummary(errorString: string): string {
  if (!errorString) return 'Unknown error'
  
  // Strip program logs from error messages (they contain sensitive/verbose info)
  const withoutLogs = errorString.split(' Logs:')[0].split(' logs:')[0]
  
  // Extract the main error type from Privy transaction errors
  if (withoutLogs.includes('insufficient lamports')) {
    const match = withoutLogs.match(/insufficient lamports (\d+), need (\d+)/)
    if (match) {
      const has = parseInt(match[1])
      const needs = parseInt(match[2])
      const shortfall = needs - has
      const shortfallSOL = (shortfall / 1_000_000_000).toFixed(4)
      return `Insufficient SOL (need ${shortfallSOL} more SOL)`
    }
    return 'Insufficient SOL balance'
  }
  
  if (withoutLogs.includes('insufficient funds for rent')) {
    return 'Insufficient funds for rent'
  }
  
  if (withoutLogs.includes('insufficient funds')) {
    return 'Insufficient funds'
  }
  
  if (withoutLogs.includes('blockhash not found')) {
    return 'Transaction expired. Please try again.'
  }
  
  // Handle price range violations
  if (
    withoutLogs.includes('Price range is violated') ||
    withoutLogs.includes('price range is violated') ||
    withoutLogs.includes('Price range would be violated')
  ) {
    return 'Swap would violate pool price range. Try using Jupiter for the swap instead, or reduce the amount.'
  }
  
  // Handle swap quote failures
  if (
    withoutLogs.includes('Swap quote failed') ||
    withoutLogs.includes('quote failed') ||
    withoutLogs.includes('Failed to get quotes') ||
    withoutLogs.includes('Unable to get quotes') ||
    withoutLogs.includes('No valid quotes obtained from any protocol')
  ) {
    return 'Swap quote failed: Unable to get quotes for this token pair'
  }
  
  // Comprehensive slippage error detection
  if (
    withoutLogs.includes('slippage tolerance exceeded') ||
    withoutLogs.includes('slippage exceeded') ||
    withoutLogs.includes('ExceededSlippage') ||
    withoutLogs.includes('exceeded slippage') ||
    withoutLogs.includes('SlippageToleranceExceeded') ||
    withoutLogs.includes('slippage check failed') ||
    withoutLogs.includes('slippage limit exceeded') ||
    withoutLogs.includes('custom program error: 0x1772') ||
    withoutLogs.includes('custom program error: 0x1e') ||
    withoutLogs.includes('Error Code: ExceededSlippage') || 
    withoutLogs.includes('exceeds desired slippage limit') 
  ) {
    return 'Slippage tolerance exceeded. Try increasing slippage or reducing amount.'
  }
  
  // Check for Anchor error messages
  if (withoutLogs.includes('Error Message:')) {
    const match = withoutLogs.match(/Error Message: ([^.]+)\./)
    if (match && match[1]) {
      const errorMsg = match[1]
      if (
        errorMsg.toLowerCase().includes('slippage') ||
        errorMsg.includes('ExceededSlippage')
      ) {
        return 'Slippage tolerance exceeded'
      }
      return errorMsg
    }
  }
  
  // Handle custom program errors with friendly messages
  if (withoutLogs.includes('custom program error')) {
    const match = withoutLogs.match(/custom program error: (0x[0-9a-fA-F]+)/)
    if (match && match[1]) {
      const errorCode = match[1].toLowerCase()
      // Map common error codes to friendly messages
      const errorMessages: Record<string, string> = {
        '0x0': 'Transaction failed',
        '0x1': 'Insufficient funds',
        '0x6': 'Transaction failed. Price may have changed, please try again.',
        '0x28': 'Insufficient funds for this transaction',
        '0x1771': 'Amount too small',
        '0x1772': 'Slippage tolerance exceeded',
        '0x1773': 'Insufficient collateral. Cannot withdraw this amount as it would leave insufficient margin for open positions.',
        '0x1788': 'Slippage tolerance exceeded. Try increasing slippage.', // Jupiter slippage error
        '0x1e': 'Slippage tolerance exceeded. Try increasing slippage.',
      }
      return errorMessages[errorCode] || 'Transaction failed. Please try again.'
    }
    return 'Transaction failed. Please try again.'
  }
  
  // Handle transaction simulation failures
  if (withoutLogs.includes('Transaction simulation failed')) {
    return 'Transaction simulation failed. Please try again.'
  }
  
  if (withoutLogs.includes('Transaction results in an account')) {
    return 'Transaction failed due to account state change'
  }
  
  // Generic broadcast failure
  if (withoutLogs.includes('Error broadcasting transaction')) {
    return 'Transaction failed to broadcast. Please try again.'
  }

  // Pool-related errors
  if (
    withoutLogs.includes('_bn') ||
    withoutLogs.includes('undefined is not an object') ||
    withoutLogs.includes('Cannot read property')
  ) {
    return 'Pool data is invalid or unavailable. Please verify the pool address.'
  }

  if (withoutLogs.includes('Pool not found') || withoutLogs.includes('pool not found')) {
    return 'Pool not found. Please check the pool address.'
  }

  if (withoutLogs.includes('Invalid pool') || withoutLogs.includes('invalid pool')) {
    return 'Invalid pool address provided.'
  }

  // Fallback: return a clean, truncated message
  const cleanMsg = withoutLogs
    .replace(/^Error:\s*/i, '')
    .replace(/^Error broadcasting transaction with message:\s*/i, '')
    .substring(0, 80)
  
  return cleanMsg.length > 0 ? cleanMsg : 'Transaction failed. Please try again.'
}

/**
 * Helper to handle try-catch blocks with Privy errors
 */
export function handlePrivyError(error: any): ParsedPrivyError {
  log.error('Privy error:', error)
  return parsePrivyError(error)
}

