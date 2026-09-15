'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {randomBytes,createHmac}=require('node:crypto');const {BrokerStore}=require('../src/store');
const {pinIdentity,COHORT}=require('../src/whatsapp-inbox-main');const C=require('../src/whatsapp-inbox-scopes');
const {createInboxCipher,createWhatsappInbox}=require('../src/whatsapp-inbox');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-inbox-scopes-'));const store=new BrokerStore(path.join(dir,'inbox.sqlite'));const key=randomBytes(32);const cipher=createInboxCipher({key,keyId:'qa-inbox-key'});
 t.after(()=>{cipher.close();store.close();key.fill(0);fs.rmSync(dir,{recursive:true,force:true});});
 const config={application:{appId:'101'},bindings:[{wabaId:'301',phoneIds:['401']}],auditContext:{tenantRef:'clinic:71',connectionRef:'qa:inbox',resourceRef:'wa-inbox:101',operation:'whatsapp.webhook.capture',policyVersion:'qa-v1'}};
 return{store,cipher,config};
}
const scopes=[{wabaId:'301',phoneId:'401',clinicIds:[71]},{wabaId:'302',phoneId:'402',clinicIds:[72]}];
test('Explicit matching legacy digest permits additive scope migration without rewriting old identity or ciphertext',t=>{
 const f=fixture(t);pinIdentity(f.store,f.config,f.cipher);const old=f.store.db.prepare('SELECT digest FROM whatsapp_inbox_identity').get().digest;
 f.store.db.exec('CREATE TABLE whatsapp_inbox(receipt TEXT, body BLOB)');f.store.db.prepare('INSERT INTO whatsapp_inbox VALUES (?,?)').run('preserved',Buffer.from('FICTITIOUS_CIPHERTEXT'));
 f.config.scopes=scopes;f.config.bindings=C.bindingsFor(scopes);f.config.previousScopesDigest=old;
 const digest=pinIdentity(f.store,f.config,f.cipher);assert.equal(pinIdentity(f.store,f.config,f.cipher),digest);
 assert.equal(f.store.db.prepare('SELECT digest FROM whatsapp_inbox_identity').get().digest,old);
 assert.equal(Buffer.from(f.store.db.prepare('SELECT body FROM whatsapp_inbox').get().body).toString(),'FICTITIOUS_CIPHERTEXT');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox_scope_migrations').get().n,1);
 const previous=structuredClone(f.config);delete previous.scopes;delete previous.previousScopesDigest;assert.throws(()=>pinIdentity(f.store,previous,f.cipher),{code:'scope_denied'});
});
for(const mutation of ['wrong_previous','reassign_clinic','reassign_waba','remove_phone','change_key','change_anchor'])test('Scope migration rejects '+mutation+' atomically',t=>{
 const f=fixture(t);f.config.scopes=scopes;f.config.previousScopesDigest=null;f.config.bindings=C.bindingsFor(scopes);const first=pinIdentity(f.store,f.config,f.cipher);
 const next=structuredClone(f.config);next.previousScopesDigest=first;next.scopes.push({wabaId:'303',phoneId:'403',clinicIds:[73]});let cipher=f.cipher;
 if(mutation==='wrong_previous')next.previousScopesDigest='0'.repeat(64);
 if(mutation==='reassign_clinic')next.scopes[0].clinicIds=[99];
 if(mutation==='reassign_waba')next.scopes[0].wabaId='999';
 if(mutation==='remove_phone')next.scopes.shift();
 if(mutation==='change_key')cipher={keyId:'replacement'};
 if(mutation==='change_anchor')next.auditContext.tenantRef='clinic:99';
 next.bindings=C.bindingsFor(next.scopes);assert.throws(()=>pinIdentity(f.store,next,cipher),{code:'scope_denied'});
 assert.equal(f.store.db.prepare('SELECT digest FROM whatsapp_inbox_scope_identity').get().digest,first);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox_scope_migrations').get().n,1);
});
test('Second additive migration requires exact current digest and keeps every original owner',t=>{
 const f=fixture(t);f.config.scopes=scopes;f.config.previousScopesDigest=null;f.config.bindings=C.bindingsFor(scopes);const first=pinIdentity(f.store,f.config,f.cipher);
 f.config.scopes=[...scopes,{wabaId:'303',phoneId:'403',clinicIds:[73,74]}];f.config.bindings=C.bindingsFor(f.config.scopes);f.config.previousScopesDigest=first;
 assert.notEqual(pinIdentity(f.store,f.config,f.cipher),first);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox_scope_migrations').get().n,2);
});
test('Multiphone signed batch audits each owner and returns authenticated immutable scope metadata with lease',t=>{
 const f=fixture(t);const inbox=createWhatsappInbox({store:f.store,cipher:f.cipher,appId:'101',bindings:C.bindingsFor(scopes),scopeBindings:scopes,auditContext:f.config.auditContext});
 const raw=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:scopes.map(s=>({id:s.wabaId,changes:[{field:'messages',value:{metadata:{phone_number_id:s.phoneId},messages:[]}}]}))}));
 const appSecret=Buffer.from('FICTITIOUS_INBOX_APP_SECRET');const receipt=inbox.accept({raw,appSecret,signature:'sha256='+createHmac('sha256',appSecret).update(raw).digest('hex')});
 const events=f.store.db.prepare('SELECT event FROM audit_outbox').all().map(r=>JSON.parse(r.event));
 assert.deepEqual(events.map(e=>[e.tenantRef,e.resourceRef]),[['clinic:71','wa-phone:401'],['clinic:72','wa-phone:402']]);
 const lease=inbox.lease(receipt.receipt);assert.deepEqual(lease.scopeBindings,C.validateScopes(scopes));assert.equal(lease.automaticActionsAllowed,false);lease.raw.fill(0);
});
test('Bindings outside declared owners and duplicate/unsorted owners fail configuration',()=>{
 assert.throws(()=>C.validateBindings([{wabaId:'301',phoneIds:['401','999']}],scopes));
 assert.throws(()=>C.validateScopes([{wabaId:'301',phoneId:'401',clinicIds:[72,71]}]));
 assert.throws(()=>C.validateScopes([...scopes,{wabaId:'999',phoneId:'401',clinicIds:[71]}]));
});
test('A real encrypted pending receipt survives expansion with the same plaintext, receipt and original clinic owner',t=>{
 const f=fixture(t);pinIdentity(f.store,f.config,f.cipher);
 const legacy=createWhatsappInbox({store:f.store,cipher:f.cipher,appId:'101',bindings:f.config.bindings,auditContext:f.config.auditContext});
 const raw=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:'301',changes:[{field:'messages',value:{metadata:{phone_number_id:'401'},messages:[{id:'FICTITIOUS'}]}}]}]}));
 const appSecret=Buffer.from('FICTITIOUS_INBOX_APP_SECRET');const packet={raw,appSecret,signature:'sha256='+createHmac('sha256',appSecret).update(raw).digest('hex')};
 const first=legacy.accept(packet);const encrypted=Buffer.from(f.store.db.prepare('SELECT body FROM whatsapp_inbox').get().body);
 f.config.scopes=scopes;f.config.bindings=C.bindingsFor(scopes);f.config.previousScopesDigest=f.store.db.prepare('SELECT digest FROM whatsapp_inbox_identity').get().digest;
 pinIdentity(f.store,f.config,f.cipher);
 const expanded=createWhatsappInbox({store:f.store,cipher:f.cipher,appId:'101',bindings:f.config.bindings,scopeBindings:f.config.scopes,auditContext:f.config.auditContext});
 assert.equal(expanded.accept(packet).receipt,first.receipt);assert(Buffer.from(f.store.db.prepare('SELECT body FROM whatsapp_inbox').get().body).equals(encrypted));
 const lease=expanded.lease(first.receipt);assert(lease.raw.equals(raw));assert.deepEqual(lease.scopeBindings,[scopes[0]]);lease.raw.fill(0);
});
