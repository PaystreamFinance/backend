import type { Next } from 'hono'
import type { User } from '@privy-io/node'
import { Context } from 'hono'
import { privy } from '../clients/privy'
import { log } from '../utils/log'

export type AuthData = {
  user: User
  idToken: string
  accessToken: string
}

declare module 'hono' {
  interface Context {
    privyUser?: AuthData
  }
}

function extractIdentityToken(c: Context): string | null {
  const headerToken = c.req.header('privy-id-token')
  return headerToken || null
}

function extractAccessToken(c: Context): string | null {
  const authHeader = c.req.header('authorization')
  if (!authHeader) {
    return null
  }

  const tokenMatch = authHeader.match(/^Bearer (.+)$/)
  return tokenMatch?.[1] || null
}

/**
 * Middleware to extract and verify both Privy tokens (identity token and access token)
 *
 * Requires:
 * - Identity token (from header 'privy-id-token') - used to extract user object
 * - Access token (from Authorization header 'Bearer <token>') - verified for authentication
 *
 * Based on:
 * - https://docs.privy.io/user-management/users/identity-tokens
 * - https://docs.privy.io/authentication/user-authentication/access-tokens
 */
export async function privyAuthMiddleware(c: Context, next: Next) {
  try {
    // Extract both tokens
    const idToken = extractIdentityToken(c)
    const accessToken = extractAccessToken(c)

    // Both tokens are required
    if (!idToken) {
      return c.json(
        {
          error: 'Unauthorized: Missing identity token',
          details: 'Provide identity token in header: privy-id-token',
        },
        401,
      )
    }

    if (!accessToken) {
      return c.json(
        {
          error: 'Unauthorized: Missing access token',
          details:
            'Provide access token in header: Authorization: Bearer <token>',
        },
        401,
      )
    }

    // Verify both tokens in parallel
    try {
      const [user] = await Promise.all([
        // Verify identity token and get user object
        privy.users().get({ id_token: idToken }),
        // Verify access token (we verify it but don't need the claims)
        privy.utils().auth().verifyAuthToken(accessToken),
      ])

      // Store user object and tokens in context
      c.privyUser = {
        user,
        idToken,
        accessToken,
      }

      // Continue to the next handler
      await next()
    } catch (error) {
      // Token verification failed
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      log.warn('[auth] Token verification failed', { error: errorMessage })

      return c.json(
        {
          error: 'Unauthorized: Invalid or expired credentials',
        },
        401,
      )
    }
  } catch (error) {
    // Unexpected error during middleware execution
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    log.error('[auth] Unexpected authentication error', { error: errorMessage })
    return c.json(
      {
        error: 'Internal server error during authentication',
      },
      500,
    )
  }
}
