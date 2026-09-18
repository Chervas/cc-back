'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compare, validatePlan, digest } = require('../../lib/securitySchemaContract');
const { parse } = require('../security-schema-release');
const schema = require('../../../ops/security/schema-contract.json');
function baseline() {
  return { defaults: { ...schema.defaults }, tables: Object.entries(schema.tables).map(([TABLE_NAME,t]) => ({ TABLE_NAME,ENGINE:t.ENGINE,TABLE_COLLATION:t.TABLE_COLLATION })),
    columns: Object.entries(schema.tables).flatMap(([TABLE_NAME,t]) => t.columns.map(c => ({TABLE_NAME,...c}))),
    indexes: Object.entries(schema.tables).flatMap(([TABLE_NAME,t]) => t.indexes.flatMap(i => i.columns.map(c => ({TABLE_NAME,...c})))),
    checks: Object.entries(schema.tables).flatMap(([TABLE_NAME,t]) => (t.checks || []).map(c => ({TABLE_NAME,...c}))),
    migrations: schema.migrations.map(m => m.name) };
}
test('contract permits additive fields but rejects security type, default, index and history drift', () => {
  const actual=baseline(); assert.equal(compare(actual,schema).compatible,true);
  actual.columns.push({ TABLE_NAME:'AuthSessions',COLUMN_NAME:'future_optional' });
  assert.equal(compare(actual,schema).compatible,true);
  for (const change of [s=>s.tables.pop(),s=>s.columns.shift(),s=>s.columns[0].IS_NULLABLE='YES',
    s=>s.columns[0].COLUMN_DEFAULT='unexpected',s=>s.indexes.shift(),s=>s.migrations.pop(),
    s=>s.defaults.DEFAULT_COLLATION_NAME='utf8mb4_unicode_ci']) {
    const altered=baseline();change(altered);assert.equal(compare(altered,schema).compatible,false);
  }
});
test('required CHECK constraints must exist, be enforced and retain their expression', () => {
  const actual = baseline();
  const table = Object.keys(schema.tables)[0];
  const constraint = { CONSTRAINT_NAME: 'synthetic_required_check', ENFORCED: 'YES', CHECK_CLAUSE: '(`id` > 0)' };
  const contract = structuredClone(schema);
  contract.tables[table].checks = [constraint];
  assert.equal(compare(actual, contract).compatible, false);
  actual.checks.push({ TABLE_NAME: table, ...constraint });
  assert.equal(compare(actual, contract).compatible, true);
  for (const change of [c => c.ENFORCED = 'NO', c => c.CHECK_CLAUSE = 'true', c => c.CONSTRAINT_NAME = 'different']) {
    const changed = structuredClone(actual); change(changed.checks.at(-1));
    assert.equal(compare(changed, contract).compatible, false);
  }
});
test('plans bind exact schema, code, ordered migration content and isolated target', () => {
  const actual=baseline(),name='20260916120000-align-security-monitoring-collations.js',hash='b'.repeat(64);
  const plan={version:1,runtime:'dev',database:'clinicaclick_dev_isolated',revision:'revision',contractDigest:'contract',beforeDigest:digest(actual),migrations:[{name,sha256:hash}]};
  const verify=p=>validatePlan(p,actual,'revision','contract',{[name]:hash});verify(plan);
  for(const change of [p=>p.database='public',p=>p.runtime='staging',p=>p.revision='changed',p=>p.contractDigest='changed',
    p=>p.beforeDigest='changed',p=>p.migrations[0].sha256='changed',p=>p.migrations.push({...p.migrations[0]}),
    p=>{p.migrations=[{name:'20260916111111-unknown.js'}];}]) {
    const altered=structuredClone(plan);change(altered);assert.throws(()=>verify(altered));
  }
  actual.migrations.push(name);assert.throws(()=>verify({...plan,beforeDigest:digest(actual)}));
});
test('command line never permits a public migration target or mixed actions', () => {
  assert.throws(()=>parse(['apply-dev','--runtime','staging','--plan','/tmp/p','--out','/tmp/o']));
  assert.throws(()=>parse(['check','--migration','anything','--out','/tmp/o']));
  assert.throws(()=>parse(['plan-dev','--out','/tmp/o']));
});
