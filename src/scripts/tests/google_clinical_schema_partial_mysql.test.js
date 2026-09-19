'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {setup}=require('./fixtures/google_clinical_schema.fixture');
const {snapshot,digest,compare}=require('../../lib/securitySchemaContract');
const migration=require('../../lib/googleClinicalSchemaRelease');
const source=path.resolve(__dirname,'../../..');

test('partial Google DDL is journaled without replay; lock release failure cannot replace the original cause',async()=>{
 await withIsolatedCampaignMysql(async({sql,report})=>{
  const f=await setup(sql),{query,info,database}=f;
  try{
   const plan=await migration.prepare({query,info,database}),journal=[];let applications=0;
   const primary=Object.assign(Error('fictitious_ddl_failure'),{code:'ER_LOCK_WAIT_TIMEOUT',errno:1205,sqlState:'HY000'});
   const connection={connection:f.connection.connection,query:async(s,v)=>{
    if(s.startsWith('SELECT RELEASE_LOCK'))throw Object.assign(Error('fictitious_release_failure'),{code:'PROTOCOL_CONNECTION_LOST'});
    return f.connection.query(s,v);
   }};
   await assert.rejects(migration.apply({connection,plan,info,database,verifyWritersStopped:async()=>{},verifyBackup:async()=>{},journal:e=>journal.push(e),loadMigration:m=>({up:async(...args)=>{
    applications++;await require(path.join(source,'migrations',m.name)).up(...args);throw primary;
   }})}),e=>e===primary&&e.releaseFailure.code==='PROTOCOL_CONNECTION_LOST');
   await query("SELECT RELEASE_LOCK('clinicaclick_google_clinical_schema_release')");
   assert.equal(applications,1);assert.equal(journal.length,1);assert.equal(journal[0].status,'migration_started');
   assert.equal((await query('SELECT COUNT(*) n FROM SequelizeMeta WHERE name=?',[migration.MIGRATIONS[0]]))[0].n,0);
   const partial=await snapshot(query);assert.notEqual(digest(partial),plan.beforeDigest);
   await assert.rejects(migration.prepare({query,info,database}),/partial_state_requires_review/);
   assert.deepEqual(await migration.rowFingerprints(query,plan.columns),plan.rows);
   assert.equal(digest(await snapshot(query)),digest(partial));
   report.checks.push('a failure after the first actual ALTER/CREATE retains original data and a started-only journal, does not advance SequelizeMeta or retry; fresh preparation rejects partial state; original SQL failure survives failed lock release');
  }finally{await sql.connectionManager.releaseConnection(f.raw);}
 });
});
