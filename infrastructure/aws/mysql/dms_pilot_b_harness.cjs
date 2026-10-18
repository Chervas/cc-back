'use strict';
// No CLI, AWS client or work on import. All SQL below is owned synthetic data.
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const policy=require('./schema_compat_sql.cjs');
const fixture=require('./dms_pilot_b_fixture.cjs');
const HOST='172.26.0.110',PORT=23306,SERVER_ID=183306;
const MAX_SEED=32*1024*1024;
const sources=new WeakSet(),seeds=new WeakSet(),targets=new WeakSet();
const need=policy.need;
const q=(c,sql,values=[])=>c.query({sql,timeout:10000},values);
function privateJson(file) {
  const stat=fs.lstatSync(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()&&(stat.mode&0o077)===0,'b_ownership_file_unsafe');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function readOwnedRun(directory) {
  need(typeof directory==='string'&&path.dirname(directory)==='/tmp'&&/^cc-dms-pilot-source-[A-Za-z0-9_-]+$/.test(path.basename(directory)),'b_source_run_namespace_invalid');
  const root=fs.lstatSync(directory),data=fs.lstatSync(path.join(directory,'data'));
  need(root.isDirectory()&&data.isDirectory()&&!root.isSymbolicLink()&&!data.isSymbolicLink()&&root.uid===process.getuid()&&data.uid===process.getuid()&&(root.mode&0o077)===0&&(data.mode&0o077)===0,'b_source_run_directory_unsafe');
  const own=privateJson(path.join(directory,'ownership.json')),proc=privateJson(path.join(directory,'process.json')),ready=privateJson(path.join(directory,'ready.json'));
  need(own.schema==='clinicaclick-dms-source-ownership/1'&&own.root===directory&&own.uid===process.getuid()&&own.synthetic_only===true&&own.source_host===HOST&&own.source_port===PORT&&own.database===fixture.SCHEMA&&/^[0-9a-f]{32}$/.test(own.run_id)&&ready.run_id===own.run_id,'b_source_ownership_contract_invalid');
  need(own.root_identity.device===root.dev&&own.root_identity.inode===root.ino&&own.data_identity.device===data.dev&&own.data_identity.inode===data.ino,'b_source_directory_identity_changed');
  need(Number.isInteger(proc.pid)&&proc.pid>1,'b_source_pid_invalid');
  const stat=fs.readFileSync('/proc/'+proc.pid+'/stat','utf8');
  const start=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/)[19];
  const args=fs.readFileSync('/proc/'+proc.pid+'/cmdline','utf8').replace(/\0$/,'').split('\0');
  need(start===proc.start_ticks&&JSON.stringify(args)===JSON.stringify(proc.args)&&args[0]==='/usr/sbin/mysqld'&&args.includes('--no-defaults')&&args.includes('--port=23306')&&args.includes('--bind-address='+HOST)&&args.includes('--datadir='+directory+'/data')&&args.includes('--socket='+directory+'/mysql.sock'),'b_source_process_identity_changed');
  const socket=fs.lstatSync(directory+'/mysql.sock');need(socket.isSocket()&&!socket.isSymbolicLink(),'b_source_socket_not_owned');
  return {directory,runId:own.run_id,pid:proc.pid,socket:directory+'/mysql.sock'};
}
async function verifySource(context) {
  need(sources.has(context),'b_source_context_not_proven');
  const run=context.readRun(context.run.directory);need(run.runId===context.run.runId&&run.pid===context.run.pid,'b_source_run_changed');
  const [[row]]=await q(context.c,'SELECT @@datadir datadir,@@version version,@@socket socket,@@port port,@@bind_address bind_address,@@server_id server_id,@@log_bin log_bin,@@binlog_format binlog_format,@@binlog_row_image binlog_row_image,@@gtid_mode gtid_mode,@@require_secure_transport tls_required,DATABASE() db');
  need(/^8\.0\.42(?:-|$)/.test(row.version)&&row.datadir.replace(/\/$/,'')===run.directory+'/data'&&row.socket===run.socket&&Number(row.port)===PORT&&row.bind_address===HOST&&Number(row.server_id)===SERVER_ID&&Number(row.log_bin)===1&&row.binlog_format==='ROW'&&row.binlog_row_image==='FULL'&&row.gtid_mode==='OFF'&&Number(row.tls_required)===1&&row.db===fixture.SCHEMA,'b_source_actual_instance_not_owned');
  const [[marker]]=await q(context.c,'SELECT run_id FROM `cc_dms_pilot`.`pilot_identity` WHERE id=1');need(marker.run_id===run.runId,'b_source_marker_mismatch');
  const [other]=await q(context.c,"SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys','cc_dms_pilot')");need(other.length===0,'b_source_unexpected_schema');
}
async function openOwnedSource(directory,{connect,readRun=readOwnedRun}={}) {
  const run=readRun(directory);
  const create=connect||require('mysql2/promise').createConnection;
  const c=await create({socketPath:run.socket,user:'root',password:'',database:fixture.SCHEMA,multipleStatements:false,charset:'utf8mb4',dateStrings:true,connectTimeout:3000});
  const context={run,c,readRun};sources.add(context);
  try{await verifySource(context);return context;}catch(error){try{c.destroy();}catch{}throw error;}
}
async function prepareFixtures(context) {
  await verifySource(context);
  const [tables]=await q(context.c,"SELECT TABLE_NAME name FROM information_schema.tables WHERE TABLE_SCHEMA='cc_dms_pilot'");
  need(tables.map(t=>t.name).sort().join(',')==='pilot_identity,pilot_probe','b_fixture_source_must_be_fresh');
  for(const sql of fixture.DDL)await q(context.c,sql);
  for(const sql of fixture.triggerDDL())await q(context.c,sql);
  await q(context.c,'START TRANSACTION');
  try{for(const statement of fixture.initialRows())await q(context.c,statement.sql,statement.values);await q(context.c,'COMMIT');}
  catch(error){await q(context.c,'ROLLBACK');throw error;}
  return {fixturePrepared:true,realWhatsappGuardsAccredited:false,externalSendsPerformed:false};
}
function buildExportCommand(run) {
  need(run?.directory&&path.dirname(run.directory)==='/tmp'&&path.basename(run.directory).startsWith('cc-dms-pilot-source-')&&run.socket===run.directory+'/mysql.sock'&&/^[0-9a-f]{32}$/.test(run.runId),'b_export_run_invalid');
  return {binary:'/usr/bin/timeout',args:['--signal=TERM','--kill-after=2s','15s','/usr/bin/mysqldump','--no-defaults','--protocol=SOCKET','--socket='+run.socket,'--port=23306','--user=root','--password=','--default-character-set=utf8mb4','--single-transaction','--source-data=2','--quick','--no-tablespaces','--set-gtid-purged=OFF','--skip-triggers','--skip-lock-tables','--skip-add-drop-table','--skip-comments','--skip-add-locks','--skip-disable-keys','--complete-insert',fixture.SCHEMA,...fixture.EXPORT_ORDER],
    env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8',TZ:'UTC',MYSQL_TEST_LOGIN_FILE:run.directory+'/unused-login-path.cnf'}};
}
function seedCoordinate(text) {
  const found=[];let i=0;
  while(i<text.length) {
    if("'\"`".includes(text[i])){i=policy.skipQuotedSql(text,i);continue;}
    if(text.slice(i,i+2)==='/*'){const end=text.indexOf('*/',i+2);need(end>=0,'b_seed_comment_unterminated');i=end+2;continue;}
    if(text[i]==='#'||text.slice(i,i+2)==='--'&&/\s/.test(text[i+2]||'')) {
      const end=text.indexOf('\n',i);const line=text.slice(i,end<0?text.length:end).replace(/^--\s*/, '');
      if(/^CHANGE\s+(?:REPLICATION\s+SOURCE|MASTER)\s+TO\b/i.test(line)) {
        const match=/^CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='(pilot-bin\.[0-9]{6})',\s*SOURCE_LOG_POS=([0-9]+);\s*$/.exec(line);
        need(match&&Number.isSafeInteger(Number(match[2]))&&Number(match[2])>=4&&Number(match[2])<=4294967295,'b_seed_coordinate_invalid');found.push({file:match[1],position:Number(match[2])});
      }
      i=end<0?text.length:end;continue;
    }
    i++;
  }
  need(found.length===1,'b_seed_coordinate_missing_or_duplicate');return {...found[0],cdcStartPosition:found[0].file+':'+found[0].position};
}
function nameAt(tokens,index) {
  const token=tokens[index];need(token&&['identifier','word'].includes(token.kind)&&Object.hasOwn(fixture.TABLES,token.value),'b_seed_table_not_fixture');return token.value;
}
function literal(tokens) {
  return tokens.length===1&&(['string','number'].includes(tokens[0].kind)||tokens[0].raw.toUpperCase()==='NULL')
    ||tokens.length===2&&['-','+'].includes(tokens[0].raw)&&tokens[1].kind==='number';
}
function parseSeed(text,runId) {
  need(typeof text==='string'&&Buffer.byteLength(text)<=MAX_SEED&&/^[0-9a-f]{32}$/.test(runId),'b_seed_limit_or_run_invalid');
  const coordinate=seedCoordinate(text),statements=[],created=new Set();let identity=false;
  for(const statement of policy.inspectStatementsForSyntheticSeed(text)) {
    const t=statement.tokens,w=t.map(x=>x.raw.toUpperCase());
    if(w[0]==='SET'){need(policy.isSafeDumpSessionStatement(t),'b_seed_session_statement_unsafe');continue;}
    need(!t.some(x=>x.kind==='symbol'&&x.raw==='.'),'b_seed_qualified_name_forbidden');
    if(w[0]==='CREATE'&&w[1]==='TABLE') {
      const name=nameAt(t,2);need(t[3]?.raw==='('&&!created.has(name),'b_seed_duplicate_or_non_native_table');created.add(name);
      const forbidden=new Set(['SELECT','LIKE','DIRECTORY','TABLESPACE','CONNECTION','DEFINER','DROP','LOAD','INFILE','OUTFILE']);
      need(!t.some((x,i)=>x.kind==='word'&&forbidden.has(w[i])),'b_seed_unsafe_create_clause');
      const engines=t.map((x,i)=>x.kind==='word'&&w[i]==='ENGINE'&&t[i+1]?.raw==='='?w[i+2]:null).filter(Boolean);need(engines.length===1&&engines[0]==='INNODB','b_seed_engine_not_innodb');
      t.forEach((x,i)=>{if(x.kind==='word'&&w[i]==='REFERENCES')nameAt(t,i+1);});
    } else {
      need(w[0]==='INSERT'&&w[1]==='INTO','b_seed_statement_not_create_or_insert');const name=nameAt(t,2);need(t[3]?.raw==='(','b_seed_complete_insert_required');
      let i=4;const columns=[];
      while(t[i]?.raw!==')'){need(t[i]&&['word','identifier'].includes(t[i].kind),'b_seed_insert_columns_invalid');columns.push(t[i++].value);if(t[i]?.raw===',')i++;else need(t[i]?.raw===')','b_seed_insert_columns_invalid');}
      need(columns.length===fixture.TABLES[name].length&&new Set(columns).size===columns.length&&columns.every(c=>fixture.TABLES[name].includes(c)),'b_seed_generated_or_unknown_insert_column');
      need(w[++i]==='VALUES','b_seed_literal_values_required');i++;
      const rows=[];
      while(i<t.length) {
        need(t[i++]?.raw==='(','b_seed_values_tuple_invalid');const row=[];
        for(let column=0;column<columns.length;column++) {
          const start=i;while(i<t.length&&t[i].raw!==','&&t[i].raw!==')')i++;
          const value=t.slice(start,i);need(literal(value),'b_seed_nonliteral_data_forbidden');row.push(value.map(v=>v.raw).join(''));
          need(t[i]?.raw===(column+1===columns.length?')':','),'b_seed_value_count_invalid');i++;
        }
        rows.push(row);if(i<t.length)need(t[i++]?.raw===',','b_seed_insert_suffix_forbidden');
      }
      if(name==='pilot_identity')need(!identity&&rows.length===1&&rows[0][columns.indexOf('id')]==='1'&&rows[0][columns.indexOf('run_id')]==="'"+runId+"'",'b_seed_run_marker_invalid');
      if(name==='pilot_identity')identity=true;
    }
    statements.push({sql:statement.text,kind:w[0],table:nameAt(t,2)});
  }
  need(identity&&created.size===fixture.EXPORT_ORDER.length&&fixture.EXPORT_ORDER.every(name=>created.has(name)),'b_seed_fixture_inventory_incomplete');
  const seed=Object.freeze({coordinate:Object.freeze(coordinate),runId,sha256:policy.sha(text),bytes:Buffer.byteLength(text),statements:Object.freeze(statements.map(Object.freeze)),clinicalData:false});seeds.add(seed);return seed;
}
async function exportNativeSeed(context,{capture}={}) {
  await verifySource(context);const command=buildExportCommand(context.run);
  const obtain=capture||(async cmd=>{
    try{const {stdout}=await promisify(execFile)(cmd.binary,cmd.args,{env:cmd.env,encoding:'utf8',maxBuffer:MAX_SEED,timeout:17000});return stdout;}
    catch{policy.refuse('b_owned_seed_export_failed');}
  });
  const text=await obtain(command);await verifySource(context);return parseSeed(text,context.run.runId);
}
async function runMutation(context,name) {
  const statements=fixture.mutationStage(name);await verifySource(context);
  const affected=[];await q(context.c,'START TRANSACTION');
  try{
    for(const statement of statements){const [result]=await q(context.c,statement.sql,statement.values);need(Number(result.affectedRows)===1,'b_mutation_did_not_change_exactly_one_row');affected.push(1);}
    await q(context.c,'COMMIT');
  }catch(error){await q(context.c,'ROLLBACK');throw error;}
  return {stage:name,syntheticOnly:true,committed:true,affectedRows:affected,interleavingWithDumpIndependentlyProven:false,
    sourceWritersFencedIndependentlyVerified:false,finalMarkerAloneProvesCompleteCdc:false};
}
async function targetScope(target) {
  need(targets.has(target),'b_target_context_not_proven');
  const [[clinical]]=await q(target.c,"SELECT COUNT(*) n FROM information_schema.schemata WHERE schema_name='clinicaclick'");need(Number(clinical.n)===0,'b_clinical_target_present');
  if(target.initialized){const [[db]]=await q(target.c,'SELECT DATABASE() db');need(db.db===fixture.SCHEMA,'b_target_session_scope_changed');}
}
async function openEmptyTarget({factory}={}) {
  const create=factory||require('/home/ubuntu/qa-evidence/architecture-diagnostic-20261018-c3CWBj/rds-target-operator.cjs').getTargetOperator;
  const op=await create();let c;
  try {
    c=await op.openConnection();const config=c.connection?.config;
    need(config?.multipleStatements===false&&/^clinicaclick-mysql\.[a-z0-9]+\.eu-west-3\.rds\.amazonaws\.com$/.test(config.host)
      &&config.ssl?.rejectUnauthorized===true&&config.ssl?.verifyIdentity===true,'b_target_strict_connection_required');
    const target={op,c,initialized:false};targets.add(target);await targetScope(target);
    const [[engine]]=await q(c,'SELECT @@version version,@@require_secure_transport tls_required,@@event_scheduler events,@@log_bin_trust_function_creators trust_creators');
    need(engine.version==='8.4.11'&&Number(engine.tls_required)===1&&engine.events==='OFF'&&Number(engine.trust_creators)===1,'b_target_engine_settings_not_ready');
    const [objects]=await q(c,"SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA='cc_dms_pilot' UNION ALL SELECT TRIGGER_NAME FROM information_schema.triggers WHERE TRIGGER_SCHEMA='cc_dms_pilot' UNION ALL SELECT ROUTINE_NAME FROM information_schema.routines WHERE ROUTINE_SCHEMA='cc_dms_pilot' UNION ALL SELECT EVENT_NAME FROM information_schema.events WHERE EVENT_SCHEMA='cc_dms_pilot'");need(objects.length===0,'b_target_schema_not_empty');
    const [[exists]]=await q(c,"SELECT COUNT(*) n FROM information_schema.schemata WHERE schema_name='cc_dms_pilot'");
    if(Number(exists.n)===0)await q(c,'CREATE DATABASE `cc_dms_pilot` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    await q(c,'USE `cc_dms_pilot`');target.initialized=true;
    await q(c,'SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci');await q(c,"SET SESSION time_zone='+00:00'");await q(c,'SET SESSION sql_mode=?',[policy.SQL_MODE]);
    return target;
  }catch(error){await op.close();throw error;}
}
const LOB_NULLABLE_DDL=Object.freeze([
  'ALTER TABLE `cc_dms_pilot`.`pilot_probe` MODIFY COLUMN payload JSON NULL',
  'ALTER TABLE `cc_dms_pilot`.`b_lob` MODIFY COLUMN payload JSON NULL,MODIFY COLUMN document MEDIUMTEXT NULL',
  'ALTER TABLE `cc_dms_pilot`.`b_wa_catalog` MODIFY COLUMN properties JSON NULL',
  'ALTER TABLE `cc_dms_pilot`.`b_wa_queue` MODIFY COLUMN payload JSON NULL',
]);
const LOB_NOTNULL_DDL=Object.freeze(LOB_NULLABLE_DDL.map(sql=>sql.replace(/ JSON NULL/g,' JSON NOT NULL').replace(/ MEDIUMTEXT NULL/g,' MEDIUMTEXT NOT NULL')));
async function restoreNativeSeed(target,seed,{lobVariant='native_notnull'}={}) {
  need(seeds.has(seed)&&['native_notnull','nullable_target_lob'].includes(lobVariant),'b_seed_or_lob_variant_invalid');await targetScope(target);
  await q(target.c,'SET SESSION foreign_key_checks=0');
  try{
    for(const statement of seed.statements){await targetScope(target);await q(target.c,statement.sql);}
  }finally{await q(target.c,'SET SESSION foreign_key_checks=1');}
  if(lobVariant==='nullable_target_lob')for(const sql of LOB_NULLABLE_DDL){await targetScope(target);await q(target.c,sql);}
  for(const sql of fixture.triggerDDL()){await targetScope(target);await q(target.c,sql);}
  const [[fk]]=await q(target.c,'SELECT @@SESSION.foreign_key_checks n');need(Number(fk.n)===1,'b_target_fk_not_on_before_cdc');
  const orphans=[];
  for(const table of ['b_child_cascade','b_child_setnull']){
    const [[row]]=await q(target.c,'SELECT COUNT(*) n FROM `cc_dms_pilot`.`'+table+'` c LEFT JOIN `cc_dms_pilot`.`b_parent` p ON p.id=c.parent_id WHERE c.parent_id IS NOT NULL AND p.id IS NULL');orphans.push(Number(row.n));
  }
  need(orphans.every(n=>n===0),'b_native_seed_orphans');
  return {restored:true,seedSha256:seed.sha256,coordinate:seed.coordinate,lobVariant,fkOnBeforeCdc:true,orphanCounts:orphans,
    realWhatsappGuardsAccredited:false,awsTaskStarted:false,clinicalCopyAuthorized:false};
}
async function probeSyntheticGuards(context) {
  if(sources.has(context))await verifySource(context);else await targetScope(context);
  for(const statement of fixture.NEGATIVE_GUARDS) {
    await q(context.c,'START TRANSACTION');let rejected=false;
    try{await q(context.c,statement.sql,statement.values);}catch(error){rejected=error.code==='ER_SIGNAL_EXCEPTION'&&Number(error.errno)===1644&&error.sqlState==='45000';}
    finally{await q(context.c,'ROLLBACK');}
    need(rejected,'b_synthetic_guard_did_not_reject');
  }
  return {syntheticInsertAndUpdateGuardsRejected:true,realWhatsappGuardsAccredited:false,externalSendsPerformed:false};
}
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
async function compareSyntheticRows(source,target) {
  await verifySource(source);await targetScope(target);const tables=[];
  for(const name of fixture.EXPORT_ORDER) {
    const columns=[...fixture.TABLES[name],...fixture.GENERATED.filter(([table])=>table===name).map(([,column])=>column)];
    const dates=new Set(['created_at','due_at','acked_at']);
    const sql='SELECT '+columns.map(column=>dates.has(column)?"DATE_FORMAT(`"+column+"`,'%Y-%m-%d %H:%i:%s.%f') AS `"+column+'`':'`'+column+'`').join(',')+' FROM `cc_dms_pilot`.`'+name+'` ORDER BY id';
    const [a]=await q(source.c,sql),[b]=await q(target.c,sql);
    const left=policy.sha(JSON.stringify(canonical(a))),right=policy.sha(JSON.stringify(canonical(b)));
    tables.push({table:name,sourceRows:a.length,targetRows:b.length,sourceSha256:left,targetSha256:right,equal:left===right});
  }
  return {tables,allTablesEqual:tables.every(table=>table.equal),realWhatsappGuardsAccredited:false,clinicalCopyAuthorized:false};
}
async function restoreNotNullAfterFence(target,{sourceWritersFenced=false,cdcStopped=false}={}) {
  // This function records a benchmark only. Caller assertions are not independently
  // verified and never become permission for a clinical cutover.
  need(sourceWritersFenced===true&&cdcStopped===true,'b_finalization_fence_assertions_required');await targetScope(target);
  const start=process.hrtime.bigint();for(const sql of LOB_NOTNULL_DDL)await q(target.c,sql);
  return {seconds:Number(process.hrtime.bigint()-start)/1e9,fixtureTablesOnly:true,
    fenceIndependentlyVerified:false,representative86TableTimingProven:false,clinicalCopyAuthorized:false};
}
async function closeSource(source){need(sources.has(source),'b_source_context_not_proven');sources.delete(source);await source.c.end();}
async function closeTarget(target){need(targets.has(target),'b_target_context_not_proven');targets.delete(target);await target.op.close();}
function cdcProposal(seed,privateSecretsDns) {
  need(seeds.has(seed),'b_seed_not_validated');need(/^vpce-[A-Za-z0-9.-]+\.secretsmanager\.eu-west-3\.vpce\.amazonaws\.com$/.test(privateSecretsDns),'b_private_secrets_dns_invalid');
  const rules=fixture.EXPORT_ORDER.map((table,i)=>({'rule-type':'selection','rule-id':String(i+1),'rule-name':'b-'+table,'object-locator':{'schema-name':fixture.SCHEMA,'table-name':table},'rule-action':'include'}));
  for(const [i,[table,column]]of fixture.GENERATED.entries())rules.push({'rule-type':'transformation','rule-id':String(101+i),'rule-name':'b-remove-'+column,'rule-target':'column','object-locator':{'schema-name':fixture.SCHEMA,'table-name':table,'column-name':column},'rule-action':'remove-column'});
  return {MigrationType:'cdc',CdcStartPosition:seed.coordinate.cdcStartPosition,TableMappings:{rules},
    ReplicationTaskSettings:{TargetMetadata:{SupportLobs:true,FullLobMode:true,LobChunkSize:64,LimitedSizeLobMode:false,InlineLobMaxSize:0,BatchApplyEnabled:false},FullLoadSettings:{TargetTablePrepMode:'DO_NOTHING'},ValidationSettings:{EnableValidation:true,SkipLobColumns:false,ValidationPartialLobSize:0},ErrorBehavior:{DataErrorPolicy:'STOP_TASK',DataTruncationErrorPolicy:'STOP_TASK',TableErrorPolicy:'STOP_TASK',ApplyErrorInsertPolicy:'STOP_TASK',ApplyErrorUpdatePolicy:'STOP_TASK',ApplyErrorDeletePolicy:'STOP_TASK',FullLoadIgnoreConflicts:false},Logging:{EnableLogging:false}},
    requiredTargetExtraConnectionAttributes:'Initstmt=SET FOREIGN_KEY_CHECKS=1;secretsManagerEndpointOverride='+privateSecretsDns+';',
    requiredSource:{host:HOST,port:PORT,schema:fixture.SCHEMA,sslMode:'verify-full'},requiredTarget:{schema:fixture.SCHEMA,sslMode:'verify-full'},
    endpointConfigurationIndependentlyVerified:false,awsTaskCreated:false,awsTaskStarted:false,clinicalCopyAuthorized:false,allInheritedGatesPassed:false};
}
module.exports={readOwnedRun,openOwnedSource,verifySource,prepareFixtures,buildExportCommand,seedCoordinate,parseSeed,exportNativeSeed,runMutation,
  openEmptyTarget,restoreNativeSeed,probeSyntheticGuards,compareSyntheticRows,restoreNotNullAfterFence,closeSource,closeTarget,cdcProposal,MAX_SEED};
