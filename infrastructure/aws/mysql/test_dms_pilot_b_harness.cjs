'use strict';
// Entirely offline: connections, dump output and SQL results are explicit fakes.
const test=require('node:test');
const assert=require('node:assert/strict');
const h=require('./dms_pilot_b_harness.cjs');
const f=require('./dms_pilot_b_fixture.cjs');
const sqlPolicy=require('./schema_compat_sql.cjs');
const run={directory:'/tmp/cc-dms-pilot-source-offline',runId:'a'.repeat(32),pid:123,socket:'/tmp/cc-dms-pilot-source-offline/mysql.sock'};
const dns='vpce-offline-123.secretsmanager.eu-west-3.vpce.amazonaws.com';
function dump({extra='',coordinate="-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='pilot-bin.000007', SOURCE_LOG_POS=371;"}={}) {
  const ddl=new Map(f.DDL.map(text=>[text.match(/`cc_dms_pilot`\.`([^`]+)`/)[1],text.replace(/`cc_dms_pilot`\./g,'')]));
  ddl.set('pilot_identity','CREATE TABLE `pilot_identity` (`id` BIGINT PRIMARY KEY,`run_id` CHAR(32) NOT NULL) ENGINE=InnoDB');
  ddl.set('pilot_probe','CREATE TABLE `pilot_probe` (`id` BIGINT PRIMARY KEY,`payload` JSON NOT NULL) ENGINE=InnoDB');
  return coordinate+'\n'+f.EXPORT_ORDER.map(name=>ddl.get(name)+';').join('\n')+"\nINSERT INTO `pilot_identity` (`id`,`run_id`) VALUES (1,'"+run.runId+"');\n"+extra;
}
function fakeConnection({source=false,port=23306,version='8.0.42-0ubuntu0.24.04.1',clinical=false,extraSchema=false,signalGuards=false,rowOverride,failWrite=false}={}) {
  const seen=[];let current=source?'cc_dms_pilot':null,closed=false;
  const c={connection:{config:{multipleStatements:false,host:'clinicaclick-mysql.offline.eu-west-3.rds.amazonaws.com',ssl:{rejectUnauthorized:true,verifyIdentity:true}}},
    seen,get closed(){return closed;},destroy(){closed=true;},async end(){closed=true;},
    async query(options,values=[]) {
      const text=options.sql;seen.push({sql:text,values});
      if(text.startsWith('SELECT @@datadir'))return [[{datadir:run.directory+'/data/',version,socket:run.socket,port,bind_address:'172.26.0.110',server_id:183306,log_bin:1,binlog_format:'ROW',binlog_row_image:'FULL',gtid_mode:'OFF',tls_required:1,db:current}]];
      if(text.startsWith('SELECT run_id'))return [[{run_id:run.runId}]];
      if(text.includes('SCHEMA_NAME NOT IN'))return [extraSchema?[{SCHEMA_NAME:'clinicaclick'}]:[]];
      if(text.includes("schema_name='clinicaclick'"))return [[{n:clinical?1:0}]];
      if(text.startsWith('SELECT @@version'))return [[{version:'8.4.11',tls_required:1,events:'OFF',trust_creators:1}]];
      if(text.includes('UNION ALL SELECT TRIGGER_NAME'))return [[]];
      if(text.includes("schema_name='cc_dms_pilot'"))return [[{n:0}]];
      if(text.startsWith('SELECT TABLE_NAME name'))return [[{name:'pilot_identity'},{name:'pilot_probe'}]];
      if(text==='USE `cc_dms_pilot`'){current='cc_dms_pilot';return [{affectedRows:0}];}
      if(text==='SELECT DATABASE() db')return [[{db:current}]];
      if(text.startsWith('SELECT @@SESSION.foreign_key_checks'))return [[{n:1}]];
      if(text.startsWith('SELECT COUNT(*) n'))return [[{n:0}]];
      if(signalGuards&&(values[0]===99||text.includes('SET phone_asset_key=NULL')))throw Object.assign(new Error('synthetic rejection'),{code:'ER_SIGNAL_EXCEPTION',errno:1644,sqlState:'45000'});
      if(text.startsWith('SELECT ')) {
        const table=/FROM `cc_dms_pilot`\.`([^`]+)`/.exec(text)?.[1];
        return [rowOverride?.(table)||[]];
      }
      if(failWrite&&/^(UPDATE|DELETE|INSERT)/.test(text))throw new Error('offline_write_failure');
      return [{affectedRows:1}];
    }};
  return c;
}
async function source(options={}) {
  const c=fakeConnection({source:true,...options});const context=await h.openOwnedSource(run.directory,{readRun:()=>({...run}),connect:async config=>{assert.equal(config.socketPath,run.socket);assert.equal(config.multipleStatements,false);return c;}});
  return {c,context};
}
async function target(options={}) {
  const c=fakeConnection(options),op={async openConnection(){return c;},async close(){await c.end();}};
  return {c,op,context:await h.openEmptyTarget({factory:async()=>op})};
}
test('fixtures are fictional and cover byte edges, generated columns, cascades and two labelled guards',()=>{
  for(const size of [0,1,32769,65535,65536,65537,1048576,1048577])assert.equal(Buffer.byteLength(f.textBytes(size)),size);
  const lob=f.initialRows().filter(row=>row.sql.includes('`b_lob`'));
  assert.deepEqual(lob.map(row=>Buffer.byteLength(row.values[2])),[0,32769,65535,65536,65537,1048576,1048577]);
  assert.ok(lob.some(row=>row.values[3]===null));assert.ok(lob.some(row=>row.values[3]===''));
  assert.equal(f.GENERATED.length,5);assert.equal(f.triggerDDL().length,2);
  assert.ok(f.DDL.some(sql=>sql.includes('ON DELETE CASCADE ON UPDATE CASCADE')));
  assert.ok(f.DDL.some(sql=>sql.includes('ON DELETE SET NULL ON UPDATE SET NULL')));
  assert.ok(f.initialRows().some(row=>row.values.some(value=>typeof value==='string'&&value.includes('sendForbidden'))));
  assert.ok(f.triggerDDL().every(sql=>sql.includes('b_guard_catalog_')&&sql.includes('synthetic_whatsapp_catalog_guard')));
  assert.equal(f.EXPORT_ORDER.at(-1),'b_parent');assert.equal(f.mutationStage('after_seed_update').filter(s=>s.sql.startsWith('INSERT')).length,1);
});
test('owned source rejects real paths without opening or inspecting them',()=>{
  for(const dir of ['/var/lib/mysql','/tmp/mysql','/tmp/cc-dms-pilot-source-fake/../real','/home/ubuntu/back-dev'])assert.throws(()=>h.readOwnedRun(dir),/b_source_run_namespace_invalid/);
});
test('source validates the actual engine before any fixture-row read or write',async()=>{
  const c=fakeConnection({source:true,port:3306});
  await assert.rejects(h.openOwnedSource(run.directory,{readRun:()=>run,connect:async()=>c}),/b_source_actual_instance_not_owned/);
  assert.equal(c.closed,true);assert.equal(c.seen.length,1);assert.ok(c.seen[0].sql.startsWith('SELECT @@datadir'));
  for(const version of ['8.0.43','8.4.11']){
    const wrongEngine=fakeConnection({source:true,version});
    await assert.rejects(h.openOwnedSource(run.directory,{readRun:()=>run,connect:async()=>wrongEngine}),/b_source_actual_instance_not_owned/);
    assert.equal(wrongEngine.seen.length,1);
  }
  const wrong=fakeConnection({source:true,extraSchema:true});
  await assert.rejects(h.openOwnedSource(run.directory,{readRun:()=>run,connect:async()=>wrong}),/b_source_unexpected_schema/);
  assert.ok(wrong.seen.every(entry=>entry.sql.startsWith('SELECT ')));
});
test('native exporter has one transaction, embedded coordinate and an owned socket; no inherited login file',()=>{
  const command=h.buildExportCommand(run);
  for(const flag of ['--single-transaction','--source-data=2','--quick','--complete-insert','--set-gtid-purged=OFF','--skip-triggers','--port=23306','--password='])assert.ok(command.args.includes(flag));
  assert.equal(command.binary,'/usr/bin/timeout');assert.ok(command.args.includes('15s'));
  assert.equal(command.env.MYSQL_TEST_LOGIN_FILE,run.directory+'/unused-login-path.cnf');
  assert.equal(command.env.MYSQL_PWD,undefined);assert.ok(!command.args.some(a=>a==='clinicaclick'||a==='--port=3306'));
});
test('only a single native coordinate comment can bind the seed',()=>{
  const seed=h.parseSeed(dump(),run.runId);assert.equal(seed.coordinate.cdcStartPosition,'pilot-bin.000007:371');
  const quoted="INSERT INTO x VALUES ('-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE=\\'pilot-bin.000999\\', SOURCE_LOG_POS=4;');\n";
  assert.equal(h.seedCoordinate(quoted+dump()).file,'pilot-bin.000007');
  for(const coordinate of ['',"-- CHANGE MASTER TO MASTER_LOG_FILE='pilot-bin.000007', MASTER_LOG_POS=371;", "-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='mysql-bin.000007', SOURCE_LOG_POS=371;","-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='pilot-bin.000007', SOURCE_LOG_POS=3;"])
    assert.throws(()=>h.parseSeed(dump({coordinate}),run.runId),/b_seed_coordinate/);
  assert.throws(()=>h.parseSeed(dump()+dump(),run.runId),/b_seed_coordinate_missing_or_duplicate/);
});
test('seed parser admits native fixture data and rejects cross-schema, DML and expression escapes',()=>{
  const allowed="INSERT INTO `b_lob` (`id`,`payload`,`document`,`nullable_document`,`revision`) VALUES (3,'{\"synthetic\":true}','🦷',NULL,0);";
  assert.equal(h.parseSeed(dump({extra:allowed}),run.runId).statements.at(-1).table,'b_lob');
  for(const extra of [
    'USE clinicaclick;', 'DROP TABLE b_lob;', 'DELETE FROM b_parent;', 'REPLACE INTO b_parent VALUES (1,2);',
    "INSERT INTO `clinicaclick`.`b_parent` (`id`,`label`) VALUES (1,'X');",
    "INSERT INTO `b_parent` (`id`,`label`) VALUES (1,LOAD_FILE('/etc/passwd'));",
    "INSERT INTO `b_parent` (`id`,`label`) VALUES (1,'x') ON DUPLICATE KEY UPDATE label='y';",
    "INSERT INTO `b_google_generated` (`id`,`ad_group`,`network`,`device`,`ad_group_key`) VALUES(1,NULL,NULL,NULL,'x');",
    'SET GLOBAL read_only=0;', '/*!80000 DROP TABLE b_parent */;',
  ])assert.throws(()=>h.parseSeed(dump({extra}),run.runId),undefined,extra);
  assert.throws(()=>h.parseSeed(dump().replace('ENGINE=InnoDB','ENGINE=MyISAM'),run.runId),/b_seed_engine_not_innodb/);
  assert.throws(()=>h.parseSeed(dump().replace('REFERENCES b_parent','REFERENCES another_table'),run.runId),/b_seed_table_not_fixture/);
  assert.throws(()=>h.parseSeed(dump().replace(run.runId,'b'.repeat(32)),run.runId),/b_seed_run_marker_invalid/);
});
test('validated seed is frozen and conveys no approval to the M6 SQL executor',()=>{
  const seed=h.parseSeed(dump(),run.runId);assert.ok(Object.isFrozen(seed)&&Object.isFrozen(seed.coordinate)&&Object.isFrozen(seed.statements[0]));
  assert.throws(()=>{seed.coordinate.position=999;},TypeError);
  assert.throws(()=>sqlPolicy.assertApproved(seed.statements[0]),/statement_not_compiled/);
  assert.throws(()=>h.cdcProposal({...seed},dns),/b_seed_not_validated/);
});
test('CDC proposal keeps native position, exact scope, FK enforcement, full LOB and generated recomputation',()=>{
  const proposal=h.cdcProposal(h.parseSeed(dump(),run.runId),dns),settings=proposal.ReplicationTaskSettings;
  assert.equal(proposal.MigrationType,'cdc');assert.equal(proposal.CdcStartPosition,'pilot-bin.000007:371');
  assert.equal(settings.TargetMetadata.FullLobMode,true);assert.equal(settings.TargetMetadata.BatchApplyEnabled,false);
  assert.equal(settings.TargetMetadata.LimitedSizeLobMode,false);assert.equal(settings.FullLoadSettings.TargetTablePrepMode,'DO_NOTHING');
  assert.equal(settings.ErrorBehavior.DataTruncationErrorPolicy,'STOP_TASK');assert.equal(settings.ValidationSettings.SkipLobColumns,false);
  assert.ok(proposal.requiredTargetExtraConnectionAttributes.startsWith('Initstmt=SET FOREIGN_KEY_CHECKS=1;'));
  assert.equal(proposal.TableMappings.rules.filter(rule=>rule['rule-action']==='remove-column').length,5);
  assert.ok(proposal.TableMappings.rules.every(rule=>rule['object-locator']['schema-name']==='cc_dms_pilot'&&!JSON.stringify(rule).includes('%')));
  for(const key of ['awsTaskCreated','awsTaskStarted','clinicalCopyAuthorized','allInheritedGatesPassed','endpointConfigurationIndependentlyVerified'])assert.equal(proposal[key],false);
  assert.throws(()=>h.cdcProposal(h.parseSeed(dump(),run.runId),'secretsmanager.eu-west-3.amazonaws.com'),/b_private_secrets_dns_invalid/);
});
test('target fails before DDL if clinical schema exists or strict TLS is absent',async()=>{
  const c=fakeConnection({clinical:true}),op={async openConnection(){return c;},async close(){await c.end();}};
  await assert.rejects(h.openEmptyTarget({factory:async()=>op}),/b_clinical_target_present/);
  assert.equal(c.closed,true);assert.equal(c.seen.length,1);
  c.connection.config.ssl.verifyIdentity=false;c.seen.length=0;
  await assert.rejects(h.openEmptyTarget({factory:async()=>op}),/b_target_strict_connection_required/);assert.equal(c.seen.length,0);
});
test('native seed restores only reviewed fixture statements and FK is on before CDC',async()=>{
  const {context,c}=await target(),seed=h.parseSeed(dump(),run.runId);
  const receipt=await h.restoreNativeSeed(context,seed);assert.equal(receipt.lobVariant,'native_notnull');assert.equal(receipt.fkOnBeforeCdc,true);
  assert.equal(receipt.realWhatsappGuardsAccredited,false);assert.equal(receipt.clinicalCopyAuthorized,false);
  assert.equal(c.seen.filter(item=>item.sql.startsWith('ALTER TABLE')).length,0);
  const off=c.seen.findIndex(item=>item.sql==='SET SESSION foreign_key_checks=0');
  const on=c.seen.findIndex(item=>item.sql==='SET SESSION foreign_key_checks=1');assert.ok(off>=0&&on>off);
  assert.equal(c.seen.filter(item=>item.sql.startsWith('CREATE DEFINER=CURRENT_USER TRIGGER')).length,2);
  assert.ok(!c.seen.some(item=>/^DROP |^DELETE |USE `clinicaclick`/.test(item.sql)));
  await h.closeTarget(context);assert.equal(c.closed,true);
});
test('nullable experiment is explicit and never claims the finalization timing is proven',async()=>{
  const {context,c}=await target();await h.restoreNativeSeed(context,h.parseSeed(dump(),run.runId),{lobVariant:'nullable_target_lob'});
  assert.equal(c.seen.filter(item=>item.sql.startsWith('ALTER TABLE')).length,4);
  await assert.rejects(h.restoreNotNullAfterFence(context),/b_finalization_fence_assertions_required/);
  const receipt=await h.restoreNotNullAfterFence(context,{sourceWritersFenced:true,cdcStopped:true});
  assert.equal(receipt.fixtureTablesOnly,true);assert.equal(receipt.representative86TableTimingProven,false);assert.equal(receipt.fenceIndependentlyVerified,false);
});
test('synthetic guard probes always roll back and cannot accredit real WhatsApp guards',async()=>{
  const {context,c}=await source({signalGuards:true});const receipt=await h.probeSyntheticGuards(context);
  assert.equal(receipt.syntheticInsertAndUpdateGuardsRejected,true);assert.equal(receipt.realWhatsappGuardsAccredited,false);
  assert.equal(c.seen.filter(item=>item.sql==='ROLLBACK').length,2);
  assert.equal(c.seen.filter(item=>item.sql==='COMMIT').length,0);
  const noGuard=await source();await assert.rejects(h.probeSyntheticGuards(noGuard.context),/b_synthetic_guard_did_not_reject/);
  assert.equal(noGuard.c.seen.at(-1).sql,'ROLLBACK');
});
test('fixed mutations commit as one transaction and fail closed on an incomplete write',async()=>{
  const {context,c}=await source();const receipt=await h.runMutation(context,'after_seed_update');
  assert.equal(c.seen.filter(item=>item.sql==='START TRANSACTION').length,1);assert.equal(c.seen.at(-1).sql,'COMMIT');
  assert.equal(receipt.committed,true);assert.equal(receipt.interleavingWithDumpIndependentlyProven,false);
  const broken=await source({failWrite:true});await assert.rejects(h.runMutation(broken.context,'during_seed_delete'),/offline_write_failure/);
  assert.equal(broken.c.seen.at(-1).sql,'ROLLBACK');
  await h.closeSource(context);assert.equal(c.closed,true);
});
test('row comparison checks all fictional tables and LOBs while returning hashes instead of data',async()=>{
  const a=await source({rowOverride:table=>table==='b_lob'?[{id:1,payload:{b:2,a:1},document:'🦷',nullable_document:null}]:[]});
  const b=await target({rowOverride:table=>table==='b_lob'?[{id:1,payload:{a:1,b:2},document:'🦷',nullable_document:null}]:[]});
  const equal=await h.compareSyntheticRows(a.context,b.context);assert.equal(equal.allTablesEqual,true);assert.equal(equal.tables.length,12);
  assert.ok(!JSON.stringify(equal).includes('🦷'));assert.equal(equal.clinicalCopyAuthorized,false);
  const different=await target({rowOverride:table=>table==='b_lob'?[{id:1,payload:{a:1,b:2},document:'truncated',nullable_document:null}]:[]});
  const receipt=await h.compareSyntheticRows(a.context,different.context);assert.equal(receipt.allTablesEqual,false);
  assert.equal(receipt.tables.find(table=>table.table==='b_lob').equal,false);
});
test('export uses the same captured buffer and rechecks source identity on both sides',async()=>{
  const {context,c}=await source();const before=c.seen.filter(item=>item.sql.startsWith('SELECT @@datadir')).length;
  const seed=await h.exportNativeSeed(context,{capture:async command=>{assert.ok(command.args.includes('--source-data=2'));return dump();}});
  assert.equal(seed.coordinate.position,371);
  assert.equal(c.seen.filter(item=>item.sql.startsWith('SELECT @@datadir')).length,before+2);
});
