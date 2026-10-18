'use strict';
const {test,mock}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const policy=require('./schema_compat_sql.cjs');
const operator=require('./rds_schema_compat_operator.cjs');
const NAMES=['ClinicMetaAssets',...Array.from({length:304},(_,i)=>'T'+String(i+1).padStart(3,'0'))];
const BODY="BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fictional guard'; END";
function dump(first='') {
  return "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n"+
    NAMES.map((name,i)=>i===0&&first?first:'CREATE TABLE `'+name+'` (`id` int NOT NULL, `note` varchar(255) DEFAULT \'fictional; DROP DATABASE clinicaclick; -- literal\', PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;').join('\n')+
    '\n/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;';
}
function triggers() {
  return ['insert','update'].map(event=>({name:'guard_whatsapp_catalog_'+event,table:'ClinicMetaAssets',timing:'BEFORE',event:event.toUpperCase(),body:BODY,
    body_sha256:policy.EXPECTED_BODY_SHA256,sql_mode:policy.SQL_MODE,character_set_client:'utf8mb4',collation_connection:'utf8mb4_0900_ai_ci',database_collation:'utf8mb4_0900_ai_ci'}));
}
// No production trigger body is read by these tests. Only the known-body digest
// branch is mocked for a fictional string; negative digest tests use real SHA256.
function mockKnownBodyHash(context) {
  const original=crypto.createHash;
  context.mock.method(crypto,'createHash',(...args)=>{
    const hash=original(...args);let body=false;
    return {update(value,...rest){body=value===BODY;hash.update(value,...rest);return this;},digest(...rest){return body?policy.EXPECTED_BODY_SHA256:hash.digest(...rest);}};
  });
}
function captureFixture(sqlDump=dump()) {
  return async command=>{
    const sql=command.args.at(-1);
    if(sql===operator.SOURCE_META_SQL)return JSON.stringify({version:'8.0.42-ubuntu',sql_mode:policy.SQL_MODE,lower_case_table_names:0,views:0,routines:0,events:0})+'\n';
    if(sql===operator.SOURCE_TABLES_SQL)return NAMES.map(name=>JSON.stringify({name,engine:'InnoDB'})).join('\n');
    if(sql===operator.SOURCE_TRIGGERS_SQL)return triggers().map(value=>JSON.stringify(value)).join('\n');
    assert.ok(command.args.includes('--no-data'));return sqlDump;
  };
}
function targetFixture({clinicalAt=Infinity,warning=0,warningRows=[],errorOnTable=false,trustCreators=1}={}) {
  const queries=[];let clinicalChecks=0;
  const c={connection:{config:{multipleStatements:false}},end:async()=>{},query:async({sql},values)=>{
    queries.push({sql,values});
    if(sql.includes("schema_name='clinicaclick'"))return [[{n:++clinicalChecks>=clinicalAt?1:0}]];
    if(sql.includes('schemata WHERE schema_name=?'))return [[{n:0}]];
    if(sql==='SELECT CURRENT_USER() owner')return [[{owner:'ccadmin@%'}]];
    if(sql.startsWith('SELECT @@version version'))return [[{version:'8.4.11',case_names:0,trust_creators:trustCreators,tls_required:1,events:'OFF'}]];
    if(sql==='SHOW COUNT(*) WARNINGS')return [[{warning_count:warning}]];
    if(sql==='SHOW WARNINGS')return [warningRows];
    if(sql.startsWith('CREATE TABLE')&&errorOnTable)throw Object.assign(new Error('FICTIONAL_SECRET_IN_DRIVER_ERROR'),{code:'ER_FAKE',errno:1000,sql:'FICTIONAL_SECRET_IN_DRIVER_SQL'});
    if(sql.startsWith('SELECT TABLE_NAME'))return [NAMES.map(name=>({name,engine:'InnoDB'}))];
    if(sql.startsWith('SELECT COUNT(*) n FROM `cc_schema_compat_20261018`'))return [[{n:0}]];
    if(sql.startsWith('SELECT TRIGGER_NAME'))return [triggers().map(t=>({name:t.name,definer:'ccadmin@%',body_sha256:policy.EXPECTED_BODY_SHA256}))];
    return [{affectedRows:0}];
  }};
  const op={metadata:{engine:'8.4.11',multiAZ:true},openConnection:async()=>c,close:async()=>{}};
  return {queries,c,factory:async()=>op};
}
test('imports are lazy and source command permits only no-data and fixed metadata SELECTs',()=>{
  const command=operator.sourceCommand('dump');
  for(const flag of ['--no-data','--skip-triggers','--skip-lock-tables','--no-tablespaces','--set-gtid-purged=OFF','--skip-add-drop-table','--skip-comments','--skip-add-locks','--skip-disable-keys'])assert.ok(command.args.includes(flag));
  assert.equal(command.args.at(-1),'clinicaclick');assert.ok(command.args.includes('--socket=/var/run/mysqld/mysqld.sock'));
  assert.ok(!command.args.includes('--single-transaction'));assert.ok(!command.args.some(arg=>arg.startsWith('--source-data')));
  assert.throws(()=>operator.sourceCommand('metadata','DELETE FROM clinicaclick.x'),/source_metadata_query_not_reviewed/);
});
test('complete table compiler keeps literals/defaults and confines every table/FK to synthetic schema',()=>{
  const first='CREATE TABLE `ClinicMetaAssets` (`id` int PRIMARY KEY, `parent` int, `amount` decimal(8,2) DEFAULT 1.25, CONSTRAINT `fake_fk` FOREIGN KEY (`parent`) REFERENCES `clinicaclick`.`T001` (`id`) ON DELETE CASCADE ON UPDATE CASCADE) ENGINE=InnoDB;';
  const statements=policy.compileTables(dump(first),NAMES);
  assert.equal(statements.length,305);assert.ok(statements[0].sql.includes('REFERENCES `cc_schema_compat_20261018`.`T001`'));
  assert.ok(statements[1].sql.includes('fictional; DROP DATABASE clinicaclick; -- literal'));
  assert.equal(policy.assertApproved(statements[0]),statements[0]);
  assert.throws(()=>policy.assertApproved({...statements[0],sql:'DROP DATABASE clinicaclick'}),/statement_not_compiled/);
});
test('DML DROP USE COPY external namespaces unsafe engine and executable comments are rejected',()=>{
  const cases=[
    dump()+'INSERT INTO clinicaclick.x VALUES (1);',dump()+'DROP DATABASE clinicaclick;',dump()+'USE clinicaclick;',
    dump()+'/*!80000 DELETE FROM clinicaclick.x */;',dump()+'/*!99999 SET NAMES utf8mb4 */;',
    dump('CREATE TABLE `ClinicMetaAssets` LIKE `clinicaclick`.`Patients`;'),
    dump('CREATE TABLE `ClinicMetaAssets` (`id` int) ENGINE=InnoDB AS SELECT 1;'),
    dump('CREATE TABLE `ClinicMetaAssets` (`id` int, FOREIGN KEY (`id`) REFERENCES `other`.`T001` (`id`)) ENGINE=InnoDB;'),
    dump('CREATE TABLE `other`.`ClinicMetaAssets` (`id` int) ENGINE=InnoDB;'),
    dump('CREATE TABLE `ClinicMetaAssets` (`id` int) ENGINE=InnoDB DATA DIRECTORY=\'/tmp\';'),
    dump('CREATE TABLE `ClinicMetaAssets` (`id` int) ENGINE=InnoDB ENGINE=FEDERATED;'),
    dump('CREATE TABLE `ClinicMetaAssets` (`id` int) ENGINE=MyISAM;'),
    dump()+'SET GLOBAL event_scheduler=ON;',dump()+'SET @unreviewed=1;',
  ];
  for(const [i,text]of cases.entries())assert.throws(()=>policy.compileTables(text,NAMES),undefined,'case '+i);
});
test('inventory omissions duplicates and source mode drift fail before target access',()=>{
  assert.throws(()=>policy.compileTables(dump(),NAMES.slice(1)),/inventory_changed/);
  assert.throws(()=>policy.compileTables(dump()+dump(),NAMES),/duplicate_table/);
  assert.throws(()=>policy.validateSourceMeta({version:'8.0.42',sql_mode:'NO_BACKSLASH_ESCAPES',lower_case_table_names:0}),/sql_mode_changed/);
  assert.throws(()=>policy.compileTables('x'.repeat(16*1024*1024+1),NAMES),/dump_limit/);
});
test('trigger bodies are gated by real fixed digest; unreviewed charset or identity cannot pass',context=>{
  assert.throws(()=>policy.compileTriggers(triggers()),/trigger_body_changed/);
  mockKnownBodyHash(context);
  const compiled=policy.compileTriggers(triggers());assert.equal(compiled.length,2);
  assert.ok(compiled[0].sql.startsWith('CREATE DEFINER=CURRENT_USER TRIGGER `cc_schema_compat_20261018`.`guard_whatsapp_catalog_insert`'));
  assert.ok(compiled[0].sql.endsWith(BODY));assert.ok(!compiled[0].sql.includes('DELIMITER'));
  const bad=triggers();bad[0].table='Patients';assert.throws(()=>policy.compileTriggers(bad),/trigger_identity_changed/);
  const charset=triggers();charset[0].character_set_client='latin1';assert.throws(()=>policy.compileTriggers(charset),/charset_not_reviewed/);
});
test('source export is fully validated before factory; ack and dangerous source abort without RDS',async()=>{
  let connected=false;const factory=async()=>{connected=true;throw Error('must not connect');};
  await assert.rejects(operator.runSchemaCompatibility({targetFactory:factory}),/ack_required/);
  await assert.rejects(operator.runSchemaCompatibility({acknowledgement:'schema-only-no-patient-data',capture:captureFixture(dump()+'DELETE FROM clinicaclick.x;'),targetFactory:factory}));
  assert.equal(connected,false);
  await assert.rejects(operator.runSchemaCompatibility({acknowledgement:'schema-only-no-patient-data',capture:async()=> 'x'.repeat(operator.MAX_STDOUT+1),targetFactory:factory}),/stdout_limit/);
  assert.equal(connected,false);
});
test('full zero-row dry protocol restores305tables and2bodies only via mocked connections',async context=>{
  mockKnownBodyHash(context);const target=targetFixture();
  const report=await operator.runSchemaCompatibility({acknowledgement:'schema-only-no-patient-data',capture:captureFixture(),targetFactory:target.factory});
  assert.equal(report.status,'schema_only_ddl_accepted');assert.equal(report.zeroRowTablesVerified,305);
  assert.equal(report.tablesCreated.length,305);assert.equal(report.triggersCreated.length,2);
  assert.equal(report.triggerBehaviorValidated,false);assert.equal(report.clinicalMigrationAuthorized,false);
  assert.equal(target.queries.filter(q=>q.sql.startsWith('CREATE DATABASE')).length,1);
  assert.ok(target.queries.filter(q=>q.sql.startsWith('CREATE TABLE')).every(q=>q.sql.startsWith('CREATE TABLE `cc_schema_compat_20261018`.')));
  assert.ok(target.queries.filter(q=>q.sql.startsWith('USE ')).every(q=>q.sql==='USE `cc_schema_compat_20261018`'));
  assert.ok(target.queries.every(q=>!/^(INSERT|UPDATE|DELETE|DROP|TRUNCATE|REPLACE)\b/i.test(q.sql)));
});
test('clinical creation race warnings and SQL errors stop while preserving partial schema',async context=>{
  mockKnownBodyHash(context);
  for(const options of [{clinicalAt:1},{clinicalAt:5},{warning:1},{errorOnTable:true},{trustCreators:0}]) {
    const target=targetFixture(options);
    const report=await operator.runSchemaCompatibility({acknowledgement:'schema-only-no-patient-data',capture:captureFixture(),targetFactory:target.factory});
    assert.equal(report.status,'failed_partial_schema_preserved');
    assert.ok(target.queries.every(q=>!/^DROP\b/.test(q.sql)));
    assert.ok(!JSON.stringify(report).includes('FICTIONAL_SECRET'));
    if(options.clinicalAt===1)assert.ok(!target.queries.some(q=>q.sql.startsWith('CREATE')));
    if(options.trustCreators===0)assert.ok(!target.queries.some(q=>q.sql.startsWith('CREATE')));
  }
});
test('only observed integer display-width deprecation is accepted and recorded',async context=>{
  mockKnownBodyHash(context);
  const reviewed={Level:'Warning',Code:1681,Message:'Integer display width is deprecated and will be removed in a future release.'};
  const run=options=>operator.runSchemaCompatibility({acknowledgement:'schema-only-no-patient-data',
    capture:captureFixture(),targetFactory:targetFixture(options).factory});
  const report=await run({warning:1,warningRows:[reviewed]});
  assert.equal(report.status,'schema_only_ddl_accepted');
  assert.equal(report.reviewedDeprecations.length,307);
  for(const row of [{...reviewed,Code:1265},{...reviewed,Message:'Unreviewed 1681 deprecation'},
    {...reviewed,Level:'Note'}]) {
    const rejected=await run({warning:1,warningRows:[row]});
    assert.equal(rejected.status,'failed_partial_schema_preserved');
    assert.equal(rejected.errorCode,'ddl_warning_requires_review');
  }
});
test('duplicate-index deprecation must name the exact synthetic table and is never a removal instruction',()=>{
  const statement={kind:'create_table',name:'ClinicAnalyticsProperties'};
  const warning={Level:'Warning',Code:1831,Message:"Duplicate index 'existing_idx' defined on the table 'cc_schema_compat_20261018.ClinicAnalyticsProperties'. This is deprecated and will be disallowed in a future release."};
  assert.deepEqual(operator.reviewedWarning(warning,statement),{kind:'create_table',name:statement.name,
    code:1831,category:'existing_duplicate_index_deprecated',index:'existing_idx'});
  for(const changed of [{...warning,Code:1832},{...warning,Level:'Error'},
    {...warning,Message:warning.Message.replace('cc_schema_compat_20261018','clinicaclick')},
    {...warning,Message:warning.Message.replace('ClinicAnalyticsProperties','OtherTable')}])
    assert.equal(operator.reviewedWarning(changed,statement),null);
});
test('only the observed SequelizeMeta legacy charset warnings are recorded without changing its charset',()=>{
  const statement={kind:'create_table',name:'SequelizeMeta'};
  for(const warning of [
    {Level:'Warning',Code:1287,Message:"'utf8mb3' is deprecated and will be removed in a future release. Please use utf8mb4 instead"},
    {Level:'Warning',Code:3778,Message:"'utf8mb3_unicode_ci' is a collation of the deprecated character set UTF8MB3. Please consider using UTF8MB4 with an appropriate collation instead."}]) {
    assert.equal(operator.reviewedWarning(warning,statement).category,'existing_migration_metadata_utf8mb3_deprecated');
    assert.equal(operator.reviewedWarning(warning,{...statement,name:'Messages'}),null);
    assert.equal(operator.reviewedWarning({...warning,Message:'Other deprecated charset'},statement),null);
    assert.equal(operator.reviewedWarning({...warning,Code:1681},statement),null);
  }
});
