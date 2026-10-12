'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {randomBytes,createHash,createHmac}=require('node:crypto');
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw Error('isolated_source_required');
const {BrokerStore}=require(root+'/src/store');
const {createInboxCipher,createWhatsappInbox}=require(root+'/src/whatsapp-inbox');
const {reviewSummary,reviewContacts}=require(root+'/src/whatsapp-inbox-review');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cc-identity-qa-'));fs.chmodSync(tmp,0o700);
const key=randomBytes(32),secret=Buffer.from('FICTITIOUS_ONLY_INBOX_IDENTITY_QA');
const scopes=[{wabaId:'301',phoneId:'401',clinicIds:[71]}],now=Date.now();let store,cipher,inbox;
const open=()=>{
 store=new BrokerStore(tmp+'/inbox.sqlite');cipher=createInboxCipher({key,keyId:'synthetic-key'});
 inbox=createWhatsappInbox({store,cipher,appId:'101',bindings:[{wabaId:'301',phoneIds:['401']}],scopeBindings:scopes,
  auditContext:{tenantRef:'clinic:71',connectionRef:'connection:identity-qa',resourceRef:'wa-inbox:101',policyVersion:'qa',operation:'whatsapp.webhook.capture'},now:()=>now});
};
try{
 const event={object:'whatsapp_business_account',entry:[{id:'301',changes:[{field:'messages',value:{
  messaging_product:'whatsapp',metadata:{phone_number_id:'401'},contacts:[{user_id:'ES.Synthetic'}],
  messages:[{from_user_id:'ES.Synthetic',id:'wamid.synthetic',timestamp:String(Math.floor(now/1000)),type:'text',text:{body:'FICTITIOUS_ONLY'}}]}}]}]};
 const raw=Buffer.from(JSON.stringify(event));assert.equal(reviewSummary(raw).category,'user_identity_unresolved');
 assert.equal(reviewContacts(raw,scopes),null);open();
 const receipt=inbox.accept({raw,appSecret:secret,signature:'sha256='+createHmac('sha256',secret).update(raw).digest('hex')}).receipt;
 const leased=inbox.lease(receipt);leased.raw.fill(0);inbox.defer({receipt,lease:leased.lease,reason:'review_required'});
 const before=store.db.prepare('SELECT * FROM whatsapp_inbox WHERE receipt=?').get(receipt);
 const aad=JSON.stringify(['cc-wa-inbox-v1',before.app_id,before.receipt,before.key_id,before.digest,before.scopes,before.kinds,before.received_at]);
 const legacy=cipher.seal(Buffer.from(JSON.stringify({version:1,contacts:null,summary:{category:'incoming_messages',errorCodes:[]}})),
  aad+':review-metadata-v1:'+createHash('sha256').update(JSON.stringify(scopes)).digest('hex'));
 store.db.prepare('UPDATE whatsapp_inbox SET review_metadata=? WHERE receipt=?').run(legacy,receipt);legacy.fill(0);
 cipher.close();store.close();open();
 assert.equal(inbox.health().groups[0].reviewSummary[0].category,'user_identity_unresolved');
 const after=store.db.prepare('SELECT * FROM whatsapp_inbox WHERE receipt=?').get(receipt);
 assert.deepEqual(Buffer.from(after.body),Buffer.from(before.body));
 for(const field of ['state','lease','lease_until','digest','imported_at','import_receipt'])assert.equal(after[field],before[field]);
 const v=event.entry[0].changes[0].value;v.messages[0].from='34000000001';
 assert.equal(reviewSummary(Buffer.from(JSON.stringify(event))).category,'incoming_messages');
 cipher.close();store.close();open();assert.equal(inbox.health().groups[0].blockingReview,1);
 console.log(JSON.stringify({passed:true,checks:['bsuid_redacted','no_phone_guess','legacy_diagnostic_upgrade','ciphertext_preserved','lease_and_import_preserved','restart_review_preserved'],metaCalls:0}));
}finally{cipher?.close();store?.close();key.fill(0);secret.fill(0);fs.rmSync(tmp,{recursive:true,force:true});}
