// Table layout and inline styles keep these emails readable in Gmail and Outlook.
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function emailLayout({ preheader, eyebrow, title, subtitle = "", body, footer }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#edf2f7;color:#172b44;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#edf2f7;mso-hide:all">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#edf2f7"><tr><td align="center" style="padding:28px 12px">
<!--[if mso]><table role="presentation" width="640"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #dce5ee;border-radius:20px;overflow:hidden">
<tr><td style="height:6px;background:#fa9b28;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:30px 28px 22px;background:#122c49;color:#ffffff">
<div style="font-size:19px;font-weight:700;letter-spacing:-.3px">Dryer Vent Squad<span style="color:#fa9b28">.</span></div>
<div style="font-size:10px;letter-spacing:2.5px;color:#b9cce0;padding-top:6px">WEST VALLEY, ARIZONA</div>
<div style="padding-top:30px;font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#ffd39a">${escapeHtml(eyebrow)}</div>
<h1 style="margin:10px 0 0;font-size:30px;line-height:1.2;font-weight:700;letter-spacing:-.7px;color:#ffffff">${escapeHtml(title)}</h1>
${subtitle ? `<p style="margin:12px 0 4px;font-size:14px;line-height:1.6;color:#c7d7e7">${escapeHtml(subtitle)}</p>` : ""}
</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.65">${body}</td></tr>
<tr><td style="padding:20px 28px;background:#f6f8fb;border-top:1px solid #e5ebf1;font-size:12px;line-height:1.6;color:#65788f">${footer || "Dryer Vent Squad West Valley &middot; Veteran-owned<br>Sent by BOB, your booking assistant."}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}

export const sectionTitle = (text) => `<h2 style="margin:26px 0 12px;font-size:17px;line-height:1.4;color:#122c49">${escapeHtml(text)}</h2>`;
