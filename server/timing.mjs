// Where a request's time goes: database queries, Jobber calls (and Jobber's rate-limit waits),
// Google, email, texts, and named steps of a booking. Each request gets its own tally; code that
// runs outside a request (tests, scripts) is measured by nobody and costs nothing.
//
// The tally goes out three ways for the booking endpoints: a Server-Timing header (browser dev
// tools), one "[timing]" line in the server log, and the request's entry in BOB activity.

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const als = new AsyncLocalStorage();

/** Runs fn with a fresh tally for this request. */
export function withTiming(fn) {
  return als.run({ start: performance.now(), kinds: {}, steps: [], memo: new Map() }, fn);
}

/**
 * Reads something at most once per request (outside a request: every time). Used for values that
 * can change between requests but not within one, like the stored Jobber token.
 */
export function oncePerRequest(key, fn) {
  const ctx = als.getStore();
  if (!ctx) return fn();
  if (!ctx.memo.has(key)) ctx.memo.set(key, Promise.resolve().then(fn).catch((error) => { ctx.memo.delete(key); throw error; }));
  return ctx.memo.get(key);
}
export function forgetPerRequest(key) {
  als.getStore()?.memo.delete(key);
}

const add = (ctx, kind, ms) => {
  const k = (ctx.kinds[kind] ||= { n: 0, ms: 0 });
  k.n++;
  k.ms += ms;
};

/** Times one call of a kind ("db", "jobber", "google", ...). Parallel calls add up (busy time). */
export async function measure(kind, fn) {
  const ctx = als.getStore();
  if (!ctx) return fn();
  const t0 = performance.now();
  try { return await fn(); } finally { add(ctx, kind, performance.now() - t0); }
}

/** Records time already spent, such as a deliberate wait. */
export function note(kind, ms) {
  const ctx = als.getStore();
  if (ctx) add(ctx, kind, ms);
}

/** Times a named step of the request ("recheck", "jobber", ...). */
export async function step(name, fn) {
  const ctx = als.getStore();
  if (!ctx) return fn();
  const t0 = performance.now();
  try { return await fn(); } finally { ctx.steps.push([name, performance.now() - t0]); }
}

/** { ms, steps: { name: ms }, db: { n, ms }, jobber: { n, ms }, ... } with whole milliseconds. */
export function timingSummary() {
  const ctx = als.getStore();
  if (!ctx) return null;
  const out = { ms: Math.round(performance.now() - ctx.start), steps: {} };
  for (const [name, ms] of ctx.steps) out.steps[name] = Math.round((out.steps[name] || 0) + ms);
  for (const [kind, v] of Object.entries(ctx.kinds)) out[kind] = { n: v.n, ms: Math.round(v.ms) };
  return out;
}

/** The Server-Timing header value for a summary. */
export function serverTimingHeader(s) {
  if (!s) return "";
  const token = (t) => String(t).replace(/[^A-Za-z0-9_.-]/g, "_");
  const parts = [`total;dur=${s.ms}`];
  for (const [name, ms] of Object.entries(s.steps || {})) parts.push(`step.${token(name)};dur=${ms}`);
  for (const [kind, v] of Object.entries(s)) {
    if (kind === "ms" || kind === "steps") continue;
    parts.push(`${token(kind)};desc="${v.n} call${v.n === 1 ? "" : "s"}";dur=${v.ms}`);
  }
  return parts.join(", ");
}
