'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../services/marketingBulkSends.service.js'),
  'utf8'
);

const requestedPatientsQuery = source.match(
  /async function getReviewRequestedPatientIds[\s\S]*?function mapReviewPatientItem/
)?.[0] || '';
assert.match(
  requestedPatientsQuery,
  /i\.sent_at IS NOT NULL[\s\S]*?OR i\.dispatch_status IN \('queued','sending','sent','delivered','read','replied'\)/,
  'los envios materializados deben seguir excluyendo al paciente aunque se archive la lista'
);
assert.match(
  requestedPatientsQuery,
  /l\.status <> 'archived'[\s\S]*?i\.selected = TRUE[\s\S]*?l\.status IN \('ready','sending','sent','completed','scheduled','paused'\)/,
  'solo una cola no archivada puede reservar destinatarios que aun no se han enviado'
);

const activeQueueQuery = source.match(
  /const \[activeQueueRow\][\s\S]*?\{ replacements:/
)?.[0] || '';
assert.match(activeQueueQuery, /COUNT\(DISTINCT CASE/);
assert.match(activeQueueQuery, /CONCAT\('patient:', i\.paciente_id\)/);
assert.match(activeQueueQuery, /CONCAT\('phone:', REGEXP_REPLACE\(i\.phone/);
assert.match(activeQueueQuery, /CONCAT\('email:', LOWER\(TRIM\(i\.email\)\)\)/);

console.log('marketing_review_queue_accounting.test.js: OK');
