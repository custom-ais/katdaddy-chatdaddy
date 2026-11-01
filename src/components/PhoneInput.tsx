import React, { forwardRef } from 'react';
import { formatUsPhone, phoneEdit } from '../../shared/phone-display.mjs';

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string | undefined;
  onValueChange: (value: string) => void;
  formatPhone?: boolean;
};

/** Controlled display formatter; the server still validates/normalizes the value. */
export const PhoneInput = forwardRef<HTMLInputElement, Props>(function PhoneInput({ value, onValueChange, formatPhone = true, ...props }, ref) {
  const displayed = formatPhone ? formatUsPhone(value) : value || '';
  return <input {...props} ref={ref} value={displayed} onChange={(event) => {
    const input = event.currentTarget;
    if (!formatPhone || (event.nativeEvent as InputEvent).isComposing) { onValueChange(input.value); return; }
    const next = phoneEdit(displayed, input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, (event.nativeEvent as InputEvent).inputType || '');
    onValueChange(next.value);
    requestAnimationFrame(() => {
      if (document.activeElement === input && input.value === next.value) input.setSelectionRange(next.start, next.end);
    });
  }} />;
});
