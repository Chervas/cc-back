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
function zeroFixture(f,proof){
 const plan={...clone(f.originalPlan),sourceRevision:R.ZERO.sourceRevision,before:clone(f.observed),beforeDigest:digest(f.observed),continuation:{schema:'clinicaclick-rds-first-create-continuation/1',priorOperationNonce:R.GBP.originalOperationNonce,priorPlanRef:{sha256:R.GBP.originalPlanSha256},proof}};
 const backup={snapshotId:'TEST_ONLY_ZERO_SNAPSHOT',status:'available',physicalDbId:f.identity.physicalDbId,createdAt:new Date(plan.createdAtEpochMs).toISOString()};
 const result={...clone(f.result),operationNonce:R.ZERO.operationNonce,planRef:{sha256:R.ZERO.planSha256},reason:'rds_schema_aws_operation_failed',writesDispatched:0,continuation:clone(plan.continuation),backup};
 const journal=[{event:'backup_request',snapshotId:backup.snapshotId},{event:'backup_create_ack',snapshotId:backup.snapshotId},{event:'backup_available',...backup},{event:'terminal',status:result.status,accepted:false,writesDispatched:0}];
 return {originalPlan:plan,result,journal,observed:f.observed,identity:f.identity,planSha256:R.ZERO.planSha256};
}
test('exact zero-write successor retains original prefixproof, requires closedtransport and refuses any dispatched statement or metadata change',async t=>{
 const f=await fixture(t),x=zeroFixture(f,await R.validate(f));assert.equal(R.validateZeroWrite(x),true);
 for(const mutate of[y=>y.result.writesDispatched=1,y=>y.result.reason='rds_schema_statement_outcome_requires_reconciliation',y=>y.result.closure.physicalCloseObserved=false,y=>y.result.operationNonce='foreign',y=>y.planSha256='0'.repeat(64),y=>y.originalPlan.sourceRevision='0'.repeat(40),y=>y.result.backup.status='pending',y=>y.journal.push({event:'statement_request'}),y=>y.journal[2].status='creating',y=>y.journal.at(-1).writesDispatched=1,y=>y.observed.columns.pop(),y=>y.result.continuation.proof.statements.pop()]){const z=clone(x);mutate(z);assert.throws(()=>R.validateZeroWrite(z),/rds_schema_reconciliation_/);}
});
test('zero-write source-pin upgrade excludes warning policy and unrelated operator changes',async t=>{
 const f=await fixture(t),x=zeroFixture(f,await R.validate(f)),plan=x.originalPlan;
 plan.operatorFiles=[...Object.entries(R.ZERO_OPERATOR_UPGRADE).map(([path,sha256])=>({path,sha256})),{path:'src/lib/rdsSchemaWarningPolicy.js',sha256:'088df783f1ffd1951d9b3b1f7722bb0340328aa3de5477cc8ca1b3e0963d2baf'}].sort((a,b)=>a.path.localeCompare(b.path));
 const req=P.effectiveRequirements({contract:{tables:{},migrations:[]}},[R.GBP.migration]);const info={effectiveContract:req.contract,effectiveContractScope:req.scope,effectiveContractDigest:req.digest,operatorFiles:plan.operatorFiles.map(r=>({...r,sha256:Object.hasOwn(R.ZERO_OPERATOR_UPGRADE,r.path)?'d'.repeat(64):r.sha256}))};
 assert.doesNotThrow(()=>R.assertOriginalRequirements(plan,info,[R.GBP.migration],R.ZERO.planSha256));info.operatorFiles.find(r=>r.path==='src/lib/rdsSchemaWarningPolicy.js').sha256='0'.repeat(64);assert.throws(()=>R.assertOriginalRequirements(plan,info,[R.GBP.migration],R.ZERO.planSha256),/operator_source_changed/);
});
test('AWS diagnostics contain only operation category and sanitized process outcome, never command arguments or captured secret output',async()=>{
 const T=require('../../lib/rdsSchemaMigrationTransport');const out={operation:'secretsmanager.get-secret-value',code:143,signal:'SIGTERM',killed:true,password:'TEST_ONLY_SECRET',stdout:'TEST_ONLY_SECRET',stderr:'TEST_ONLY_SECRET',args:['--secret-id','TEST_ONLY_SECRET']};assert.deepEqual(T.safeAwsDiagnostic(out),{operation:'secretsmanager.get-secret-value',code:143,signal:'SIGTERM',killed:true});assert.equal(T.safeAwsDiagnostic({...out,operation:'TEST_ONLY_SECRET'}),null);
 let caught;try{await T.createAws({execute:async()=>{throw Object.assign(Error('TEST_ONLY_SECRET'),out);}}).ensureFresh();}catch(e){caught=e;}assert.equal(caught.message,'rds_schema_aws_operation_failed');assert.equal(caught.awsDiagnostic.operation,'configure.export-credentials');assert(!JSON.stringify(caught).includes('TEST_ONLY_SECRET'));assert.deepEqual(Object.keys(caught),['awsDiagnostic']);
});
