'use strict';

const { marketingOrigins, resolveLeadMarketingOrigin } = require('../lib/lead-attribution-view');

const attributionFields = [
  'source', 'channel', 'external_source', 'utm_source', 'utm_medium', 'gclid',
  'gbraid', 'wbraid', 'google_ads_customer_id', 'google_ads_campaign_id', 'fbclid', 'ttclid',
];

function validOrigins(origins) {
  return Array.isArray(origins) && origins.length > 0 && origins.length <= marketingOrigins.length &&
    new Set(origins).size === origins.length && origins.every(value => marketingOrigins.includes(value));
}

async function acceptsOrigin(db, rule, thread, entry, transaction) {
  if (rule.origins === undefined) return true;
  if (!validOrigins(rule.origins)) return false;
  if (entry.ad) return rule.origins.includes('meta_ads');
  const localThread = await db.Conversation.findOne({
    where: { id: thread.id, clinic_id: thread.clinic_id }, attributes: ['lead_id'], raw: true, transaction,
  });
  if (!localThread) return false;
  if (!localThread.lead_id) return rule.origins.includes(entry.channel === 'whatsapp' ? 'whatsapp' : 'social_inbox');
  const lead = await db.LeadIntake.findOne({
    where: { id: localThread.lead_id, clinica_id: thread.clinic_id, archived_at: null },
    attributes: attributionFields, raw: true, transaction,
  });
  return !!lead && rule.origins.includes(resolveLeadMarketingOrigin(lead));
}

module.exports = { validOrigins, acceptsOrigin };
