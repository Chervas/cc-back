'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const lead = require('../../services/leadAutoReply.service');
const { buildDefinition } = require('../promote-lead-auto-reply-catalog');

test('catalog source uses the native regulated graph without a sender or activation', () => {
  const result = buildDefinition({ clinic_id: null, group_id: null,
    template_key: lead.BASE_TEMPLATE_KEY, trigger_config: { whatsapp_catalog_template_id: 108 } }, lead);
  assert.equal(result.is_active, false);
  assert.equal(result.trigger_config.configured, false);
  assert.deepEqual(result.trigger_config.sources, ['write']);
  assert.equal(result.trigger_config.sender_display_name, null);
  assert.equal(result.trigger_config.whatsapp_template_id, null);
  assert.equal(result.trigger_config.whatsapp_catalog_template_id, 108);
  assert.deepEqual(result.nodes, lead.buildManagedNodes(result.trigger_config));
  assert.equal(result.nodes.find((n) => n.id === 'N8').config.interval_duration, 30);
  assert.equal(result.nodes.find((n) => n.id === 'N7').outputs.on_true, 'N9');
  assert.equal(result.nodes.find((n) => n.id === 'N7').outputs.on_false, 'N8');
  assert.throws(() => buildDefinition({ clinic_id: 56, template_key: lead.BASE_TEMPLATE_KEY }, lead),
    /scope_mismatch/);
});

test('native propagation regenerates lead nodes from local settings, not former N7 bindings', async () => {
  const source = fs.readFileSync(require.resolve('../../services/automationDefaults.service'), 'utf8');
  const start = source.indexOf('async function ensureCatalogTemplateForClinic(');
  const end = source.indexOf('\nasync function createDefaultAutomationsForClinic(', start);
  const local = lead.normalizeConfig({ configured: true, sources: ['call'], timing: 'next_day',
    schedule_scope: 'all_days', whatsapp_template_id: 123, whatsapp_catalog_template_id: 108,
    whatsapp_template_name: 'lead_test', whatsapp_template_language: 'ca', sender_display_name: 'Vero' });
  const published = { id: 4, version: 9, is_active: false, public_id: 'local',
    trigger_config: local, nodes: lead.buildManagedNodes(local) };
  const master = { template_key: lead.BASE_TEMPLATE_KEY, public_id: 'master',
    trigger_type: 'lead_nuevo', nodes: buildDefinition({ clinic_id: null, group_id: null,
      template_key: lead.BASE_TEMPLATE_KEY, trigger_config: { whatsapp_catalog_template_id: 108 } }, lead).nodes,
    trigger_config: { whatsapp_catalog_template_id: 108 } };
  let observed;
  const sandbox = { require: () => lead,
    resolveClinicScope: async () => ({ clinic_id: 56, group_id: 22 }),
    resolveLinkedTemplateForCatalog: async () => master, buildCatalogTemplateKey: () => 'lead__clinic_56',
    repairClinicDraftFamily: async () => {}, REVIEW_AUTOMATION_ACTION: 'action/request_review',
    getNodesArray: (r) => r.nodes || [], inspectExplicitReviewAutomation: () => null,
    mergeLocalReviewConfigIntoCatalogNodes: () => [], cloneJson: (v) => structuredClone(v),
    catalogTemplateMatchesDesired: (row, payload, active) => { observed = { row, payload, active }; return true; },
    AutomationFlowTemplateV2: { findOne: async (options) => (
      options.where.published_at === null ? null : published
    ) }, Op: { ne: 'ne' },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  const result = await sandbox.ensureCatalogTemplateForClinic({ clinicId: 56,
    catalogFlow: { id: 1, name: lead.CATALOG_NAME }, backfillScheduled: false });
  assert.equal(result.status, 'unchanged');
  assert.equal(observed.active, false);
  assert.deepEqual(observed.payload.trigger_config, local);
  assert.deepEqual(observed.payload.nodes, lead.buildManagedNodes(local));
  assert.equal(observed.payload.nodes.find((n) => n.id === 'N9').config.template_id, 123);
  assert.equal(observed.payload.nodes.find((n) => n.id === 'N9').config.variables_named.nombre_remitente, 'Vero');
});
