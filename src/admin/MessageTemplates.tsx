import React, { useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { MESSAGE_TEMPLATE_FIELDS, MESSAGE_VARIABLES, CUSTOMER_SMS_FOOTER, renderMessageTemplate } from '../../shared/message-templates.mjs';
import { Field, Section, inputClass, secondaryButton } from './ui';

export function confirmationChannel(config: any) {
  return config.smsConfirmations ? (config.emailConfirmations ? 'both' : 'text') : config.emailConfirmations ? 'email' : 'off';
}
export function confirmationChannelPatch(value: string) {
  return { smsConfirmations: value === 'text' || value === 'both', emailConfirmations: value === 'email' || value === 'both' };
}
export function insertTemplateVariable(value: string, start: number, end: number, key: string) {
  const token = `{{${key}}}`;
  return { value: value.slice(0, start) + token + value.slice(end), caret: start + token.length };
}
function TemplateEditor({ field, value, onChange }: { field: any; value: string; onChange: (value: string) => void }) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const variables = MESSAGE_VARIABLES.filter((variable: any) => !field.variables || field.variables.includes(variable.key));
  const [variable, setVariable] = useState(variables[0]?.key || '');
  const samples = Object.fromEntries(MESSAGE_VARIABLES.map((item: any) => [item.key, item.sample]));
  let preview = '', error = '';
  if (value.trim()) {
    try { preview = renderMessageTemplate(value, samples, field);
      if (field.key === 'confirmationSms') preview = preview.trim() + ' ' + CUSTOMER_SMS_FOOTER; }
    catch (e) { error = (e as Error).message; }
  }
  const insert = () => {
    const element = editor.current;
    const next = insertTemplateVariable(value, element?.selectionStart ?? value.length, element?.selectionEnd ?? value.length, variable);
    onChange(next.value);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(next.caret, next.caret); });
  };
  return <div className="space-y-3 rounded-2xl border border-slate-200 p-4">
    <Field label={field.label} hint={`Plain text only. Blank uses the built-in default. Maximum ${field.maxLength} characters.`}>
      <textarea ref={editor} className={`${inputClass} min-h-24`} rows={field.subject ? 2 : 5} value={value} onChange={event => onChange(event.target.value)} aria-label={field.label} />
    </Field>
    <div className="flex flex-wrap items-end gap-2"><Field label={`Variable for ${field.label}`}><select className={inputClass} value={variable} onChange={event => setVariable(event.target.value)}>{variables.map((item: any) => <option key={item.key} value={item.key}>{item.label} — {`{{${item.key}}}`}</option>)}</select></Field><button type="button" className={secondaryButton} onClick={insert}>Insert at cursor</button><button type="button" className={secondaryButton} onClick={() => onChange('')} disabled={!value}>Reset to default</button></div>
    {error && <p role="alert" className="text-sm font-semibold text-rose-700">{error}</p>}
    <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs font-bold text-slate-500">Sample preview — fictional details, nothing is sent</p><p className="whitespace-pre-wrap break-words text-sm text-slate-700">{value.trim() ? preview || 'Fix the template error to preview.' : 'Built-in default will be used. No custom message is saved.'}</p></div>
  </div>;
}
export function MessageTemplates({ config, integrations, onPatch }: { config: any; integrations: any; onPatch: (patch: any) => void }) {
  const textReady = integrations?.sms?.enabled !== false && integrations?.sms?.configured;
  const emailReady = integrations?.email?.enabled !== false && integrations?.email?.configured;
  return <Section icon={<MessageSquare size={18} />} title="Message templates" description="These drafts use the page’s Save button. Only successful appointment confirmations and optional owner booking alerts are editable here. Verification codes and emergency approval requests are separate and unchanged.">
    <Field label="Customer booking confirmation channel"><select className={inputClass} value={confirmationChannel(config)} onChange={event => onPatch(confirmationChannelPatch(event.target.value))}><option value="text">Text</option><option value="email">Email</option><option value="both">Both</option><option value="off">Off — neither channel</option></select></Field>
    <p className="text-sm text-slate-600">Text sender: {textReady ? 'configured; delivery not confirmed' : 'unavailable or disabled'}. Email sender: {emailReady ? 'configured; delivery not confirmed' : 'unavailable or disabled'}. Choosing a channel does not enable or configure its connection.</p>
    <p className="text-sm text-slate-600">Texts require customer consent; the STOP footer is added automatically. Email requires a customer email address and the email channel selected. No automatic email fallback when email is off. Owner alerts still require their separate enabled setting and recipient.</p>
    <p className="text-xs text-slate-500">Client Hub links belong only in confirmation email bodies and require the separately saved, account-bound Client Hub setting. Do not paste customer-specific links or secrets into templates.</p>
    {MESSAGE_TEMPLATE_FIELDS.map((field: any) => <TemplateEditor key={field.key} field={field} value={config.messageTemplates?.[field.key] || ''} onChange={value => onPatch({ messageTemplates: { ...config.messageTemplates, [field.key]: value } })} />)}
  </Section>;
}
