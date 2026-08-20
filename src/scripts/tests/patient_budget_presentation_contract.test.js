#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const service = fs.readFileSync(
  path.resolve(__dirname, '../../services/patientEconomics.service.js'),
  'utf8',
);

assert.match(service, /present_again:\s*\{\s*from:\s*\['presented'\],\s*to:\s*'presented'/);
assert.match(service, /presented_at:\s*transition\.to === 'presented'\s*\?\s*\(budget\.presented_at \|\| now\)/,
  'repeat presentation must preserve the first presented_at value');
assert.match(service, /!\['draft', 'presented'\]\.includes\(budget\.status\)/,
  'a saved draft must be presentable through a real channel');
assert.match(service, /presentation_channel:[\s\S]*?presentation_delivery_status:[\s\S]*?signature_request_public_id:/,
  'presentation events must retain channel and delivery evidence');

const signatureStart = service.indexOf('async function createBudgetSignatureRequest');
const signatureEnd = service.indexOf('\nasync function ', signatureStart + 20);
const signatureSource = service.slice(signatureStart, signatureEnd > signatureStart ? signatureEnd : undefined);
const whatsappSend = signatureSource.indexOf('sendBudgetSignatureWhatsapp');
const whatsappPresentation = signatureSource.indexOf("presentation_channel: 'whatsapp'", whatsappSend);
assert.ok(whatsappSend >= 0 && whatsappPresentation > whatsappSend,
  'WhatsApp presentation must be registered only after the provider accepts the request');
assert.match(signatureSource, /normalizedChannel === 'tablet'[\s\S]*?presentation_channel: 'tablet'/,
  'a tablet presentation must be registered once its signing session is available');
assert.doesNotMatch(
  signatureSource.slice(signatureSource.indexOf("normalizedChannel === 'email'")),
  /presentation_channel:\s*'email'/,
  'mock email must never present a budget');

console.log('patient budget presentation backend contract: ok');
