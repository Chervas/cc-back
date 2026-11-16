'use strict';

// This namespace records an operator's correction hold for one request cycle.
// It is not consent, an opt-out or permission to change an existing message.
const KEY = 'review_attribution_hold';
function assertReviewAttributionClear(item) {
  const plain = item?.get ? item.get({ plain: true }) : item;
  const fields = plain?.custom_fields;
  if (!fields || !Object.prototype.hasOwnProperty.call(fields, KEY) || fields[KEY] == null) return;
  // Malformed or caller-defined release flags do not silently authorize sends.
  throw Object.assign(new Error('La solicitud está retenida porque se está corrigiendo la sede de su atención.'), {
    code: 'review_attribution_held', reason: 'review_attribution_held',
    status: 409, statusCode: 409, retryable: false,
  });
}
module.exports = { KEY, assertReviewAttributionClear };
