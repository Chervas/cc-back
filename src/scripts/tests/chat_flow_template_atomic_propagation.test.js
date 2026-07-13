'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  __test: { buildChatFlowTemplateConfigMutation },
} = require('../../controllers/chatFlowTemplates.controller');

const base = {
  id: 7,
  name: 'Flujo recepción',
  is_active: true,
  disciplina_codes: [],
  is_default_for: null,
  show_when_clinic_closed: false,
};
const templateRules = [{
  index: 0,
  name: 'Flujo recepción',
  url_rules: ['*'],
  flow: { steps: [{ id: 'welcome', type: 'message', text: 'Hola' }] },
}];

function testMutationPreservesLatestLockedServerState() {
  const currentConfig = {
    campaigns: { active_mode: 'connect_only' },
    features: {
      ad_personalization_activation_audit: { reconciliation_key: 'latest-audit' },
    },
    google_ads: {
      user_data_enabled: true,
      enhanced_conversions: { enabled: true, reconciliation_key: 'latest-enhanced' },
      events: { lead: { user_data_enabled: true, value: 0 } },
    },
    flows: [],
  };
  const mutation = buildChatFlowTemplateConfigMutation({
    base,
    templateId: 7,
    templateRules,
    clinicConfiguracion: {},
    currentConfig,
  });
  assert.equal(mutation.shouldWrite, true);
  assert.deepEqual(mutation.nextConfig.campaigns, currentConfig.campaigns);
  assert.deepEqual(mutation.nextConfig.features, currentConfig.features);
  assert.deepEqual(mutation.nextConfig.google_ads, currentConfig.google_ads);
  assert.equal(mutation.nextConfig.flows.length, 1);
  assert.equal(mutation.nextConfig.flows[0].catalog_template_id, 7);

  const idempotent = buildChatFlowTemplateConfigMutation({
    base,
    templateId: 7,
    templateRules,
    clinicConfiguracion: {},
    currentConfig: mutation.nextConfig,
  });
  assert.equal(idempotent.shouldWrite, false);
}

function testPropagationRereadsEachClinicUnderUpdateLock() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/chatFlowTemplates.controller.js'),
    'utf8',
  );
  const start = source.indexOf('async function propagateChatFlowTemplateToExistingConfigs');
  const end = source.indexOf('\nfunction mapTemplate', start);
  const propagation = source.slice(start, end);
  assert.match(propagation, /for \(const clinic of clinics \|\| \[\]\)[\s\S]*db\.sequelize\.transaction/);
  assert.match(propagation, /IntakeConfig\.findOne\(\{[\s\S]*lock: transaction\.LOCK\.UPDATE/);
  assert.match(propagation, /currentConfig: locked\?\.config/);
  assert.match(propagation, /locked\.update\(\{ config: mutation\.nextConfig \}, \{ transaction \}\)/);
  assert.match(propagation, /IntakeConfig\.create\([\s\S]*\}, \{ transaction \}\)/);
  assert.doesNotMatch(propagation, /IntakeConfig\.findAll/);
}

testMutationPreservesLatestLockedServerState();
testPropagationRereadsEachClinicUnderUpdateLock();
console.log('chat_flow_template_atomic_propagation.test.js: OK');
