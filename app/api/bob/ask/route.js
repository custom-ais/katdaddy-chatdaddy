import { NextResponse } from 'next/server';
import { ADDONS, BUSINESS, HOURS_TEXT, PACKAGES, PRICING_NOTE, REPAIR_STEPS, SEVERITY_CREDIT, SURCHARGES } from '@/lib/bob/catalog';
import { allow, clientIp } from '@/lib/bob/rateLimit';

export const dynamic = 'force-dynamic';

const DEFAULT_MODEL = 'gemini-3.5-flash';

function facts() {
  const pkgs = Object.values(PACKAGES)
    .map((p) => {
      const price = p.prices
        ? `$${p.prices.one} (1-story), $${p.prices.twoFirst} (2-story, laundry 1st floor), $${p.prices.twoSecond} (2-story, laundry 2nd floor)`
        : `$${p.price}`;
      return `- ${p.name}: ${price}. Includes: ${p.features.join('; ')}.`;
    })
    .join('\n');
  const extras = Object.values(SURCHARGES).map((s) => `- ${s.label}: +$${s.amount}`).join('\n');
  const addons = Object.values(ADDONS).map((a) => `- ${a.name}: $${a.price} (${a.description})`).join('\n');
  return `${pkgs}

Extra charges on See-It-Clean packages:
${extras}
Severe airflow problems get a $${SEVERITY_CREDIT} credit on Total System See-It-Clean.

Add-ons:
${addons}

Repair process: ${REPAIR_STEPS.join(', ')}.
Pricing promise: ${PRICING_NOTE}
Hours: ${HOURS_TEXT}. Phone: ${BUSINESS.phone}.
Service area: Phoenix West Valley (Surprise, Goodyear, Buckeye, Peoria, Avondale, Glendale, Sun City, Sun City West, El Mirage, Litchfield Park, Tolleson, Waddell, Youngtown).`;
}

const SYSTEM = () => `You are BOB, the friendly booking assistant for ${BUSINESS.name}, a veteran-owned dryer vent cleaning, repair, rerouting and installation company.
Answer the customer's question in 2 to 4 short sentences, in plain words. Only use the facts below. Never invent prices, discounts, times or promises.
If the facts don't cover it, say the team can answer it and give the phone number ${BUSINESS.phone}.
If someone describes smoke, fire or a burning smell happening right now, tell them to turn the dryer off and call 911 if there is any fire or smoke.
Don't ask for personal details; BOB's booking steps collect those. End by inviting them to keep going with their booking when it fits.

FACTS
${facts()}`;

const FALLBACK = `Good question. The team can answer that best: call ${BUSINESS.phone} (${HOURS_TEXT}). You can keep booking here in the meantime.`;

export async function POST(request) {
  if (!allow(`ask:${clientIp(request)}`, 20, 10 * 60 * 1000)) {
    return NextResponse.json({ answer: `You've asked a lot of questions quickly. Call ${BUSINESS.phone} and we'll help directly.` });
  }
  const body = await request.json().catch(() => ({}));
  const question = String(body.question || '').trim().slice(0, 500);
  if (!question) return NextResponse.json({ answer: 'What would you like to know?' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return NextResponse.json({ answer: FALLBACK, ai: false });

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM() }] },
          contents: [{ role: 'user', parts: [{ text: question }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 400 },
        }),
      }
    );
    const data = await res.json().catch(() => ({}));
    const answer = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
    if (!res.ok || !answer) {
      console.error('BOB ask error:', res.status, data.error?.message);
      return NextResponse.json({ answer: FALLBACK, ai: false });
    }
    return NextResponse.json({ answer, ai: true });
  } catch (error) {
    console.error('BOB ask error:', error.message);
    return NextResponse.json({ answer: FALLBACK, ai: false });
  }
}
