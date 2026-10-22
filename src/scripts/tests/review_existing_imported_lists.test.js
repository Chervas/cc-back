'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { Op } = require('sequelize');
const { hasPriorReviewRequest } = require('../../lib/review-request-history');
function native(file, name, dependencies) {
  const source = fs.readFileSync(require.resolve(file), 'utf8');
  const assignment = source.indexOf('exports.' + name + ' =');
  const pos = assignment >= 0 ? source.indexOf('async ', assignment) : source.indexOf('function ' + name + '(');
  assert(pos >= 0, name);
  const start = source.slice(pos - 6, pos) === 'async ' ? pos - 6 : pos;
  const ends = (assignment >= 0 ? ['\nexports.'] : ['\nasync function ', '\nfunction ', '\nconst '])
    .map(marker => source.indexOf(marker, start + 10)).filter(end => end >= 0);
  const code = source.slice(start, Math.min(...ends)).trim().replace(/;$/, '');
  return vm.runInNewContext('(' + code + ')', { Set, Map, Date, ...dependencies });
}
const file = '../../services/marketingBulkSends.service';
const repairMojibake = native(file, 'repairMojibake', { Buffer });
const normalizeText = native(file, 'normalizeText', { repairMojibake });
const asPlainObject = native(file, 'asPlainObject', {});
const isReview = native(file, 'isReviewRequestList', { asPlainObject,
  isReviewTemplateUsage: value => value === 'solicitud_resena', normalizeKey: value => String(value || '').toLowerCase() });
const eligible = native(file, 'isReviewImportedListEligible', { asPlainObject, normalizeText, OBJECTIVE_ID: 'mass_sends', isReviewRequestList: isReview });
const excludePreviouslyRequestedReviews = native(file, 'excludePreviouslyRequestedReviews', { hasPriorReviewRequest });
const row = patch => ({ id: 41, name: 'TESTONLY imported', objective_id: 'reactivate_patients',
  source: 'imported_file', status: 'draft', clinica_id: 66, criteria: {}, counters: { total: 4 }, ...patch });
test('selector eligibility accepts imported clinic lists, not campaigns, reviews, manual lists or archived records', () => {
  assert(eligible(row()));
  assert(eligible(row({ objective_id: 'mass_sends', criteria: { record_kind: 'recipient_list' } })));
  assert(eligible(row({ objective_id: 'mass_sends', source: 'saved_recipient_list', criteria: { record_kind: 'recipient_list', import_file_name: 'TESTONLY.csv' } })));
  for (const patch of [{ status: 'archived' }, { objective_id: 'other' }, { source: 'manual_list' },
    { objective_id: 'mass_sends', criteria: { record_kind: 'campaign' } },
    { objective_id: 'mass_sends', criteria: { record_kind: 'recipient_list', review_request: true } },
    { objective_id: 'mass_sends', source: 'saved_recipient_list', criteria: { record_kind: 'recipient_list' } }]) assert(!eligible(row(patch)));
});
test('metadata selector is scoped and returns no recipients, payloads or delivery actions', async () => {
  let reads = 0;
  const run = native(file, 'listReviewImportedLists', { Op, OBJECTIVE_ID: 'mass_sends',
    scopeToWhere: scope => ({ clinica_id: scope.clinicIds[0] }), isReviewImportedListEligible: eligible,
    MarketingPatientList: { findAll: async input => {
      reads++; assert.equal(input.where.clinica_id, 66); assert.equal(input.where.status[Op.ne], 'archived');
      assert(!input.attributes.includes('items_preview'));
      return [row({ secret: 'TESTONLY not returned', phone: 'TESTONLY' }), row({ id: 42, source: 'manual_list' })];
    } },
  });
  const result = await run({ scope: 'clinic', clinicIds: [66] });
  assert.equal(reads, 1); assert.equal(result.items.length, 1);
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['id', 'name', 'total']);
  assert.equal(result.items[0].total, 4);
});
function audienceFixture(list = row()) {
  const calls = [], scope = { scope: 'clinic', clinicIds: [66] };
  const map = native(file, 'mapReviewItemsFromImportedListBase', { normalizeText,
    normalizeKey: value => String(value || '').toLowerCase(), resolveLastAttendedAppointmentDate: item => item.last_visit_at || null });
  const deps = { Op, OBJECTIVE_ID: 'mass_sends', parseReviewImportListId: input => Number(input.review_import_list_id) || null,
    scopeToWhere: () => ({ clinica_id: 66 }), isReviewImportedListEligible: eligible,
    MarketingPatientList: { findOne: async input => { assert.equal(input.where.clinica_id, 66); return list; } },
    MarketingPatientListItem: { findAll: async input => {
      assert.equal(input.where.list_id, 41); assert.deepEqual(Array.from(input.where[Op.or][0].clinica_id[Op.in]), [66]);
      return [
        { paciente_id: 1, clinica_id: 66, name: 'TESTONLY previous', status: 'ready' },
        { paciente_id: 2, clinica_id: 66, name: 'TESTONLY opted out', status: 'excluded_opt_out' },
        { paciente_id: 3, clinica_id: 66, name: 'TESTONLY future', status: 'excluded_future_appointment' },
        { paciente_id: null, clinica_id: 66, name: 'TESTONLY unlinked', status: 'ready' },
      ];
    } },
    getReviewRequestHistory: async () => ({ patientIds:new Set([1]),phoneKeys:new Set() }),
    excludePreviouslyRequestedReviews, mapReviewItemsFromImportedListBase: map,
    prepareReviewItemsForExclusions: async (items, actualScope, options) => { calls.push('exclusions'); assert.equal(actualScope, scope); assert(options.review_exclusion_rules); return items; },
    applyMarketingOptOutExclusions: async items => { calls.push('current_opt_outs'); return items; },
    sortReviewRequestItemsByRecentCare: items => { calls.push('recent_first'); return items; },
  };
  return { calls, run: () => native(file, 'buildReviewItemsFromImportedList', deps)(scope,
    { review_import_list_id: 41, review_exclusion_rules: { no_visit_date: true } }) };
}
test('existing imported list uses the review pipeline and retains exclusions, recency and original records', async () => {
  const f = audienceFixture(); const items = await f.run();
  assert.equal(items[0].status, 'excluded_review_already_requested');
  assert.equal(items[1].status, 'excluded_opt_out'); assert.equal(items[2].status, 'ready');
  assert.deepEqual(f.calls, ['exclusions', 'current_opt_outs', 'recent_first']);
});
test('bulk imported contacts without a patient record are excluded rather than creating or guessing a patient', async () => {
  const f = audienceFixture(row({ objective_id: 'mass_sends', criteria: { record_kind: 'recipient_list' } }));
  const items = await f.run(); assert.equal(items[3].status, 'excluded_no_patient'); assert.equal(items[3].selected, false);
});
test('unavailable, foreign or archived selections fail closed and never fall back to the whole history', async () => {
  for (const value of [null, row({ status: 'archived' }), row({ source: 'manual_list' })]) {
    const f = audienceFixture(value); await assert.rejects(f.run(), error => error.status === 404);
    assert.deepEqual(f.calls, []);
  }
});
test('native endpoint requires review access before reading scoped metadata', async () => {
  for (const allowed of [true, false]) {
    let reads = 0, noStore = false;
    const run = native('../../controllers/marketingBulkSends.controller', 'listReviewImportedLists', {
      resolveReviewRequestSummaryScope: async (_req, options) => { assert.equal(options.allowAll, false); return { clinicIds: [66] }; },
      requireReviewHistoryAccess: async () => { if (!allowed) throw Object.assign(Error('TESTONLY forbidden'), { status: 403 }); },
      marketingBulkSendsService: { listReviewImportedLists: async () => { reads++; return { items: [] }; } },
      sendError: (res, error) => { res.status = error.status; },
    });
    const res = { status: 200, set: (key, value) => { noStore = key === 'Cache-Control' && value === 'no-store'; }, json() {} };
    await run({}, res); assert.equal(reads, allowed ? 1 : 0); assert.equal(res.status, allowed ? 200 : 403);
    assert.equal(noStore, allowed);
  }
});
test('owned MySQL proves clinic/group filtering and preserves source lists and recipients', {
  skip: process.env.REVIEW_IMPORTED_LISTS_MYSQL_TEST !== '1', timeout: 180000,
}, async () => {
  const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    const { DataTypes } = require('sequelize');
    const List = require('../../../models/marketingpatientlist')(sql, DataTypes);
    const Item = require('../../../models/marketingpatientlistitem')(sql, DataTypes);
    await List.sync(); await Item.sync();
    const rows = [row(), row({ id: 42, objective_id: 'mass_sends', criteria: { record_kind: 'recipient_list' } }),
      row({ id: 43, clinica_id: 72 }), row({ id: 44, status: 'archived' }), row({ id: 45, source: 'manual_list' }),
      row({ id: 46, objective_id: 'mass_sends', criteria: { record_kind: 'campaign' } }),
      row({ id: 47, clinica_id: null, grupo_clinica_id: 5, scope_type: 'group' })];
    await List.bulkCreate(rows);
    await Item.bulkCreate([
      { list_id: 42, paciente_id: 1, clinica_id: 66, name: 'TESTONLY previous' },
      { list_id: 42, paciente_id: 2, clinica_id: 66, name: 'TESTONLY opted out', status: 'excluded_opt_out' },
      { list_id: 42, paciente_id: null, clinica_id: 66, name: 'TESTONLY unlinked' },
      { list_id: 42, paciente_id: 3, clinica_id: 99, name: 'TESTONLY outside scope' },
      { list_id: 47, paciente_id: 4, clinica_id: 66, name: 'TESTONLY group selected' },
      { list_id: 47, paciente_id: 5, clinica_id: 72, name: 'TESTONLY group not selected' },
    ]);
    const snapshot = async () => JSON.stringify([await List.findAll({ raw: true, order: [['id','ASC']] }),
      await Item.findAll({ raw: true, order: [['id','ASC']] })]);
    const before = await snapshot();
    const scopeToWhere = native(file, 'scopeToWhere', { Op });
    const list = native(file, 'listReviewImportedLists', { Op, OBJECTIVE_ID: 'mass_sends',
      scopeToWhere, MarketingPatientList: List, isReviewImportedListEligible: eligible });
    const clinic = { scope: 'clinic', clinicIds: [66] }, group = { scope: 'group', groupId: 5, clinicIds: [66] };
    assert.deepEqual(Array.from((await list(clinic)).items.map(value => value.id)).sort(), [41,42]);
    assert.deepEqual(Array.from((await list(group)).items.map(value => value.id)).sort(), [41,42,47]);
    const map = native(file, 'mapReviewItemsFromImportedListBase', { normalizeText,
      normalizeKey: value => String(value || '').toLowerCase(), resolveLastAttendedAppointmentDate: () => null });
    const build = native(file, 'buildReviewItemsFromImportedList', { Op, OBJECTIVE_ID: 'mass_sends',
      scopeToWhere, parseReviewImportListId: value => value.review_import_list_id,
      MarketingPatientList: List, MarketingPatientListItem: Item, isReviewImportedListEligible: eligible,
      getReviewRequestHistory: async () => ({ patientIds:new Set([1]),phoneKeys:new Set() }),
      excludePreviouslyRequestedReviews, mapReviewItemsFromImportedListBase: map,
      prepareReviewItemsForExclusions: async items => items, applyMarketingOptOutExclusions: async items => items,
      sortReviewRequestItemsByRecentCare: items => items,
    });
    const candidates = await build(clinic, { review_import_list_id: 42 });
    assert.equal(candidates.length, 3); assert.equal(candidates[0].status, 'excluded_review_already_requested');
    assert.equal(candidates[1].status, 'excluded_opt_out'); assert.equal(candidates[2].status, 'excluded_no_patient');
    assert.equal((await build(group, { review_import_list_id: 47 })).length, 1);
    await assert.rejects(build(clinic, { review_import_list_id: 43 }), error => error.status === 404);
    assert.equal(await snapshot(), before);
    report.checks.push('Native metadata/candidate queries against owned MySQL; own/group scopes, review exclusions, unlinked contacts, foreign IDs and source immutability; no transport or real patients.');
  });
});
