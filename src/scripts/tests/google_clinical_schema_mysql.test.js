'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {setup}=require('./fixtures/google_clinical_schema.fixture');
const {snapshot,digest,compare}=require('../../lib/securitySchemaContract');
const migration=require('../../lib/googleClinicalSchemaRelease');
const source=path.resolve(__dirname,'../../..');
const {encryptedRecoveryFixture}=require('./fixtures/clinical_encrypted_recovery.fixture');

test('clinical Google cut protects all eight observed legacy schemas, shared assignments, credentials and conversion outcomes',async()=>{
 await withIsolatedCampaignMysql(async({sql,report})=>{
  const f=await setup(sql),{connection,query,info,database}=f;
  try{
   const plan=await migration.prepare({query,info,database}),journal=[];
   assert.equal(Object.values(plan.rows).reduce((n,r)=>n+r.count,0),22);
   await encryptedRecoveryFixture({query,report,plan,migration});
   const controls={connection,plan,info,database,verifyWritersStopped:async()=>{},verifyBackup:async p=>assert.equal(p.rowsDigest,plan.rowsDigest),loadMigration:m=>require(path.join(source,'migrations',m.name)),journal:e=>journal.push(structuredClone(e))};
   const unchanged=async()=>assert.equal(digest(await snapshot(query)),plan.beforeDigest);
   for(const key of ['kind','database','revision','contractDigest','rowsDigest','beforeDigest']){
    await assert.rejects(migration.apply({...controls,plan:{...plan,[key]:'changed'}}));await unchanged();
   }
   await assert.rejects(migration.apply({...controls,database:'other_database'}),/target_mismatch/);await unchanged();
   await assert.rejects(migration.apply({...controls,plan:{...plan,kind:'meta_clinical_schema_v1'}}),/stale_or_invalid/);await unchanged();
   await assert.rejects(migration.apply({...controls,verifyWritersStopped:async()=>{throw Error('writer_live');}}),/writer_live/);await unchanged();
   await assert.rejects(migration.apply({...controls,verifyBackup:async()=>{throw Error('backup_invalid');}}),/backup_invalid/);await unchanged();
   await assert.rejects(migration.apply({...controls,plan:{...plan,migrations:plan.migrations.slice(1)}}),/stale_or_invalid/);await unchanged();
   await assert.rejects(migration.apply({...controls,info:{...info,migrations:{...info.migrations,[migration.MIGRATIONS[0]]:'0'.repeat(64)}}}),/changed_or_applied/);await unchanged();
   const historical=migration.HISTORICAL_MIGRATIONS[0];await query('DELETE FROM SequelizeMeta WHERE name=?',[historical]);
   await assert.rejects(migration.prepare({query,info,database}),/historical_contract_required/);await query('INSERT INTO SequelizeMeta VALUES (?)',[historical]);
   await query("UPDATE GroupAssetClinicAssignments SET assetType='changed' WHERE id=3");
   await assert.rejects(migration.apply(controls),/stale_or_invalid/);await unchanged();
   await query("UPDATE GroupAssetClinicAssignments SET assetType='meta_ad_account' WHERE id=3");
   await query("UPDATE GoogleAdsConversionUploadAttempts SET status='failed' WHERE id=1");
   await assert.rejects(migration.apply(controls),/stale_or_invalid/);await unchanged();
   await query("UPDATE GoogleAdsConversionUploadAttempts SET status='pending' WHERE id=1");
   assert.equal(journal.length,0);
   report.checks.push('wrong kind, source, target, migration list/hash, history, live writers, backup and changed shared assignments or conversion outcomes all reject before DDL');
   const result=await migration.apply(controls);assert(result.compatible);assert.equal(result.completed.length,19);
   const after=await snapshot(query);assert(compare(after,info.contract).compatible);
   assert.deepEqual(await migration.rowFingerprints(query,plan.columns),plan.rows);
   for(const name of migration.TABLES)assert.deepEqual(after.foreignKeys.filter(k=>k.TABLE_NAME===name),plan.before.foreignKeys.filter(k=>k.TABLE_NAME===name));
   for(const name of migration.NEW_TABLES)assert.equal(Number((await query('SELECT COUNT(*) n FROM '+name))[0].n),0);
   for(const table of migration.TABLES.slice(1,5))assert.equal(Number((await query('SELECT COUNT(*) n FROM '+table+' WHERE broker_read_connection_ref IS NOT NULL OR broker_read_asset_ref IS NOT NULL'))[0].n),0);
   assert.equal(journal.filter(v=>v.status==='migration_started').length,19);assert.equal(journal.filter(v=>v.status==='migration_completed').length,19);
   report.checks.push('nineteen exact forward migrations pass all twenty-two Google contracts, preserve twenty-two original rows and every old FK, leave sixteen new registries empty and all four mapping references unset');
   const done=digest(after);await assert.rejects(migration.apply(controls),/stale_or_invalid/);assert.equal(digest(await snapshot(query)),done);
   await assert.rejects(migration.prepare({query,info,database}),/partial_state_requires_review/);
   report.checks.push('completed plan cannot be replayed and the initialized Google registry cannot be treated as a new cut');
   report.tables=migration.TABLES;report.migrations=result.completed;report.rowsPreserved=result.rowsPreserved;
  }finally{await sql.connectionManager.releaseConnection(f.raw);}
 });
});

