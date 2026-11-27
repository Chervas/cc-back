'use strict';

const { createHmac, timingSafeEqual, createHash } = require('node:crypto');
const { fail } = require('./errors');
const operation = 'meta.marketing.social.verify.v1';

function verifyBody(p, secret, accounts, resolveRecipient) {
  const raw = Buffer.from(p.rawBase64, 'base64');
  if (!raw.length || raw.length > 65536 || raw.toString('base64') !== p.rawBase64)
    fail('invalid_request');
  if (
    !timingSafeEqual(
      createHmac('sha256', secret).update(raw).digest(),
      Buffer.from(p.signature.slice(7), 'hex'),
    )
  )
    fail('invalid_signature');
  let body;
  try { body = JSON.parse(raw); } catch { fail('invalid_request'); }
  const channel = { page: 'messenger', instagram: 'instagram' }[body?.object];
  if (!channel || !Array.isArray(body.entry) || !Array.isArray(accounts)) fail('invalid_request');
  const recipients = new Set(body.entry.map(entry => entry?.id));
  const rows = [...accounts];
  if (resolveRecipient) {
    if (recipients.size > 1000) fail('invalid_request');
    for (const accountId of recipients) {
      if (!require('./meta-marketing-contract').graphId(accountId)) continue;
      const dynamic = resolveRecipient(channel, accountId);
      if (!dynamic) continue;
      if (dynamic.conflict) { recipients.delete(accountId); continue; }
      const explicit = rows.find(a => a.channel === channel && a.accountId === accountId);
      if (!explicit) rows.push(dynamic);
      else if (explicit.clinicId !== dynamic.clinicId || explicit.pageId !== dynamic.pageId) recipients.delete(accountId);
    }
  }
  const destinations = rows
    .filter(account => account.channel === channel && recipients.has(account.accountId))
    .map(({ accountId, clinicId }) => ({ accountId, clinicId }));
  return { digest: createHash('sha256').update(raw).digest('hex'), destinations };
}
module.exports = { operation, verifyBody };
