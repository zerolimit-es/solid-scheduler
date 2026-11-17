/**
 * Redis Client Singleton
 *
 * Provides a shared Redis connection for session storage and transient data.
 * Returns null when REDIS_URL is not configured (graceful fallback to in-memory).
 */

import Redis from 'ioredis';
import config from '../config/index.js';

let client = null;
let connectionAttempted = false;

export function getRedis() {
  if (connectionAttempted) return client;
  connectionAttempted = true;

  if (!config.redisUrl) {
    console.log('[Redis] REDIS_URL not set — using in-memory session storage');
    return null;
  }

  try {
    client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: false,
      enableReadyCheck: true,
    });

    client.on('connect', () => console.log('[Redis] Connected'));
    client.on('error', (err) => console.error('[Redis] Error:', err.message));
  } catch (err) {
    console.error('[Redis] Failed to create client:', err.message);
    client = null;
  }

  return client;
}

export async function closeRedis() {
  if (client) {
    await client.quit();
    client = null;
    connectionAttempted = false;
  }
}
