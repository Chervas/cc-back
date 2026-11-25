'use strict';
const db = require('./fixtures/email_models.fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Op, Sequelize } = require('sequelize');
const bulk = require('../../services/marketingBulkSends.service');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');

const clinic = { scope: 'clinic', clinicIds: [21] };
const group = { scope: 'group', clinicIds: [21, 22], groupId: 8 };
const row = (id, kind, extra = {}) => ({ id, name: `Campaña ${id}`, objective_id: 'mass_sends', status: 'draft',
  clinica_id: 21, criteria: kind === undefined ? {} : { record_kind: kind }, counters: { total: 2, ready: 1 },
  updated_at: new Date('2026-11-01T00:00:00Z'), ...extra });

function review(criteria = {}) {
  const contexts = ['review_request', 'reviews', 'solicitud_resena', 'resenas'];
  return [true, 1, 'true', '1'].includes(criteria.review_request)
    || ['solicitud_resena', 'resena', 'review_request', 'reviews'].includes(criteria.template_usage)
    || [criteria.dispatch, criteria.dispatch_config].some(value => contexts.includes(value?.context) || contexts.includes(value?.dispatch_context));
}

// The repository fixture applies the supplied WHERE before count/offset/limit.
// This makes omissions/overwritten AND/OR filters visible in the public result.
function matches(value, where) {
  if (where instanceof db.Sequelize.Utils.Literal) {
    if (where.val.includes('$.record_kind')) {
      const kind = value.criteria?.record_kind == null ? '' : String(value.criteria.record_kind).toLowerCase();
      return where.val.includes("IN ('recipient_list', '')") ? ['', 'recipient_list'].includes(kind) : kind !== 'recipient_list';
    }
    if (where.val.includes('$.review_request')) return where.val.trim().startsWith('NOT') ? !review(value.criteria) : review(value.criteria);
    throw Error('UNEXPECTED_PAGINATION_LITERAL');
  }
  return Reflect.ownKeys(where).every(key => {
    if (key === Op.and) return where[key].every(condition => matches(value, condition));
    if (key === Op.or) return where[key].some(condition => matches(value, condition));
    const condition = where[key];
    if (condition && typeof condition === 'object') return Reflect.ownKeys(condition).every(operator => {
      if (operator === Op.ne) return value[key] !== condition[operator];
      if (operator === Op.eq) return value[key] === condition[operator];
      if (operator === Op.in) return condition[operator].includes(value[key]);
      throw Error('UNEXPECTED_PAGINATION_OPERATOR');
    });
    return value[key] === condition;
  });
}

function repository(t, records) {
  const calls = [];
  t.mock.method(db.MarketingPatientList, 'findAndCountAll', async options => {
    calls.push(options);
    const eligible = records.filter(value => matches(value, options.where)).sort((left, right) => {
      for (const [field, direction] of options.order) {
        const a = field === 'updated_at' ? +left[field] : left[field];
        const b = field === 'updated_at' ? +right[field] : right[field];
        if (a !== b) return (a > b ? 1 : -1) * (direction === 'DESC' ? -1 : 1);
      }
      return 0;
    });
    return { count: eligible.length, rows: eligible.slice(options.offset, options.offset + options.limit) };
  });
  return calls;
}

test('each collection paginates beyond 100, counts filtered rows and retains missing/null/empty legacy kinds in both', async t => {
  const campaigns = Array.from({ length: 120 }, (_, index) => row(index + 1, 'campaign'));
  const lists = Array.from({ length: 120 }, (_, index) => row(index + 201, 'recipient_list'));
  const legacy = [row(501), row(502, null), row(503, '')];
  const records = [...campaigns, ...lists, ...legacy, row(600, 'campaign', { clinica_id: 99 }),
    row(601, 'campaign', { status: 'archived' }), row(602, 'campaign', { criteria: { review_request: true } }),
    row(603, 'recipient_list', { criteria: { record_kind: 'recipient_list', template_usage: 'solicitud_resena' } })];
  const calls = repository(t, records);
  for (const kind of ['campaign', 'recipient_list']) {
    const ids = [];
    for (let page = 1; page <= 13; page++) {
      const result = await bulk.listCampaigns(clinic, { context: 'mass_sends', record_kind: kind, page: String(page), page_size: '10' });
      assert.deepEqual(result.pagination, { page, page_size: 10, total: 123 });
      assert.equal(result.aggregate, undefined); assert.equal(result.daily_series, undefined);
      assert(result.items.every(item => item.items_preview.length === 0));
      ids.push(...result.items.map(item => item.id));
    }
    const expected = [...(kind === 'campaign' ? campaigns : lists), ...legacy].map(item => item.id).sort((a, b) => b - a);
    assert.deepEqual(ids, expected); assert.equal(new Set(ids).size, 123);
  }
  assert(calls.every(call => call.limit === 10 && call.order[1][0] === 'id' && call.order[1][1] === 'DESC'));
});

test('group OR scope and review/type AND filters reach SQL before LIMIT with stable updated_at/id order', async t => {
  const calls = repository(t, [row(1, 'campaign'), row(2, 'recipient_list'), row(3, 'campaign', { clinica_id: null, grupo_clinica_id: 8 }),
    row(4, 'campaign', { clinica_id: 22 }), row(5, 'campaign', { clinica_id: null, grupo_clinica_id: 9 }),
    row(6, 'campaign', { criteria: { dispatch_config: { dispatch_context: 'reviews' } } })]);
  const result = await bulk.listCampaigns(group, { context: 'mass_sends', record_kind: 'campaign', page: '1', page_size: '25' });
  assert.deepEqual(result.items.map(item => item.id), [4, 3, 1]); assert.equal(result.pagination.total, 3);
  const generator = new Sequelize('offline', 'offline', 'offline', { dialect: 'mysql', logging: false }).dialect.queryGenerator;
  const sql = generator.selectQuery('MarketingPatientLists', { ...calls[0], attributes: ['id'] });
  assert.match(sql, /grupo_clinica_id.*8.*OR.*clinica_id.*IN \(21, 22\)/s);
  assert.match(sql, /NOT.*review_request.*JSON_TYPE.*record_kind.*ORDER BY.*updated_at.*DESC.*id.*DESC.*LIMIT 0, 25/s);
  assert.equal(calls[0].where[Op.and].length, 4);
});

test('the campaign collection projects an interrupted job without persisting or restarting the queue', async t => {
  const message = 'El teléfono de destino no coincide con la conversación. Revisa la ficha antes de enviar.';
  const interrupted = row(1, 'campaign', { status: 'sending', criteria: {
    record_kind: 'campaign', dispatch: { status: 'sending', job_id: 98 },
  } });
  const scheduled = row(2, 'campaign', { status: 'scheduled', criteria: {
    record_kind: 'campaign', dispatch: { status: 'scheduled', job_id: 99 },
  } });
  repository(t, [interrupted, scheduled]);
  const jobs = t.mock.method(db.JobRequest, 'findAll', async options => {
    assert.deepEqual(options.where.id[Op.in].sort(), [98, 99]);
    return [{ id: 98, status: 'failed', error_message: message, completed_at: new Date('2026-11-04T15:55:40Z') }];
  });
  const result = await bulk.listCampaigns(clinic, { context: 'mass_sends', record_kind: 'campaign', page_size: 10 });
  assert.equal(result.items[0].dispatch.status, 'scheduled');
  assert.equal(result.items[1].dispatch.status, 'failed');
  assert.equal(result.items[1].dispatch.can_resume_identity_conflict, true);
  assert.equal(result.items[1].dispatch.last_error, message);
  assert.equal(interrupted.status, 'sending');
  assert.equal(interrupted.criteria.dispatch.status, 'sending');
  assert.equal(jobs.mock.callCount(), 1);
});

test('page sizes 10/25/50, defaults, out-of-range pages and string null kind use the same filtered count', async t => {
  repository(t, [...Array.from({ length: 60 }, (_, index) => row(index + 1, 'campaign')), row(101, 'null'), row(102, 'RECIPIENT_LIST')]);
  for (const size of [10, 25, 50]) {
    const result = await bulk.listCampaigns(clinic, { context: 'envíos masivos', record_kind: 'campaign', page_size: size });
    assert.equal(result.items.length, size); assert.deepEqual(result.pagination, { page: 1, page_size: size, total: 61 });
  }
  const empty = await bulk.listCampaigns(clinic, { context: 'mass_sends', record_kind: 'campaign', page: 99, page_size: 10 });
  assert.deepEqual(empty.items, []); assert.deepEqual(empty.pagination, { page: 99, page_size: 10, total: 61 });
  const lists = await bulk.listCampaigns(clinic, { context: 'mass_sends', record_kind: 'recipient_list' });
  assert.deepEqual(lists.items.map(item => item.id), [102]);
  const denied = await bulk.listCampaigns({ scope: 'clinic', clinicIds: [] }, { context: 'mass_sends', record_kind: 'campaign' });
  assert.deepEqual(denied.pagination, { page: 1, page_size: 10, total: 0 });
});

test('invalid optional pagination is rejected before any collection storage query', async () => {
  const base = { context: 'mass_sends', record_kind: 'campaign', page: 1, page_size: 10 };
  const invalid = [{ context: 'reviews' }, { context: undefined }, { record_kind: 'unknown' }, { record_kind: ['campaign'] },
    { record_kind: undefined }, { page: '1x' }, { page: '01' }, { page: 0 }, { page: -1 }, { page: 1.5 },
    { page: ['1'] }, { page: true }, { page: Number.MAX_SAFE_INTEGER }, { page: 214748366 },
    { page_size: 20 }, { page_size: null }, { page_size: '25x' }, { page_size: ['10'] }];
  for (const input of invalid) await assert.rejects(bulk.listCampaigns(clinic, { ...base, ...input }),
    { status: 400, code: 'bulk_send_pagination_invalid' });
});

test('a protected record on a page retains its clinical authority guard', async t => {
  repository(t, [row(1, 'campaign', { criteria: { record_kind: 'campaign', review_care_version: 1 } })]);
  const key = require.resolve('../../services/reviewCareContext.service'); const previous = require.cache[key];
  let checked = false;
  require.cache[key] = { id: key, filename: key, loaded: true, exports: { current: () => ({ guard: async input => {
    checked = true; assert.equal(input.scope, clinic); assert.equal(input.list.id, 1);
    throw Object.assign(Error('FICTITIOUS_CLINICAL_PERMISSION_DENIED'), { status: 403 });
  } }) } };
  t.after(() => { if (previous) require.cache[key] = previous; else delete require.cache[key]; });
  await assert.rejects(bulk.listCampaigns(clinic, { context: 'mass_sends', record_kind: 'campaign', page: 1, page_size: 10 }), { status: 403 });
  assert.equal(checked, true);
});

test('legacy response and aggregates remain intact; only normalized mass context advertises capability', async t => {
  const listCalls = []; let contacts = 0;
  t.mock.method(db.MarketingPatientList, 'findAll', async options => { listCalls.push(options); return [row(1)]; });
  t.mock.method(db.MarketingPatientListItem, 'findAll', async () => []);
  t.mock.method(db.sequelize, 'query', async () => { contacts++; return [{ unique_contacts: 7, unique_ready_contacts: 3, unique_sent_contacts: 2 }]; });
  for (const context of ['mass_sends', 'envíos masivos', 'reviews', null]) {
    const result = await bulk.listCampaigns(clinic, { context });
    assert.equal(result.aggregate.unique_contacts, 7); assert.equal(result.aggregate.total_lists, 1);
    assert.deepEqual(result.daily_series, []); assert.equal(result.pagination, undefined);
    assert.equal(result.supports_collection_pagination, ['mass_sends', 'envíos masivos'].includes(context) ? true : undefined);
  }
  assert.equal(contacts, 4); assert(listCalls.every(call => call.limit === 100 && call.order.length === 1));
});

function response() { return { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } }; }
function controller(access, calls) {
  return loadDiscoverySource('controllers/marketingBulkSends.controller.js', {
    '../lib/clinicScope': { resolveClinicScope: async () => ({ ...group, isValid: true }) },
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async options => { calls.push(options); return access; } },
    '../services/marketingBulkSends.service': bulk,
  });
}

test('paginated HTTP requires read access to the whole resolved scope and forwards typed query inputs', async t => {
  const calls = []; const denied = response();
  const request = { query: { clinicId: 'group:8', context: 'mass_sends', record_kind: 'recipient_list', page: '2', page_size: '25' }, userData: { userId: 55 } };
  await controller(false, calls).listCampaigns(request, denied);
  assert.equal(denied.statusCode, 403); assert.equal(calls[0].access, 'read'); assert.deepEqual(calls[0].clinicIds, [21, 22]);
  const options = repository(t, Array.from({ length: 60 }, (_, index) => row(index + 1, 'recipient_list')));
  const allowed = response(); await controller(true, calls).listCampaigns(request, allowed);
  assert.equal(allowed.statusCode, 200); assert.equal(allowed.body.pagination.page, 2); assert.equal(allowed.body.pagination.total, 60);
  assert.equal(options[0].offset, 25); assert.equal(options[0].limit, 25); assert.equal(allowed.body.scope.groupId, 8);
});
