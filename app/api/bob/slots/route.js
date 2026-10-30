import { NextResponse } from 'next/server';
import { listVisits } from '@/lib/bob/jobber';
import { busyFromVisits, openSlots, searchWindow } from '@/lib/bob/schedule';
import { quote } from '@/lib/bob/pricing';
import { checkPackage, cleanAnswers } from '@/lib/bob/request';
import { allow, clientIp } from '@/lib/bob/rateLimit';
import { bookingCrews } from '@/lib/bob/config';

export const dynamic = 'force-dynamic';

// Open appointment times for the chosen package, checked against the Jobber calendar.
export async function POST(request) {
  if (!allow(`slots:${clientIp(request)}`, 30, 10 * 60 * 1000)) {
    return NextResponse.json({ error: 'Too many requests. Wait a few minutes and try again.' }, { status: 429 });
  }
  const body = await request.json().catch(() => ({}));
  const answers = cleanAnswers(body.answers);
  const pick = checkPackage(body.packageId, answers, body.addons);
  if (!pick) return NextResponse.json({ error: 'That package is not available for these answers.' }, { status: 400 });

  const { minutes } = quote(pick.packageId, answers, pick.addons);
  try {
    const { from, to } = searchWindow();
    const visits = await listVisits(from, to);
    const slots = openSlots({ busy: busyFromVisits(visits), minutes, crews: bookingCrews() });
    return NextResponse.json({ minutes, slots });
  } catch (error) {
    console.error('BOB slots error:', error.message);
    return NextResponse.json(
      { error: 'The schedule could not be loaded right now.', minutes, slots: [] },
      { status: 503 }
    );
  }
}
