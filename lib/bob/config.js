// Settings read from Vercel environment variables.

// How many jobs can run at the same time (one per crew/van). Set BOOKING_CREWS in Vercel.
export function bookingCrews() {
  const n = parseInt(process.env.BOOKING_CREWS || '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function geminiReady() {
  return Boolean(process.env.GEMINI_API_KEY);
}
