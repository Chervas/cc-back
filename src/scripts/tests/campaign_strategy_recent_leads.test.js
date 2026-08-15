'use strict';

const assert = require('assert');
const {
  __test: {
    buildStrategyRecentLeadItems
  }
} = require('../../controllers/campaignOnboarding.controller');

const payload = {
  external_targets: [
    {
      kind: 'treatment',
      treatment_id: 12,
      treatment_name: 'Cirugía de pecho',
      campaigns: [
        {
          provider: 'google_ads',
          account_id: '123-456-7890',
          external_campaign_id: '999888777',
          name: 'BS Medical - Pecho'
        }
      ]
    },
    {
      kind: 'generic',
      campaigns: [
        {
          provider: 'meta_ads',
          account_id: 'act_5651594564879938',
          external_campaign_id: '123123123',
          name: 'Lead Facial'
        }
      ]
    }
  ],
  campaign_admin_playbook_name: 'Armonización facial'
};

const rows = [
  {
    id: 1,
    nombre: 'Paciente Google',
    email: 'paciente@example.com',
    telefono: '+34600000000',
    status_lead: 'citado',
    source: 'web',
    google_ads_customer_id: '1234567890',
    google_ads_campaign_id: '999888777',
    utm_campaign: 'otro nombre antiguo',
    created_at: '2026-08-15T10:00:00.000Z',
    clinica_id: 72,
    clinica: { nombre_clinica: 'BS Medical' }
  },
  {
    id: 2,
    nombre: 'Paciente Meta',
    email: null,
    telefono: '+34611111111',
    status_lead: 'cualificado',
    source: 'web',
    fbclid: 'fbclid-test',
    utm_campaign: 'Lead Facial',
    created_at: '2026-08-15T09:00:00.000Z',
    clinica_id: 72,
    clinica: { nombre_clinica: 'BS Medical' }
  },
  {
    id: 3,
    nombre: 'No debe entrar',
    email: 'otro@example.com',
    telefono: '+34622222222',
    status_lead: 'citado',
    source: 'web',
    google_ads_customer_id: '1234567890',
    google_ads_campaign_id: '000000000',
    utm_campaign: 'BS Medical - Pecho',
    created_at: '2026-08-15T08:00:00.000Z',
    clinica_id: 72
  }
];

const items = buildStrategyRecentLeadItems(rows, payload, 5);

assert.equal(items.length, 2);
assert.equal(items[0].id, 1);
assert.equal(items[0].source, 'google_ads');
assert.equal(items[0].target.label, 'Cirugía de pecho');
assert.equal(items[0].campaign.campaign_id, '999888777');
assert.equal(items[0].has_email, true);
assert.equal(Object.prototype.hasOwnProperty.call(items[0], 'email'), false);
assert.equal(Object.prototype.hasOwnProperty.call(items[0], 'telefono'), false);

assert.equal(items[1].id, 2);
assert.equal(items[1].source, 'meta_ads');
assert.equal(items[1].target.label, 'Armonización facial');
assert.equal(items[1].has_email, false);
assert.equal(items[1].has_phone, true);

console.log('campaign_strategy_recent_leads.test.js OK');
