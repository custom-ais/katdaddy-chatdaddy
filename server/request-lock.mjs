import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Only mutations for the same booking wait for one another. A lease outlives
// Vercel's 60-second request limit, and an old owner cannot release a new lease.
export async function waitForRequestLock(store, key, { waitMs = 12_000 } = {}) {
  const owner = randomUUID(), deadline = Date.now() + waitMs;
  while (true) {
    if (await store.acquireLease(key, owner, 90)) {
      return { release: () => store.releaseLease(key, owner) };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw Object.assign(new Error('Your earlier request is still finishing. Please try again shortly.'), {
        status: 409, extra: { code: 'CONVERSATION_PENDING', retryInSeconds: 1 },
      });
    }
    await sleep(Math.min(remaining, 100 + Math.floor(Math.random() * 100)));
  }
}
