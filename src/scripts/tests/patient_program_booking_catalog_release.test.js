'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const op = require('../patient-program-booking-catalog-release');
const C = require('../../lib/patient-program-booking-confirmation');
const empty = () => ({ database: 'owned_TESTONLY', flows: [], catalog: [], whatsapp: [], instances: [], executions: [] });
const clone = value => JSON.parse(JSON.stringify(value));
test('native controllers validate/normalize three central inactive candidates for booking AND reschedule, without inventing a timeout', async () => {
  const rows = await op.proposal();
  assert.equal(rows.flows.nodes.length, 13); assert(C.graphValid(rows.flows.nodes));
  for (const row of Object.values(rows)) assert.equal(row.is_active, false);
  assert.equal(rows.flows.is_system, true); assert.equal(rows.flows.clinic_id, null); assert.equal(rows.flows.group_id, null);
  assert.equal(rows.flows.published_at, null); assert.equal(rows.flows.published_by, null);
  assert.equal(rows.flows.trigger_type, C.REQUEST); assert.equal(rows.catalog.trigger_type, C.REQUEST);
  assert.equal(rows.catalog.template_key, C.FAMILY); assert.equal(rows.catalog.template_version, 1);
  assert.equal(rows.catalog.steps.length, 13); assert.equal(rows.catalog.is_default_for_trigger, false);
  assert.equal(rows.whatsapp.locale, 'es'); assert.equal(rows.whatsapp.category, 'UTILITY');
  assert.equal(rows.whatsapp.body_text, C.BODY); assert.equal(rows.whatsapp.components[0].text, C.BODY);
  assert.match(C.BODY, /citas reservadas actualmente/); assert.match(rows.catalog.description, /Reserva o reprogramación/);
  assert.deepEqual(rows.whatsapp.components[1].buttons.map(row => row.text), [...C.BUTTONS]);
  assert.equal(rows.flows.trigger_config.configured, false);
  for (const config of [rows.flows.trigger_config, rows.flows.nodes[0].config]) {
    assert.equal(config.response_timeout_minutes, null); assert.equal(config.enabled_after, null);
    assert.equal(C.configValid(config), false);
  }
});
test('operator proposal cannot bootstrap app models, services/providers, timers, subprocesses or mutate runtime environment', () => {
  const script = `const assert=require('assert/strict'),Module=require('module'),old=Module._load;
  const env={...process.env},op=require('./src/scripts/patient-program-booking-catalog-release');
  assert(!require.cache[require.resolve('./models')]);
  for(const [name,methods] of Object.entries({http:['request','get'],https:['request','get'],net:['connect','createConnection'],
    tls:['connect'],child_process:['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']})) {
    const builtin=require(name);for(const method of methods)builtin[method]=()=>{throw Error('SIDE_EFFECT_CALL:'+name+'.'+method)};
  }
  Module._load=function(name,parent,...rest){let file;try{file=Module._resolveFilename(name,parent)}catch{}
    if(file&&(/\\/models\\/index.js$/.test(file)||/\\/services\\/|\\/queue\\./.test(file)))throw Error('APP_BOOT_FORBIDDEN:'+file);
    return old.call(this,name,parent,...rest)};
  op.proposal().then(()=>{assert.deepEqual({...process.env},env);assert(!require.cache[require.resolve('./models')]);console.log('isolated-native-validation-pass')})
    .catch(e=>{console.error(e.stack);process.exitCode=1});`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /isolated-native-validation-pass/);
});
test('fresh scoped plan pins full before snapshot, source/rows and exactly three inserts; known identical preparation is a no-op', async () => {
  const before = empty(), now = new Date('2026-10-20T12:00:00.000Z'), plan = await op.makePlan(before, 'owned', { now });
  assert.deepEqual(plan.change, { no_op: false, insert_count: 3 });
  assert.equal(Date.parse(plan.expires_at) - Date.parse(plan.created_at), 1800000);
  assert.equal(plan.before_sha256, op.hash(before)); assert.equal(plan.rows_sha256, op.hash(plan.rows));
  assert.equal(plan.source_sha256, op.sourceHash());
  for (const field of ['central_catalog_only', 'inactive_only', 'no_scope_copies', 'no_jobs', 'no_messages',
    'no_provider_submission', 'no_gate_change', 'no_historical_replay', 'timeout_and_cut_explicitly_unset']) assert.equal(plan.policy[field], true);
  const installed = { ...empty(), flows: [{ id: 11, ...plan.rows.flows }], catalog: [{ id: 12, ...plan.rows.catalog }],
    whatsapp: [{ id: 13, ...plan.rows.whatsapp }] };
  assert.deepEqual(op.assertSnapshot(installed, plan.rows), { no_op: true, insert_count: 0 });
  // mysql wire booleans are numbers, not JS booleans.
  for (const key of ['flows', 'catalog', 'whatsapp']) for (const [field, value] of Object.entries(installed[key][0])) {
    if (typeof value === 'boolean') installed[key][0][field] = Number(value);
  }
  assert.deepEqual(op.assertSnapshot(installed, plan.rows), { no_op: true, insert_count: 0 });
});
test('partial, active, changed, configured, scoped, published, duplicate or already-used candidates fail closed; no overwrite/revision path', async () => {
  const rows = await op.proposal(), installed = { ...empty(), flows: [{ id: 11, ...rows.flows }],
    catalog: [{ id: 12, ...rows.catalog }], whatsapp: [{ id: 13, ...rows.whatsapp }] };
  for (const mutate of [
    value => value.flows = [], value => value.catalog.push(clone(value.catalog[0])),
    value => value.flows[0].is_active = 1, value => value.flows[0].clinic_id = 72,
    value => value.flows[0].published_at = '2026-10-20 12:00:00', value => value.flows[0].trigger_config.response_timeout_minutes = 1440,
    value => value.flows[0].trigger_config.enabled_after = '2026-10-20T12:00:00.000Z',
    value => value.catalog[0].is_default_for_trigger = true, value => value.catalog[0].last_propagated_at = '2026-10-20 12:00:00',
    value => value.whatsapp[0].category = 'MARKETING', value => value.whatsapp[0].locale = 'es_ES',
    value => value.whatsapp[0].body_text += ' Cambiado', value => value.instances.push({ id: 100 }),
    value => value.executions.push({ id: 200 }),
  ]) {
    const changed = clone(installed); mutate(changed); assert.throws(() => op.assertSnapshot(changed, rows), /PROGRAM_CATALOG_/);
  }
});
test('missing approval, altered/stale source/body/before/change and expired plans fail before any database access', async () => {
  const now = new Date(), plan = await op.makePlan(empty(), 'owned', { now });
  const forbidden = new Proxy({}, { get() { throw Error('DATABASE_FORBIDDEN'); } });
  const check = (value, options = {}) => assert.rejects(op.execute({ connection: forbidden, plan: value,
    approvedHash: op.hash(value), backupPath: 'TESTONLY', now, ...options }), /EXACT_FRESH_REVIEWED_PLAN_REQUIRED/);
  await check(plan, { approvedHash: 'wrong' });
  for (const mutate of [value => value.source_sha256 = 'wrong', value => value.rows.whatsapp.body_text += ' changed',
    value => value.before.database = 'foreign', value => value.change.insert_count = 4,
    value => value.expires_at = new Date(+now + 86400000).toISOString()]) {
    const invalid = clone(plan); mutate(invalid); await check(invalid);
  }
  await check(plan, { now: new Date(+now + 1800000) });
});
