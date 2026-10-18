'use strict';
// No work on import. This entry point is restricted to zero-row native DDL in
// one new schema of the empty RDS migration candidate. It never runs a DMS task.
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {TextDecoder}=require('node:util');
const policy=require('./schema_compat_sql.cjs');
const TARGET_OPERATOR='/home/ubuntu/qa-evidence/architecture-diagnostic-20261018-c3CWBj/rds-target-operator.cjs';
const MAX_STDOUT=16*1024*1024;
const SOURCE_SOCKET='/var/run/mysqld/mysqld.sock';
const SOURCE_SELECTOR='--defaults-file=/etc/mysql/debian.cnf';
const SOURCE_META_SQL="SELECT JSON_OBJECT('version',@@version,'sql_mode',@@sql_mode,'lower_case_table_names',@@lower_case_table_names,'views',(SELECT COUNT(*) FROM information_schema.views WHERE TABLE_SCHEMA='clinicaclick'),'routines',(SELECT COUNT(*) FROM information_schema.routines WHERE ROUTINE_SCHEMA='clinicaclick'),'events',(SELECT COUNT(*) FROM information_schema.events WHERE EVENT_SCHEMA='clinicaclick'));";
const SOURCE_TABLES_SQL="SELECT JSON_OBJECT('name',TABLE_NAME,'engine',ENGINE) FROM information_schema.tables WHERE TABLE_SCHEMA='clinicaclick' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;";
const SOURCE_TRIGGERS_SQL="SELECT JSON_OBJECT('name',TRIGGER_NAME,'table',EVENT_OBJECT_TABLE,'timing',ACTION_TIMING,'event',EVENT_MANIPULATION,'body',ACTION_STATEMENT,'body_sha256',SHA2(ACTION_STATEMENT,256),'sql_mode',SQL_MODE,'character_set_client',CHARACTER_SET_CLIENT,'collation_connection',COLLATION_CONNECTION,'database_collation',DATABASE_COLLATION) FROM information_schema.triggers WHERE TRIGGER_SCHEMA='clinicaclick' ORDER BY TRIGGER_NAME;";
function sourceCommand(kind,sql) {
  const prefix=['-n','/usr/bin/timeout','--signal=TERM','--kill-after=5s','120s','/usr/bin/env',
    '-u','MYSQL_PWD','-u','MYSQL_HOME','MYSQL_TEST_LOGIN_FILE=/dev/null'];
  const connection=[SOURCE_SELECTOR,'--protocol=SOCKET','--socket='+SOURCE_SOCKET,'--default-character-set=utf8mb4'];
  if(kind==='metadata') {
    policy.need([SOURCE_META_SQL,SOURCE_TABLES_SQL,SOURCE_TRIGGERS_SQL].includes(sql),'source_metadata_query_not_reviewed');
    return {binary:'/usr/bin/sudo',args:[...prefix,'/usr/bin/mysql',...connection,'--batch','--raw','--skip-column-names','-e',sql]};
  }
  policy.need(kind==='dump','source_operation_invalid');
  return {binary:'/usr/bin/sudo',args:[...prefix,'/usr/bin/mysqldump',...connection,'--no-data','--skip-triggers',
    '--skip-lock-tables','--no-tablespaces','--set-gtid-purged=OFF','--skip-add-drop-table','--skip-comments',
    '--skip-add-locks','--skip-disable-keys','clinicaclick']};
}
function captureBounded(command,limit) {
  return new Promise((resolve,reject)=>{
    let child,bytes=0,failed=false;const chunks=[];
    const fail=code=>{if(failed)return;failed=true;child?.stdout.destroy();try{child?.kill('SIGTERM');}catch{}reject(Object.assign(new Error(code),{safeCode:code}));};
    try{child=spawn(command.binary,command.args,{stdio:['ignore','pipe','pipe']});}catch{return fail('source_process_start_failed');}
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>limit)return fail('source_stdout_limit_exceeded');if(!failed)chunks.push(chunk);});
    // Drain but never retain or print database stderr/SQL fragments.
    child.stderr.on('data',()=>{});
    child.on('error',()=>fail('source_process_failed'));
    child.on('close',code=>{
      if(failed)return;
      if(code!==0)return fail('source_read_failed');
      try{resolve(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
      catch{fail('source_utf8_invalid');}
    });
  });
}
function jsonLines(text) {
  try{return text.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));}
  catch{policy.refuse('source_json_metadata_invalid');}
}
async function sourcePlan(capture=captureBounded) {
  let remaining=MAX_STDOUT;
  const read=async(kind,sql)=>{policy.need(remaining>0,'source_stdout_limit_exceeded');const text=await capture(sourceCommand(kind,sql),remaining);remaining-=Buffer.byteLength(text);policy.need(remaining>=0,'source_stdout_limit_exceeded');return text;};
  const metaRows=jsonLines(await read('metadata',SOURCE_META_SQL));policy.need(metaRows.length===1,'source_metadata_missing');policy.validateSourceMeta(metaRows[0]);
  const inventory=jsonLines(await read('metadata',SOURCE_TABLES_SQL));policy.need(inventory.every(table=>table.engine==='InnoDB'),'source_non_innodb');
  const names=inventory.map(table=>table.name);const dump=await read('dump');
  const tables=policy.compileTables(dump,names);
  const triggerRows=jsonLines(await read('metadata',SOURCE_TRIGGERS_SQL));const triggers=policy.compileTriggers(triggerRows);
  // No lock or consistent-DDL snapshot is claimed by this read-only export.
  return {tables,triggers,sourceDumpSha256:policy.sha(dump),sourceStdoutBytes:MAX_STDOUT-remaining,
    sourceVersion:metaRows[0].version,sourceSqlMode:metaRows[0].sql_mode,
    sourceDdlAtomicSnapshot:false,fullCompatibilityOrClinicalMigrationProven:false};
}
function query(c,sql,values=[]) {return c.query({sql,timeout:10000},values);}
async function noClinical(c) {
  const [[row]]=await query(c,"SELECT COUNT(*) n FROM information_schema.schemata WHERE schema_name='clinicaclick'");
  policy.need(Number(row.n)===0,'clinical_target_schema_present');
}
async function executeCompiled(c,statement) {
  policy.assertApproved(statement);await noClinical(c);
  await query(c,statement.sql);
  const [[row]]=await query(c,'SHOW COUNT(*) WARNINGS');
  const count=Number(Object.values(row)[0]);
  if(count===0)return [];
  const [warnings]=await query(c,'SHOW WARNINGS');
  // Observed on the empty 8.4.11 target: accepted legacy integer display
  // widths warn without changing integer range/storage. No other warning
  // (including a different 1681 deprecation) is silently accepted.
  policy.need(Array.isArray(warnings)&&warnings.length===count&&warnings.every(w=>
    w.Level==='Warning'&&Number(w.Code)===1681&&
    w.Message==='Integer display width is deprecated and will be removed in a future release.'),
    'ddl_warning_requires_review');
  return warnings.map(w=>({kind:statement.kind,name:statement.name,code:Number(w.Code),
    category:'legacy_integer_display_width_deprecated'}));
}
async function runSchemaCompatibility({acknowledgement,capture=captureBounded,targetFactory}={}) {
  policy.need(acknowledgement==='schema-only-no-patient-data','explicit_schema_only_ack_required');
  const plan=await sourcePlan(capture); // Fully validate source export before opening the target.
  const factory=targetFactory||require(TARGET_OPERATOR).getTargetOperator;
  let op,c;const report={schema:'clinicaclick-rds-schema-compatibility/1',observedAtUtc:new Date().toISOString(),
    targetSchema:policy.TARGET_SCHEMA,sourceDumpSha256:plan.sourceDumpSha256,sourceStdoutBytes:plan.sourceStdoutBytes,
    sourceDdlAtomicSnapshot:false,sourceVersion:plan.sourceVersion,sourceTableCount:plan.tables.length,
    tablesCreated:[],triggersCreated:[],reviewedDeprecations:[],clinicalDataCopied:false,clinicalDataQueriesPerformed:false,
    targetDefinerPolicy:'CURRENT_USER for this schema-only compatibility experiment; dedicated clinical owner not accredited',
    applicationBehaviorValidated:false,triggerBehaviorValidated:false,clinicalMigrationAuthorized:false,status:'not_started'};
  try {
    op=await factory();
    policy.need(op.metadata?.engine==='8.4.11'&&op.metadata?.multiAZ===true,'target_engine_not_reviewed');
    c=await op.openConnection();policy.need(c.connection?.config?.multipleStatements===false,'target_multiple_statements_must_be_disabled');
    await noClinical(c);
    const [[settings]]=await query(c,'SELECT @@version version,@@lower_case_table_names case_names,@@log_bin_trust_function_creators trust_creators,@@require_secure_transport tls_required,@@event_scheduler events');
    policy.need(settings.version==='8.4.11'&&Number(settings.case_names)===0&&Number(settings.trust_creators)===1
      &&Number(settings.tls_required)===1&&settings.events==='OFF','target_settings_not_ready_before_ddl');
    const [[exists]]=await query(c,'SELECT COUNT(*) n FROM information_schema.schemata WHERE schema_name=?',[policy.TARGET_SCHEMA]);
    policy.need(Number(exists.n)===0,'compatibility_schema_already_exists');
    const [[owner]]=await query(c,'SELECT CURRENT_USER() owner');report.targetDefiner=owner.owner;
    policy.need(typeof owner.owner==='string'&&owner.owner.startsWith('ccadmin@'),'target_owner_not_reviewed');
    await noClinical(c);
    await query(c,'CREATE DATABASE `cc_schema_compat_20261018` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    await query(c,'USE `cc_schema_compat_20261018`');
    await query(c,'SET SESSION sql_mode=?',[plan.sourceSqlMode]);
    await query(c,'SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    await query(c,'SET SESSION foreign_key_checks=0');
    for(const table of plan.tables) {
      report.lastAttempted={kind:table.kind,name:table.name};
      report.reviewedDeprecations.push(...await executeCompiled(c,table));
      report.tablesCreated.push({name:table.name,sourceSha256:table.sourceSha256,targetStatementSha256:table.targetSha256});
    }
    await query(c,'SET SESSION foreign_key_checks=1');
    for(const trigger of plan.triggers) {
      report.lastAttempted={kind:trigger.kind,name:trigger.name};
      report.reviewedDeprecations.push(...await executeCompiled(c,trigger));report.triggersCreated.push({name:trigger.name,sourceBodySha256:trigger.sourceSha256});
    }
    await noClinical(c);
    const [tables]=await query(c,'SELECT TABLE_NAME name,ENGINE engine FROM information_schema.tables WHERE TABLE_SCHEMA=? AND TABLE_TYPE=\'BASE TABLE\' ORDER BY TABLE_NAME',[policy.TARGET_SCHEMA]);
    policy.need(tables.length===policy.EXPECTED_TABLES&&tables.every(t=>t.engine==='InnoDB')
      &&tables.map(t=>t.name).sort().join('\n')===plan.tables.map(t=>t.name).sort().join('\n'),'target_table_inventory_mismatch');
    // Only aggregate counts of the newly created fictional schema; never query source data.
    for(const table of plan.tables) {
      const [[row]]=await query(c,'SELECT COUNT(*) n FROM `cc_schema_compat_20261018`.`'+table.name+'`');
      policy.need(Number(row.n)===0,'compatibility_table_not_empty');
    }
    const [triggers]=await query(c,'SELECT TRIGGER_NAME name,DEFINER definer,SHA2(ACTION_STATEMENT,256) body_sha256 FROM information_schema.triggers WHERE TRIGGER_SCHEMA=? ORDER BY TRIGGER_NAME',[policy.TARGET_SCHEMA]);
    policy.need(triggers.length===2&&triggers.every(t=>t.body_sha256===policy.EXPECTED_BODY_SHA256&&t.definer===owner.owner)
      &&triggers.map(t=>t.name).sort().join('\n')===plan.triggers.map(t=>t.name).sort().join('\n'),'target_trigger_metadata_mismatch');
    report.zeroRowTablesVerified=plan.tables.length;report.status='schema_only_ddl_accepted';
  } catch(error) {
    report.status='failed_partial_schema_preserved';
    report.errorCode=error.safeCode||(/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'compatibility_operator_failed');
    if(Number.isInteger(error.errno))report.mysqlErrno=error.errno;
    // Never return error.message/sql/parameters: these can contain full definitions.
  } finally {
    if(c)try{await query(c,'SET SESSION foreign_key_checks=1');}catch{}
    // The reviewed private factory tracks this connection and bounds close/end
    // to three seconds before destroy. Do not await an unbounded c.end first.
    if(op)try{await op.close();}catch{}
  }
  return report;
}
async function main() {
  const args=process.argv.slice(2);
  policy.need(args.every(arg=>arg==='--execute-schema-only'||arg.startsWith('--report=')),'unknown_operator_argument');
  if(!args.includes('--execute-schema-only')) {
    console.log(JSON.stringify({executionPerformed:false,sourceReadsPerformed:false,targetSchema:policy.TARGET_SCHEMA,
      requires:'Explicit --execute-schema-only and protected new --report path; readiness only by default'}));return;
  }
  const reportArg=args.find(arg=>arg.startsWith('--report='));
  policy.need(reportArg,'private_report_path_required');const path=reportArg.slice('--report='.length);
  policy.need(/^\/home\/ubuntu\/qa-evidence\/architecture-diagnostic-20261018-c3CWBj\/schema-compat-[A-Za-z0-9_-]+\.json$/.test(path),'private_report_path_not_reviewed');
  // Reserve a private report before any source/target operation; never overwrite.
  const fd=fs.openSync(path,'wx',0o600);
  try {
    let report;
    try{report=await runSchemaCompatibility({acknowledgement:'schema-only-no-patient-data'});}
    catch(error){report={status:'preflight_failed',errorCode:error.safeCode||'schema_compatibility_preflight_failed',clinicalDataCopied:false};}
    fs.writeFileSync(fd,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({status:report.status,report:path,clinicalDataCopied:false}));
    if(report.status!=='schema_only_ddl_accepted')process.exitCode=2;
  } finally {fs.closeSync(fd);}
}
if(require.main===module)main().catch(()=>{console.log(JSON.stringify({errorCode:'schema_compatibility_operator_refused',clinicalDataCopied:false}));process.exitCode=2;});
module.exports={sourceCommand,sourcePlan,captureBounded,runSchemaCompatibility,MAX_STDOUT,
  SOURCE_META_SQL,SOURCE_TABLES_SQL,SOURCE_TRIGGERS_SQL};
