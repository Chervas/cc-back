'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op, Sequelize } = require('sequelize');
const { metaAdvertisingIdentity, attachLeadAdvertisingIdentities } = require('../../services/leadAdvertisingIdentity.service');
const { leadCampaign } = require('../../services/campaignWorkspaceReport.service');

const identity = { version: 1, verified_by: 'meta_graph', provider: 'meta_ads', clinic_id: 5,
  account_id: '500', campaign_id: '600', ad_id: '400', page_id: '200', form_id: '300' };
const lead = { id: 1, source: 'meta_ads', channel: 'paid', clinica_id: 5 };
const campaigns = [{ id: 'a', provider: 'meta_ads', clinicId: 5, account_id: '500', campaign_id: '600', name: 'Same' },
  { id: 'b', provider: 'meta_ads', clinicId: 5, account_id: '501', campaign_id: '601', name: 'Same' }];

test('verified attribution is clinic bound and validates every provider identifier', () => {
  assert.equal(metaAdvertisingIdentity(identity, 5).account_id, '500');
  for (const patch of [{ clinic_id: 6 }, { version: 0 }, { verified_by: 'browser' }, { campaign_id: 600 }, { account_id: '../me' }, { form_id: null }]) {
    assert.equal(metaAdvertisingIdentity({ ...identity, ...patch }, 5), null);
  }
});
test('canonical Meta identity wins over names and UTMs without crossing account or clinic boundaries', () => {
  assert.equal(leadCampaign({ ...lead, advertising_identity: identity, utm_campaign: 'Same' }, campaigns), 'a');
  assert.equal(leadCampaign({ ...lead, advertising_identity: { ...identity, account_id: '999' }, utm_campaign: '600' }, campaigns), null);
  assert.equal(leadCampaign({ ...lead, advertising_identity: identity }, [{ ...campaigns[0], clinicId: 6 }]), null);
});
test('loader reads only the IDs already authorized by its caller and no raw audit payload', async () => {
  const leads = [{ ...lead }];
  await attachLeadAdvertisingIdentities({ models: { LeadAttributionAudit: { findAll: async options => {
    assert.deepEqual(options.where.lead_intake_id[Op.in], ['1']);
    assert.equal(options.attributes[1][0].path, 'attribution_steps.advertising_identity');
    const db = new Sequelize('test', 'test', 'test', { dialect: 'mysql', logging: false });
    const sql = db.getQueryInterface().queryGenerator.selectQuery('LeadAttributionAudits', options);
    assert.match(sql, /json_extract/i); assert.doesNotMatch(sql, /\$\$/);
    await db.close();
    assert.ok(!options.attributes.includes('raw_payload'));
    return [{ lead_intake_id: 1, identity: JSON.stringify(identity) }, { lead_intake_id: 999, identity }];
  } } }, leads });
  assert.equal(leadCampaign(leads[0], campaigns), 'a');
});
test('duplicate audit proofs agree; conflicting account identities stay unattributed', async () => {
  for (const other of [identity, { ...identity, account_id: '501' }]) {
    const leads = [{ ...lead }];
    await attachLeadAdvertisingIdentities({ models: { LeadAttributionAudit: { findAll: async () => [
      { lead_intake_id: 1, identity }, { lead_intake_id: 1, identity: other },
    ] } }, leads });
    assert.equal(Boolean(leads[0].advertising_identity), other === identity);
    if (other !== identity) assert.equal(leadCampaign({ ...leads[0], utm_campaign: '600' }, campaigns), null);
  }
});
