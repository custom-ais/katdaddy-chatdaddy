import sanitizeHtml from 'sanitize-html';
import { parseDocument } from 'htmlparser2';
import { renderMessageTemplate, MESSAGE_TEMPLATE_FIELDS } from '../shared/message-templates.mjs';
import { normalizeClientHubUrl } from '../shared/client-hub.mjs';
const tokens = /\{\{([a-z][a-z0-9_]*)\}\}/g;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hubHost = value => { try { const host = new URL(value).hostname.toLowerCase().replace(/\.+$/, ''); return host === 'clienthub.getjobber.com' || host === 'clienthub.jobber.com'; } catch { return false; } };
const blocked = new Set(['script','style','iframe','svg','math','textarea','title','noscript','xmp','plaintext']);

/** A real HTML parser validates placeholder contexts before values are inserted. */
export function validateHtmlTemplate(template) {
  const errors=[];
  try { renderMessageTemplate(template, {}, MESSAGE_TEMPLATE_FIELDS[2]); } catch(error) { return [error.message]; }
  let counted=0;
  const doc=parseDocument(template);
  function walk(node, forbidden=false) {
    const denied=forbidden || blocked.has(node.name);
    if(node.type==='text') {
      const found=[...node.data.matchAll(tokens)]; counted+=found.length;
      if(denied && found.length) errors.push('Variables are not allowed in script, style or other active content.');
    }
    if(node.name && /[{}]/.test(node.name)) errors.push('Variables cannot appear in tag names.');
    for(const [name,value] of Object.entries(node.attribs||{})) {
      if(/[{}]/.test(name)) errors.push('Variables cannot appear in attribute names.');
      const found=[...value.matchAll(tokens)]; counted+=found.length;
      if(found.length && !(node.name==='a' && name==='href' && value==='{{client_hub_url}}')) errors.push('Attribute variables are allowed only as href="{{client_hub_url}}" on a link.');
      if(name==='href' && value!=='{{client_hub_url}}' && hubHost(value)) errors.push('Use the account-bound {{client_hub_url}} variable instead of a pasted Client Hub link.');
    }
    for(const child of node.children||[]) walk(child,denied);
  }
  walk(doc);
  if(counted!==[...template.matchAll(tokens)].length) errors.push('A variable appears in an unsupported HTML context.');
  return [...new Set(errors)];
}
const options={
  allowedTags:['p','br','div','span','h1','h2','h3','h4','strong','b','em','i','u','s','ul','ol','li','blockquote','hr','table','thead','tbody','tfoot','tr','td','th','a'],
  allowedAttributes:{'*':['style'],a:['href','title'],table:['role','cellpadding','cellspacing','width'],td:['colspan','rowspan','width'],th:['colspan','rowspan','width']},
  allowedSchemes:['https','mailto','tel'],allowProtocolRelative:false,
  nonTextTags:['script','style','textarea','option','iframe','svg','math','noscript'],
  allowedStyles:{'*':{
    color:[/^(?:#[a-fA-F0-9]{3,8}|[a-zA-Z]{1,20})$/], 'background-color':[/^(?:#[a-fA-F0-9]{3,8}|[a-zA-Z]{1,20})$/],
    'font-size':[/^\d{1,2}(?:px|pt)$/], 'font-weight':[/^(?:normal|bold|[1-9]00)$/],
    'font-family':[/^(?:Arial|Helvetica|Verdana|Georgia|sans-serif|serif|monospace)(?:,\s*(?:Arial|Helvetica|Verdana|Georgia|sans-serif|serif|monospace))*$/],
    'text-align':[/^(?:left|right|center)$/], 'text-decoration':[/^(?:none|underline|line-through)$/],
    padding:[/^\d{1,2}px(?: \d{1,2}px){0,3}$/], margin:[/^\d{1,2}px(?: \d{1,2}px){0,3}$/],
    'border-collapse':[/^(?:collapse|separate)$/], 'border-radius':[/^\d{1,2}px$/],
    'line-height':[/^(?:[12](?:\.\d{1,2})?|\d{1,2}px)$/],
  }},
  transformTags:{a:(tagName,attribs)=>({tagName,attribs:{...attribs,...(!attribs.href?.trim()?{href:undefined}:{})}})},
};
export function sanitizeEmailHtml(html) { return sanitizeHtml(html,options); }
export function htmlToPlainText(html) {
  const doc=parseDocument(html); let out='';
  const blocks=new Set(['p','div','h1','h2','h3','h4','li','blockquote','tr','table','ul','ol']);
  function walk(node) {
    if(node.type==='text') out+=node.data;
    if(node.name==='br'||node.name==='hr') out+='\n';
    if(node.name==='li') out+='• ';
    for(const child of node.children||[]) walk(child);
    if(node.name==='a'&&node.attribs?.href) out+=' ('+node.attribs.href+')';
    if(node.name==='td'||node.name==='th') out+='\t';
    if(blocks.has(node.name)) out+='\n';
  }
  walk(doc);return out.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function renderHtmlTemplate(template,values) {
  const errors=validateHtmlTemplate(template);if(errors.length) throw new Error(errors.join(' '));
  let hub='';try{hub=normalizeClientHubUrl(values?.client_hub_url||'');}catch{}
  const safe={...values,client_hub_url:hub};
  const expanded=renderMessageTemplate(template,Object.fromEntries(Object.entries(safe).map(([k,v])=>[k,escape(v)])),MESSAGE_TEMPLATE_FIELDS[2]);
  const html=sanitizeEmailHtml(expanded);
  const text=htmlToPlainText(html);
  if(!text) throw new Error('Email HTML must contain readable text.');
  return {html,text};
}
