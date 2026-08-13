import type { ConnectionOptions, QueueOptions } from 'bullmq'
import Redis from 'ioredis'
import { sendOpsAlert, AlertSeverity } from '@paystream/alerts'

const redisHost = process.env.REDIS_HOST || 'localhost'
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10)
const redisPassword = process.env.REDIS_PASSWORD || undefined

export const redisConnectionOptions = {
  host: redisHost,
  port: redisPort,
  password: redisPassword || undefined,
  maxRetriesPerRequest: null,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000)
    return delay
  },
  enableReadyCheck: true,
  lazyConnect: false,
} satisfies ConnectionOptions

export const redisConnection = new Redis(redisConnectionOptions)

redisConnection.on('error', (err) => {
  console.error(`Redis error (${redisHost}:${redisPort}):`, err.message)
  sendOpsAlert({
    key: 'redis-connection-error',
    severity: AlertSeverity.CRITICAL,
    title: 'Redis connection error',
    message: `${redisHost}:${redisPort} — ${err.message}`,
    service: 'core-worker',
    error: err,
  })
})
export async function waitForRedis() {
  if (redisConnection.status === 'ready') {
    console.log("Redis connected successfully!")
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Redis connection timeout'))
    }, 10000)
    
    redisConnection.once('ready', () => {
      clearTimeout(timeout)
      resolve()
    })
    
    redisConnection.once('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

export const queueOptions: QueueOptions = {
  connection: redisConnectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 3600,
      count: 1000,
    },
    removeOnFail: {
      age: 86400,
    },
  },
}

