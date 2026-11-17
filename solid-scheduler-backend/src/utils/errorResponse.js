import config from '../config/index.js';

/**
 * Return error.message in development, generic message in production.
 * Prevents leaking internal details (stack traces, DB errors, file paths).
 */
export function safeMessage(error, fallback = 'Something went wrong') {
  return config.nodeEnv === 'development' ? error.message : fallback;
}
