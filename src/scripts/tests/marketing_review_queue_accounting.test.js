'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../services/marketingBulkSends.service.js'),
  'utf8'
);

const { reviewItemBlocksRepeat } = require('../../lib/review-request-history');
assert(reviewItemBlocksRepeat({sent_at:new Date(),list_status:'archived'}),
  'archivar una lista no olvida un envio real');
assert(reviewItemBlocksRepeat({dispatch_status:'accepted',list_status:'archived'}),
  'una aceptacion pendiente de webhook tambien reserva al destinatario');
assert(reviewItemBlocksRepeat({status:'ready',selected:true,list_status:'paused'}));
assert(!reviewItemBlocksRepeat({status:'ready',selected:true,list_status:'archived'}),
  'una preparacion archivada sin envio no reserva al destinatario');

const activeQueueQuery = source.match(
  /const \[activeQueueRow\][\s\S]*?\{ replacements:/
)?.[0] || '';
assert.match(activeQueueQuery, /COUNT\(DISTINCT CASE/);
assert.match(activeQueueQuery, /CONCAT\('patient:', i\.paciente_id\)/);
assert.match(activeQueueQuery, /CONCAT\('phone:', REGEXP_REPLACE\(i\.phone/);
assert.match(activeQueueQuery, /CONCAT\('email:', LOWER\(TRIM\(i\.email\)\)\)/);

console.log('marketing_review_queue_accounting.test.js: OK');
