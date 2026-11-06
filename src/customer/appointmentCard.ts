// The saved appointment card: a phone-friendly PNG of the booking, drawn on a canvas so it looks
// the same everywhere and lands in the photo gallery or downloads like any other image.

export type AppointmentCardData = {
  businessName: string;
  phone?: string;
  email?: string;
  pending: boolean;
  reference: string;
  jobNumber?: string | number;
  day: string; // "Tuesday, Nov 10"
  time: string; // the visit's start, "10:00 AM"
  window?: string; // its arrival window, "9:30–10:30 AM"
  lineItems: { name: string; cents: number }[];
  totalCents: number;
  repairsNote?: string;
  name: string;
  address: string;
  cityLine: string;
  preparation?: string;
};

const W = 1080;
const PAD = 48; // around the card
const IN = 64; // inside the card
const DISPLAY = '"Bricolage Grotesque Variable", ui-sans-serif, system-ui, sans-serif';
const BODY = '"Atkinson Hyperlegible Next Variable", ui-sans-serif, system-ui, sans-serif';
const C = {
  page: '#e9eef4', card: '#ffffff', navy: '#0f172a', navy2: '#1e293b', ink: '#0f172a', text: '#334155', muted: '#64748b', faint: '#94a3b8',
  line: '#e2e8f0', orange: '#f97316', orangeSoft: '#fff7ed', orangeLine: '#fed7aa', green: '#047857', greenSoft: '#ecfdf5', amber: '#b45309', amberSoft: '#fffbeb',
};

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** "+16235550100" or "623-555-0100" → "(623) 555-0100"; anything else is shown as given. */
export function displayPhone(value = '') {
  const d = value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : value;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = [];
  for (const paragraph of String(text || '').split(/\n+/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= max || !line) line = next;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | number[]) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/**
 * Lays the card out top to bottom. With `draw` false it only measures, so the canvas can be sized
 * to fit before the real pass.
 */
function paint(ctx: CanvasRenderingContext2D, d: AppointmentCardData, logo: HTMLImageElement | null, draw: boolean, height: number) {
  const left = PAD + IN, right = W - PAD - IN, width = right - left;
  const font = (weight: number, size: number, family = BODY) => { ctx.font = `${weight} ${size}px ${family}`; };
  const fill = (color: string) => { ctx.fillStyle = color; };
  const text = (s: string, x: number, y: number, align: CanvasTextAlign = 'left') => { if (draw) { ctx.textAlign = align; ctx.fillText(s, x, y); } };
  const label = (s: string, y: number) => { font(700, 22); fill(C.faint); if (draw) { ctx.save(); ctx.letterSpacing = '3px'; text(s.toUpperCase(), left, y); ctx.restore(); } return y + 22; };
  const rule = (y: number) => { if (draw) { fill(C.line); ctx.fillRect(left, y, width, 2); } return y + 2; };

  if (draw) {
    fill(C.page); ctx.fillRect(0, 0, W, height);
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.12)'; ctx.shadowBlur = 48; ctx.shadowOffsetY = 16;
    fill(C.card); roundRect(ctx, PAD, PAD, W - PAD * 2, height - PAD * 2, 44); ctx.fill();
    ctx.restore();
  }
  ctx.textBaseline = 'alphabetic';

  // Header: logo, business name, what this is.
  const headerH = 236;
  if (draw) {
    const g = ctx.createLinearGradient(PAD, PAD, W - PAD, PAD + headerH);
    g.addColorStop(0, C.navy); g.addColorStop(1, C.navy2);
    ctx.fillStyle = g; roundRect(ctx, PAD, PAD, W - PAD * 2, headerH, [44, 44, 0, 0]); ctx.fill();
    fill(C.orange); ctx.fillRect(PAD, PAD + headerH - 6, W - PAD * 2, 6);
  }
  const logoSize = 124, logoX = left, logoY = PAD + (headerH - logoSize) / 2 - 3;
  if (draw && logo) {
    ctx.save();
    fill('#ffffff'); ctx.beginPath(); ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2 + 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
    ctx.restore();
  }
  const nameX = logo ? logoX + logoSize + 36 : left;
  font(800, 46, DISPLAY);
  const nameLines = wrap(ctx, d.businessName || 'Your appointment', right - nameX).slice(0, 2);
  const nameBlock = nameLines.length * 52 + 40;
  let hy = PAD + (headerH - nameBlock) / 2 + 42;
  fill('#ffffff');
  for (const l of nameLines) { text(l, nameX, hy); hy += 52; }
  font(700, 24); fill('#fdba74');
  if (draw) { ctx.save(); ctx.letterSpacing = '3px'; text('APPOINTMENT CONFIRMATION', nameX, hy + 2); ctx.restore(); }

  let y = PAD + headerH + 56;

  // Status pill.
  font(800, 28);
  const status = d.pending ? 'Almost there — not confirmed yet' : "You're booked";
  const pillW = ctx.measureText(status).width + (d.pending ? 56 : 104), pillH = 64;
  if (draw) {
    fill(d.pending ? C.amberSoft : C.greenSoft); roundRect(ctx, left, y, pillW, pillH, 32); ctx.fill();
    if (!d.pending) {
      const cx = left + 42, cy = y + pillH / 2;
      fill(C.green); ctx.beginPath(); ctx.arc(cx, cy, 16, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(cx - 7, cy + 1); ctx.lineTo(cx - 2, cy + 6); ctx.lineTo(cx + 8, cy - 5); ctx.stroke();
    }
    fill(d.pending ? C.amber : C.green); text(status, left + (d.pending ? 28 : 74), y + 42);
  }
  y += pillH + 52;

  // When.
  y = label('When', y) + 20;
  font(800, 64, DISPLAY); fill(C.ink);
  const dayLines = wrap(ctx, d.day, width - 36);
  let wy = y + 58;
  for (const l of dayLines) { text(l, left + 36, wy); wy += 70; }
  font(800, 48, DISPLAY); fill(C.ink); text(d.time, left + 36, wy + 8); wy += 50;
  font(600, 28); fill(C.muted); text(d.window ? `Arrival window ${d.window} · Arizona time` : 'Arizona time', left + 36, wy + 2);
  if (draw) { fill(C.orange); roundRect(ctx, left, y, 8, wy + 14 - y, 4); ctx.fill(); }
  y = wy + 14 + 48;
  y = rule(y) + 48;

  // Service and price.
  y = label('Service', y) + 30;
  for (const item of d.lineItems) {
    font(600, 30); fill(C.ink);
    const lines = wrap(ctx, item.name, width - 190);
    lines.forEach((l, i) => text(l, left, y + 30 + i * 40));
    font(700, 30); fill(C.ink); text(dollars(item.cents), right, y + 30, 'right');
    y += lines.length * 40 + 18;
  }
  y += 6;
  if (draw) { fill(C.line); ctx.fillRect(left, y, width, 2); }
  y += 24;
  font(800, 34); fill(C.ink); text('Total', left, y + 40);
  font(800, 48, DISPLAY); fill(C.ink); text(dollars(d.totalCents), right, y + 42, 'right');
  y += 62;
  if (d.repairsNote) { font(700, 24); fill(C.amber); for (const l of wrap(ctx, d.repairsNote, width)) { text(l, left, y + 30); y += 34; } }
  y += 44;
  y = rule(y) + 48;

  // Where.
  y = label('Where', y) + 30;
  font(700, 32); fill(C.ink); text(d.name, left, y + 32); y += 46;
  font(500, 30); fill(C.text);
  for (const l of [...wrap(ctx, d.address, width), d.cityLine]) { text(l, left, y + 30); y += 42; }
  y += 40;

  // Before we arrive.
  if (d.preparation) {
    font(500, 27);
    const lines = wrap(ctx, d.preparation, width - 72);
    const boxH = 40 + 34 + 16 + lines.length * 38 + 30;
    if (draw) {
      fill(C.orangeSoft); roundRect(ctx, left, y, width, boxH, 28); ctx.fill();
      ctx.strokeStyle = C.orangeLine; ctx.lineWidth = 2; roundRect(ctx, left + 1, y + 1, width - 2, boxH - 2, 27); ctx.stroke();
    }
    font(800, 28); fill('#9a3412'); text('Before we arrive', left + 36, y + 40 + 24);
    font(500, 27); fill(C.text);
    let py = y + 40 + 34 + 16 + 26;
    for (const l of lines) { text(l, left + 36, py); py += 38; }
    y += boxH + 48;
  }

  // Reference and contact.
  y = rule(y) + 44;
  font(700, 26); fill(C.muted);
  text(`Reference ${d.reference}${d.jobNumber ? `  ·  Job #${d.jobNumber}` : ''}`, left, y + 26);
  y += 44;
  const contact = [d.phone ? displayPhone(d.phone) : '', d.email || ''].filter(Boolean).join('  ·  ');
  if (contact) {
    font(500, 26); fill(C.muted);
    for (const l of wrap(ctx, `Questions? ${contact}`, width)) { text(l, left, y + 26); y += 38; }
  }
  return y + 40 + PAD;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Draws the card and returns it as a PNG. */
export async function renderAppointmentCard(data: AppointmentCardData, logoSrc = '/bob-avatar.png'): Promise<Blob> {
  // The page's own fonts, so the card matches the chat. If they can't load, system fonts are used.
  try {
    await Promise.all([`800 64px ${DISPLAY}`, `700 30px ${BODY}`, `500 30px ${BODY}`].map((f) => document.fonts.load(f)));
  } catch {}
  const logo = await loadImage(logoSrc);
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('This browser cannot draw the card.');
  const height = Math.ceil(paint(measure, data, logo, false, 0));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the card.');
  paint(ctx, data, logo, true, height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The card could not be saved.'))), 'image/png'));
}
