import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const REQUEST_LIMIT = 20;
const WINDOW_MS = 60_000;
const localBuckets = new Map();
let sharedLimiter;

function clientAddress(req) {
  const forwardedFor = req.headers?.['x-forwarded-for'];
  const forwardedAddress = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(',')[0];

  return String(forwardedAddress || req.ip || req.socket?.remoteAddress || 'unknown').trim();
}

function localLimit(address) {
  const now = Date.now();
  for (const [key, bucket] of localBuckets) {
    if (bucket.resetAt <= now) localBuckets.delete(key);
  }

  const key = localBuckets.size >= 5000 && !localBuckets.has(address) ? 'overflow' : address;
  let bucket = localBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    localBuckets.set(key, bucket);
  }

  if (bucket.count >= REQUEST_LIMIT) {
    return {
      allowed: false,
      limit: REQUEST_LIMIT,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    limit: REQUEST_LIMIT,
    remaining: REQUEST_LIMIT - bucket.count,
    retryAfter: 0,
  };
}

export async function checkChatRateLimit(req) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) return localLimit(clientAddress(req));

  if (!sharedLimiter) {
    sharedLimiter = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(REQUEST_LIMIT, '1 m'),
      analytics: false,
      prefix: 'voicebot:chat',
    });
  }

  const result = await sharedLimiter.limit(clientAddress(req));
  return {
    allowed: result.success,
    limit: REQUEST_LIMIT,
    remaining: result.remaining,
    retryAfter: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
  };
}