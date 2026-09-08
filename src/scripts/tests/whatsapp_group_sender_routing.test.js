#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  applyBindingToAsset,
} = require('../../services/whatsappChannelBindings.service');
const {
  resolveWhatsappRouting,
  selectWhatsappPhoneAsset,
} = require('../../lib/whatsapp-channel-role');

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

const groupPrimary = {
  id: 358,
  assignmentScope: 'group',
  phoneNumberId: 'group-phone',
  waAccessToken: 'token',
  additionalData: { routing: { whatsapp_channel_role: 'primary' } },
};
const scopedSecondary = applyBindingToAsset(groupPrimary, {
  id: 9,
  clinic_id: 56,
  asset_id: 358,
  role: 'secondary',
  purposes: ['lead_first_contact'],
  unavailable_action: 'pause',
});
assert.equal(resolveWhatsappRouting(groupPrimary).role, 'primary',
  'the group asset keeps its global primary role');
assert.equal(resolveWhatsappRouting(scopedSecondary).role, 'secondary',
  'the clinic binding overlays the role only for that clinic');
assert.equal(selectWhatsappPhoneAsset({
  clinicAssets: [{
    id: 374,
    assignmentScope: 'clinic',
    phoneNumberId: 'clinic-phone',
    waAccessToken: 'token',
    additionalData: { routing: { whatsapp_channel_role: 'primary' } },
  }],
  groupAssets: [scopedSecondary],
  purpose: 'lead_first_contact',
}).id, 358, 'lead first contact uses the clinic-scoped secondary');
assert.equal(selectWhatsappPhoneAsset({
  clinicAssets: [{
    id: 374,
    assignmentScope: 'clinic',
    phoneNumberId: 'clinic-phone',
    waAccessToken: 'token',
    additionalData: { routing: { whatsapp_channel_role: 'primary' } },
  }],
  groupAssets: [scopedSecondary],
  purpose: null,
}).id, 374, 'care traffic keeps using the clinic primary');

console.log('whatsapp group sender routing: ok');
