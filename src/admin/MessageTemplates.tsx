import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
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
export function emailPreviewDocument(sanitizedHtml: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'"></head><body>${sanitizedHtml}</body></html>`;
}
export function SanitizedEmailPreview({html,text}: {html:string; text:string}) {
  return <><iframe title="Sanitized confirmation email preview" sandbox="" referrerPolicy="no-referrer" tabIndex={-1} inert className="h-80 w-full rounded border border-slate-200 bg-white pointer-events-none" srcDoc={emailPreviewDocument(html)} /><details><summary className="text-sm font-semibold">Plain-text alternative</summary><p className="whitespace-pre-wrap break-words text-sm">{text}</p></details></>;
}
export async function requestHtmlPreview(template: string, request = api): Promise<{html: string; text: string}> {
  const result = await request('/api/admin/templates/preview', {method:'POST',body:{template}});
  if (typeof result?.html !== 'string' || typeof result?.text !== 'string') throw new Error('The sanitized preview is unavailable.');
  return {html:result.html,text:result.text};
}
function TemplateEditor({ field, value, onChange, emailFormat = 'plain' }: { field: any; value: string; onChange: (value: string) => void; emailFormat?: string }) {
  const htmlMode = field.key === 'confirmationEmailBody' && emailFormat === 'html';
  const [htmlPreview, setHtmlPreview] = useState<{html:string; text:string; source:string} | null>(null);
  const [previewError, setPreviewError] = useState(''), [previewBusy, setPreviewBusy] = useState(false);
  const generation = useRef(0);
  const sourceKey = `${emailFormat}:${value}`;
  const currentSource = useRef(sourceKey); currentSource.current = sourceKey;
  const clearPreview = () => { generation.current++; setHtmlPreview(null); setPreviewError(''); setPreviewBusy(false); };
  useEffect(() => { clearPreview(); }, [sourceKey]);
  const change = (next: string) => { clearPreview(); onChange(next); };
  const previewHtml = async () => {
    const version = ++generation.current, source = sourceKey;
    setPreviewBusy(true); setPreviewError(''); setHtmlPreview(null);
    try {
      const result = await requestHtmlPreview(value);
      if (version === generation.current && source === currentSource.current) setHtmlPreview({...result, source});
    } catch (e) { if (version === generation.current && source === currentSource.current) setPreviewError((e as Error).message); }
    finally { if (version === generation.current && source === currentSource.current) setPreviewBusy(false); }
  };
  const editor = useRef<HTMLTextAreaElement>(null);
  const variables = MESSAGE_VARIABLES.filter((variable: any) => !field.variables || field.variables.includes(variable.key));
  const [variable, setVariable] = useState(variables[0]?.key || '');
  const samples = Object.fromEntries(MESSAGE_VARIABLES.map((item: any) => [item.key, item.sample]));
  let preview = '', error = '';
  if (value.trim() && !htmlMode) {
    try { preview = renderMessageTemplate(value, samples, field);
      if (field.key === 'confirmationSms') preview = preview.trim() + ' ' + CUSTOMER_SMS_FOOTER; }
    catch (e) { error = (e as Error).message; }
  }
  const insert = () => {
    const element = editor.current;
    const next = insertTemplateVariable(value, element?.selectionStart ?? value.length, element?.selectionEnd ?? value.length, variable);
    change(next.value);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(next.caret, next.caret); });
  };
  return <div className="space-y-3 rounded-2xl border border-slate-200 p-4">
    <Field label={field.label} hint={<>{`${htmlMode ? 'HTML mode: unsupported elements, attributes and styles are removed. External images and active content are not supported.' : 'Plain text only.'} Blank uses the built-in default. Maximum ${field.maxLength} characters.`}{field.key === 'ownerBookingSms' && <span className="block mt-1">Start with "Custom-AIs ChatDaddy alert:" and end with "Reply STOP to opt out." to match the registered campaign.</span>}</>}>
      <textarea ref={editor} className={`${inputClass} min-h-24`} rows={field.subject ? 2 : 5} value={value} onChange={event => change(event.target.value)} aria-label={field.label} />
    </Field>
    <div className="flex flex-wrap items-end gap-2"><Field label={`Variable for ${field.label}`}><select className={inputClass} value={variable} onChange={event => setVariable(event.target.value)}>{variables.map((item: any) => <option key={item.key} value={item.key}>{item.label} — {`{{${item.key}}}`}</option>)}</select></Field><button type="button" className={secondaryButton} onClick={insert}>Insert at cursor</button><button type="button" className={secondaryButton} onClick={() => change('')} disabled={!value}>Reset to default</button></div>
    {error && <p role="alert" className="text-sm font-semibold text-rose-700">{error}</p>}
    <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs font-bold text-slate-500">Sample preview — fictional details, nothing is sent</p>{htmlMode && value.trim() ? <div className="space-y-3">
      <button type="button" className={secondaryButton} onClick={previewHtml} disabled={previewBusy}>{previewBusy ? 'Preparing safe preview…' : 'Preview HTML safely'}</button>
      <p className="text-xs text-slate-500">Preview uses the server’s sanitizer and fictional sample data. It does not save, send, load remote images or open links.</p>
      {previewError && <p role="alert" className="text-sm text-rose-700">{previewError}</p>}
      {htmlPreview && htmlPreview.source === sourceKey && <SanitizedEmailPreview html={htmlPreview.html} text={htmlPreview.text} />}
    </div> : <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{value.trim() ? preview || 'Fix the template error to preview.' : 'Built-in default will be used. No custom message is saved.'}</p>}</div>
  </div>;
}
export function MessageTemplates({ config, integrations, onPatch, allowOwner = false, allowMessaging = false }: { config: any; integrations: any; onPatch: (patch: any) => void; allowOwner?: boolean; allowMessaging?: boolean }) {
  const textReady = integrations?.sms?.enabled !== false && integrations?.sms?.configured;
  const emailReady = integrations?.email?.enabled !== false && integrations?.email?.configured;
  return <Section icon={<MessageSquare size={18} />} title="Message templates" description="These drafts use the page’s Save button. Only successful appointment confirmations and optional owner booking alerts are editable here. Verification codes and emergency approval requests are separate and unchanged.">
    {allowMessaging && <Field label="Customer booking confirmation channel"><select className={inputClass} value={confirmationChannel(config)} onChange={event => onPatch(confirmationChannelPatch(event.target.value))}><option value="text">Text</option><option value="email">Email</option><option value="both">Both</option><option value="off">Off — neither channel</option></select></Field>}
    <p className="text-sm text-slate-600">Text sender: {textReady ? 'configured; delivery not confirmed' : 'unavailable or disabled'}. Email sender: {emailReady ? 'configured; delivery not confirmed' : 'unavailable or disabled'}. Choosing a channel does not enable or configure its connection.</p>
    <p className="text-sm text-slate-600">Texts require customer consent; the STOP footer is added automatically. Email requires a customer email address and the email channel selected. No automatic email fallback when email is off. Owner alerts still require their separate enabled setting and recipient.</p>
    <p className="text-xs text-slate-500">Client Hub links belong only in confirmation email bodies and require the separately saved, account-bound Client Hub setting. Do not paste customer-specific links or secrets into templates.</p>
    <Field label="Confirmation email body format" hint="Plain text preserves existing templates. HTML allows supported formatting only. Changing mode keeps your current body text; review its preview before saving."><select className={inputClass} value={config.messageEmailFormat || 'plain'} onChange={event => onPatch({messageEmailFormat:event.target.value})}><option value="plain">Plain text</option><option value="html">HTML — sanitized formatting</option></select></Field>
    {MESSAGE_TEMPLATE_FIELDS.filter((field: any) => field.key === 'ownerBookingSms' ? allowOwner : field.key === 'confirmationSms' ? allowMessaging : true).map((field: any) => <TemplateEditor key={field.key} field={field} emailFormat={config.messageEmailFormat || 'plain'} value={config.messageTemplates?.[field.key] || ''} onChange={value => onPatch({ messageTemplates: { ...config.messageTemplates, [field.key]: value } })} />)}
  </Section>;
}
