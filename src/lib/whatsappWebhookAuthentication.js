'use strict';
const { createHmac, timingSafeEqual } = require('node:crypto');
const MAX_BYTES = 1024 * 1024;
function reject(code, status) { throw Object.assign(Error(code), { code, status }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const graphId = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);

function authenticate(req, env = process.env) {
  const secret = env.FACEBOOK_APP_SECRET || env.APP_SECRET;
  if (typeof secret !== 'string' || !secret.trim()) reject('whatsapp_webhook_unavailable', 503);
  if (!Buffer.isBuffer(req.rawBody)) reject('whatsapp_webhook_unavailable', 503);
  if (req.rawBody.length > MAX_BYTES) reject('whatsapp_webhook_too_large', 413);
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json' || !['', 'identity'].includes(String(req.headers['content-encoding'] || '').toLowerCase())) {
    reject('whatsapp_webhook_media_type', 415);
  }
  const signature = req.headers['x-hub-signature-256'];
  const count = (req.rawHeaders || []).filter((header, index) => index % 2 === 0 && header.toLowerCase() === 'x-hub-signature-256').length;
  if (count !== 1 || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) reject('whatsapp_webhook_signature_invalid', 401);
  const expected = createHmac('sha256', secret).update(req.rawBody).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) reject('whatsapp_webhook_signature_invalid', 401);
  // Only the exact authenticated bytes may become the business payload.
  let body;
  try { body = JSON.parse(req.rawBody.toString('utf8')); } catch { reject('whatsapp_webhook_payload_invalid', 400); }
  if (!object(body) || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry) || body.entry.length !== 1) reject('whatsapp_webhook_payload_invalid', 400);
  const entry = body.entry[0];
  if (!object(entry) || !graphId(entry.id) || !Array.isArray(entry.changes) || entry.changes.length !== 1) reject('whatsapp_webhook_payload_invalid', 400);
  const change = entry.changes[0];
  if (!object(change) || typeof change.field !== 'string' || !/^[a-z_]{1,64}$/.test(change.field) || !object(change.value)) reject('whatsapp_webhook_payload_invalid', 400);
  const value = change.value;
  if (value.metadata !== undefined && (!object(value.metadata) || !graphId(value.metadata.phone_number_id))) reject('whatsapp_webhook_payload_invalid', 400);
  // The current worker receives one clinic/contact per job. Do not let an
  // unsupported provider batch run under the scope of its first message.
  const contacts = [];
  for (const [key, contactKey] of [['messages', 'from'], ['message_echoes', 'to']]) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length > 1) reject('whatsapp_webhook_batch_unsupported', 400);
    for (const message of value[key]) {
      if (!object(message) || !graphId(message[contactKey])) reject('whatsapp_webhook_payload_invalid', 400);
      contacts.push(message[contactKey]);
    }
  }
  if (value.history !== undefined) {
    if (!Array.isArray(value.history) || value.history.length > 100) reject('whatsapp_webhook_payload_invalid', 400);
    for (const block of value.history) {
      if (!object(block) || !Array.isArray(block.threads) || block.threads.length > 100) reject('whatsapp_webhook_payload_invalid', 400);
      for (const thread of block.threads) {
        if (!object(thread) || !graphId(thread.id)) reject('whatsapp_webhook_payload_invalid', 400);
        contacts.push(thread.id);
      }
    }
  }
  if (new Set(contacts).size > 1) reject('whatsapp_webhook_batch_unsupported', 400);
  return body;
}

function subscription(req, env = process.env) {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  const tokens = [env.WHATSAPP_VERIFY_TOKEN, env.META_WEBHOOK_VERIFY_TOKEN, env.META_VERIFY_TOKEN]
    .filter(value => typeof value === 'string' && value.trim());
  if (mode !== 'subscribe' || typeof token !== 'string' || token.length > 512 || typeof challenge !== 'string' || !/^[0-9]{1,128}$/.test(challenge)) return null;
  const supplied = createHmac('sha256', 'whatsapp-webhook-subscription').update(token).digest();
  const valid = tokens.reduce((found, value) => timingSafeEqual(supplied, createHmac('sha256', 'whatsapp-webhook-subscription').update(value).digest()) || found, false);
  return valid ? challenge : null;
}
module.exports = { authenticate, subscription, MAX_BYTES };
