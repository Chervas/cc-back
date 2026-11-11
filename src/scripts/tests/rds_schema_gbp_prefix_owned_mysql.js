'use strict';
// An explicitly supplied owned /tmp Unix socket only. No runtime credentials,
// application models, AWS or TCP. The caller owns server lifecycle and datadir.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const mysql=require('mysql2'),S=require('sequelize'),R=require('../../lib/rdsSchemaFirstCreateReconciliation'),P=require('../../lib/rdsSchemaMigrationPolicy'),C=require('../../lib/rdsSchemaMigration'),W=require('../../lib/rdsSchemaWarningPolicy');
const {digest}=require('../../lib/securitySchemaContract'),T=require('../../lib/rdsSchemaMigrationTransport');
async function run(socketPath){
 assert.match(socketPath||'',/^\/tmp\/cc-gbp-prefix-native-[a-f0-9]+\/mysql\.sock$/);assert(fs.lstatSync(socketPath).isSocket());
 const nativeConnect=require('node:net').Socket.prototype.connect;require('node:net').Socket.prototype.connect=function(...args){const opt=Array.isArray(args[0])?args[0][0]:args[0];const p=typeof opt==='string'?opt:opt?.path;assert.equal(p,socketPath,'only the owned Unix socket is allowed');return nativeConnect.apply(this,args);};
 const raw=mysql.createConnection({socketPath,user:'root',multipleStatements:false}),db=raw.promise();let output;
 try{
  await db.connect();const [[v]]=await db.query('SELECT VERSION() version,@@skip_networking isolated');assert.equal(v.version,'8.4.11');assert.equal(Number(v.isolated),1);
  await db.query('CREATE DATABASE cc_gbp_prefix_owned CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');await db.query('USE cc_gbp_prefix_owned');await db.query('SET SESSION sql_mode=?',[T.SQL_MODES.join(',')]);
  await db.query('CREATE TABLE BusinessProfileBrokerBindings (external_location_id VARCHAR(30) NOT NULL, connection_ref VARCHAR(128) NOT NULL, asset_ref VARCHAR(128) NOT NULL, clinica_id INTEGER NOT NULL, google_connection_id INTEGER NOT NULL) ENGINE=InnoDB');
  await db.query('CREATE TABLE SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
  const admin={raw,identity:{engineVersion:'8.4.11',physicalDbId:'TEST_ONLY_OWNED',database:'cc_gbp_prefix_owned'},query:async(sql,values=[])=>{const [rows]=await db.query(sql,values);return rows;}};
  const before=await C.schemaSnapshot(admin),source=path.resolve(__dirname,'../../..'),info={revision:R.GBP.sourceRevision,contractDigest:R.GBP.contractDigest,contract:{tables:{},migrations:[]},migrations:{[R.GBP.migration]:R.GBP.migrationSha256}};
  const plan=P.buildPlan({info,before,identity:admin.identity,selected:[R.GBP.migration],moduleFiles:P.migrationFiles(source,[R.GBP.migration]),profile:'TEST_ONLY',at:Date.now()});
  const prefix=[];const seq=new S({dialect:'mysql',logging:false});seq.query=async sql=>{prefix.push(sql);return [];};const stop=Error('TEST_ONLY_prefix_captured');const q=seq.getQueryInterface();q.createTable=async()=>{throw stop;};try{await require(source+'/migrations/'+R.GBP.migration).up(q,S);}catch(e){assert.equal(e,stop);}
  assert.deepEqual(prefix.map(P.sha),R.GBP.statements);const journal=[{event:'backup_request'},{event:'backup_create_ack'},{event:'backup_available'}];let originalWarnings;
  for(let i=0;i<2;i++){journal.push({event:'statement_request',migration:R.GBP.migration,kind:'ddl',sqlSha256:P.sha(prefix[i])});const [result]=await db.query(prefix[i]),[warnings]=await db.query('SHOW WARNINGS');if(i===0){assert.equal(warnings.length,0);journal.push({event:'statement_ack',migration:R.GBP.migration,kind:'ddl',sqlSha256:P.sha(prefix[i]),warnings:0});}else{assert.equal(result.warningStatus,1);assert.equal(warnings.length,1);assert.equal(Number(warnings[0].Code),1287);assert.equal(P.sha(warnings[0].Message),R.GBP.diagnosticMessageSha256);originalWarnings=warnings;journal.push({event:'statement_diagnostics',migration:R.GBP.migration,kind:'ddl',sqlSha256:P.sha(prefix[i]),warningReadFailed:false,warningStatus:1,diagnostics:W.diagnostics(warnings),policy:W.NAME});}}
  journal.push({event:'terminal',accepted:false,writesDispatched:2});
  const result={status:'rds_schema_failed_preserve_partial',reason:'rds_schema_statement_warnings_require_reconciliation',writesDispatched:2,automaticReplayAllowed:false,transportOpened:true,operationNonce:R.GBP.originalOperationNonce,planRef:{sha256:R.GBP.originalPlanSha256},closure:{physicalCloseObserved:true,physicalStreamDestroyed:true},backup:{status:'available',physicalDbId:admin.identity.physicalDbId,createdAt:new Date(plan.createdAtEpochMs).toISOString()}};
  const proof=await R.validate({source,originalPlan:plan,observed:await C.schemaSnapshot(admin),identity:admin.identity,result,journal});
  const sent=[],events=[],native=raw.query;raw.query=function(...args){const sql=typeof args[0]==='string'?args[0]:args[0].sql;if(sql!=='SHOW WARNINGS')sent.push(sql);return native.apply(raw,args);};
  const continuation={pending:true,proof,resultRef:{path:'/TEST_ONLY/result.json',sha256:'a'.repeat(64)}};
  const bridge=C.migrationInterface({admin,aws:{assertFresh(){}},journal:e=>events.push(e),migrationName:R.GBP.migration,continuation});
  try{await require(source+'/migrations/'+R.GBP.migration).up(bridge.queryInterface,S);}finally{await bridge.restore();}
  assert.equal(continuation.pending,false);assert.equal(continuation.cursor,2);assert.equal(sent.length,4);assert(!sent.some(sql=>R.GBP.statements.includes(P.sha(sql))));
  assert.equal(events.filter(e=>e.event==='statement_reconciled').length,2);assert.equal(events.filter(e=>e.event==='statement_request').length,4);assert.equal(events.filter(e=>e.event==='statement_ack').length,4);
  const typed=events.filter(e=>e.event==='statement_diagnostics');assert.equal(typed.length,1);assert.equal(typed[0].warningStatus,7);assert.equal(typed[0].policy,W.GBP_NAME);assert(typed[0].diagnostics.every(r=>r.level==='Warning'&&r.code===1287&&r.messageSha256===R.GBP.diagnosticMessageSha256));
  const create=sent.find(sql=>P.sha(sql)===R.GBP.requestCreateSha256),good={sql:create,kind:'ddl',engineVersion:'8.4.11',rows:Array.from({length:7},()=>originalWarnings[0]),warningStatus:7,migrationName:R.GBP.migration,continuationProof:proof};
  assert.equal(W.accepted(good),true);for(const change of[{sql:create+' '},{kind:'metadata'},{engineVersion:'8.4.12'},{rows:good.rows.slice(1)},{warningStatus:6},{migrationName:'other'},{continuationProof:null},{rows:[...good.rows.slice(1),{...originalWarnings[0],Code:1681}]},{rows:[...good.rows.slice(1),{...originalWarnings[0],Message:'other'}]}])assert.equal(W.accepted({...good,...change}),false);
  const after=await C.schemaSnapshot(admin);assert.equal(after.tables.length-before.tables.length,2);assert.equal(after.columns.length-before.columns.length,44);assert.equal(after.indexes.filter(r=>r.TABLE_NAME==='BusinessProfileAssociationRequests').length,10);
  await db.query('INSERT INTO SequelizeMeta(name) VALUES (?)',[R.GBP.migration]);
  output={success:true,engine:v.version,originalWarning:originalWarnings[0],nativeContinuationWarningCount:typed[0].warningStatus,requests:4,acks:4,reconciledStatements:2,oldColumnReplays:0,checks:['exact-native-warning1287','full-metadata-prefix','both-old-alters-skipped','seven-uuid-warnings-typed-and-pinned','normal-four-ddl-acks','warning-mutation-refusals','metadata-only-sequelize-tracking'],businessRows:'none'};
 }finally{try{await db.query('DROP DATABASE cc_gbp_prefix_owned');}finally{await db.end();}require('node:net').Socket.prototype.connect=nativeConnect;}
 return output;
}
module.exports={run};if(require.main===module)run(process.argv[2]).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.stack);process.exitCode=1;});
