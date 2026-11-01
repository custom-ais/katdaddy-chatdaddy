// Booking verification codes are 4 digits, by text and by email, for every provider.
// Twilio Verify generates its own codes: its service's Code Length must be set to 4 to match.
export const CODE_DIGITS = 4;
export const isVerificationCode = (code) => new RegExp(`^\\d{${CODE_DIGITS}}$`).test(String(code ?? ''));
