'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const gateway=path.resolve(__dirname,'../../..'),req=createRequire(gateway+'/package.json'),schema=req('./src/lib/securitySchemaContract');
const code=fs.readFileSync(path.join(gateway,'src/scripts/security-schema-release.js'),'utf8').replace(/^#![^\n]*\n/,'');
const names=['20261107203000-create-meta-marketing-credential-renewals.js','20261107223000-create-meta-marketing-business-continuity.js'];
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'cc-schema-required-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'ops/security'),{recursive:true});fs.mkdirSync(path.join(dir,'migrations'));
  fs.writeFileSync(path.join(dir,'release.json'),JSON.stringify({commit:'e'.repeat(40)}));
  const bytes=names.map((name,index)=>Buffer.from('// OFFLINE migration pin '+index+'; never executed\n'));
  names.forEach((name,index)=>fs.writeFileSync(path.join(dir,'migrations',name),bytes[index]));
  const contract={version:1,defaults:{},tables:{},migrations:names.map((name,index)=>({name,sha256:digest(bytes[index])}))};
  fs.writeFileSync(path.join(dir,'ops/security/schema-contract.json'),JSON.stringify(contract));
  const calls=[],state={connected:0,closed:0,committed:0,readback:names.slice()},connection={
    async query({sql,values}){calls.push({sql,values});assert(sql==='SET TRANSACTION READ ONLY'||sql.startsWith('SELECT name FROM SequelizeMeta WHERE name IN ('),'Only expected readonly statements are allowed');return [sql.startsWith('SELECT')?state.readback.map(name=>({name})):[]];},
    async beginTransaction(){},async commit(){state.committed++;},async end(){throw Error('Public checked transport must use physical close');}};
  const publicDatabase={readBinding:()=>({runtime:'gateway'}),validateBinding:()=>{},connectCheck:async()=>{state.connected++;return {connection,proof:{mode:'OFFLINE_DOUBLE'}};},close:value=>{assert.equal(value,connection);state.closed++;}};
  const mod={exports:{}},localRequire=name=>{
    if(name==='node:child_process')return {execFileSync:()=>{throw Error('NO_PROCESS_OR_GIT_ALLOWED');}};
    if(name==='../lib/securitySchemaContract')return {...schema,snapshot:async()=>({defaults:{},tables:[],columns:[],indexes:[],checks:[],foreignKeys:[],migrations:names.slice()})};
    if(name==='./security-email-login-metadata')return {observedEnvironment:()=>({env:{},process:{pid:1}})};
    if(name==='./security-database-metadata')return {configuration:()=>{throw Error('NO_LOCAL_DATABASE_ALLOWED');}};
    if(name==='../lib/schemaReleaseDatabase')return publicDatabase;
    if(name==='../lib/delegatedSchemaPreflight')return req('./src/lib/delegatedSchemaPreflight');
    return req(name);
  };
  new Function('require','module','exports','__dirname','process',code)(localRequire,mod,mod.exports,path.join(gateway,'src/scripts'),{getuid:()=>0});
  const args=(required=names)=>['check','--source',dir,'--runtime','gateway','--out',path.join(dir,'report.json'),'--binding',path.join(dir,'fictitious-binding.json'),'--binding-sha','b'.repeat(64),...required.flatMap(name=>['--require-migration',name])];
  return {dir,bytes,state,calls,api:mod.exports,args};
}
test('actual parser accepts the exact two normal-wrapper required migration names',t=>{
  const f=fixture(t);assert.deepEqual(f.api.parse(f.args()).required,names);assert.equal(f.state.connected,0);
});
test('duplicate, malformed and non-check required migrations reject before any database acquisition',t=>{
  const f=fixture(t);for(const list of [[names[0],names[0]],['not-a-migration'],Array.from({length:21},(_,index)=>'20261108'+String(index).padStart(6,'0')+'-extra.js')])assert.throws(()=>f.api.parse(f.args(list)),/schema_arguments_invalid/);
  const args=f.args();args[0]='plan-dev';assert.throws(()=>f.api.parse(args),/schema_arguments_invalid/);assert.equal(f.state.connected,0);
});
test('an unknown valid name cannot become an inferred contract requirement',async t=>{
  const f=fixture(t);await assert.rejects(f.api.run(f.args(['20261108000000-unreviewed.js'])),/schema_required_migration_invalid/);assert.equal(f.state.connected,0);
});
test('altering an actual required migration file fails its existing source hash guard before connection',async t=>{
  const f=fixture(t);fs.appendFileSync(path.join(f.dir,'migrations',names[1]),'// altered\n');await assert.rejects(f.api.run(f.args()),/schema_required_migration_changed/);assert.equal(f.state.connected,0);
});
test('actual check performs explicit two-name readonly readback and returns both names with physical closure',async t=>{
  const f=fixture(t),report=await f.api.run(f.args());assert.equal(report.compatible,true);assert.deepEqual(report.requiredMigrations,names);assert.deepEqual(report.missingRequiredMigrations,[]);
  const query=f.calls.find(row=>row.sql.startsWith('SELECT'));assert.deepEqual(query.values,names);assert.match(query.sql,/IN \(\?,\?\)$/);assert.equal(f.state.closed,1);assert.equal(f.state.committed,1);
});
test('a missing required journal row makes check incompatible even when generic metadata snapshot reports both',async t=>{
  const f=fixture(t);f.state.readback=[names[0]];const report=await f.api.run(f.args());assert.equal(report.compatible,false);assert.equal(report.status,'incompatible');assert.deepEqual(report.missingRequiredMigrations,[names[1]]);assert.equal(f.state.closed,1);
});
test('unexpected journal names are rejected and the checked connection closes without a success report',async t=>{
  const f=fixture(t);f.state.readback=['20261108000000-unrequested.js'];await assert.rejects(f.api.run(f.args()),/schema_required_migration_readback_invalid/);assert.equal(f.state.closed,1);assert.equal(f.state.committed,0);assert.equal(fs.existsSync(path.join(f.dir,'report.json')),false);
});
test('checks without the new flag preserve baseline behavior and issue no extra journal readback',async t=>{
  const f=fixture(t),report=await f.api.run(f.args([]));assert.equal(report.compatible,true);assert.deepEqual(report.requiredMigrations,[]);assert.deepEqual(report.missingRequiredMigrations,[]);assert.equal(f.calls.some(row=>row.sql.startsWith('SELECT')),false);assert.equal(f.state.closed,1);
});
