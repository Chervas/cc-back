'use strict';

const { createHmac, timingSafeEqual, createHash } = require('node:crypto');
const { fail } = require('./errors');
const operation = 'meta.marketing.social.verify.v1';

function verifyBody(p, secret) {
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
  return { digest: createHash('sha256').update(raw).digest('hex') };
}
module.exports = { operation, verifyBody };
