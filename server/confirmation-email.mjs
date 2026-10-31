import { money, windowLabel, TIME_ZONE } from "../shared/domain.mjs";
import { emailLayout, escapeHtml as esc, sectionTitle } from "./email-layout.mjs";

export function confirmationEmail(appt, config) {
  const first = String(appt.customerName || "").trim().split(/\s+/)[0] || "there";
  const when = new Date(appt.scheduledAt);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(when);
  // Use BOB's existing arrival-window calculation; the email never changes the booked time.
  const arrival = windowLabel(appt.scheduledAt).split(" · ").slice(1).join(" · ");
  const total = Math.round(appt.price * 100);
  const address = [appt.address, [appt.city, "AZ", appt.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const replyEmail = config.email || "westvalley@dryerventsquad.com";
  const phone = String(config.phone || "").replace(/[^+\d]/g, "");
  const digits = phone.replace(/\D/g, "").slice(-10);
  const prettyPhone = digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : phone;
  const preparation = config.preparation || "Please make the laundry area accessible and secure pets before the visit. Do not move or disconnect the dryer yourself.";
  const lines = appt.lineItems?.length ? appt.lineItems.map((l) => [l.name, l.cents])
    : [[appt.package, total - (appt.travelFeeCents || 0)], ...(appt.travelFeeCents ? [["Travel fee", appt.travelFeeCents]] : [])];
  const quoteRows = lines.map(([name, cents]) => `<tr><td style="padding:9px 0;border-bottom:1px solid #edf1f5;font-size:14px">${esc(name)}</td><td style="padding:9px 0 9px 12px;border-bottom:1px solid #edf1f5;text-align:right;white-space:nowrap;font-size:14px">${esc(money(cents))}</td></tr>`).join("");
  const subject = `Appointment confirmed | ${appt.package} | ${day}`;
  const body = `<p style="margin:0 0 20px">Hi ${esc(first)},<br>Thanks for choosing Dryer Vent Squad West Valley. Your appointment is confirmed, and your visit details are below.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d7e5f0;border-radius:12px;background:#f2f7fc"><tr><td style="padding:21px">
<div style="font-size:10px;letter-spacing:1.6px;font-weight:700;color:#426484">YOUR APPOINTMENT</div>
<div style="padding-top:8px;font-size:21px;font-weight:700;line-height:1.35;color:#122c49">${esc(day)}</div>
<div style="padding-top:6px;font-size:15px;color:#325576">${esc(arrival)}</div>
<div style="margin-top:16px;padding-top:14px;border-top:1px solid #d7e5f0;font-size:13px;color:#506a83">Booking reference <strong style="color:#122c49">${esc(appt.id)}</strong></div>
</td></tr></table>
${sectionTitle("Visit details")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6">
<tr><td valign="top" style="width:80px;padding:6px 14px 6px 0;color:#6a7f94">Service</td><td style="padding:6px 0;font-weight:700">${esc(appt.package)}</td></tr>
<tr><td valign="top" style="padding:6px 14px 6px 0;color:#6a7f94">Address</td><td style="padding:6px 0">${esc(address)}</td></tr></table>
${sectionTitle("Your service total")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${quoteRows}
<tr><td style="padding:15px 0;font-size:15px;font-weight:700">Quoted total</td><td style="padding:15px 0;text-align:right;font-size:25px;line-height:1;font-weight:700;color:#122c49">${esc(money(total))}</td></tr></table>
${appt.route !== "cleaning" ? '<p style="margin:0 0 16px;font-size:12px;color:#82602c">Repairs and parts are quoted separately.</p>' : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff8ec;border-left:4px solid #fa9b28"><tr><td style="padding:16px 18px">
<div style="font-size:14px;font-weight:700;color:#66451d">A little preparation helps</div><p style="margin:7px 0 0;font-size:13px;line-height:1.7;color:#725638">${esc(preparation)}</p>
</td></tr></table>
${sectionTitle("Need a hand before your visit?")}
<p style="margin:0 0 18px;font-size:14px;color:#506a83">Reply to this email${phone ? ` or call <a href="tel:${esc(phone)}" style="color:#245c92;text-decoration:underline">${esc(prettyPhone)}</a>` : ""} if you have a question or need to request a change.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#122c49;border-radius:8px"><a href="mailto:${esc(replyEmail)}" style="display:inline-block;padding:13px 22px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none">Contact our team &rarr;</a></td></tr></table>
<p style="margin:24px 0 0;font-size:14px;color:#506a83">We look forward to helping you.<br><strong style="color:#122c49">Your Dryer Vent Squad West Valley team</strong></p>`;
  const text = `APPOINTMENT CONFIRMED\nDryer Vent Squad West Valley\n\nHi ${first},\nYour appointment is confirmed.\n\n${day}\n${arrival}\nBooking reference: ${appt.id}\n\nService: ${appt.package}\nAddress: ${address}\n\n${lines.map(([name, cents]) => `${name}: ${money(cents)}`).join("\n")}\nQuoted total: ${money(total)}\n${appt.route !== "cleaning" ? "Repairs and parts are quoted separately.\n" : ""}\nBefore your visit: ${preparation}\n\nQuestions or changes: reply to this email or email ${replyEmail}${phone ? `, or call ${prettyPhone}` : ""}.\n\nDryer Vent Squad West Valley · Veteran-owned`;
  return {
    subject, text,
    html: emailLayout({ preheader: `${day} · ${arrival} · Reference ${appt.id}`, eyebrow: "Appointment confirmed", title: "You're on the schedule.", subtitle: "Your visit is booked. Here’s everything you need to know.", body }),
  };
}
