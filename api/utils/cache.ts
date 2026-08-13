/**
 * Simple in-memory cache with TTL support
 * Used to cache API responses and prevent rate limiting
 */

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

class SimpleCache {
  private cache = new Map<string, CacheEntry<any>>()

  /**
   * Get a value from cache if it exists and hasn't expired
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) {
      return null
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }

    return entry.data as T
  }

  /**
   * Set a value in cache with TTL in milliseconds
   */
  set<T>(key: string, value: T, ttlMs: number): void {
    this.cache.set(key, {
      data: value,
      expiresAt: Date.now() + ttlMs,
    })
  }

  /**
   * Check if a key exists and is valid (not expired)
   */
  has(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) {
      return false
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return false
    }

    return true
  }

  /**
   * Delete a key from cache
   */
  delete(key: string): void {
    this.cache.delete(key)
  }

  /**
   * Clear all expired entries
   */
  clearExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size
  }
}

// Global cache instance
export const cache = new SimpleCache()

// Clean up expired entries every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    cache.clearExpired()
  }, 5 * 60 * 1000) // 5 minutes
}

