'use strict';

const { createHmac, timingSafeEqual, createHash } = require('node:crypto');
const { fail } = require('./errors');
const operation = 'meta.marketing.social.verify.v1';

function verifyBody(p, secret, accounts) {
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
  const destinations = accounts
    .filter(account => account.channel === channel && recipients.has(account.accountId))
    .map(({ accountId, clinicId }) => ({ accountId, clinicId }));
  return { digest: createHash('sha256').update(raw).digest('hex'), destinations };
}
module.exports = { operation, verifyBody };
