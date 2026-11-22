'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {setup}=require('./google-first-sc-fixture.cjs');
const R=require('../src/google-first-admission-main'),A=require('../src/google-first-scope-additions');
const {createFirstGoogleJournal,TABLE:FIRST}=require('../src/google-first-identity-journal');
const {createFirstGooglePublicationJournal,TABLE:PUB}=require('../src/google-first-publication-journal');
const {createFirstSearchConsoleReadOwner}=require('../src/google-first-search-console-read-owner');
const {createFirstGoogleCredentialVault}=require('../src/google-first-identity-vault');
const {BrokerStore}=require('../src/store');
const {REVOKE_OPERATION}=require('../src/google-search-console-contract');
const H=v=>createHash('sha256').update(v).digest('hex');
const copy=v=>structuredClone(v);
async function fixture(t){
 const f=await setup(t),m=R.scopeAdditionMaintenance;
 const prior={cohort:R.COHORT,purpose:R.PURPOSE,enabled:true,environment:'staging',listenAddress:'127.0.0.1',port:48001,stateFile:path.join(f.dir,'owner.sqlite'),
  tlsCertFile:path.join(f.dir,'server.crt'),tlsKeyFile:path.join(f.dir,'server.key'),tlsRenewal:{issuerCaFile:path.join(f.dir,'ca.crt')},
  policy:{...f.policy,principals:[f.policy.principals.find(v=>v.id==='crm:staging:google-first-oauth')]},
  scopes:f.options.approvedScopes,slots:f.options.slots,redirectUri:f.options.redirectUri,
  publicationResources:[{scopeKey:'group:11',service:'search_console',clinicId:31,resource:{siteUrl:f.resource.siteUrl}}],
  searchConsoleReaderPrincipal:f.policy.principals.find(v=>v.id==='crm:staging:google-first-sc-reader'),searchConsoleCursorKeyFile:path.join(f.dir,'reader.key')};
 const next=copy(prior);next.scopes.push({scopeKey:'clinic:42',clinicIds:[42],services:['search_console']});
 next.slots.push({...f.slot,scopeKey:'clinic:42',secretArn:f.slot.secretArn.replace('group-11-qA123z','clinic-42-nEw123'),baselineVersion:randomUUID()});
 next.publicationResources.push({scopeKey:'clinic:42',service:'search_console',clinicId:42,resource:{siteUrl:'sc-domain:new.example.invalid'}});
 R.validateConfig(prior);R.validateConfig(next);
 f.store.db.exec('CREATE TABLE '+m.MARKER+'(singleton INTEGER PRIMARY KEY CHECK(singleton=1),purpose TEXT NOT NULL,authority_digest TEXT NOT NULL) STRICT');
 f.store.db.prepare('INSERT INTO '+m.MARKER+' VALUES(1,?,?)').run(R.PURPOSE,m.authorityDigest(prior));
 const priorFile=path.join(f.dir,'prior.json'),newFile=path.join(f.dir,'next.json');
 const save=(filename,config)=>{const s=JSON.stringify(config);fs.writeFileSync(filename,s,{mode:0o600});return H(s);};
 const plan={version:1,requestId:randomUUID(),priorConfigFile:priorFile,priorConfigSha256:save(priorFile,prior),newConfigFile:newFile,newConfigSha256:save(newFile,next),
  priorAuthorityDigest:m.authorityDigest(prior),newAuthorityDigest:m.authorityDigest(next)};
 const snapshot=()=>JSON.stringify(f.store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all())+
  f.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(v=>v.name+JSON.stringify(f.store.db.prepare('SELECT * FROM "'+v.name+'"').all())).join('\n');
 return{...f,prior,next,plan,save,snapshot,
  target(){plan.newConfigSha256=save(newFile,next);plan.newAuthorityDigest=m.authorityDigest(next);},
  marker(){return f.store.db.prepare('SELECT authority_digest AS d FROM '+m.MARKER).get().d;},
  reopen(){
   const store=new BrokerStore(prior.stateFile),journal=createFirstGoogleJournal({store,now:f.now}),ledger=createFirstGooglePublicationJournal({store,journal,approvedScopes:next.scopes,now:f.now});
   const vault=createFirstGoogleCredentialVault({...f.base.config,client:f.base.client,redirectUri:next.redirectUri,slots:next.slots,now:f.now});
   const reader=createFirstSearchConsoleReadOwner({...f.options,store,firstJournal:journal,ledger,vault,approvedScopes:next.scopes,slots:next.slots});
   return{...reader,close(){reader.close();store.close();}};
  }};
}
test('read-only preflight changes no schema or row; explicit apply advances only marker plus immutable history',async t=>{
 const f=await fixture(t),before=f.snapshot(),oldBytes=fs.readFileSync(f.plan.priorConfigFile),newBytes=fs.readFileSync(f.plan.newConfigFile);
 const report=A.preflight(f.plan);assert.equal(report.status,'ready');assert.equal(report.addedScopes,1);assert.equal(report.addedSlots,1);assert.equal(report.addedResources,1);
 assert.equal(f.snapshot(),before);assert(!fs.existsSync(f.prior.stateFile+'.owner.lock'));
 assert.equal(A.apply(f.plan,report).protectedDataPreserved,true);assert.equal(f.marker(),f.plan.newAuthorityDigest);
 assert.deepEqual(fs.readFileSync(f.plan.priorConfigFile),oldBytes);assert.deepEqual(fs.readFileSync(f.plan.newConfigFile),newBytes);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM '+A.TABLE).get().n,1);
 assert.equal(A.preflight(f.plan).status,'already_applied');assert.throws(()=>A.apply(f.plan,report),{code:'idempotency_conflict'});
 R.scopeAdditionMaintenance.preflightState(f.prior.stateFile,f.plan.newAuthorityDigest);
 assert.throws(()=>R.scopeAdditionMaintenance.preflightState(f.prior.stateFile,f.plan.priorAuthorityDigest),{code:'scope_denied'});f.oldRows();
});
test('existing signed discovery and exact withdrawal survive extension and reader restart; no new grant is created',async t=>{
 const f=await fixture(t);await f.execute();const certs=f.store.db.prepare('SELECT COUNT(*) n FROM google_first_sc_read_authorities_v1').get().n;
 const report=A.preflight(f.plan);A.apply(f.plan,report);const reader=f.reopen();t.after(()=>reader.close());
 // Setup signer closes over f.reader; call its actual signed request against the newly constructed broker.
 const previous=f.reader.broker.execute.bind(f.reader.broker);f.reader.broker.execute=reader.broker.execute.bind(reader.broker);
 assert.equal((await f.execute()).data.siteUrl,f.resource.siteUrl);
 await assert.rejects(f.execute(f.command(undefined,{}, {tenantRef:'clinic:42'})));
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM google_first_sc_read_authorities_v1').get().n,certs);
 assert.equal((await f.execute(f.command(REVOKE_OPERATION,{}),'control')).data.revoked,true);
 const again=f.reopen();t.after(()=>again.close());f.reader.broker.execute=again.broker.execute.bind(again.broker);
 const calls=f.calls.length;await assert.rejects(f.execute(),{code:'asset_revoked'});assert.equal(f.calls.length,calls);f.reader.broker.execute=previous;f.oldRows();
});
test('existing tombstones and historical source withdrawal survive offline marker extension',async t=>{
 const f=await fixture(t);f.first.abort(f.proof,f.owner);await f.execute(f.command(REVOKE_OPERATION,{}),'control');
 const blocked=JSON.stringify(f.store.db.prepare('SELECT * FROM asset_revocations').all());A.apply(f.plan,A.preflight(f.plan));
 assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM asset_revocations').all()),blocked);
 const reader=f.reopen();t.after(()=>reader.close());f.reader.broker.execute=reader.broker.execute.bind(reader.broker);
 await assert.rejects(f.execute(),{code:'asset_revoked'});assert.equal(f.calls.length,0);f.oldRows();
});
test('old roster, slot, principal, resources, listener, root capability and clinic reassignment cannot change',async t=>{
 const mutations=[n=>n.scopes[0].clinicIds.push(99),n=>n.slots[0].baselineVersion=randomUUID(),n=>n.policy.principals[0].keyId='wrong',
  n=>n.publicationResources[0].resource.siteUrl='sc-domain:changed.invalid',n=>n.port++,n=>n.scopes[1].clinicIds=[31],
  n=>{n.scopes[1]={scopeKey:'group:12',clinicIds:[31],services:['search_console']};n.slots[1].scopeKey='group:12';},
  n=>n.slots.reverse(),n=>n.publicationResources.push({...n.publicationResources[0],clinicId:17})];
 for(const mutate of mutations)await t.test(String(mutations.indexOf(mutate)),async t=>{
  const f=await fixture(t),before=f.snapshot();mutate(f.next);f.target();assert.throws(()=>A.preflight(f.plan));assert.equal(f.snapshot(),before);
 });
});
test('all exact configuration hashes, request type and prior marker pins are mandatory',async t=>{
 const f=await fixture(t),before=f.snapshot();
 for(const change of [{priorConfigSha256:'0'.repeat(64)},{newConfigSha256:'0'.repeat(64)},{priorAuthorityDigest:'0'.repeat(64)},
  {newAuthorityDigest:'0'.repeat(64)},{requestId:'not-uuid'},{extra:true}])assert.throws(()=>A.preflight({...f.plan,...change}));
 assert.equal(f.snapshot(),before);
 fs.chmodSync(f.plan.newConfigFile,0o644);assert.throws(()=>A.preflight(f.plan));fs.chmodSync(f.plan.newConfigFile,0o600);
 const file=f.plan.newConfigFile;fs.renameSync(file,file+'.real');fs.symlinkSync(file+'.real',file);assert.throws(()=>A.preflight(f.plan));
});
test('a live runtime kernel lock blocks apply and leaves all database rows untouched',async t=>{
 const f=await fixture(t),report=A.preflight(f.plan),before=f.snapshot(),unlock=R.scopeAdditionMaintenance.acquireLock(f.prior.stateFile);
 try{assert.throws(()=>A.apply(f.plan,report),{code:'oauth_flow_busy'});assert.equal(f.snapshot(),before);}finally{unlock();}
 assert.equal(A.apply(f.plan,report).status,'applied');
});
test('post-review data or evidence drift fails shut before the marker write',async t=>{
 const f=await fixture(t),report=A.preflight(f.plan);
 assert.throws(()=>A.apply(f.plan,{...report,sourceDigest:'0'.repeat(64)}),{code:'idempotency_conflict'});
 f.store.db.prepare('UPDATE connections SET revision=revision+1 WHERE ref=?').run('preserved-whatsapp');
 assert.throws(()=>A.apply(f.plan,report),{code:'idempotency_conflict'});assert.equal(f.marker(),f.plan.priorAuthorityDigest);
 assert(!f.store.db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(A.TABLE));
});
test('prepared, exchange, unknown stage and unconfirmed activation reservations block commissioning',async t=>{
 for(const state of ['prepared','exchanging','candidate_ready','stage_intent'])await t.test(state,async t=>{
  const f=await fixture(t),before=f.marker();f.store.db.prepare('UPDATE '+FIRST+' SET state=? WHERE id=?').run(state,f.proof.attemptId);
  assert.throws(()=>A.preflight(f.plan),{code:'oauth_flow_busy'});assert.equal(f.marker(),before);
 });
 const f=await fixture(t);f.store.db.prepare('UPDATE '+PUB+" SET state='activation_intent' WHERE attempt_id=?").run(f.proof.attemptId);
 assert.throws(()=>A.preflight(f.plan),{code:'oauth_flow_busy'});
});
test('an unexpected marker trigger or extension-history schema is rejected rather than normalized',async t=>{
 const f=await fixture(t);f.store.db.exec('CREATE TRIGGER unexpected AFTER UPDATE ON '+R.scopeAdditionMaintenance.MARKER+' BEGIN UPDATE connections SET revision=revision+1; END');
 assert.throws(()=>A.preflight(f.plan),{code:'scope_denied'});
 f.store.db.exec('DROP TRIGGER unexpected');f.store.db.exec('CREATE TABLE '+A.TABLE+'(request_id TEXT)');
 assert.throws(()=>A.preflight(f.plan),{code:'scope_denied'});
});
test('a second entirely new scope builds a forward chain and cannot reuse an old request',async t=>{
 const f=await fixture(t);A.apply(f.plan,A.preflight(f.plan));const old=copy(f.next),next=copy(old);
 next.scopes.push({scopeKey:'clinic:43',clinicIds:[43],services:['search_console']});
 next.slots.push({...next.slots[1],scopeKey:'clinic:43',secretArn:next.slots[1].secretArn.replace('clinic-42-nEw123','clinic-43-nEw321'),baselineVersion:randomUUID()});
 next.publicationResources.push({scopeKey:'clinic:43',service:'search_console',clinicId:43,resource:{siteUrl:'sc-domain:third.example.invalid'}});
 const filename=path.join(f.dir,'third.json'),plan={...f.plan,requestId:randomUUID(),priorConfigFile:f.plan.newConfigFile,priorConfigSha256:f.plan.newConfigSha256,
  priorAuthorityDigest:f.plan.newAuthorityDigest,newConfigFile:filename,newConfigSha256:f.save(filename,next),newAuthorityDigest:R.scopeAdditionMaintenance.authorityDigest(next)};
 assert.equal(A.apply(plan,A.preflight(plan)).status,'applied');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM '+A.TABLE).get().n,2);
 assert.throws(()=>A.preflight(f.plan),{code:'idempotency_conflict'});
});
test('SIGKILL after the SQL updates but before COMMIT rolls back the whole transition and releases the exact kernel lock',async t=>{
 const f=await fixture(t),report=A.preflight(f.plan),before=f.snapshot();
 const script=path.join(f.dir,'kill-before-commit.cjs');
 fs.writeFileSync(script,`'use strict';
const deny=()=>{throw Error('LIVE_NETWORK_FORBIDDEN_SCOPE_ADDITION_QA');};require('node:net').Socket.prototype.connect=deny;require('node:tls').connect=deny;global.fetch=deny;
const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
const real=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT')process.kill(process.pid,'SIGKILL');return real.call(this,sql);};
const A=require(${JSON.stringify(require.resolve('../src/google-first-scope-additions'))});
A.apply(JSON.parse(fs.readFileSync(process.argv[2])),JSON.parse(fs.readFileSync(process.argv[3])));
`,{mode:0o600});
 const planFile=path.join(f.dir,'plan.json'),reviewFile=path.join(f.dir,'review.json');
 fs.writeFileSync(planFile,JSON.stringify(f.plan),{mode:0o600});fs.writeFileSync(reviewFile,JSON.stringify(report),{mode:0o600});
 const child=require('node:child_process').spawnSync(process.execPath,[script,planFile,reviewFile],{stdio:'pipe',timeout:10000});
 assert.equal(child.signal,'SIGKILL',child.stderr?.toString());assert.equal(f.snapshot(),before);assert.equal(f.marker(),f.plan.priorAuthorityDigest);
 assert.equal(A.apply(f.plan,report).status,'applied');
});
test('an uncertain acknowledgement after COMMIT is inspected read-only and cannot replay the mutation',async t=>{
 const f=await fixture(t),report=A.preflight(f.plan),real=DatabaseSync.prototype.exec;let once=true;
 DatabaseSync.prototype.exec=function(sql){const value=real.call(this,sql);if(sql==='COMMIT'&&once){once=false;throw Error('FICTITIOUS_ACK_LOSS_AFTER_DURABLE_COMMIT');}return value;};
 try{assert.throws(()=>A.apply(f.plan,report),/FICTITIOUS_ACK_LOSS/);}finally{DatabaseSync.prototype.exec=real;}
 assert.equal(f.marker(),f.plan.newAuthorityDigest);const before=f.snapshot();assert.equal(A.preflight(f.plan).status,'already_applied');
 assert.throws(()=>A.apply(f.plan,report),{code:'idempotency_conflict'});assert.equal(f.snapshot(),before);
});
test('a corrupted historical digest or disconnected extension chain is denied on the next read-only inspection',async t=>{
 const f=await fixture(t);A.apply(f.plan,A.preflight(f.plan));f.store.db.prepare('UPDATE '+A.TABLE+' SET baseline_digest=?').run('not-a-digest');
 assert.throws(()=>A.preflight(f.plan),{code:'scope_denied'});
});
test('an absent config scope with historical abort or persistent revocation is not an entirely new scope',async t=>{
 const f=await fixture(t),p={...f.proof,attemptId:randomUUID(),bindingDigest:'a'.repeat(64)},o={...f.owner,tenantRef:'clinic:42',connectionRef:null,assetRef:'google-oauth:search_console:clinic:42'};
 o.connectionRef='google-first:'+p.attemptId;f.first.abort(p,o);const before=f.snapshot();
 assert.throws(()=>A.preflight(f.plan),{code:'scope_denied'});assert.equal(f.snapshot(),before);
 const g=await fixture(t);g.store.seedConnection('google-first:search_console:clinic:42',{state:'revoked'});
 assert.throws(()=>A.preflight(g.plan),{code:'scope_denied'});
});
