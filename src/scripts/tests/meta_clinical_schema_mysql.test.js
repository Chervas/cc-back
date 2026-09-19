'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const schema = require('../../../ops/security/schema-contract.json');
const original = require('./fixtures/meta_pre_migration_schema.json');
const { digest, snapshot } = require('../../lib/securitySchemaContract');
const migration = require('../../lib/metaClinicalSchemaRelease');
const source = path.resolve(__dirname, '../../..');
test('clinical Meta cut rejects changed rows, source, target, backup or active writers before DDL and preserves populated legacy/WhatsApp rows', async () => {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    for (const [table,id] of [['Usuarios','id_usuario'],['Clinicas','id_clinica'],['GruposClinicas','id_grupo']]) {
      await sql.query(`CREATE TABLE ${table} (${id} INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`);
    }
    await sql.query('CREATE TABLE SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    for (const ddl of Object.values(original.ddl)) await sql.query(ddl);
    await sql.query("INSERT INTO MetaConnections (id,metaUserId,accessToken,userName,createdAt,updatedAt) VALUES (1,'123','FICTITIOUS_TOKEN','Clínica ñ',NOW(),NOW())");
    await sql.query("INSERT INTO ClinicMetaAssets (id,metaConnectionId,metaAssetId,assetType,waAccessToken,isActive,additionalData,createdAt,updatedAt) VALUES (1,1,'456','whatsapp_phone_number','FICTITIOUS_WA_TOKEN',1,JSON_OBJECT('paused',true,'nested',JSON_ARRAY(NULL,'ñ')),NOW(),NOW()),(2,1,'789','ad_account',NULL,0,NULL,NOW(),NOW())");
    const raw = await sql.connectionManager.getConnection(), connection = raw.promise();
    const query = async (q,v=[]) => (await connection.query(q,v))[0];
    const selected = migration.MIGRATIONS.map(name => ({name,sha256:createHash('sha256').update(fs.readFileSync(path.join(source,'migrations',name))).digest('hex')}));
    const contract = {version:1,tables:Object.fromEntries([...migration.TABLES,...migration.NEW_TABLES].map(n=>[n,schema.tables[n]])),migrations:selected};
    const info={revision:'owned-clinical-fixture',contractDigest:digest(contract),contract,migrations:Object.fromEntries(selected.map(m=>[m.name,m.sha256]))};
    const database='campaign_optimization_qa';
    try {
      const plan = await migration.prepare({query,info,database}), journal=[];
      const controls={connection,plan,info,database,verifyWritersStopped:async()=>{},verifyBackup:async p=>assert.equal(p.rowsDigest,plan.rowsDigest),
        loadMigration:m=>require(path.join(source,'migrations',m.name)),journal:event=>journal.push(structuredClone(event))};
      const unchanged=async()=>assert.equal(digest(await snapshot(query)),plan.beforeDigest);
      for (const field of ['database','revision','contractDigest','rowsDigest','beforeDigest']) {
        await assert.rejects(migration.apply({...controls,plan:{...plan,[field]:'changed'}}));await unchanged();
      }
      await assert.rejects(migration.apply({...controls,database:'wrong_target'}),/target_mismatch/);await unchanged();
      await assert.rejects(migration.apply({...controls,verifyWritersStopped:async()=>{throw Error('writer_active');}}),/writer_active/);await unchanged();
      await assert.rejects(migration.apply({...controls,verifyBackup:async()=>{throw Error('backup_invalid');}}),/backup_invalid/);await unchanged();
      await sql.query("UPDATE ClinicMetaAssets SET isActive=0 WHERE id=1");
      await assert.rejects(migration.apply(controls),/stale_or_invalid/);await unchanged();
      await sql.query("UPDATE ClinicMetaAssets SET isActive=1 WHERE id=1");
      assert.equal(journal.length,0);
      const expectedRows={};for(const t of migration.TABLES)expectedRows[t]=await query('SELECT * FROM '+t);
      const result=await migration.apply(controls);assert.equal(result.compatible,true);assert.equal(result.completed.length,9);
      for(const t of migration.TABLES)assert.deepEqual(await query('SELECT '+plan.columns[t].map(c=>'`'+c+'`').join(',')+' FROM '+t),expectedRows[t]);
      assert.equal(journal.filter(r=>r.status==='migration_started').length,9);assert.equal(journal.filter(r=>r.status==='migration_completed').length,9);
      assert.equal(journal.at(-1).status,'clinical_schema_compatible');
      const after=digest(await snapshot(query));await assert.rejects(migration.apply(controls),/stale_or_invalid/);assert.equal(digest(await snapshot(query)),after);
      report.checks.push('Source, target, schema, rows, live-writer and backup failures reject before any DDL; all nine real migrations preserve complete legacy/WhatsApp rows, pauses, JSON, Unicode and foreign keys; replay rejected');
    } finally { await sql.connectionManager.releaseConnection(raw); }
  });
});
