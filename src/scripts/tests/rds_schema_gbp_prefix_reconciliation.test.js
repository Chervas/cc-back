'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
require('node:net').Socket.prototype.connect=()=>{throw Error('TEST_ONLY_network_forbidden');};
require('node:tls').connect=()=>{throw Error('TEST_ONLY_network_forbidden');};
const R=require('../../lib/rdsSchemaFirstCreateReconciliation'),P=require('../../lib/rdsSchemaMigrationPolicy'),C=require('../../lib/rdsSchemaMigration'),W=require('../../lib/rdsSchemaWarningPolicy');
const {digest}=require('../../lib/securitySchemaContract'),S=require('sequelize'),SOURCE=path.resolve(__dirname,'../../..'),clone=structuredClone;
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cc-gbp-prefix-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(root+'/migrations');fs.copyFileSync(SOURCE+'/migrations/'+R.GBP.migration,root+'/migrations/'+R.GBP.migration);
 const before={defaults:{DEFAULT_CHARACTER_SET_NAME:'utf8mb4',DEFAULT_COLLATION_NAME:'utf8mb4_0900_ai_ci'},tables:[{TABLE_NAME:R.GBP.table,ENGINE:'InnoDB',TABLE_COLLATION:'utf8mb4_0900_ai_ci'}],
 columns:[{TABLE_NAME:R.GBP.table,COLUMN_NAME:'external_location_id',COLUMN_TYPE:'varchar(30)',IS_NULLABLE:'NO',COLUMN_DEFAULT:null,EXTRA:'',CHARACTER_SET_NAME:'utf8mb4',COLLATION_NAME:'utf8mb4_0900_ai_ci',GENERATION_EXPRESSION:''}],indexes:[],checks:[],foreignKeys:[],migrations:[],triggers:[]};
 const identity={physicalDbId:'TEST_ONLY_OWNED',engineVersion:'8.4.11'},info={revision:R.GBP.sourceRevision,contractDigest:R.GBP.contractDigest,contract:{tables:{},migrations:[]},migrations:{[R.GBP.migration]:R.GBP.migrationSha256}};
 const plan=P.buildPlan({info,before,identity,selected:[R.GBP.migration],moduleFiles:P.migrationFiles(root,[R.GBP.migration]),profile:'TEST_ONLY',at:Date.now()});
 const observed=clone(before);observed.columns.push(...await R.gbpDefinition(root,plan));
 const result={operationNonce:R.GBP.originalOperationNonce,planRef:{sha256:R.GBP.originalPlanSha256},status:'rds_schema_failed_preserve_partial',reason:'rds_schema_statement_warnings_require_reconciliation',writesDispatched:2,automaticReplayAllowed:false,transportOpened:true,
 closure:{physicalCloseObserved:true,physicalStreamDestroyed:true},backup:{status:'available',physicalDbId:identity.physicalDbId,createdAt:new Date(plan.createdAtEpochMs).toISOString()}};
 const journal=[{event:'backup_request'},{event:'backup_create_ack'},{event:'backup_available'},
 {event:'statement_request',migration:R.GBP.migration,kind:'ddl',sqlSha256:R.GBP.statements[0]},
 {event:'statement_ack',migration:R.GBP.migration,kind:'ddl',sqlSha256:R.GBP.statements[0],warnings:0},
 {event:'statement_request',migration:R.GBP.migration,kind:'ddl',sqlSha256:R.GBP.statements[1]},
 {event:'statement_diagnostics',migration:R.GBP.migration,kind:'ddl',sqlSha256:R.GBP.statements[1],warningReadFailed:false,warningStatus:1,policy:W.NAME,diagnostics:[{level:'Warning',code:1287,messageSha256:R.GBP.diagnosticMessageSha256}]},
 {event:'terminal',accepted:false,writesDispatched:2}];
 return {source:root,originalPlan:plan,observed,identity,result,journal};
}
test('GBP reconciles exactly the original two additive columns and retained1287 diagnostic',async t=>{
 const f=await fixture(t),proof=await R.validate(f);assert.deepEqual(proof.statements.map(r=>r.sqlSha256),R.GBP.statements);assert.equal(proof.observedDigest,digest(f.observed));assert.equal(proof.originalDiagnostics.journalIndex,6);assert.equal(proof.continuationWarningPolicy.warningCount,7);
});
test('GBP refuses any partial prefix, changed run, metadata drift, diagnostics, ack or source',async t=>{
 const f=await fixture(t);const changes=[x=>x.observed.columns.pop(),x=>x.observed.columns[1].COLUMN_DEFAULT='staged',x=>x.observed.columns[2].COLLATION_NAME='utf8mb4_0900_ai_ci',x=>x.observed.columns.reverse(),x=>x.observed.columns[0].IS_NULLABLE='YES',x=>x.observed.indexes.push({INDEX_NAME:'unexpected'}),x=>x.observed.tables.push({TABLE_NAME:'BusinessProfileAssociationScopes'}),x=>x.observed.triggers.push({TRIGGER_NAME:'unexpected'}),x=>x.observed.migrations.push(R.GBP.migration),x=>x.originalPlan.sourceRevision='0'.repeat(40),x=>x.originalPlan.contractDigest='0'.repeat(64),x=>x.result.operationNonce='foreign',x=>x.result.planRef.sha256='0'.repeat(64),x=>x.result.writesDispatched=1,x=>x.result.backup.status='pending',x=>x.result.closure.physicalStreamDestroyed=false,x=>x.identity.engineVersion='8.4.12',x=>x.journal[4].warnings=1,x=>x.journal[5].sqlSha256=R.GBP.statements[0],x=>x.journal[6].diagnostics[0].messageSha256='0'.repeat(64),x=>x.journal[6].diagnostics[0].code=1681,x=>x.journal[6].warningReadFailed=true,x=>x.journal[6].warningStatus=2,x=>x.journal[6].policy='any',x=>x.journal.splice(4,1),x=>x.journal.splice(7,0,{event:'statement_request'}),x=>x.journal.at(-1).accepted=true];
 for(const change of changes){const x=clone(f);change(x);await assert.rejects(R.validate(x),/rds_schema_reconciliation_/);}
 fs.appendFileSync(f.source+'/migrations/'+R.GBP.migration,'\n//changed\n');await assert.rejects(R.validate(f),/source_changed/);
});
test('GBP continuation reconciles both ALTERs, dispatches only two CREATEs and two indexes; no synthetic ACK for old columns',async t=>{
 const f=await fixture(t),sent=[],events=[];const raw={query(options,values,cb){if(typeof values==='function')cb=values;const sql=typeof options==='string'?options:options.sql;sent.push(sql);queueMicrotask(()=>cb(null,sql==='SHOW WARNINGS'?[]:{affectedRows:0,warningStatus:0}));return new EventEmitter();}};raw.execute=raw.query;
 const continuation={pending:true,proof:await R.validate(f),resultRef:{path:'/TEST_ONLY/result.json',sha256:'a'.repeat(64)}};
 const bridge=C.migrationInterface({admin:{raw,identity:{engineVersion:'8.4.11'}},aws:{assertFresh(){}},journal:e=>events.push(e),migrationName:R.GBP.migration,continuation});
 try{await require(f.source+'/migrations/'+R.GBP.migration).up(bridge.queryInterface,S);}finally{await bridge.restore();}
 assert.equal(continuation.pending,false);assert.equal(continuation.cursor,2);assert.equal(sent.filter(s=>s!=='SHOW WARNINGS').length,4);assert(!sent.some(sql=>R.GBP.statements.includes(P.sha(sql))));assert.equal(events.filter(e=>e.event==='statement_reconciled').length,2);assert.equal(events.filter(e=>e.event==='statement_ack').length,4);
 assert(!events.some(e=>e.event==='statement_ack'&&R.GBP.statements.includes(e.sqlSha256)));
});
test('original GBP operator upgrade permits only three recovery files; contract/runtime/other source pins retain strict equality',async t=>{
 const f=await fixture(t),plan=f.originalPlan;plan.operatorFiles=[...Object.entries(R.GBP_OPERATOR_UPGRADE).map(([path,sha256])=>({path,sha256})),{path:'unchanged.js',sha256:'c'.repeat(64)}].sort((a,b)=>a.path.localeCompare(b.path));
 const req=P.effectiveRequirements({contract:{tables:{},migrations:[]}},[R.GBP.migration]);const info={effectiveContract:req.contract,effectiveContractScope:req.scope,effectiveContractDigest:req.digest,operatorFiles:plan.operatorFiles.map(r=>({...r,sha256:Object.hasOwn(R.GBP_OPERATOR_UPGRADE,r.path)?'d'.repeat(64):r.sha256}))};
 assert.doesNotThrow(()=>R.assertOriginalRequirements(plan,info,[R.GBP.migration],R.GBP.originalPlanSha256));
 for(const mutate of[x=>x.operatorFiles.at(-1).sha256='0'.repeat(64),x=>x.operatorFiles.push({path:'new.js',sha256:'a'.repeat(64)}),x=>x.effectiveContractDigest='0'.repeat(64)]){const x=clone(info);mutate(x);assert.throws(()=>R.assertOriginalRequirements(plan,x,[R.GBP.migration],R.GBP.originalPlanSha256),/rds_schema_/);}
 assert.throws(()=>R.assertOriginalRequirements(plan,info,[R.GBP.migration],'0'.repeat(64)),/original_run_changed/);plan.operatorFiles[0].sha256='0'.repeat(64);assert.throws(()=>R.assertOriginalRequirements(plan,info,[R.GBP.migration],R.GBP.originalPlanSha256),/operator_source_changed/);
});
