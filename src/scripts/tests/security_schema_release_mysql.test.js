'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshot, compare, digest } = require('../../lib/securitySchemaContract');
const { applyPlan } = require('../security-schema-release');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const baseline = require('../../../ops/security/schema-contract.json');
const normalize = '20260916120000-align-security-monitoring-collations.js';
const inbox = '20260915040000-create-whatsapp-inbox-imports.js';
const selected = [normalize,inbox];
const hash = 'b'.repeat(64);
test('isolated MySQL: forward migrations align schema, preserve rows, reject concurrent/stale runs and retain partial DDL', async () => {
  await withIsolatedCampaignMysql(async ({sql,report}) => {
    await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await sql.query('CREATE TABLE SequelizeMeta (name VARCHAR(255) PRIMARY KEY)');
    await sql.query('CREATE TABLE AiUsageDaily (id INT PRIMARY KEY)');
    await require('../../../migrations/20260916103000-security-monitoring-and-ai-prices').up(sql.getQueryInterface(),require('sequelize'));
    await sql.query("INSERT INTO SecurityMonitoringSettings(scope,rules,created_at,updated_at) VALUES('sintético-ñ',JSON_OBJECT('keep',true),NOW(),NOW())");
    const names = Object.keys(baseline.tables).filter(n=>n.startsWith('WhatsappInbox')||n.startsWith('SecurityMonitoring')||n==='AiModelPrices');
    const contract={version:1,defaults:baseline.defaults,tables:Object.fromEntries(names.map(n=>[n,baseline.tables[n]])),migrations:selected.map(name=>({name,sha256:hash}))};
    const info={revision:'revision',contractDigest:'contract',contract,migrations:Object.fromEntries(selected.map(n=>[n,hash]))};
    const raw = await sql.connectionManager.getConnection();const c=raw.promise();
    const query=async (s,v=[])=>(await c.query(s,v))[0];
    const events=[];
    const makePlan=async names=>({version:1,runtime:'dev',database:'clinicaclick_dev_isolated',revision:info.revision,contractDigest:info.contractDigest,
      beforeDigest:digest(await snapshot(query)),migrations:names.map(name=>({name,sha256:hash}))});
    const apply=plan=>applyPlan({connection:c,plan,info,loadMigration:m=>require('../../../migrations/'+m.name),journal:e=>events.push(structuredClone(e))});
    try {
      assert.equal(compare(await snapshot(query),contract).compatible,false);
      const plan=await makePlan(selected);
      const another = await sql.connectionManager.getConnection();
      try {
        await another.promise().query("SELECT GET_LOCK('clinicaclick_dev_schema_release',0)");
        await assert.rejects(apply(plan),/schema_migration_busy/);
      } finally {await another.promise().query("SELECT RELEASE_LOCK('clinicaclick_dev_schema_release')");await sql.connectionManager.releaseConnection(another);}
      const applied=await apply(plan);assert.equal(applied.compatible,true,JSON.stringify(applied));
      assert.deepEqual(applied.completed,selected);
      const [rows]=await c.query('SELECT scope,rules FROM SecurityMonitoringSettings');assert.equal(rows[0].scope,'sintético-ñ');
      assert.equal((typeof rows[0].rules==='string'?JSON.parse(rows[0].rules):rows[0].rules).keep,true);
      await assert.rejects(apply(plan),/schema_plan_stale_or_invalid/);
      // Re-running the normalization itself is a no-op; delivery keys stay ASCII.
      const after=digest(await snapshot(query));await require('../../../migrations/'+normalize).up(sql.getQueryInterface());
      assert.equal(digest(await snapshot(query)),after);
      const broken='20260916130000-synthetic-partial.js';info.migrations[broken]=hash;
      const failedPlan=await makePlan([broken]);
      await assert.rejects(applyPlan({connection:c,plan:failedPlan,info,journal:e=>events.push(structuredClone(e)),loadMigration:()=>({up:async q=>{
        await q.createTable('SyntheticPartial',{id:{type:require('sequelize').INTEGER,primaryKey:true}});throw Error('synthetic failure');
      }})}),/synthetic failure/);
      const final=await snapshot(query);
      assert.equal(final.tables.some(t=>t.TABLE_NAME==='SyntheticPartial'),true);
      assert.equal(final.migrations.includes(broken),false);
      assert.equal(events.at(-1).status,'migration_started');
      await assert.rejects(applyPlan({connection:c,plan:failedPlan,info,journal:()=>{},loadMigration:()=>assert.fail('Must reject stale partial schema')}),/schema_plan_stale_or_invalid/);
      report.checks.push('real MySQL forward parity','preserved synthetic text and JSON','ASCII inbox keys unchanged','exclusive lock','stale plan','migration history only after success','partial DDL preserved without automatic retry');
    } finally {await sql.connectionManager.releaseConnection(raw);}
  });
});
