'use strict';
// Explicit OFFLINE maintenance only. No startup path calls this command.
// Neither configuration is rewritten; the target is a separately sealed file.
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createHash}=require('node:crypto');
const {canonical}=require('./canonical');
const {fail}=require('./errors');
const R=require('./google-first-admission-main'),M=R.scopeAdditionMaintenance;
const DOMAIN='clinicaclick/google-first-scope-additions/1';
const TABLE='google_first_authority_extensions_v1';
const DDL=`CREATE TABLE ${TABLE}(
 request_id TEXT PRIMARY KEY,plan_digest TEXT NOT NULL UNIQUE,
 prior_config_sha256 TEXT NOT NULL,new_config_sha256 TEXT NOT NULL,
 prior_authority_digest TEXT NOT NULL UNIQUE,new_authority_digest TEXT NOT NULL UNIQUE,
 added_scopes_digest TEXT NOT NULL,baseline_digest TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT`;
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash=v=>createHash('sha256').update(v).digest('hex');
const digest=v=>hash(canonical(v));
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const norm=s=>s.replace(/\s+/g,' ').trim();
function sourcePin(){
 const entries=fs.readdirSync(__dirname).sort().map(name=>{
  const filename=path.join(__dirname,name),st=fs.lstatSync(filename);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('invalid_request');
  return[name,st.mode&0o777,hash(fs.readFileSync(filename))];
 });
 return{sourceDigest:digest([DOMAIN,'source',process.version,entries]),sourceFiles:entries.length};
}
function jsonFile(filename){
 M.privateDirectory(path.dirname(filename));const bytes=M.privateFile(filename,1048576);
 try{return{value:JSON.parse(bytes.toString('utf8')),sha256:hash(bytes)};}finally{bytes.fill(0);}
}
function prefix(old,next){return Array.isArray(next)&&next.length>=old.length&&old.every((v,i)=>canonical(v)===canonical(next[i]));}
function compare(prior,next){
 R.validateConfig(prior);R.validateConfig(next);
 const arrays=['scopes','slots','publicationResources'];
 for(const key of new Set([...Object.keys(prior),...Object.keys(next)])){
  if(arrays.includes(key))continue;
  if(canonical(prior[key])!==canonical(next[key]))fail('scope_denied');
 }
 // Optional capability pairs cannot be enabled by this maintenance command.
 for(const key of arrays)if(Object.hasOwn(prior,key)!==Object.hasOwn(next,key))fail('scope_denied');
 if(!prefix(prior.scopes,next.scopes)||next.scopes.length===prior.scopes.length||!prefix(prior.slots,next.slots)
  ||Object.hasOwn(prior,'publicationResources')&&!prefix(prior.publicationResources,next.publicationResources))fail('scope_denied');
 const old=new Set(prior.scopes.map(v=>v.scopeKey)),added=next.scopes.slice(prior.scopes.length);
 if(added.some(v=>old.has(v.scopeKey)))fail('scope_denied');
 const addedKeys=new Set(added.map(v=>v.scopeKey));
 for(const key of ['slots','publicationResources'])for(const row of (next[key]||[]).slice((prior[key]||[]).length))if(!addedKeys.has(row.scopeKey))fail('scope_denied');
 // A clinic already commissioned in another scope cannot be reassigned here.
 const clinics=new Set(prior.scopes.flatMap(row=>row.clinicIds));
 if(added.some(row=>row.clinicIds.some(id=>clinics.has(id))))fail('scope_denied');
 const newClinics=added.flatMap(row=>row.clinicIds);
 if(new Set(newClinics).size!==newClinics.length)fail('scope_denied');
 return{addedScopes:added.length,addedSlots:next.slots.length-prior.slots.length,
  addedResources:(next.publicationResources||[]).length-(prior.publicationResources||[]).length,
  addedScopesDigest:digest([DOMAIN,'addition',added,next.slots.slice(prior.slots.length),
   (next.publicationResources||[]).slice((prior.publicationResources||[]).length)])};
}
function load(plan){
 if(!exact(plan,'version,requestId,priorConfigFile,priorConfigSha256,newConfigFile,newConfigSha256,priorAuthorityDigest,newAuthorityDigest')
  ||plan.version!==1||!UUID.test(plan.requestId)||!['priorConfigSha256','newConfigSha256','priorAuthorityDigest','newAuthorityDigest'].every(k=>SHA.test(plan[k]))
  ||plan.priorConfigFile===plan.newConfigFile||plan.priorAuthorityDigest===plan.newAuthorityDigest)fail('invalid_request');
 const prior=jsonFile(plan.priorConfigFile),next=jsonFile(plan.newConfigFile);
 if(prior.sha256!==plan.priorConfigSha256||next.sha256!==plan.newConfigSha256)fail('idempotency_conflict');
 const additions=compare(prior.value,next.value);
 if(M.authorityDigest(prior.value)!==plan.priorAuthorityDigest||M.authorityDigest(next.value)!==plan.newAuthorityDigest)fail('scope_denied');
 const stateFile=prior.value.stateFile;M.privateDirectory(path.dirname(stateFile));
 M.privateFile(stateFile,1073741824,false);
 for(const suffix of ['-wal','-shm'])if(fs.existsSync(stateFile+suffix))M.privateFile(stateFile+suffix,1073741824,false);
 return{plan:structuredClone(plan),planDigest:digest([DOMAIN,'plan',plan]),stateFile,additions,
  newScopes:next.value.scopes.slice(prior.value.scopes.length),...sourcePin()};
}
function schema(db){return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();}
function history(db){
 const rows=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name=? ORDER BY type,name').all(TABLE);
 if(!rows.length)return[];
 if(rows.length!==5||rows.filter(v=>v.type==='table').length!==1||rows.some(v=>v.type==='table'
  ?v.name!==TABLE||norm(v.sql)!==norm(DDL)
  :v.type!=='index'||v.sql!==null||!v.name.startsWith('sqlite_autoindex_'+TABLE+'_')))fail('scope_denied');
 // request PK plus plan, prior and new unique keys = four autoindexes.
 const records=db.prepare('SELECT * FROM '+TABLE+' ORDER BY applied_at,request_id').all();
 for(const row of records)if(!UUID.test(row.request_id)||!['plan_digest','prior_config_sha256','new_config_sha256','prior_authority_digest',
  'new_authority_digest','added_scopes_digest','baseline_digest'].every(k=>SHA.test(row[k]))
  ||row.prior_authority_digest===row.new_authority_digest||!Number.isSafeInteger(row.applied_at)||row.applied_at<=0)fail('scope_denied');
 if(records.length){
  const byPrior=new Map(records.map(row=>[row.prior_authority_digest,row])),next=new Set(records.map(row=>row.new_authority_digest));
  const starts=records.filter(row=>!next.has(row.prior_authority_digest));if(starts.length!==1)fail('scope_denied');
  let cursor=starts[0],visited=new Set();while(cursor){if(visited.has(cursor.request_id))fail('scope_denied');visited.add(cursor.request_id);cursor=byPrior.get(cursor.new_authority_digest);}
  if(visited.size!==records.length)fail('scope_denied');
 }
 return records;
}
function marker(db){
 const rows=db.prepare('SELECT * FROM '+M.MARKER).all();
 const shape=db.prepare('SELECT type,name,sql FROM sqlite_schema WHERE tbl_name=?').all(M.MARKER);
 const definition=`CREATE TABLE ${M.MARKER}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),purpose TEXT NOT NULL,authority_digest TEXT NOT NULL) STRICT`;
 if(shape.length!==1||shape[0].type!=='table'||norm(shape[0].sql)!==norm(definition)||rows.length!==1||rows[0].singleton!==1
  ||rows[0].purpose!==M.PURPOSE||!SHA.test(rows[0].authority_digest))fail('scope_denied');
 return rows[0].authority_digest;
}
function tableDigest(db,name){
 // Constant-memory, order-independent multiset digest including exact types.
 const statement=db.prepare('SELECT * FROM '+quote(name));statement.setReadBigInts(true);statement.setReturnArrays(true);
 const columns=statement.columns().map(c=>c.name),mod=1n<<256n;let sum=0n,xor=0n,count=0;
 for(const row of statement.iterate()){
  const encoded=row.map(v=>v===null?['null']:typeof v==='bigint'?['integer',v.toString()]:typeof v==='number'?['real',(()=>{const b=Buffer.alloc(8);b.writeDoubleBE(v);return b.toString('hex');})()]
   :typeof v==='string'?['text',v]:v instanceof Uint8Array?['blob',Buffer.from(v).toString('hex')]:fail('invalid_request'));
  const h=BigInt('0x'+digest([columns,encoded]));sum=(sum+h)%mod;xor^=h;count++;
 }
 return{name,count,digest:digest([DOMAIN,'table',columns,count,sum.toString(16),xor.toString(16)])};
}
function inventory(db,{protectedOnly=false}={}){
 const objects=schema(db).filter(v=>!protectedOnly||v.tbl_name!==TABLE&&v.tbl_name!==M.MARKER);
 const tables=objects.filter(v=>v.type==='table').map(v=>tableDigest(db,v.name));
 return{digest:digest([DOMAIN,'inventory',objects,tables]),objects:objects.length,tables:tables.length,rows:tables.reduce((n,v)=>n+v.count,0)};
}
function quiescent(db){
 const names=new Set(schema(db).filter(v=>v.type==='table').map(v=>v.name));
 if(!names.has('google_first_identity_journal_v1'))fail('scope_denied');
 if(db.prepare("SELECT 1 FROM google_first_identity_journal_v1 WHERE state IN ('prepared','exchanging','candidate_ready','stage_intent') OR stage_intent IS NOT NULL AND receipt_digest IS NULL LIMIT 1").get())fail('oauth_flow_busy');
 if(names.has('google_first_publications_v1')&&db.prepare("SELECT 1 FROM google_first_publications_v1 WHERE state IN ('approved','activation_intent') OR activation_intent IS NOT NULL AND activation_readback_digest IS NULL LIMIT 1").get())fail('oauth_flow_busy');
 if(names.has('commands')&&db.prepare("SELECT 1 FROM commands WHERE state='started' LIMIT 1").get())fail('oauth_flow_busy');
 if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').get())fail('invalid_request');
}
function entirelyNew(db,ctx){
 // A scope absent from the old file may still have a retired/aborted history.
 // Such a scope is not a new admission and this command must never restore it.
 for(const scope of ctx.newScopes)for(const service of ['business_profile','search_console','analytics','ads']){
  const asset='google-oauth:'+service+':'+scope.scopeKey,connection='google-first:'+service+':'+scope.scopeKey;
  if(db.prepare('SELECT 1 FROM google_first_identity_journal_v1 WHERE asset=? LIMIT 1').get(asset)
   ||db.prepare('SELECT 1 FROM connections WHERE ref=? LIMIT 1').get(connection)
   ||db.prepare('SELECT 1 FROM asset_revocations WHERE connection=? LIMIT 1').get(connection))fail('scope_denied');
 }
}
function observation(db,ctx){
 const current=marker(db),past=history(db),existing=past.find(v=>v.request_id===ctx.plan.requestId);
 if(past.length){
  const priors=new Set(past.map(row=>row.prior_authority_digest)),tails=past.filter(row=>!priors.has(row.new_authority_digest));
  if(tails.length!==1||tails[0].new_authority_digest!==current)fail('idempotency_conflict');
 }
 if(current===ctx.plan.newAuthorityDigest){
  if(!existing||existing.plan_digest!==ctx.planDigest||existing.prior_config_sha256!==ctx.plan.priorConfigSha256
   ||existing.new_config_sha256!==ctx.plan.newConfigSha256||existing.prior_authority_digest!==ctx.plan.priorAuthorityDigest
   ||existing.new_authority_digest!==current||existing.added_scopes_digest!==ctx.additions.addedScopesDigest)fail('idempotency_conflict');
  return{status:'already_applied',existing};
 }
 if(current!==ctx.plan.priorAuthorityDigest||existing||past.some(v=>v.plan_digest===ctx.planDigest))fail('idempotency_conflict');
 quiescent(db);entirelyNew(db,ctx);return{status:'ready'};
}
function result(ctx,observed,data){return{version:1,status:observed.status,requestId:ctx.plan.requestId,planDigest:ctx.planDigest,
 sourceDigest:ctx.sourceDigest,sourceFiles:ctx.sourceFiles,priorAuthorityDigest:ctx.plan.priorAuthorityDigest,newAuthorityDigest:ctx.plan.newAuthorityDigest,
 ...ctx.additions,baselineDigest:data.digest,baselineObjects:data.objects,baselineTables:data.tables,baselineRows:data.rows};}
function preflight(plan){
 const ctx=load(plan),db=new DatabaseSync(ctx.stateFile,{readOnly:true});
 try{db.exec('BEGIN');const observed=observation(db,ctx),data=inventory(db);db.exec('COMMIT');return result(ctx,observed,data);}
 finally{db.close();}
}
function apply(plan,reviewed){
 const initial=load(plan),release=M.acquireLock(initial.stateFile);let db;
 try{
  const ctx=load(plan);db=new DatabaseSync(ctx.stateFile);db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  let committed=false;
  try{
   const observed=observation(db,ctx),before=inventory(db),actual=result(ctx,observed,before);
   if(observed.status==='already_applied'){
    // After an uncertain acknowledgement the only supported action is inspect.
    fail('idempotency_conflict');
   }
   if(canonical(actual)!==canonical(reviewed))fail('idempotency_conflict');
   const protectedBefore=inventory(db,{protectedOnly:true});
   if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(TABLE))db.exec(DDL);
   db.prepare('INSERT INTO '+TABLE+' VALUES (?,?,?,?,?,?,?,?,?)').run(ctx.plan.requestId,ctx.planDigest,ctx.plan.priorConfigSha256,ctx.plan.newConfigSha256,
    ctx.plan.priorAuthorityDigest,ctx.plan.newAuthorityDigest,ctx.additions.addedScopesDigest,before.digest,Date.now());
   const changed=db.prepare('UPDATE '+M.MARKER+' SET authority_digest=? WHERE singleton=1 AND purpose=? AND authority_digest=?')
    .run(ctx.plan.newAuthorityDigest,M.PURPOSE,ctx.plan.priorAuthorityDigest);
   if(changed.changes!==1||canonical(inventory(db,{protectedOnly:true}))!==canonical(protectedBefore))fail('idempotency_conflict');
   if(canonical(load(plan))!==canonical(ctx))fail('idempotency_conflict');
   db.exec('COMMIT');committed=true;
   return{version:1,status:'applied',requestId:ctx.plan.requestId,planDigest:ctx.planDigest,newAuthorityDigest:ctx.plan.newAuthorityDigest,protectedDataPreserved:true};
  }catch(error){if(!committed&&db.isTransaction)db.exec('ROLLBACK');throw error;}
 }finally{db?.close();release();}
}
if(require.main===module){
 try{
  const [action,planFile,reviewFile,...rest]=process.argv.slice(2);
  if(rest.length||!['preflight','apply'].includes(action)||action==='preflight'&&reviewFile||action==='apply'&&!reviewFile)fail('invalid_request');
  const plan=jsonFile(planFile).value,out=action==='preflight'?preflight(plan):apply(plan,jsonFile(reviewFile).value);
  process.stdout.write(JSON.stringify(out)+'\n');
 }catch{process.stderr.write('GOOGLE_FIRST_SCOPE_ADDITION_DENIED\n');process.exitCode=1;}
}
module.exports={preflight,apply,compare,TABLE};
