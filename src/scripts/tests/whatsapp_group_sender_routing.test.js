#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webhook = fs.readFileSync(
  path.resolve(__dirname, '../../routes/whatsapp-webhook.routes.js'),
  'utf8'
);

const resolverStart = webhook.indexOf('async function findGroupConversation');
const resolverEnd = webhook.indexOf('async function resolveClinicAndContact', resolverStart);
assert.ok(resolverStart >= 0 && resolverEnd > resolverStart,
  'the group conversation resolver must exist');

const resolver = webhook.slice(resolverStart, resolverEnd);
assert.match(resolver, /Message\.findAll/,
  'group routing must inspect outbound messages');
assert.match(webhook, /whatsapp_sender_asset_id/,
  'group routing must compare the physical sender asset');
assert.match(resolver, /return conversations\[0\]/,
  'legacy latest-conversation routing remains the fallback');
assert.match(webhook, /assetId:\s*webhookAsset\?\.id/,
  'the receiving WhatsApp asset must reach the group resolver');

console.log('whatsapp group sender routing: ok');
