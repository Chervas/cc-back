'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Op } = require('sequelize');
const calls = require('../../services/leadCallState.service');
const source = file => fs.readFileSync(path.join(__dirname, '../../', file), 'utf8');

test('strict enum, quoted identifier and internal clock reject untrusted SQL inputs', () => {
  for (const value of [undefined, null, '']) assert.equal(calls.normalizeCallState(value), null);
  for (const value of calls.CALL_STATES) assert.equal(calls.normalizeCallState(' ' + value + ' '), value);
  for (const value of [true, 1, [], {}, 'called', "no_answer' OR 1=1"]) assert.throws(() => calls.normalizeCallState(value), { code: 'lead_call_state_invalid', status: 400 });
  assert.throws(() => calls.leadCallStateSql('Lead;SELECT 1'), /alias_invalid/);
  assert.throws(() => calls.leadCallStateSql('LeadIntake', { now: '2026-11-18' }), /clock_invalid/);
  const sql = calls.leadCallStateSql('AllowedAlias', { now: new Date('2026-11-18T12:00:00Z') });
  assert.match(sql, /`AllowedAlias`\.historial_contactos/);
  assert.doesNotMatch(sql, /call_initiated|num_contactos|telefono|nombre|Messages|CitasPacientes/);
  assert.match(calls.leadCallStateWhere('no_answer').val, /='no_answer'$/);
});

test('counters preserve caller scope/transaction and make one grouped metadata read', async () => {
  const where = { clinica_id: { [Op.in]: [66,72] }, [Op.and]: [{ actor_acl: 'already enforced' }] }, transaction = {};
  let reads = 0;
  const counts = await calls.countLeadCallStates({ LeadIntake: { name: 'LeadIntake', async findAll(options) {
    reads++; assert.equal(options.where, where); assert.equal(options.transaction, transaction); assert.equal(options.raw, true);
    assert.equal(options.attributes.length, 2); assert.equal(options.attributes[0][1], 'call_state');
    assert.equal(options.attributes[1][1], 'count'); assert.equal(options.group[0].val, 'call_state');
    return [{ call_state: 'never_called', count: '4' }, { call_state: 'no_answer', count: '3' }, { call_state: 'called', count: '20' }, { call_state: null, count: '50' }];
  } }, where, transaction });
  assert.deepEqual(counts, { never_called: 4, no_answer: 3 }); assert.equal(reads, 1);
  assert.deepEqual(await calls.countLeadCallStates({}), { never_called: 0, no_answer: 0 });
});

test('canonical DTO is exact clinic/id, private, independent of num_contactos and one query', async () => {
  let reads = 0;
  const leads = [{ id: 1, clinica_id: 72, num_contactos: 999 }, { id: 2, clinica_id: 72, num_contactos: 0 },
    { id: 3, clinica_id: 72, privacy_redacted: true }, { id: 4, clinica_id: 72 }];
  const before = JSON.stringify(leads);
  const result = await calls.enrichLeadCallState({ leads, models: { LeadIntake: { name: 'LeadIntake', async findAll(options) {
    reads++; assert.deepEqual(options.where[Op.or], [{ id: 1, clinica_id: 72 }, { id: 2, clinica_id: 72 }, { id: 4, clinica_id: 72 }]);
    assert.deepEqual(options.attributes.slice(0, 2), ['id','clinica_id']);
    return [{ id: 1, clinica_id: 72, call_state: 'never_called' }, { id: 2, clinica_id: 72, call_state: 'no_answer' },
      { id: 3, clinica_id: 72, call_state: 'no_answer' }, { id: 4, clinica_id: 66, call_state: 'no_answer' }];
  } } } });
  assert.equal(reads, 1); assert.equal(JSON.stringify(leads), before);
  assert.deepEqual(result.map(row => row.call_state), ['never_called','no_answer',null,null]);
});

test('post-write projection failure remains unknown and cannot turn a committed mutation into retry', async () => {
  const warnings = [], lead = { id: 1, clinica_id: 72, call_state: 'never_called' };
  const result = await calls.enrichLeadCallState({ leads: [lead], logger: { warn: (...args) => warnings.push(args) },
    models: { LeadIntake: { async findAll() { throw Object.assign(Error('PRIVATE_ERROR'), { code: 'ER_NO_SUCH_TABLE' }); } } } });
  assert.equal(result[0].call_state, undefined); assert.equal(result[0].call_state_status, 'unavailable');
  assert.equal(lead.call_state, 'never_called'); assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE_ERROR/);
});

function listHarness() {
  const file = source('controllers/intake.controller.js');
  const block = file.slice(file.indexOf('const LEAD_LIST_SORT_FIELDS ='), file.indexOf('exports.listLeads ='));
  const queries = [], scopes = [], privacy = [];
  const build = vm.runInNewContext(block + '\nbuildLeadListPayload;', {
    Op, Set, Number, Math, Date, ...calls,
    parseInteger: value => value == null ? null : Number.isInteger(Number(value)) ? Number(value) : null,
    applyLeadScopeWhere: async (where, query, actor) => { scopes.push({ query, actor });
      if (query.clinicId && Number(query.clinicId) !== 72) throw Object.assign(Error('FORBIDDEN'), { status: 403 });
      where.clinica_id = 72;
    },
    CHANNELS: new Set(['paid','organic','unknown']), SOURCES: new Set(['web']), STATUSES: new Set(['nuevo']),
    appendAndWhere: (where, clause) => { where[Op.and] = [...(where[Op.and] || []), clause]; },
    LeadIntake: { async findAndCountAll(query) { queries.push(query); return { count: 1, rows: [{ id: 1, clinica_id: 72 }] }; } },
    Clinica: {}, GrupoClinica: {}, Campana: {}, enrichLeadsForUi: async rows => rows,
    protectLeadRowsForRequest: async (req, rows) => { privacy.push(req.userData.userId); return rows; },
  });
  return { build, queries, scopes, privacy };
}

test('real paginated controller applies canonical call filter together with existing clinic ACL before SQL', async () => {
  const f = listHarness(); const page = await f.build({ clinica_id: 72, call_state: 'no_answer', page: 2, pageSize: 10 }, { userId: 144 });
  assert.equal(f.scopes[0].actor, 144); assert.equal(f.queries[0].where.clinica_id, 72);
  assert.match(f.queries[0].where[Op.and][0].val, /='no_answer'$/);
  assert.equal(f.queries[0].offset, 10); assert.equal(page.page, 2); assert.deepEqual(f.privacy, [144]);
  await assert.rejects(f.build({ clinica_id: 66, call_state: 'never_called' }, { userId: 144 }), { status: 403 });
  assert.equal(f.queries.length, 1, 'a call filter cannot remove clinic access checks');
  await assert.rejects(f.build({ call_state: 'all' }, { userId: 144 }), { code: 'lead_call_state_invalid' });
  assert.equal(f.queries.length, 1);
});

test('real privacy whitelist omits call bucket, human detail and contact canaries', () => {
  const file = source('controllers/intake.controller.js');
  const block = file.slice(file.indexOf('const redactLeadForPrivacy ='), file.indexOf('const protectLeadRowsForRequest ='));
  const redact = vm.runInNewContext(block + '\nredactLeadForPrivacy;', {
    toPlain: row => row, compactPrivacyObject: row => row, parseInteger: value => Number(value) || null,
    sanitizeLeadClinic: () => null, sanitizeLeadGroup: () => null, sanitizeLeadCampaign: () => null,
    sanitizeLeadMarketingCampaign: () => null, sanitizeLeadSourceTrace: () => null, leadPrivacySuffix: () => 'safe',
    CHANNELS: new Set(['paid']), SOURCES: new Set(['web']), STATUSES: new Set(['nuevo']),
  });
  const value = redact({ id: 1, clinica_id: 72, source: 'web', channel: 'paid', status_lead: 'nuevo',
    call_state: 'no_answer', call_state_status: 'unavailable', nombre: 'PRIVATE_NAME', telefono: 'PRIVATE_PHONE',
    historial_contactos: [{ notas: 'PRIVATE_CLINICAL' }], first_human_interaction: { user_name: 'PRIVATE_ACTOR' } });
  assert.equal(value.call_state, undefined); assert.equal(value.call_state_status, undefined);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_/);
});

test('real dashboard tasks use two distinct buckets and exact filtered links; counters retain scope', async () => {
  const file = source('services/panelesDashboard.service.js');
  const block = file.slice(file.indexOf('async function countTasks('), file.indexOf('async function loadPendingConsentCards('));
  const reads = [];
  const LeadIntake = { name: 'LeadIntake', async findAll(options) { reads.push(options); return [
    { call_state: 'never_called', count: 5 }, { call_state: 'no_answer', count: 2 }]; } };
  const functions = vm.runInNewContext(block + '\n({countTasks,taskItems});', {
    Op, Promise, Number, LeadIntake, countLeadCallStates: calls.countLeadCallStates,
    scopedWhere: (field, ids) => ({ [field]: ids.length === 1 ? ids[0] : { [Op.in]: ids } }),
    reviewSourceIds: () => [], buildClinicDayRanges: () => [], CitaPaciente: null,
    PatientConsentDocument: null, BusinessProfileReview: null,
  });
  const counts = await functions.countTasks({ clinicIds: [72], clinicMap: new Map(), todayDate: '2026-11-18', reviewSources: {} });
  assert.equal(reads.length, 1); assert.equal(reads[0].where.clinica_id, 72);
  assert.equal(counts.leadsNeverCalled, 5); assert.equal(counts.leadsPending, 5); assert.equal(counts.leadsNoAnswer, 2);
  const items = functions.taskItems(counts, '2026-11-18', [72]);
  assert.equal(items.find(row => row.id === 'leads_never_called').queryParams.call_state, 'never_called');
  assert.equal(items.find(row => row.id === 'leads_no_answer').queryParams.call_state, 'no_answer');
  assert.equal(items.find(row => row.id === 'leads_no_answer').queryParams.clinica_id, 72);
  assert.equal(items.some(row => row.id === 'leads_pending'), false, 'compatibility count is not a duplicated visible task');
  await functions.countTasks({ clinicIds: [], clinicMap: new Map(), todayDate: '2026-11-18' });
  assert.equal(reads.length, 1, 'empty permission scope performs no lead query');
});

test('real stats handler exposes the same bucket contract and filter inside its authorized scope', async () => {
  const file = source('controllers/intake.controller.js');
  const block = file.slice(file.indexOf('exports.getLeadStats ='), file.indexOf('exports.updateLeadStatus ='));
  const exports = {}, readWhere = [];
  const LeadIntake = { name: 'LeadIntake', async findAll(options) {
    readWhere.push(options.where);
    return Array.isArray(options.attributes[0]) ? [{ call_state: 'no_answer', count: 2 }]
      : [{ id: 1, clinica_id: 72 }];
  }, async count() { return 2; } };
  vm.runInNewContext(block, { exports, asyncHandler: fn => fn, LeadIntake, db: {}, ...calls,
    buildLeadStatsWhereFromRequest: async req => {
      assert.equal(req.userData.userId, 144); return { clinica_id: 72 };
    },
    appendAndWhere: (where, clause) => { where[Op.and] = [...(where[Op.and] || []), clause]; },
    require: module => { assert.equal(module, '../services/campaignWorkspace.service'); return {
      loadReportingPatientContexts: async () => [], patientContextBreakdown: () => ({}), PATIENT_CONTEXT_EXPLANATION: 'existing contract',
    }; },
    getLeadCompetitionStatsMode: () => null,
  });
  let response;
  await exports.getLeadStats({ query: { clinica_id: 72, call_state: 'no_answer' }, userData: { userId: 144 } },
    { status(code) { assert.equal(code, 200); return this; }, json(value) { response = value; } });
  assert.deepEqual(response.call_state_counts, { never_called: 0, no_answer: 2 });
  for (const where of readWhere) { assert.equal(where.clinica_id, 72); assert.match(where[Op.and][0].val, /='no_answer'$/); }
});
