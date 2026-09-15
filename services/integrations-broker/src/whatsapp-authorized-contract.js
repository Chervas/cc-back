'use strict';
const { createHash } = require('node:crypto');
const E = require('./whatsapp-onboarding-contract'); const { fail } = require('./errors');
const PROVIDER = 'meta_whatsapp_authorized'; const COHORT = 'whatsapp-authorized-v1';
const SEND = 'meta.whatsapp.authorized.send.v1'; const REVOKE = 'meta.whatsapp.authorized.phone.revoke.v1';
const keys = (v, required, optional = []) => E.exact(v, [...required, ...optional.filter(k => Object.hasOwn(v || {}, k))]);
const text = (v, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max;
function httpsUrl(v) { try { const u = new URL(v); return text(v, 2048) && u.href === v && u.protocol === 'https:' && !u.username && !u.password && !u.port; } catch { return false; } }
function requireValue(value) { if (!value) fail('invalid_request'); }
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => k !== 'example').sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function definitionComponents(raw) {
  const components = raw?.components;
  requireValue(Array.isArray(components) && components.length >= 1 && components.length <= 4
    && new Set(components.map(c => c?.type)).size === components.length && components.some(c => c.type === 'BODY'));
  for (const c of components) {
    if (c.type === 'BUTTONS') {
      requireValue(keys(c, ['type','buttons']) && Array.isArray(c.buttons) && c.buttons.length > 0 && c.buttons.length <= 10);
      for (const b of c.buttons) {
        requireValue(text(b?.text, 25));
        if (b.type === 'QUICK_REPLY') requireValue(keys(b, ['type','text']));
        else if (b.type === 'URL') requireValue(keys(b, ['type','text','url'], ['example']) && typeof b.url === 'string' && httpsUrl(b.url.replace(/\{\{1\}\}$/, 'example'))
          && !/{{|}}/.test(b.url.replace(/\{\{1\}\}$/, '')));
        else if (b.type === 'PHONE_NUMBER') requireValue(keys(b, ['type','text','phone_number']) && /^\+?[1-9][0-9]{6,14}$/.test(b.phone_number));
        else fail('invalid_request');
      }
    } else if (c.type === 'HEADER' && c.format === 'IMAGE') requireValue(keys(c, ['type','format'], ['example']));
    else requireValue(['BODY','HEADER','FOOTER'].includes(c.type) && keys(c, ['type','text'], c.type === 'HEADER' ? ['format','example'] : ['example'])
      && text(c.text) && (c.type !== 'HEADER' || c.format === 'TEXT') && (c.type !== 'FOOTER' || !/{{|}}/.test(c.text)));
  }
  return components;
}
function templateDigest(raw) { return createHash('sha256').update(canonical(definitionComponents(raw))).digest('hex'); }
function validateMessage(message) {
  requireValue(keys(message, ['messaging_product','to','type', message?.type], ['recipient_type']) && message.messaging_product === 'whatsapp'
    && typeof message.to === 'string' && /^\+?[1-9][0-9]{6,14}$/.test(message.to) && (!Object.hasOwn(message, 'recipient_type') || message.recipient_type === 'individual'));
  if (message.type === 'text') requireValue(keys(message.text, ['body'], ['preview_url']) && text(message.text.body)
    && (!Object.hasOwn(message.text, 'preview_url') || typeof message.text.preview_url === 'boolean'));
  else if (message.type === 'interactive') {
    const v = message.interactive;
    requireValue(keys(v, ['type','body','action']) && v.type === 'cta_url' && keys(v.body, ['text']) && text(v.body.text, 1024)
      && keys(v.action, ['name','parameters']) && v.action.name === 'cta_url' && keys(v.action.parameters, ['display_text','url'])
      && text(v.action.parameters.display_text, 20) && httpsUrl(v.action.parameters.url));
  } else if (message.type === 'template') {
    const v = message.template;
    requireValue(keys(v, ['name','language'], ['components']) && /^[a-z0-9_]{1,512}$/.test(v.name)
      && keys(v.language, ['code']) && /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(v.language.code));
    if (v.components !== undefined) {
      requireValue(Array.isArray(v.components) && v.components.length <= 12);
      const seen = new Set();
      for (const c of v.components) {
        requireValue(['header','body','button'].includes(c?.type));
        const button = c.type === 'button'; const key = button ? 'button:' + c.index : c.type;
        requireValue(!seen.has(key) && keys(c, button ? ['type','sub_type','index','parameters'] : ['type','parameters'])
          && Array.isArray(c.parameters) && c.parameters.length >= 1 && c.parameters.length <= 20);
        seen.add(key);
        if (button) requireValue(['quick_reply','url'].includes(c.sub_type) && /^[0-9]$/.test(c.index) && c.parameters.length === 1);
        if (c.type === 'header') requireValue(c.parameters.length === 1);
        for (const p of c.parameters) {
          if (c.type === 'header' && p?.type === 'image') requireValue(keys(p, ['type','image']) && keys(p.image, ['link']) && httpsUrl(p.image.link));
          else if (button && c.sub_type === 'quick_reply') requireValue(keys(p, ['type','payload']) && p.type === 'payload' && text(p.payload, 128));
          else requireValue(keys(p, ['type','text']) && p.type === 'text' && text(p.text, 1024));
        }
      }
    }
  } else fail('invalid_request');
  requireValue(Buffer.byteLength(JSON.stringify(message)) <= 24576); return message;
}
function validateSend(payload) {
  requireValue(keys(payload, ['authorizationId','phoneId','message']) && E.uuid(payload.authorizationId) && E.id(payload.phoneId));
  validateMessage(payload.message); return payload;
}
function parameterCount(value) {
  const all = [...value.matchAll(/{{([1-9][0-9]*)}}/g)].map(m => Number(m[1])); const unique = [...new Set(all)].sort((a,b) => a-b);
  requireValue(unique.length <= 20 && unique.every((v,i) => v === i+1) && !/{{|}}/.test(value.replace(/{{[1-9][0-9]*}}/g, ''))); return unique.length;
}
function verifyTemplate(raw, pin, message) {
  if (raw?.error || raw.id !== pin.id || raw.name !== pin.name || raw.language !== pin.language || raw.status !== 'APPROVED'
    || templateDigest(raw) !== pin.contentDigest) fail('operation_denied');
  const components = definitionComponents(raw); const supplied = message.template.components || [];
  for (const kind of ['BODY','HEADER']) {
    const definition = components.find(c => c.type === kind); const c = supplied.find(c => c.type === kind.toLowerCase());
    const count = definition?.format === 'IMAGE' ? 1 : definition?.text ? parameterCount(definition.text) : 0;
    if ((c?.parameters.length || 0) !== count || c && c.parameters.some(p => p.type !== (definition?.format === 'IMAGE' ? 'image' : 'text'))) fail('operation_denied');
  }
  const buttons = components.find(c => c.type === 'BUTTONS')?.buttons || [];
  for (const c of supplied.filter(c => c.type === 'button')) {
    const b = buttons[Number(c.index)]; if (!b || b.type.toLowerCase() !== c.sub_type) fail('operation_denied');
    if (c.sub_type === 'url') {
      if (!b.url.endsWith('{{1}}')) fail('operation_denied');
      const full = b.url.replace('{{1}}', c.parameters[0].text);
      if (!httpsUrl(full) || new URL(full).origin !== new URL(b.url.replace('{{1}}','example')).origin) fail('operation_denied');
    }
  }
  for (let i=0;i<buttons.length;i++) if (buttons[i].type === 'URL' && buttons[i].url.endsWith('{{1}}')
    && !supplied.some(c => c.type === 'button' && Number(c.index) === i && c.sub_type === 'url')) fail('operation_denied');
  return true;
}
function projectResult(raw) {
  if (raw?.error || raw?.messaging_product && raw.messaging_product !== 'whatsapp' || !Array.isArray(raw?.messages) || raw.messages.length !== 1) fail('provider_failed');
  const m = raw.messages[0];
  if (!/^wamid\.[A-Za-z0-9+/=_-]{2,512}$/.test(m?.id) || m.message_status !== undefined && !['accepted','held_for_quality_assessment'].includes(m.message_status)) fail('provider_failed');
  return { messages: [{ id: m.id, ...(m.message_status !== undefined ? { message_status: m.message_status } : {}) }] };
}
module.exports = { PROVIDER, COHORT, SEND, REVOKE, keys, httpsUrl, validateMessage, validateSend, templateDigest, verifyTemplate, projectResult };
