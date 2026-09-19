#!/usr/bin/env node
'use strict';
// Explicit public Google schema cut. No model/provider imports, no process stops,
// no automatic rollback/retry, and no generic public migration command.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { sourceInfo } = require('./security-schema-release');
const { observedEnvironment } = require('./security-email-login-metadata');
const { snapshot, digest } = require('../lib/securitySchemaContract');
const google = require('../lib/googleClinicalSchemaRelease');
const { assertGoogleClinicalRuntime } = require('../lib/googleClinicalRuntime');
const { clinicalCutFailure } = require('../lib/clinicalCutFailure');
// Cryptographic stream helpers are shared; the Meta migration operator is never invoked.
const { encryptStream, verifyCipher } = require('./meta-clinical-schema-release');
const ROOTS = ['/home/ubuntu/wt/back-staging', '/home/ubuntu/wt/gateway'];
const RECOVERY = '/var/lib/clinicaclick-schema-recovery';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw Error(code); };
function secure(file, directory=false) {
  const s=fs.lstatSync(file);
  if (s.isSymbolicLink() || s.uid!==0 || s.mode&0o077 || (directory?!s.isDirectory():!s.isFile())) fail('google_schema_private_artifact_invalid');
}
function syncDirectory(dir) { const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);} }
function persist(file,bytes) {
  const fd=fs.openSync(file,'wx',0o600);
  try { fs.writeFileSync(fd,bytes);fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function write(file,value) { persist(file,JSON.stringify(value,null,2)+'\n'); }
function args(argv) {
  const [action,sourceOption,source,dirOption,dir,...rest]=argv;
  if (!['plan','backup','apply'].includes(action) || sourceOption!=='--source' || dirOption!=='--dir'
    || rest.length || !source || !path.isAbsolute(source) || !dir || path.dirname(dir)!==RECOVERY
    || !/^[a-z0-9][a-z0-9-]{5,100}$/.test(path.basename(dir))) fail('google_schema_arguments_invalid');
  return {action,source:fs.realpathSync(source),dir};
}
function noWriters() {
  for (const id of fs.readdirSync('/proc').filter(v=>/^[1-9][0-9]*$/.test(v))) {
    let cwd,command;
    try { cwd=fs.realpathSync('/proc/'+id+'/cwd');command=fs.readFileSync('/proc/'+id+'/cmdline').toString().split('\0'); }
    catch { continue; }
    if (ROOTS.includes(cwd) && command.some(v=>/(^|\/)(node|npm)(\s|$)|src\/app\.js/.test(v))) fail('google_schema_stop_public_writers_first');
  }
  for (const unit of ['clinicaclick-whatsapp-fresh-inbound.service','clinicaclick-whatsapp-inbox-consumer.service']) {
    const state = require('node:child_process').execFileSync('systemctl', ['show',unit,'--property=MainPID,ActiveState'], {encoding:'utf8',timeout:5000});
    const values = Object.fromEntries(state.trim().split('\n').map(line=>line.split('=')));
    if (values.ActiveState !== 'inactive' || values.MainPID !== '0') fail('google_schema_stop_auxiliary_writers_first');
  }
}
async function exclusiveDatabase(query) {
  const [{n}] = await query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()');
  if (Number(n)) fail('google_schema_other_database_connections');
}
function publicTarget() {
  const runtimes=['staging','gateway'].map(name=>observedEnvironment(name));
  for (const r of runtimes) {
    assertGoogleClinicalRuntime(r.env);
    if (r.env.AUTH_SESSION_MODE!=='enforce' || r.env.AUTH_EMAIL_MFA_MODE!=='enforce'
      || Object.entries(r.env).some(([k,v])=>/^META_MARKETING_.*ENABLED$/.test(k) && !['','false'].includes(v))) fail('google_schema_runtime_review_required');
  }
  const database=runtimes[0].env.DB_NAME;
  if (!/^[a-zA-Z0-9_]+$/.test(database) || database==='clinicaclick_dev_isolated'
    || runtimes.some(r=>r.env.DB_NAME!==database || !['localhost','127.0.0.1'].includes(r.env.DB_HOST))) fail('google_schema_public_target_invalid');
  const files=Object.fromEntries(ROOTS.map(root=>[root+'/.env',sha(fs.readFileSync(root+'/.env'))]));
  // Apply resolves the database again from the exact protected configuration;
  // never store SQL credentials or full process environment in the plan.
  for (const root of ROOTS) if (require('dotenv').parse(fs.readFileSync(root+'/.env')).DB_NAME!==database) fail('google_schema_database_override_requires_review');
  return {database,files,processes:runtimes.map(r=>r.process)};
}
function verifyTarget(target) {
  if (!target || !/^[a-zA-Z0-9_]+$/.test(target.database) || target.database==='clinicaclick_dev_isolated'
    || JSON.stringify(Object.keys(target.files))!==JSON.stringify(ROOTS.map(r=>r+'/.env'))) fail('google_schema_public_target_invalid');
  for (const [file,hash] of Object.entries(target.files)) {
    if (sha(fs.readFileSync(file))!==hash || require('dotenv').parse(fs.readFileSync(file)).DB_NAME!==target.database) fail('google_schema_runtime_configuration_changed');
  }
}
async function connection(database) {
  secure('/etc/mysql/debian.cnf');
  const text=fs.readFileSync('/etc/mysql/debian.cnf','utf8'), section=text.match(/\[client\]([^]*?)(?=\n\[|$)/)?.[1];
  if (!section) fail('google_schema_dba_configuration_invalid');
  const c=require('dotenv').parse(section);
  if (c.socket!=='/var/run/mysqld/mysqld.sock' || !c.user || !c.password) fail('google_schema_dba_configuration_invalid');
  return require('mysql2/promise').createConnection({socketPath:c.socket,user:c.user,password:c.password,database,connectTimeout:5000,multipleStatements:false});
}
async function verifyBackup(dir,plan) {
  for (const name of ['recovery.key','legacy.sql.enc','backup.json']) secure(path.join(dir,name));
  const receipt=JSON.parse(fs.readFileSync(path.join(dir,'backup.json')));
  if (receipt.planDigest!==digest(plan) || receipt.rowsDigest!==plan.rowsDigest || receipt.database!==plan.database) fail('google_schema_backup_plan_mismatch');
  await verifyCipher(path.join(dir,'legacy.sql.enc'),fs.readFileSync(path.join(dir,'recovery.key')),receipt);
}
async function backup(dir,plan,query) {
  noWriters();
  await exclusiveDatabase(query);
  if (plan.beforeDigest!==digest(await snapshot(query)) || plan.rowsDigest!==digest(await google.rowFingerprints(query,plan.columns))) fail('google_schema_plan_stale_or_invalid');
  const key=crypto.randomBytes(32);persist(path.join(dir,'recovery.key'),key);
  const child=spawn('/usr/bin/mysqldump',['--defaults-file=/etc/mysql/debian.cnf','--single-transaction','--skip-lock-tables',
    '--no-tablespaces','--set-gtid-purged=OFF','--hex-blob',plan.database,...google.TABLES],{stdio:['ignore','pipe','ignore']});
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  let receipt;
  try { receipt=await encryptStream(child.stdout,path.join(dir,'legacy.sql.enc'),key,crypto.randomBytes(12)); }
  catch (error) { if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited.catch(()=>{});throw error; }
  const status=await exited;if(status.code!==0)fail('google_schema_backup_dump_failed');
  noWriters();
  await exclusiveDatabase(query);
  if (plan.rowsDigest!==digest(await google.rowFingerprints(query,plan.columns))) fail('google_schema_backup_data_changed');
  write(path.join(dir,'backup.json'),{at:new Date().toISOString(),database:plan.database,planDigest:digest(plan),rowsDigest:plan.rowsDigest,...receipt});
  await verifyBackup(dir,plan);
}
async function run(argv) {
  if (process.getuid()!==0) fail('google_schema_operator_requires_root');
  const o=args(argv),info=sourceInfo(o.source,true);
  if (!fs.existsSync(RECOVERY))fs.mkdirSync(RECOVERY,{mode:0o700});secure(RECOVERY,true);
  let plan,target;
  if(o.action==='plan') { fs.mkdirSync(o.dir,{mode:0o700});syncDirectory(RECOVERY);target=publicTarget(); }
  else { secure(o.dir,true);secure(path.join(o.dir,'plan.json'));plan=JSON.parse(fs.readFileSync(path.join(o.dir,'plan.json')));target=plan.target;verifyTarget(target);noWriters(); }
  const c=await connection(target.database),query=async(sql,values=[])=>(await c.query({sql,values,timeout:30000}))[0];
  let journal;
  try {
    if (o.action==='plan') {
      await query('SET TRANSACTION READ ONLY');await c.beginTransaction();
      plan={...await google.prepare({query,info,database:target.database}),target};await c.commit();
      write(path.join(o.dir,'plan.json'),plan);return {status:'clinical_google_plan_created',revision:info.revision,rows:plan.rows,migrations:plan.migrations.map(m=>m.name)};
    }
    if (o.action==='backup') { await backup(o.dir,plan,query);return {status:'clinical_google_backup_verified'}; }
    journal=fs.openSync(path.join(o.dir,'journal.jsonl'),'wx',0o600);
    syncDirectory(o.dir);
    const append=event=>{fs.writeSync(journal,JSON.stringify({at:new Date().toISOString(),...event})+'\n');fs.fsyncSync(journal);};
    try {
      return await google.apply({connection:c,plan,info,database:target.database,verifyWritersStopped:async()=>{verifyTarget(target);noWriters();await exclusiveDatabase(query);},
        verifyBackup:p=>verifyBackup(o.dir,p),journal:append,loadMigration:m=>{
          const file=path.join(o.source,'migrations',m.name);if(sha(fs.readFileSync(file))!==m.sha256)fail('google_schema_migration_changed');return require(file);
        }});
    } catch (error) {
      append({status:'clinical_schema_failed_preserve_partial',failure:clinicalCutFailure(error),releaseFailure:error.releaseFailure||null,
        instruction:'Inspect schema and journal. No automatic retry or destructive rollback.'});
      throw error;
    }
  } finally {if(journal!==undefined)fs.closeSync(journal);await c.end();}
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{
  console.error(JSON.stringify({status:'failed',failure:clinicalCutFailure(e)}));process.exitCode=1;
});
module.exports={run,args,encryptStream,verifyCipher};
