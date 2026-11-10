'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),{createHmac}=require('node:crypto');
const {createMetaMarketingLeadReceipts}=require('../src/meta-marketing-leads-receipts');
const {readRoutedLeadReceipt}=require('../src/meta-marketing-lead-routing-receipt');
function fixture(t,{organic=false}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const store={db,transaction:f=>f()},now=()=>1000;
 const receipts=createMetaMarketingLeadReceipts({store,now}),old={app:'101',subject:'201',tenant:'clinic:71',connection:'synthetic',enrollment:'synthetic-enrollment',page:'401',account:'301',generation:'1'.repeat(64),recipientClinicId:71},current={...old,account:'302',generation:'2'.repeat(64)};
 const secret=Buffer.from('a'.repeat(32)),raw=Buffer.from(JSON.stringify({object:'page',entry:[{id:'401',changes:[{field:'leadgen',value:{leadgen_id:'701',form_id:'702',...(organic?{}:{ad_id:'603'})}}]}]}));
 const receiptRef=receipts.accept({raw,signature:'sha256='+createHmac('sha256',secret).update(raw).digest('hex'),appSecret:secret,context:old,authorize(){}}).receipts[0].receiptRef;
 const route={pageAssetRef:'meta-facebook_page:401',adAccountAssetRef:'meta-ad_account:302',recipientClinicId:71};
 const run=extra=>readRoutedLeadReceipt({read:receipts.read,receiptRef,current,route,previousContexts:()=>[old],...extra});return{db,receipts,receiptRef,old,current,route,run};
}
test('explicit routing correction can read the paid event without rewriting or duplicating its verified receipt',t=>{const f=fixture(t),before=f.db.prepare('SELECT * FROM meta_marketing_lead_receipts').all();assert.throws(()=>f.receipts.read(f.receiptRef,f.current),{code:'scope_denied'});assert.equal(f.run().event.ad_id,'603');assert.deepEqual(f.db.prepare('SELECT * FROM meta_marketing_lead_receipts').all(),before)});
test('no explicit route, wrong current route or no selected old account denies reconciliation',t=>{const f=fixture(t);for(const extra of [{route:null},{route:{...f.route,recipientClinicId:72}},{route:{...f.route,adAccountAssetRef:'meta-ad_account:999'}},{previousContexts:()=>[]}])assert.throws(()=>f.run(extra),{code:'scope_denied'})});
test('another clinic, tenant, subject, enrollment or Page cannot reuse the event',t=>{const f=fixture(t);for(const k of ['app','subject','tenant','connection','enrollment','page','recipientClinicId'])assert.throws(()=>f.run({previousContexts:()=>[{...f.old,[k]:k==='recipientClinicId'?72:'other'}]}),{code:'scope_denied'})});
test('changed selection generation or expiry still requires review',t=>{const f=fixture(t);assert.throws(()=>f.run({previousContexts:()=>[{...f.old,generation:'3'.repeat(64)}]}),{code:'meta_lead_receipt_review_required'});f.db.prepare('UPDATE meta_marketing_lead_receipts SET expires_at=1000').run();assert.throws(()=>f.run(),{code:'meta_lead_receipt_review_required'})});
test('organic receipts cannot use an account-change recovery path',t=>{const f=fixture(t,{organic:true});assert.throws(()=>f.run(),{code:'scope_denied'})});
