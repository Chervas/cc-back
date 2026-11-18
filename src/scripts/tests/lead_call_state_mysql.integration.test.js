'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DataTypes: D, Op, literal } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { leadCallStateSql, leadCallStateWhere, countLeadCallStates, enrichLeadCallState } = require('../../services/leadCallState.service');

const NOW = new Date('2026-11-19T00:00:00Z');
const START = new Date('2026-11-18T00:00:00Z');
test('actual MySQL last-human-call classification, history/audit receipts, canonical count/filter/DTO and scope', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 120000,
}, async () => withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Clinicas', timestamps: false });
  for (const file of ['leadintake','leadcontactattempt','leadattributionaudit']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  await sql.sync();
  await sql.models.Clinica.bulkCreate([{ id_clinica: 72 }, { id_clinica: 66 }, { id_clinica: 35 }]);
  const cases = [];
  const lead = async (label, expected, fields = {}) => {
    const row = await db.LeadIntake.create({ clinica_id: 72, status_lead: 'nuevo', created_at: START, ...fields }, { hooks: false });
    cases.push({ label, row, expected }); return row;
  };
  const call = (row, reason, at = '2026-11-18T10:00:00Z', fields = {}) => db.LeadContactAttempt.create({
    lead_intake_id: row.id, usuario_id: 44, canal: 'llamada', motivo: reason, created_at: new Date(at), ...fields });
  const outcome = (row, value, at = '2026-11-18T10:00:00Z', steps = {}) => db.LeadAttributionAudit.create({
    lead_intake_id: row.id, raw_payload: { outcome: value }, attribution_steps: { action: 'call_outcome', userId: 44, ...steps }, created_at: new Date(at) });
  const history = (at, reason = 'no_contesta', fields = {}) => ({ fecha: at, usuario_id: 44, canal: 'llamada', motivo: reason, ...fields });
  await lead('no manual call', 'never_called');
  await lead('inbound website phone click is not an outbound human call', 'never_called', { call_initiated: true, call_initiated_at: new Date('2026-11-18T11:00Z') });
  await call(await lead('WhatsApp receipt is not a phone call', 'never_called'), 'no_contesta', undefined, { canal: 'whatsapp' });
  await call(await lead('automated callback has no human actor', 'never_called'), 'no_contesta', undefined, { usuario_id: null });
  await call(await lead('automation reason excludes a retained actor', 'never_called'), 'lead_auto_reply:sent');
  await call(await lead('human no answer', 'no_answer'), 'no_contesta');
  await call(await lead('human other result is called', 'called'), 'otro');
  const answered = await lead('later call result replaces old no answer', 'called');
  await call(answered, 'no_contesta'); await call(answered, 'otro', '2026-11-18T11:00:00Z');
  const retry = await lead('later no answer is the last call, not all-time effective contact', 'no_answer');
  await call(retry, 'otro'); await call(retry, 'sin_respuesta', '2026-11-18T11:00:00Z');
  await outcome(await lead('manual call outcome without normalized attempt is evidence', 'no_answer'), 'no_contactado');
  await outcome(await lead('manual completed information call is called', 'called'), 'informacion');
  await outcome(await lead('a phone-click audit does not claim a call', 'never_called'), 'no_contactado', undefined, { action: 'call_initiated' });
  await outcome(await lead('call outcome requires a human actor', 'never_called'), 'no_contactado', undefined, { userId: null });
  await outcome(await lead('boolean actor is not a user identifier', 'never_called'), 'no_contactado', undefined, { userId: true });
  await outcome(await lead('automation source with human id does not qualify', 'never_called'), 'no_contactado', undefined, { source: 'automation_v2' });
  await outcome(await lead('automation flag with human id does not qualify', 'never_called'), 'no_contactado', undefined, { is_automated: true });
  await outcome(await lead('call audit from another explicit clinic is rejected', 'never_called'), 'no_contactado', undefined, { clinic_id: 66 });
  await lead('unmirrored legacy manual receipt', 'no_answer', { historial_contactos: [history('2026-11-18T10:00:00.987Z')] });
  await lead('legacy offset is compared in UTC', 'no_answer', { historial_contactos: [history('2026-11-19T00:30:00+02:00')] });
  await lead('legacy missing channel keeps its historical phone default', 'no_answer', { historial_contactos: [history('2026-11-18 10:00:00', 'no_contesta', { canal: null })] });
  await lead('legacy missing channel and WhatsApp reason is not a phone call', 'never_called', { historial_contactos: [history('2026-11-18T10:00:00Z', 'whatsapp_message_sent', { canal: null })] });
  await lead('legacy malformed and future receipts are ignored', 'never_called', { historial_contactos: [history('2026-02-31T10:00:00Z'), history('not-a-date'), history('2026-11-20T10:00:00Z')] });
  await lead('legacy automation and null actor are ignored', 'never_called', { historial_contactos: [history('2026-11-18T10:00:00Z', 'no_contesta', { usuario_id: null }), history('2026-11-18T10:00:00Z', 'lead_auto_reply:sent')] });
  const mirror = await lead('mirrored history does not override a later normalized result', 'called', { historial_contactos: [history('2026-11-18T10:00:00.987Z')] });
  await call(mirror, 'no_contesta'); await call(mirror, 'otro', '2026-11-18T10:00:00Z');
  await call(await lead('pre-request and future calls do not qualify', 'never_called'), 'no_contesta', '2026-11-17T10:00:00Z');
  const future = cases.at(-1).row; await call(future, 'no_contesta', '2026-11-20T10:00:00Z');
  for (const state of ['citado','acudio_cita','convertido','descartado']) await call(await lead('excluded phase ' + state, null, { status_lead: state }), 'no_contesta');
  await lead('archived is excluded even with no calls', null, { archived_at: new Date('2026-11-18T11:00:00Z') });
  const foreign = await lead('other clinic remains outside caller scope', 'no_answer', { clinica_id: 66 }); await call(foreign, 'no_contesta');
  const groupOnly = await lead('authorized group request without clinic keeps its canonical bucket', 'no_answer', {
    clinica_id: null, grupo_clinica_id: 48 }); await call(groupOnly, 'no_contesta');
  const foreignGroup = await lead('other group remains outside caller scope', 'no_answer', {
    clinica_id: null, grupo_clinica_id: 99 }); await call(foreignGroup, 'no_contesta');
  const foreignClinic = await lead('clinic outside the indicator payload remains outside its list', 'no_answer', {
    clinica_id: 35 }); await call(foreignClinic, 'no_contesta');
  const [classified] = await sql.query(`SELECT LeadIntake.id,(${leadCallStateSql('LeadIntake', { now: NOW })}) AS state FROM LeadIntakes AS LeadIntake ORDER BY id`);
  for (const item of cases) assert.equal(classified.find(row => row.id === item.row.id).state, item.expected, item.label);
  const where = { clinica_id: 72 };
  const counts = await countLeadCallStates({ LeadIntake: db.LeadIntake, where, now: NOW });
  for (const state of ['never_called','no_answer']) {
    const expected = cases.filter(row => row.row.clinica_id === 72 && row.expected === state).map(row => row.row.id);
    const selected = await db.LeadIntake.findAndCountAll({ where: { [Op.and]: [where, leadCallStateWhere(state, { now: NOW })] },
      attributes: ['id'], order: [['id','ASC']], limit: 3, offset: 0, raw: true });
    const full = await db.LeadIntake.findAll({ where: { [Op.and]: [where, leadCallStateWhere(state, { now: NOW })] }, attributes: ['id'], order: [['id','ASC']], raw: true });
    assert.deepEqual(full.map(row => row.id), expected);
    assert.equal(selected.count, counts[state]); assert.equal(counts[state], expected.length);
    assert.equal(selected.rows.length, Math.min(3, expected.length), 'filtering occurs before pagination');
  }
  const empty = await countLeadCallStates({ LeadIntake: db.LeadIntake, where: { clinica_id: 999 }, now: NOW });
  assert.deepEqual(empty, { never_called: 0, no_answer: 0 });
  const inputs = cases.filter(item => item.row.clinica_id === 72).map(item => item.row.toJSON());
  let queries = 0; const before = sql.options.logging; sql.options.logging = () => { queries++; };
  let projected; try { projected = await enrichLeadCallState({ models: db, leads: inputs, now: NOW }); } finally { sql.options.logging = before; }
  assert.equal(queries, 1, 'one bulk query, not one lookup per lead');
  for (const item of cases.filter(item => item.row.clinica_id === 72)) assert.equal(projected.find(row => row.id === item.row.id).call_state,
    ['never_called','no_answer'].includes(item.expected) ? item.expected : null);
  const mismatch = await enrichLeadCallState({ models: db, leads: [{ ...foreign.toJSON(), clinica_id: 72 }], now: NOW });
  assert.equal(mismatch[0].call_state, null, 'an id cannot project another clinic identity');
  const redacted = await enrichLeadCallState({ models: db, leads: [{ ...foreign.toJSON(), privacy_redacted: true }], now: NOW });
  assert.equal(redacted[0].call_state, null);
  const groupCounts = await countLeadCallStates({ LeadIntake: db.LeadIntake, where: { clinica_id: null, grupo_clinica_id: 48 }, now: NOW });
  assert.deepEqual(groupCounts, { never_called: 0, no_answer: 1 });
  const groupView = await enrichLeadCallState({ models: db, leads: [groupOnly.toJSON()], now: NOW });
  assert.equal(groupView[0].call_state, 'no_answer');
  const wrongGroup = await enrichLeadCallState({ models: db, leads: [{ ...foreignGroup.toJSON(), grupo_clinica_id: 48 }], now: NOW });
  assert.equal(wrongGroup[0].call_state, null, 'a group-only request cannot be projected through another group identity');
  const { createLeadCallScopeFixture, dashboardTaskItems } = require('./fixtures/lead_call_scope.fixture');
  const clinicScope = { clinica_id: { [Op.in]: [66,72] } };
  const indicatorCounts = await countLeadCallStates({ LeadIntake: db.LeadIntake, where: clinicScope, now: NOW });
  const links = dashboardTaskItems()({ leadsNeverCalled: indicatorCounts.never_called, leadsNoAnswer: indicatorCounts.no_answer },
    '2026-11-18', [66,72]).filter(item => item.id.startsWith('leads_'));
  for (const link of links) {
    assert.equal(link.queryParams.clinica_id, '66,72');
    for (const globalAdmin of [false,true]) {
      const resolver = createLeadCallScopeFixture({ globalAdmin }), listWhere = {};
      await resolver.applyLeadScopeWhere(listWhere, link.queryParams, globalAdmin ? 1 : 144);
      listWhere[Op.and].push(leadCallStateWhere(link.queryParams.call_state, { now: NOW }));
      const listed = await db.LeadIntake.findAll({ where: listWhere, attributes: ['id'], order: [['id','ASC']], raw: true });
      assert.equal(listed.length, link.count, 'group CSV and All-selector links use the exact authorized indicator count scope');
      const actualIds = listed.map(row => row.id);
      assert.equal(actualIds.includes(groupOnly.id), false); assert.equal(actualIds.includes(foreignGroup.id), false);
      assert.equal(actualIds.includes(foreignClinic.id), false);
    }
  }
  const deniedWhere = {}, resolver = createLeadCallScopeFixture();
  await resolver.applyLeadScopeWhere(deniedWhere, { clinica_id: '35' }, 144);
  deniedWhere[Op.and].push(leadCallStateWhere('no_answer', { now: NOW }));
  assert.equal(await db.LeadIntake.count({ where: deniedWhere }), 0, 'a foreign URL scope cannot become an unfiltered list');
  report.callProfiles = cases.length;
  report.checks.push('Native core receipt models: last human call from normalized/legacy/audit, mirror dedup, UTC offsets and fractional timestamps; phone clicks/WhatsApp/automation/invalid actors/foreign clinic/future receipts excluded.');
  report.checks.push('One canonical SQL classifier feeds scoped counters and paginated WHERE with equal matching IDs/counts; archive and closed phases excluded, empty scope zero, one metadata-only bulk DTO query and redacted/cross-clinic projection denied.');
  report.checks.push('Real scope parser and server task payload: explicit indicator CSV gives the same IDs/count for group and All-selector callers, excludes NULL-group and foreign clinics, and an empty permission intersection yields zero instead of all.');
}));
