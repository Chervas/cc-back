'use strict';

const assert = require('node:assert/strict');
const S = require('sequelize');
const C = require('../../lib/patient-mobile-verification');
const { createService } = require('../../services/patientMobileVerificationLifecycle.service');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const fixture = require('./fixtures/patient_mobile_verification_modular_runtime.fixture');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');

withIsolatedCampaignMysql(async scope => {
  const f = await fixture(scope), { db } = f, { sql, report } = scope;
  await db.AutomationFlowTemplateV2.destroy({ where: {} });
  db.ClinicMetaAsset = sql.define('ClinicMetaAsset', { id: { type: S.INTEGER, primaryKey: true },
    phoneNumberId: S.STRING, wabaId: S.STRING, isActive: S.BOOLEAN, additionalData: S.JSON }, { timestamps: false });
  await db.ClinicMetaAsset.sync();
  const utility = await db.WhatsappTemplateCatalog.create({ name: C.TEMPLATE, family_key: C.TEMPLATE,
    body_text: C.BODY, category: 'UTILITY', language: 'es',
    components: f.approved.components, is_active: true, is_generic: true });
  const sourceData = C.definition();
  sourceData.nodes.find(n => n.type === 'action/send_whatsapp').config.catalog_template_id = utility.id;
  const source = await db.AutomationFlowTemplateV2.create({ ...sourceData, published_at: f.clock });
  const catalog = await db.AutomationFlowCatalog.create({ name: C.FAMILY, display_name: source.name,
    trigger_type: C.REQUEST, template_key: C.FAMILY, template_version: 1, steps: [], is_generic: true, is_active: true });
  const defaults = loadSource('automationDefaults.service', { '../../models': db, './queue.service': {}, './whatsappTemplates.service': {} }, {});
  const stop = loadSource('../lib/automation-runtime-stop', { '../../models': db,
    './appointment-template-scope': require('../../lib/appointment-template-scope') }, {});
  let gate = true, available = false, healthy = true, waba = f.sender.wabaId;
  const jobs = [];
  const asset = await db.ClinicMetaAsset.create({ id: f.sender.originId, phoneNumberId: f.sender.phoneNumberId,
    wabaId: waba, isActive: true });
  await f.approved.update({ catalog_template_id: utility.id, clinic_id: null });
  let lifecycle;
  const controller = loadSource('../controllers/automationsV2.controller', { '../../models': db,
    '../services/patientMobileVerificationLifecycle.service': { current: () => lifecycle, publicState: s => s },
  }, { PATIENT_MOBILE_VERIFICATION_ENABLED: 'true' }, 10000);
  const deps = { db, enabled: () => gate, now: () => f.clock,
    distribute: args => defaults.ensureCatalogTemplateForClinic(args), publish: defaults.publishClinicTemplateVersion,
    validate: async candidate => {
      const result = await controller.validateFlowPayloadForInternalUse(candidate);
      if (!result.ok) console.log(JSON.stringify({ testOnlyValidationErrors: result.errors }));
      return result;
    }, stop: stop.setActive,
    sender: async () => available ? { ...f.sender, wabaId: waba, authorizedBroker: { sendEnabled: true } } : null,
    health: () => ({ state: healthy ? 'healthy' : 'blocked', can_send: healthy, is_stale: false }),
    selectTemplate: (config, clinicId, wabaId) => f.engine._loadConfiguredWhatsappTemplate({ ...config, template_id: null },
      { clinic_id: clinicId }, { targetWabaId: wabaId, expectedLocale: 'es' }),
    enqueue: args => { jobs.push(args); return f.requests.enqueueUniqueJobRequest(args); } };
  lifecycle = createService(deps);
  const copies = clinicId => db.AutomationFlowTemplateV2.findAll({ where: { clinic_id: clinicId }, order: [['id', 'ASC']], raw: true });
  const snapshot = async clinicId => JSON.stringify(await copies(clinicId));
  const latest = async clinicId => (await copies(clinicId)).at(-1);
  await lifecycle.reconcile(73);
  assert.equal((await lifecycle.inspect(73)).enabled, true);
  assert.equal((await lifecycle.inspect(73)).reason, 'whatsapp_unavailable');
  assert.equal((await copies(73)).length, 1); assert.equal((await latest(73)).is_active, 0);
  assert.equal(await db.Message.count() + await db.PatientOperationalEvent.count(), 0);
  report.checks.push('new clinic distributed inactive, enabled by default but not send-ready; no events/messages');
  f.enabled = true;
  const beforeLaunch = await f.source({ clinic: 73 });
  assert.equal(beforeLaunch.metadata.delivery_enabled, false);

  const ids = Array.from({ length: 25 }, (_, i) => 200 + i);
  await db.Clinica.bulkCreate(ids.map(id => ({ id_clinica: id, nombre_clinica: 'TESTONLY pending ' + id })));
  for (const id of ids) await lifecycle.reconcile(id);
  const pending = JSON.stringify(await db.AutomationFlowTemplateV2.findAll({ where: { clinic_id: { [S.Op.in]: ids } }, raw: true }));
  for (const id of ids) assert.equal((await lifecycle.inspect(id)).status, 'pending');
  await lifecycle.run();
  assert.equal(JSON.stringify(await db.AutomationFlowTemplateV2.findAll({ where: { clinic_id: { [S.Op.in]: ids } }, raw: true })), pending);
  report.checks.push('25 existing pending clinics remain enabled, inactive and byte-identical after recovery sweep');

  available = true; await f.approved.update({ status: 'PENDING' });
  assert.equal((await lifecycle.reconcile(73)).reason, 'template_approval_pending');
  const original = await latest(73);
  await f.approved.update({ status: 'APPROVED' });
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => lifecycle.reconcile(73)));
  assert(concurrent.every(r => r.status === 'active'));
  let active = await latest(73);
  assert.equal(active.version, 2); assert.equal(active.public_id, original.public_id); assert.equal((await copies(73)).length, 2);
  assert.equal(active.trigger_config.response_timeout_minutes, 1440); assert.equal(active.trigger_config.enabled_after, f.clock.toISOString());
  assert.equal(active.nodes[0].config.enabled_after, active.trigger_config.enabled_after);
  assert.equal(active.nodes[0].config.response_timeout_minutes, 1440);
  assert.equal((await copies(73)).filter(r => r.is_active).length, 1);
  report.checks.push('later connection and approval activate natively once under eight concurrent reconciliations with 1440 and a real new cut');
  const baseline = await snapshot(73);
  f.clock = new Date(+f.clock + 60000); lifecycle = createService(deps);
  await lifecycle.reconcile(73); await lifecycle.reconcile(73);
  assert.equal(await snapshot(73), baseline);
  report.checks.push('restart and repeated approval preserve exact family, version, nodes and activation cut');

  const eight = Array.from({ length: 8 }, (_, i) => 100 + i);
  for (const id of eight) {
    await db.Clinica.create({ id_clinica: id, nombre_clinica: 'TESTONLY previously active ' + id });
    const row = structuredClone(active); delete row.id; delete row.created_at; delete row.updated_at;
    await db.AutomationFlowTemplateV2.create({ ...row, clinic_id: id, public_id: 'flw_TESTONLY_existing_' + id,
      template_key: 'testonly_existing_' + id });
  }
  const beforeEight = await Promise.all(eight.map(snapshot));
  for (const id of eight) await lifecycle.reconcile(id);
  assert.deepEqual(await Promise.all(eight.map(snapshot)), beforeEight);
  report.checks.push('eight previously activated clinics keep every stored field, including their original cuts');

  waba = 'TESTONLY-NEW-WABA'; await asset.update({ wabaId: waba });
  assert.equal((await lifecycle.reconcile(73)).reason, 'template_approval_pending');
  assert.equal(await snapshot(73), baseline);
  const replacement = await db.WhatsappTemplate.create({ catalog_template_id: utility.id, waba_id: waba,
    clinic_id: null, name: C.TEMPLATE + '_v99', language: 'es', category: 'UTILITY', status: 'APPROVED',
    is_active: true, components: f.approved.components });
  assert.equal((await lifecycle.reconcile(73)).status, 'active');
  healthy = false; assert.equal((await lifecycle.reconcile(73)).reason, 'whatsapp_unavailable');
  healthy = true; assert.equal((await lifecycle.reconcile(73)).status, 'active');
  assert.equal(await snapshot(73), baseline);
  report.checks.push('WABA change requires its exact catalog instance; loss/recovery do not recreate versions or change cuts');

  const bound = await db.AutomationFlowTemplateV2.findByPk(active.id);
  await lifecycle.setEnabled(bound, false, 15);
  assert.equal((await lifecycle.inspect(73)).status, 'manual_disabled');
  assert.equal((await db.Clinica.findByPk(73)).configuracion.patient_mobile_verification.enabled, false);
  const stopped = await snapshot(73);
  await lifecycle.reconcile(73); lifecycle = createService(deps); await lifecycle.reconcile(73);
  assert.equal(await snapshot(73), stopped);
  await lifecycle.setEnabled(bound, true, 15);
  active = await latest(73); assert.equal(active.id, bound.id); assert.equal(active.trigger_config.enabled_after, original.trigger_config.enabled_after || '2026-10-20T12:00:00.000Z');
  report.checks.push('explicit stop is atomic, persisted, survives restarts and approval; explicit re-enable retains the cut/version');

  await db.Clinica.create({ id_clinica: 300, nombre_clinica: 'TESTONLY historical manual stop' });
  const legacy = structuredClone(active); delete legacy.id; delete legacy.created_at; delete legacy.updated_at;
  await db.AutomationFlowTemplateV2.create({ ...legacy, public_id: 'flw_TESTONLY_legacy', template_key: 'testonly_legacy', clinic_id: 300, is_active: false });
  assert.equal((await lifecycle.reconcile(300)).status, 'manual_disabled');
  assert.equal((await db.Clinica.findByPk(300)).configuracion.patient_mobile_verification.enabled, false);
  report.checks.push('legacy configured inactive copies are conservatively imported as explicit stops, not autoenabled');

  await db.Clinica.create({ id_clinica: 301, nombre_clinica: 'TESTONLY custom' });
  available = false; await lifecycle.reconcile(301);
  const custom = await db.AutomationFlowTemplateV2.findByPk((await latest(301)).id), nodes = structuredClone(custom.nodes);
  nodes.push({ id: 'N14', type: 'action/write_note', config: { content: 'TESTONLY compatible note' }, outputs: { on_success: 'N13' } });
  nodes.find(n => n.id === 'N7').outputs.on_success = 'N14';
  await custom.update({ name: 'TESTONLY custom compatible name', nodes }); available = true;
  assert.equal((await lifecycle.reconcile(301)).status, 'active');
  assert.equal((await latest(301)).name, 'TESTONLY custom compatible name'); assert((await latest(301)).nodes.some(n => n.id === 'N14'));
  const invalid = await db.AutomationFlowTemplateV2.findByPk((await latest(301)).id);
  await invalid.update({ nodes: [{ id: 'BAD', type: 'action/change_status' }] });
  const invalidBefore = await snapshot(301);
  assert.equal((await lifecycle.reconcile(301)).status, 'review_required'); assert.equal(await snapshot(301), invalidBefore);
  report.checks.push('compatible customizations survive launch; incompatible copies require review without overwriting');

  const duplicate = { ...legacy, public_id: 'flw_TESTONLY_duplicate', template_key: 'testonly_duplicate', clinic_id: 73, is_active: false };
  const duplicateRow = await db.AutomationFlowTemplateV2.create(duplicate);
  assert.equal((await lifecycle.reconcile(73)).reason, 'local_copy_conflict');
  await duplicateRow.destroy();
  await replacement.update({ category: 'MARKETING' }); assert.equal((await lifecycle.inspect(73)).reason, 'template_approval_pending');
  await replacement.update({ category: 'UTILITY', components: [{ type: 'BODY', text: C.BODY + ' changed' }] });
  assert.equal((await lifecycle.inspect(73)).reason, 'template_approval_pending');
  await replacement.update({ components: f.approved.components });
  report.checks.push('duplicate families and incorrect category/body/buttons cannot activate a clinic');

  // Origin uses its normal frozen-request path, with readiness as the only new gate.
  f.enabled = true;
  f.deliveryReady = (clinicId, transaction) => lifecycle.inspect(clinicId, { transaction }).then(s => s.ready && s.status === 'active');
  const historical = await f.source({ clinic: 73 });
  assert.equal(historical.metadata.delivery_enabled, true);
  const jobsBefore = await db.JobRequest.count({ where: { type: 'patient_mobile_verification_dispatch' } });
  healthy = false;
  const dispatch = await f.runtime.dispatch({ request_event_id: historical.id, clinic_id: 73 });
  await f.engine.runExecution(dispatch.result.execution_id);
  const reviewed = await f.runtime.state(historical);
  assert.equal(reviewed.state, 'review_required'); assert.equal(reviewed.reason, 'delivery_failed');
  assert.equal(await db.Message.count(), 0);
  const heldRequest = await f.source({ clinic: 73 }); assert.equal(heldRequest.metadata.delivery_enabled, false);
  healthy = true; await lifecycle.reconcile(73); await heldRequest.reload();
  assert.equal(heldRequest.metadata.delivery_enabled, false);
  assert.equal(await db.JobRequest.count({ where: { type: 'patient_mobile_verification_dispatch' } }), jobsBefore);
  report.checks.push('unavailable sender freezes delivery_enabled=false; recovery never replays or upgrades old requests');
  const invoke = async (handler, params, body) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controller[handler]({ userData: { userId: 1 }, params, body }, res);
    assert(res.statusCode < 400, JSON.stringify(res.body)); return res.body.data;
  };
  const scoped = await latest(73), params = { template_ref: scoped.public_id, version: scoped.version };
  const off = await invoke('updateTemplateDraft', params, { is_active: false });
  assert.equal(off.mobile_verification.status, 'manual_disabled');
  const draft = await invoke('createTemplateDraft', {}, { ...scoped, id: undefined });
  const publishedOff = await invoke('publishTemplateVersion', { template_ref: draft.public_id, version: draft.version }, {});
  assert.equal(publishedOff.is_active, false);
  await lifecycle.reconcile(73); assert.equal((await lifecycle.inspect(73)).status, 'manual_disabled');
  const on = await invoke('updateTemplateDraft', { template_ref: draft.public_id, version: draft.version }, { is_active: true });
  assert.equal(on.mobile_verification.status, 'active');
  assert.equal(on.trigger_config.enabled_after, scoped.trigger_config.enabled_after);
  available = false;
  const pendingCopy = await latest(200);
  const pendingOn = await invoke('updateTemplateDraft', { template_ref: pendingCopy.public_id, version: pendingCopy.version }, { is_active: true });
  assert.equal(pendingOn.mobile_verification.enabled, true); assert.equal(pendingOn.mobile_verification.status, 'pending');
  assert.equal(pendingOn.is_active, false);
  available = true;
  const current = await db.AutomationFlowTemplateV2.findByPk(on.id);
  await Promise.all([...Array.from({ length: 8 }, () => lifecycle.reconcile(73)), lifecycle.setEnabled(current, false, 15)]);
  assert.equal((await lifecycle.inspect(73)).status, 'manual_disabled');
  assert.equal((await copies(73)).filter(r => r.is_active).length, 0);
  report.checks.push('native toggle and publication preserve manual stops; enabling without prerequisites remains pending; concurrent stop beats reconciliation');
  gate = false; const gateBefore = await snapshot(73); await lifecycle.reconcile(73); await lifecycle.request();
  assert.equal(await snapshot(73), gateBefore); assert.equal(jobs.length, 0);
  gate = true; await lifecycle.request(73); await lifecycle.request(73);
  assert.equal(await db.JobRequest.count({ where: { type: 'patient_mobile_verification_reconcile' } }), 1);
  assert.equal(await db.Message.count(), 0); assert.equal((await source.reload()).is_active, false);
  await beforeLaunch.reload(); assert.equal(beforeLaunch.metadata.delivery_enabled, false);
  report.checks.push('closed DEV gate performs no rollout; recovery jobs deduplicate and never send or activate the central source');
}).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
