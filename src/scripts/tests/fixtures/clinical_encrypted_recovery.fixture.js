'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{pipeline}=require('node:stream/promises');
const {encryptStream,verifyCipher}=require('../../meta-clinical-schema-release');
const {snapshot}=require('../../../lib/securitySchemaContract');
async function encryptedRecoveryFixture({ query, report, plan, migration }) {
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
  for(const table of ['Usuarios','Clinicas','GruposClinicas','IntakeConfigs','SequelizeMeta']) {
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
  report.checks.push('Real mysqldump → AES-GCM stream → private MySQL restore preserves all original table schemas and every original row; no plaintext file or host database access');
}
module.exports={encryptedRecoveryFixture};
