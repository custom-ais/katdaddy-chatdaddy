// Display-only US phone formatting. Unsupported input is preserved for validation.
export function formatUsPhone(value) {
  const raw = String(value ?? '');
  if (!/^[\d\s()+.\-]*$/.test(raw)) return raw;
  let digits = raw.replace(/\D/g, '');
  if (raw.includes('+') && !/^\s*\+1(?:\D|\d)/.test(raw)) return raw;
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  else if (digits.length > 10 || raw.includes('+')) return raw;
  if (!digits) return '';
  if (digits.length < 3) return `(${digits}`;
  if (digits.length === 3) return `(${digits})`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function phoneEdit(previous, raw, start = raw.length, end = start, inputType = '') {
  const old = String(previous ?? '');
  let source = String(raw ?? '');
  let before = source.slice(0, start).replace(/\D/g, '').length;
  let through = source.slice(0, end).replace(/\D/g, '').length;
  // Deleting a separator must delete a digit too, rather than trap the cursor.
  const digits = source.replace(/\D/g, '');
  if (/^deleteContent(Backward|Forward)$/.test(inputType) && source.length < old.length && digits === old.replace(/\D/g, '') && formatUsPhone(source) !== source) {
    const index = inputType === 'deleteContentBackward' ? before - 1 : before;
    if (index >= 0 && index < digits.length) {
      source = digits.slice(0, index) + digits.slice(index + 1);
      before = through = Math.max(0, index);
    }
  }
  const value = formatUsPhone(source);
  if (value === source) return { value, start: Math.min(start, value.length), end: Math.min(end, value.length) };
  const countryRemoved = source.replace(/\D/g, '').length === 11 && value.replace(/\D/g, '').length === 10;
  if (countryRemoved) { before = Math.max(0, before - 1); through = Math.max(0, through - 1); }
  const atDigit = (n) => {
    if (!n) return 0;
    let count = 0;
    for (let i = 0; i < value.length; i++) if (/\d/.test(value[i]) && ++count === n) return i + 1;
    return value.length;
  };
  return { value, start: atDigit(before), end: atDigit(through) };
}
