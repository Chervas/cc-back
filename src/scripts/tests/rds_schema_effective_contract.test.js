'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
// No real AWS, subprocess, network, session/environment or shared SQL access.
const child=require('node:child_process');for(const name of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'])child[name]=()=>{throw Error('TEST_ONLY_children_forbidden');};
require('node:net').Socket.prototype.connect=()=>{throw Error('TEST_ONLY_network_forbidden');};require('node:tls').connect=()=>{throw Error('TEST_ONLY_tls_forbidden');};
const readFile=fs.readFileSync;fs.readFileSync=function(file,...args){if(typeof file==='string'&&(/\/\.env(?:\.|$)|\/proc\/|\/\.aws\//.test(file)))throw Error('TEST_ONLY_private_environment_read_forbidden');return readFile.call(fs,file,...args);};
const N=require('../../lib/securitySchemaContract'),P=require('../../lib/rdsSchemaMigrationPolicy'),C=require('../../lib/rdsSchemaMigration'),T=require('../../lib/rdsSchemaMigrationTransport'),CLI=require('../security-rds-schema-migrate');
const META='20261104123000-create-meta-marketing-recoveries.js',GOAL='20261030090000-create-google-ads-goal-policy-journals.js',OLD='20200101000000-unselected-history.js';
const TABLES={ [META]:'MetaMarketingRecoveries',[GOAL]:'GoogleAdsGoalPolicyJournals' };
const clone=structuredClone;
function fixture(t,{metaAlreadyApplied=false,defaultFullContract=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cc-rds-effective-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=root+'/source';fs.mkdirSync(source);fs.mkdirSync(source+'/migrations');
  for(const [name,table]of Object.entries(TABLES))fs.writeFileSync(source+'/migrations/'+name,`module.exports={async up(q,S){await q.createTable('${table}',{id:{type:S.INTEGER,primaryKey:true,allowNull:false}},{charset:'utf8mb4',collate:'utf8mb4_bin'});}};\n`);
  fs.writeFileSync(source+'/migrations/'+OLD,"module.exports={up(){throw Error('TEST_ONLY_UNSELECTED_HISTORY_MUST_NOT_RUN')}};\n");
  const state={tables:[{TABLE_NAME:'SequelizeMeta',ENGINE:'InnoDB',TABLE_COLLATION:'utf8mb4_unicode_ci'},{TABLE_NAME:'ExistingRequired',ENGINE:'InnoDB',TABLE_COLLATION:'utf8mb4_0900_ai_ci'}],columns:[],indexes:[],foreignKeys:[],migrations:[],dispatch:[],events:[],closed:0,backupCount:0,connectCount:0,
    defaults:{DEFAULT_CHARACTER_SET_NAME:'utf8mb4',DEFAULT_COLLATION_NAME:'utf8mb4_0900_ai_ci'},
    env:{DB_HOST:T.HOST,DB_NAME:T.DATABASE,DB_PORT:'3306',DB_TLS_REQUIRED:'true',META_MARKETING_LEGACY_RECOVERY_ENABLED:'false',GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED:'false',DB_PASSWORD:'FICTITIOUS_PASSWORD_NEVER_IN_PLAN'},
    revision:'b'.repeat(40),operatorHash:'c'.repeat(64),onBackup:null,onConnect:null,skipCreate:null};
  const column={COLUMN_NAME:'id',COLUMN_TYPE:'int',IS_NULLABLE:'NO',COLUMN_DEFAULT:null,EXTRA:'',CHARACTER_SET_NAME:null,COLLATION_NAME:null,GENERATION_EXPRESSION:''};
  const index={INDEX_NAME:'PRIMARY',NON_UNIQUE:0,SEQ_IN_INDEX:1,COLUMN_NAME:'id',SUB_PART:null,INDEX_TYPE:'BTREE'};
  const contract={version:1,defaults:clone(state.defaults),featureGroups:{meta_marketing_recovery:{enabledWhenAny:{DB_TLS_REQUIRED:'true',META_MARKETING_LEGACY_RECOVERY_ENABLED:'true'},tables:[TABLES[META]],migrations:[META]},
    google_ads_goal_policy_writes:{enabledWhenAll:{GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED:'true'},tables:[TABLES[GOAL]],migrations:[GOAL]}},
    tables:{ExistingRequired:{ENGINE:'InnoDB',TABLE_COLLATION:'utf8mb4_0900_ai_ci',columns:[],indexes:[]},
      [TABLES[META]]:{ENGINE:'InnoDB',TABLE_COLLATION:'utf8mb4_bin',columns:[clone(column)],indexes:[{name:'PRIMARY',columns:[clone(index)]}],foreignKeys:[]},
      [TABLES[GOAL]]:{ENGINE:'InnoDB',TABLE_COLLATION:'utf8mb4_bin',columns:[clone(column)],indexes:[{name:'PRIMARY',columns:[clone(index)]}],foreignKeys:[]}},
    migrations:[META,GOAL].map(name=>({name,sha256:P.sha(fs.readFileSync(source+'/migrations/'+name))}))};
  const addTable=table=>{state.tables.push({TABLE_NAME:table,ENGINE:'InnoDB',TABLE_COLLATION:'utf8mb4_bin'});state.columns.push({TABLE_NAME:table,...clone(column)});state.indexes.push({TABLE_NAME:table,...clone(index)});};
  if(metaAlreadyApplied){addTable(TABLES[META]);state.migrations.push(META);}
  const info=()=>({revision:state.revision,contractDigest:N.digest(contract),contract:clone(contract),migrations:Object.fromEntries([META,GOAL,OLD].map(name=>[name,P.sha(fs.readFileSync(source+'/migrations/'+name))]))});
  const identity={host:T.HOST,database:T.DATABASE,port:3306,serverUuid:'TEST_ONLY_UUID',engineVersion:'8.4.11',physicalDbId:'db-TEST_ONLY',secretVersionId:'TEST_ONLY',caSha256:T.CA_SHA,strictTls:true,hostnameVerified:true};
  function respond(sql,values=[]){
    state.dispatch.push(sql);
    if(sql==='SHOW WARNINGS')return [];
    if(/information_schema.SCHEMATA/.test(sql))return [clone(state.defaults)];
    if(/FROM information_schema.TABLES/.test(sql))return clone(state.tables).sort((a,b)=>a.TABLE_NAME.localeCompare(b.TABLE_NAME));
    if(/FROM information_schema.COLUMNS/.test(sql))return clone(state.columns);
    if(/FROM information_schema.STATISTICS/.test(sql))return clone(state.indexes);
    if(/REFERENTIAL_CONSTRAINTS/.test(sql))return clone(state.foreignKeys);
    if(/information_schema\./.test(sql))return [];
    if(/SELECT name FROM SequelizeMeta/.test(sql))return state.migrations.slice().sort().map(name=>({name}));
    if(/GET_LOCK/.test(sql))return [{acquired:1}];
    if(/^SET SESSION/.test(sql)){state.onSet?.();return {affectedRows:0,warningStatus:0};}
    if(/^INSERT INTO SequelizeMeta/.test(sql)){state.migrations.push(values[0]);return {affectedRows:1,warningStatus:0};}
    if(/^CREATE TABLE/.test(sql)){const table=Object.values(TABLES).find(name=>sql.includes('`'+name+'`'));assert(table,'Only the two selected test table names are accepted');if(state.skipCreate!==table)addTable(table);return {affectedRows:0,warningStatus:0};}
    throw Error('TEST_ONLY_unexpected_SQL');
  }
  const raw={config:{},query(options,values,callback){if(typeof values==='function'){callback=values;values=[];}const sql=typeof options==='string'?options:options.sql;queueMicrotask(()=>{try{callback(null,respond(sql,values));}catch(e){callback(e);}});return new EventEmitter();}};raw.execute=raw.query;
  const aws={assertFresh(){},inspect:async()=>{state.events.push('inspect');return {};},secret:async()=>({password:'FICTITIOUS_ONLY'}),backup:async({journal})=>{state.backupCount++;journal({event:'backup_request'});journal({event:'backup_create_ack'});await state.onBackup?.();return {status:'available',physicalDbId:identity.physicalDbId,createdAt:new Date().toISOString()};}};
  const connect=async()=>{state.connectCount++;await state.onConnect?.();return {raw,identity:clone(identity),query:async(sql,values)=>respond(sql,values),close:async()=>{state.closed++;return {physicalCloseObserved:true,physicalStreamDestroyed:true};}};};
  const runner=C.createRunner({sourceInfo:info,awsFactory:()=>aws,connect,storeFactory:()=>C.createStore(root+'/ledger',process.getuid()),operatorUid:()=>0,fileOwner:process.getuid(),
    ...(defaultFullContract?{}:{resolveEffectiveContract:(value,selected)=>CLI.runtimeRequirements(value,selected,()=>({env:state.env}))}),operatorPins:()=>[{path:'src/scripts/security-email-login-metadata.js',sha256:state.operatorHash}]});
  const plan=async(selected=[META])=>runner.plan({source,selected,out:root+'/plan-'+Math.random().toString(16).slice(2)+'/plan.json'});
  const apply=p=>runner.apply({source,planFile:p.planRef.path,approvePlan:p.planRef.sha256});
  const writes=()=>state.dispatch.filter(sql=>/^CREATE|^ALTER|^INSERT/.test(sql));
  return {root,source,state,contract,runner,info,addTable,plan,apply,writes};
}
test('normal runtime plan/apply/verify requires Meta only with Goal Policy off, without unselected or Goal DDL',async t=>{
  const f=fixture(t),p=await f.plan();const body=C.readPrivate(p.planRef.path,process.getuid()).value;
  assert.equal(body.schema,P.PLAN_SCHEMA);assert.match(body.effectiveContractDigest,/^[a-f0-9]{64}$/);assert.deepEqual(body.effectiveContractScope.selectedMigrations,[META]);
  assert(body.compatibilityBefore.issues.some(i=>i.table===TABLES[META]));assert(!body.compatibilityBefore.issues.some(i=>i.table===TABLES[GOAL]));assert.deepEqual(body.compatibilityBefore.missingMigrations,[META]);
  assert(!JSON.stringify(body).includes('FICTITIOUS_PASSWORD_NEVER_IN_PLAN'));
  const applied=await f.apply(p);assert.equal(applied.compatible,true);assert.deepEqual(applied.completed,[META]);assert.deepEqual(f.state.migrations,[META]);
  assert(!f.writes().some(sql=>sql.includes(TABLES[GOAL])||sql.includes('unselected-history')));
  const verified=await f.runner.verify({source:f.source,runDirectory:path.dirname(applied.resultRef.path)});assert.equal(verified.compatible,true);assert.equal(f.state.closed,3);
});
test('explicit Goal selection forces its whole group while flag is off and its table is required after DDL',async t=>{
  const f=fixture(t,{metaAlreadyApplied:true}),p=await f.plan([GOAL]);const plan=C.readPrivate(p.planRef.path,process.getuid()).value;
  assert(plan.effectiveContractScope.selectedFeatureGroups.includes('google_ads_goal_policy_writes'));assert(plan.compatibilityBefore.issues.some(i=>i.table===TABLES[GOAL]));
  assert.equal((await f.apply(p)).compatible,true);assert.equal(f.state.env.GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED,'false');
  const denied=fixture(t,{metaAlreadyApplied:true}),q=await denied.plan([GOAL]);denied.state.skipCreate=TABLES[GOAL];await assert.rejects(denied.apply(q),/postcheck_incompatible/);
});
test('runtime feature toggle before apply refuses before backup or any write',async t=>{
  const f=fixture(t),p=await f.plan();f.state.env.GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED='true';
  await assert.rejects(f.apply(p),/effective_requirements_changed/);assert.equal(f.state.backupCount,0);assert.deepEqual(f.writes(),[]);
});
test('runtime feature toggle during snapshot waiting is fenced before opening the DDL session',async t=>{
  const f=fixture(t),p=await f.plan();f.state.onBackup=()=>{f.state.env.GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED='true';};
  await assert.rejects(f.apply(p),/effective_requirements_changed/);assert.equal(f.state.backupCount,1);assert.equal(f.state.connectCount,1);assert.deepEqual(f.writes(),[]);
});
test('runtime change during plan creation returns no reviewable plan and closes the read session',async t=>{
  const f=fixture(t);f.state.onConnect=()=>{f.state.env.GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED='true';};
  await assert.rejects(f.plan(),/effective_requirements_changed/);assert.equal(f.state.closed,1);assert.deepEqual(f.writes(),[]);
});
test('a final runtime toggle after connection setup is refused at the real Sequelize DDL dispatch gate',async t=>{
  const f=fixture(t),p=await f.plan();f.state.onSet=()=>{f.state.env.GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED='true';};
  await assert.rejects(f.apply(p),/effective_requirements_changed/);assert.equal(f.state.backupCount,1);assert.equal(f.state.connectCount,2);assert.deepEqual(f.writes(),[]);assert.equal(f.state.closed,2);
});
test('even a selected forced group cannot hide its runtime flag changing during backup',async t=>{
  const f=fixture(t,{metaAlreadyApplied:true}),p=await f.plan([GOAL]);f.state.onBackup=()=>{f.state.env.GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED='true';};
  await assert.rejects(f.apply(p),/effective_requirements_changed/);assert.deepEqual(f.writes(),[]);
});
test('verify reobserves the runtime requirement fence before opening another SQL session',async t=>{
  const f=fixture(t),p=await f.plan(),a=await f.apply(p),before=f.state.connectCount;f.state.env.GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED='true';
  await assert.rejects(f.runner.verify({source:f.source,runDirectory:path.dirname(a.resultRef.path)}),/effective_requirements_changed/);assert.equal(f.state.connectCount,before);
});
test('source revision and metadata-observer operator pins are rechecked across backup',async t=>{
  for(const change of [f=>{f.state.revision='d'.repeat(40);},f=>{f.state.operatorHash='e'.repeat(64);}]){
    const f=fixture(t),p=await f.plan();f.state.onBackup=()=>change(f);await assert.rejects(f.apply(p),/plan_stale|operator_source_changed/);assert.deepEqual(f.writes(),[]);
  }
});
test('old version plans are refused clearly and never rewritten or interpreted as version two',async t=>{
  const f=fixture(t),p=await f.plan(),body=C.readPrivate(p.planRef.path,process.getuid()).value;
  const old={...body,schema:'clinicaclick-rds-selective-schema-plan/1'};delete old.effectiveContractDigest;delete old.effectiveContractScope;delete old.operatorFiles;
  const dir=f.root+'/old-fixture';fs.mkdirSync(dir,{mode:0o700});const ref=C.writePrivate(dir+'/plan.json',old);
  await assert.rejects(f.runner.apply({source:f.source,planFile:ref.path,approvePlan:ref.sha256}),/plan_version_unsupported/);
  assert.equal(P.sha(fs.readFileSync(ref.path)),ref.sha256);assert.equal(f.state.backupCount,0);assert.deepEqual(f.writes(),[]);
});
test('runtime filtering preserves database defaults and every unconditional requirement; default runner remains full-contract strict',async t=>{
  const f=fixture(t),requirements=P.effectiveRequirements(f.info(),[META],f.state.env,'staging');assert.deepEqual(requirements.contract.defaults,f.contract.defaults);assert(requirements.contract.tables.ExistingRequired);
  const wrong={defaults:{...f.state.defaults,DEFAULT_COLLATION_NAME:'latin1_swedish_ci'},tables:[],columns:[],indexes:[],checks:[],foreignKeys:[],migrations:[]};assert(N.compare(wrong,requirements.contract).issues.some(i=>i.reason==='database_default'));
  const p=await f.plan();f.state.tables=f.state.tables.filter(row=>row.TABLE_NAME!=='ExistingRequired');await assert.rejects(f.apply(p),/plan_stale/);
  const strict=fixture(t,{defaultFullContract:true}),s=await strict.plan();assert(s.compatibilityBefore.issues.some(i=>i.table===TABLES[GOAL]));
});
test('normal CLI pins observer dependencies as public code only and binds the observed primary runtime',()=>{
  const source=path.resolve(__dirname,'../../..'),pins=CLI.operatorPins(source);assert(pins.some(row=>row.path==='src/scripts/security-email-login-metadata.js'));assert(pins.some(row=>row.path==='src/scripts/security-database-metadata.js'));
  assert(pins.every(row=>!row.path.includes('.env')&&/^[a-f0-9]{64}$/.test(row.sha256)));
  assert.throws(()=>CLI.runtimeRequirements({contract:{tables:{},migrations:[]}},[],()=>({env:{DB_TLS_REQUIRED:'false',DB_HOST:'localhost'}})),/runtime_configuration/);
});
