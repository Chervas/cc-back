'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { encryptStream, verifyCipher } = require('../meta-clinical-schema-release');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const schema = require('../../../ops/security/schema-contract.json');
const original = require('./fixtures/meta_pre_migration_schema.json');
const { digest, snapshot } = require('../../lib/securitySchemaContract');
const migration = require('../../lib/metaClinicalSchemaRelease');
const source = path.resolve(__dirname, '../../..');
async function encryptedRecoveryFixture({ query, report, plan }) {
  // Both CLI clients are forced onto this fixture's private Unix socket. No
  // plaintext dump is written and no host credentials/default files are read.
  const socket = path.join(report.root, 'mysql.sock');
  const file = path.join(report.root, 'legacy-fixture.sql.enc');
  const key = crypto.randomBytes(32);
  const child = spawn('/usr/bin/mysqldump', ['--no-defaults', '--protocol=SOCKET', '--socket='+socket,
    '--user=root', '--single-transaction', '--skip-lock-tables', '--no-tablespaces', '--set-gtid-purged=OFF',
    '--hex-blob', report.database, ...migration.TABLES], {stdio:['ignore','pipe','ignore']});
  const exited = new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  let receipt;
  try { receipt = await encryptStream(child.stdout,file,key,crypto.randomBytes(12)); }
  finally { if(child.exitCode===null && child.signalCode===null && child.stdout.destroyed && !child.stdout.readableEnded)child.kill('SIGTERM'); }
  assert.deepEqual(await exited,{code:0,signal:null});
  await verifyCipher(file,key,receipt);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert(!fs.readFileSync(file).includes(Buffer.from('FICTITIOUS_TOKEN')));
  await query('CREATE DATABASE campaign_recovery_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  for(const table of ['Usuarios','Clinicas','GruposClinicas','SequelizeMeta']) {
    await query('CREATE TABLE campaign_recovery_qa.'+table+' LIKE '+table);
  }
  const restore = spawn('/usr/bin/mysql',['--no-defaults','--protocol=SOCKET','--socket='+socket,
    '--user=root','campaign_recovery_qa'],{stdio:['pipe','ignore','ignore']});
  const restored = new Promise((resolve,reject)=>{restore.once('error',reject);restore.once('exit',(code,signal)=>resolve({code,signal}));});
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(receipt.iv,'hex'));
  decipher.setAuthTag(Buffer.from(receipt.tag,'hex'));
  try { await pipeline(fs.createReadStream(file),decipher,restore.stdin); }
  catch(error){if(restore.exitCode===null&&restore.signalCode===null)restore.kill('SIGTERM');await restored.catch(()=>{});throw error;}
  assert.deepEqual(await restored,{code:0,signal:null});
  try {
    await query('USE campaign_recovery_qa');
    assert.deepEqual(await migration.rowFingerprints(query,plan.columns),plan.rows);
    const recovered=await snapshot(query);
    for(const field of ['tables','columns','indexes','foreignKeys']) {
      const select = rows => rows.filter(row=>migration.TABLES.includes(row.TABLE_NAME));
      assert.deepEqual(select(recovered[field]),select(plan.before[field]),field+' recovery');
    }
  } finally { await query('USE campaign_optimization_qa'); }
  report.checks.push('Real mysqldump → AES-GCM stream → private MySQL restore preserves both original table schemas and every original row; no plaintext file or host database access');
}
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
      await encryptedRecoveryFixture({query,report,plan});
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
