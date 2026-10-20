'use strict';
const assert = require('node:assert/strict');
const D = require('sequelize');
const fs = require('node:fs'), vm = require('node:vm');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { buildSingleNoticeFlow } = require('../../lib/appointment-single-notice-flow');
const { selectEffectiveAppointmentTemplates } = require('../../lib/appointment-template-scope');
const { reconcileClinicScope, snapshotHash } = require('../../lib/appointment-scope-reconciliation');
const publication = require('../../lib/appointment-single-notice-publication');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.AutomationFlowTemplateV2 = require('../../../models/automationflowtemplatev2')(sql, D);
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER }, { tableName: 'Clinicas' });
  await sql.sync();
  await db.Clinica.bulkCreate([{ id_clinica: 1, grupoClinicaId: 29 }, { id_clinica: 2, grupoClinicaId: 29 }]);
  const stop = require('../../lib/automation-runtime-stop');
  let seq = 0;
  const nodes = [
    { id: 'N1', type: 'trigger/appointment_created', outputs: { on_success: 'N2' } },
    { id: 'N2', type: 'action/send_whatsapp', config: { template_name: 'TESTONLY_initial' }, outputs: { on_success: 'N3' } },
    { id: 'N3', type: 'delay/wait_response', config: { listens_to_node_id: 'N2', timeout_duration: 2, timeout_unit: 'hours' }, outputs: { on_response: 'N8', on_timeout: 'N4' } },
    { id: 'N4', type: 'action/send_whatsapp', config: { template_name: 'clinicaclick_confirmacion_datos_cita_48_sin_respuesta_v1' }, outputs: { on_success: 'N5' } },
    { id: 'N5', type: 'delay/wait_response', config: { listens_to_node_id: 'N4', timeout_duration: 12, timeout_unit: 'hours' }, outputs: { on_response: 'N8' } },
    { id: 'N8', type: 'condition/ai_analysis', config: { instruction: 'TESTONLY immutable historic prompt', confidence: 0.9 }, outputs: { on_success: 'N9' } },
    { id: 'N9', type: 'control/end', outputs: {} },
  ];
  async function fixture(trigger = 'appointment_created') {
    const key = trigger === 'appointment_created' ? 'env_o_de_datos_de_la_cita_tras_agendar' : 'envio_de_datos_de_la_cita_tras_agendar_copy';
    const values = { public_id: 'TESTONLY_scope_' + ++seq, template_key: key + '__clinic_1', version: 1,
      name: 'TESTONLY preserved flow', clinic_id: 1, group_id: 29, is_system: false, is_active: true,
      trigger_type: trigger, entry_node_id: 'N1', nodes: nodes.map(n => n.id === 'N1' ? { ...n, type: 'trigger/' + trigger } : n),
      trigger_config: { TESTONLY_original: true }, published_at: new Date(), created_by: 1, published_by: 1 };
    // Each test has a globally unique key suffix without changing its native family.
    const offset = seq * 10;
    const source = await db.AutomationFlowTemplateV2.create({ ...values, ...buildSingleNoticeFlow(values), version: offset + 1 });
    const alias = await db.AutomationFlowTemplateV2.create({ ...source.toJSON(), id: undefined, group_id: null, version: offset + 2, is_active: false });
    await source.reload(); await alias.reload();
    const body = { source_id: source.id, expected_latest_id: alias.id, source_hash: snapshotHash(source), latest_hash: snapshotHash(alias) };
    return { source, alias, body, ref: values.public_id };
  }
  for (const trigger of ['appointment_created', 'appointment_rescheduled']) {
    const f = await fixture(trigger), all = () => db.AutomationFlowTemplateV2.findAll({ where: { public_id: f.ref } });
    assert.deepEqual(selectEffectiveAppointmentTemplates(await all(), 1, 29), []);
    await assert.rejects(stop.assertTemplateActive(f.source), { code: 'automation_deactivated' });
    await sql.transaction(async transaction => {
      assert.equal(await stop.publicationActivation(f.source, { preserve_activation: true, expected_published_version: f.alias.version }, transaction), false);
      await assert.rejects(stop.publicationActivation(f.source, { preserve_activation: true, expected_published_version: f.source.version }, transaction), { code: 'automation_publication_conflict' });
    });
    const before = await db.AutomationFlowTemplateV2.count();
    const args = { db, actorId: 1, ref: f.ref, body: f.body };
    assert.equal((await reconcileClinicScope(args)).dry_run, true);
    assert.equal(await db.AutomationFlowTemplateV2.count(), before);
    await assert.rejects(reconcileClinicScope({ ...args, body: { ...f.body, source_hash: '0'.repeat(64), apply: true } }), { code: 'appointment_scope_reconciliation_conflict' });
    const foreign = await db.AutomationFlowTemplateV2.create({ ...f.source.toJSON(), id: undefined, clinic_id: 2, version: f.alias.version + 1 });
    const results = await Promise.all([1, 2].map(() => reconcileClinicScope({ ...args, body: { ...f.body, apply: true } })));
    assert.equal(results.filter(r => !r.skipped).length, 1);
    const current = results.find(r => !r.skipped).row;
    assert.equal(current.version, foreign.version + 1);
    assert.deepEqual(current.nodes, f.source.nodes);
    assert.deepEqual(current.trigger_config, f.source.trigger_config);
    assert.equal(current.published_by, 1);
    assert.equal((await all()).filter(row => row.clinic_id === 1 && row.is_active).length, 1);
    assert.deepEqual(selectEffectiveAppointmentTemplates(await all(), 1, 29).map(row => row.id), [current.id]);
    assert.equal((await stop.assertTemplateActive(f.source)).id, current.id);
    await foreign.reload(); assert.equal(foreign.is_active, true);
    await current.update({ is_active: false });
    await assert.rejects(reconcileClinicScope({ ...args, body: { ...f.body, apply: true } }), { code: 'appointment_scope_reconciliation_conflict' });
    assert.deepEqual(selectEffectiveAppointmentTemplates(await all(), 1, 29), []);
    await assert.rejects(stop.assertTemplateActive(f.source), { code: 'automation_deactivated' });
  }
  report.checks.push('Actual InnoDB creation/reschedule selection and dispatch gates: mixed-group aliases fail closed; CAS dry-run, exact immutable repair, concurrent retry, global version allocation, other clinic preserved; subsequent manual OFF never revives');
  for (const change of ['manual_off', 'same_group', 'draft', 'mobile', 'wrong_group', 'two_active']) {
    const f = await fixture();
    if (change === 'manual_off') await f.source.update({ is_active: false });
    if (change === 'same_group') await f.alias.update({ group_id: 29 });
    if (change === 'draft') await db.AutomationFlowTemplateV2.create({ ...f.alias.toJSON(), id: undefined, version: f.alias.version + 1, published_at: null });
    if (change === 'mobile') await f.source.update({ trigger_type: 'patient.mobile_verification_requested' });
    if (change === 'wrong_group') await f.source.update({ group_id: 30 });
    if (change === 'two_active') await f.alias.update({ is_active: true });
    f.body.source_hash = snapshotHash(f.source); f.body.latest_hash = snapshotHash(f.alias);
    await assert.rejects(reconcileClinicScope({ db, actorId: 1, ref: f.ref, body: { ...f.body, apply: true } }), { code: 'appointment_scope_reconciliation_conflict' });
  }
  const f = await fixture();
  // Future native publishers must see the alias before creating ANY draft.
  const original = { ...f.source.toJSON(), nodes, trigger_config: {} };
  const entry = publication.planEntry(original);
  let writes = 0;
  await assert.rejects(publication.publishEntry(entry, async method => {
    if (method !== 'GET') writes++;
    return { data: [original, f.alias.toJSON()] };
  }), /single_notice_source_changed/);
  assert.equal(writes, 0);
  report.checks.push('Manual OFF, same-scope OFF, drafts, mobile verification, wrong group and multiple active sources rejected; future publisher refuses stale grouped source before any write');
  const controller = fs.readFileSync(require.resolve('../../controllers/automationsV2.controller'), 'utf8');
  const start = controller.indexOf('exports.reconcileClinicTemplateScope ='), end = controller.indexOf('\nexports.', start + 10);
  for (const access of [{ user_id: null }, { user_id: 142, is_admin: false }]) {
    const native = {}; let status;
    vm.runInNewContext(controller.slice(start, end), { exports: native, resolveAccess: async () => access,
      require: () => assert.fail('Unauthorized reconciliation must not load or mutate models') });
    await native.reconcileClinicTemplateScope({}, { status(code) { status = code; return this; }, json() {} });
    assert.equal(status, access.user_id ? 403 : 401);
  }
  report.checks.push('Native controller refuses unauthenticated and clinic-staff calls before loading repair service; no backfill/provider/clinical state code is invoked');
}).catch(error => { console.error(error); process.exitCode = 1; });
