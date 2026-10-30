import { NextResponse } from 'next/server';
import { createClient, createJob, createVisit, findClient, findOrCreateProperty, listVisits } from '@/lib/bob/jobber';
import { busyFromVisits, formatWhen, openSlots, searchWindow } from '@/lib/bob/schedule';
import { PERFORMANCE_LABELS, SYMPTOM_LABELS, quote, severityOf } from '@/lib/bob/pricing';
import { LAYOUTS } from '@/lib/bob/catalog';
import { checkPackage, cleanAnswers, cleanContact } from '@/lib/bob/request';
import { inServiceArea } from '@/lib/bob/serviceArea';
import { allow, clientIp } from '@/lib/bob/rateLimit';
import { bookingCrews } from '@/lib/bob/config';

export const dynamic = 'force-dynamic';

const PATHS = {
  emergency: 'Emergency: clog or overheating',
  clean: 'Book a vent cleaning',
  help: 'Help me choose',
  repair: 'Repair, reroute or upgrade',
};
const REPAIR_STATE = {
  normal: 'Working normally',
  multi_cycle: 'Takes more than 1 cycle',
  not_working: 'Not working',
  unknown: "Doesn't know",
};
const URGENCY = { normal: 'Normal', unknown: 'Normal', multi_cycle: 'Elevated', not_working: 'High' };

// The notes the tech sees on the job in Jobber.
function jobNotes(answers, contact, q, inArea) {
  const rows = [`Booked online with BOB. Customer was quoted ${'$' + q.total}.`];
  rows.push(`Reason: ${PATHS[answers.path]}`);
  if (answers.stories) rows.push(`Home: ${LAYOUTS[layoutKey(answers)]}`);
  if (answers.fuel) rows.push(`Dryer: ${answers.fuel}, ${answers.config || 'standard'}`);
  if (answers.express) rows.push('No dryer installed or recently serviced: vent only');
  if (answers.symptoms?.length) rows.push(`Symptoms: ${answers.symptoms.map((s) => SYMPTOM_LABELS[s]).join(', ')}`);
  if (answers.performance?.length) rows.push(`Performance: ${answers.performance.map((p) => PERFORMANCE_LABELS[p]).join(', ')}`);
  if (answers.path !== 'repair' && answers.path) rows.push(`Airflow severity from answers: ${severityOf(answers)}`);
  if (answers.pests) rows.push(`Signs of animals: ${answers.pests}`);
  if (answers.repairState) rows.push(`Dryer state: ${REPAIR_STATE[answers.repairState]} (urgency ${URGENCY[answers.repairState]})`);
  if (answers.details) rows.push(`Customer description: ${answers.details}`);
  if (contact.notes) rows.push(`Gate code / property notes: ${contact.notes}`);
  if (!inArea) rows.push('OUTSIDE SERVICE AREA: call the customer to confirm before scheduling.');
  return rows.join('\n');
}

function layoutKey(answers) {
  if (answers.stories === 'two') return answers.floor === 'second' ? 'twoSecond' : 'twoFirst';
  return 'one';
}

export async function POST(request) {
  const ip = clientIp(request);
  if (!allow(`book:${ip}`, 10, 60 * 60 * 1000)) {
    return NextResponse.json({ error: 'Too many booking attempts. Please call us instead.' }, { status: 429 });
  }

  const body = await request.json().catch(() => ({}));
  // Hidden form field that only bots fill in.
  if (body.website) return NextResponse.json({ ok: true, jobNumber: null, inArea: true });

  const answers = cleanAnswers(body.answers);
  const pick = checkPackage(body.packageId, answers, body.addons);
  if (!pick) return NextResponse.json({ error: 'That package is not available for these answers.' }, { status: 400 });

  const { contact, problems } = cleanContact(body.contact);
  if (problems.length) {
    return NextResponse.json({ error: `Please check your ${problems.join(', ')}.` }, { status: 400 });
  }

  const q = quote(pick.packageId, answers, pick.addons);
  const inArea = inServiceArea(contact);

  let start = null;
  let end = null;
  try {
    if (inArea) {
      start = new Date(body.slot?.start);
      if (Number.isNaN(start.getTime())) {
        return NextResponse.json({ error: 'Pick an appointment time first.' }, { status: 400 });
      }
      // Re-check the calendar right before booking so two people can't take the same time.
      const { from, to } = searchWindow();
      const visits = await listVisits(from, to);
      const slots = openSlots({ busy: busyFromVisits(visits), minutes: q.minutes, crews: bookingCrews() });
      const match = slots.find((s) => s.start === start.toISOString());
      if (!match) {
        return NextResponse.json(
          { error: 'That time was just taken. Pick another time.', code: 'slot_taken' },
          { status: 409 }
        );
      }
      end = new Date(match.end);
    }

    const existing = await findClient(contact);
    const client = existing || (await createClient(contact));
    const propertyId = await findOrCreateProperty(existing || { ...client, properties: [] }, contact);

    const title = inArea ? q.name : `Out-of-area request: ${q.name}`;
    const notes = jobNotes(answers, contact, q, inArea);
    const job = await createJob({ propertyId, title, instructions: notes, lines: q.lines });

    if (inArea) {
      try {
        await createVisit(job.id, { title: q.name, instructions: notes, start, end });
      } catch (error) {
        console.error('BOB visit error:', error.message);
        return NextResponse.json({
          ok: true,
          scheduled: false,
          jobNumber: job.jobNumber,
          message: `Your request is saved as job #${job.jobNumber}, but the time couldn't be locked in. We'll call you to confirm.`,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      scheduled: inArea,
      inArea,
      jobNumber: job.jobNumber,
      when: inArea ? formatWhen(start) : null,
      start: start?.toISOString() || null,
      total: q.total,
      name: q.name,
      returning: Boolean(existing),
    });
  } catch (error) {
    console.error('BOB booking error:', error.message);
    return NextResponse.json(
      { error: 'Booking failed on our side. Please call us and we will get you scheduled.' },
      { status: 502 }
    );
  }
}
