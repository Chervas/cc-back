'use strict';
const {createHmac,createHash,timingSafeEqual,randomUUID}=require('node:crypto'),{fail}=require('./errors'),L=require('./meta-marketing-leads-contract'),M=require('./meta-marketing-contract');
const RETENTION_MS=30*86400000;
function createMetaMarketingLeadReceipts({store,now=Date.now}){
  store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_lead_receipts (
    id TEXT PRIMARY KEY,app TEXT NOT NULL,subject TEXT NOT NULL,tenant TEXT NOT NULL,connection TEXT NOT NULL,
    enrollment TEXT NOT NULL,generation TEXT NOT NULL,page TEXT NOT NULL,account TEXT NOT NULL,
    lead TEXT NOT NULL,form TEXT NOT NULL,ad TEXT,body_digest TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,recipient_clinic INTEGER,
    UNIQUE(app,page,lead));
    CREATE INDEX IF NOT EXISTS meta_marketing_lead_receipts_scope ON meta_marketing_lead_receipts(enrollment,page,account);`);
  const keys=['app','subject','tenant','connection','enrollment','generation','page','account'];
  if(!store.db.prepare('PRAGMA table_info(meta_marketing_lead_receipts)').all().some(r=>r.name==='recipient_clinic'))store.db.exec('ALTER TABLE meta_marketing_lead_receipts ADD COLUMN recipient_clinic INTEGER');
  function scope(value){if(!value||keys.some(k=>typeof value[k]!=='string'||!value[k]||value[k].length>128)||!M.graphId(value.app)||!M.graphId(value.subject)||!M.graphId(value.page)||!M.graphId(value.account)||!/^[a-f0-9]{64}$/.test(value.generation)||value.recipientClinicId!==null&&(!Number.isInteger(value.recipientClinicId)||value.recipientClinicId<1||value.recipientClinicId>2147483647))fail('scope_denied');return value;}
  function read(receiptRef,context){scope(context);const row=store.db.prepare('SELECT * FROM meta_marketing_lead_receipts WHERE id=?').get(receiptRef);if(!row||keys.filter(k=>k!=='generation').some(k=>row[k]!==context[k]))fail('scope_denied');if(row.generation!==context.generation||row.recipient_clinic!==context.recipientClinicId||row.expires_at<=now())fail('meta_lead_receipt_review_required');return {event:L.event({lead_id:row.lead,page_id:row.page,form_id:row.form,ad_id:row.ad}),recipientClinicId:row.recipient_clinic};}
  function accept({raw,signature,appSecret,context,authorize,allowNew=()=>true,settledDuplicate=()=>false}){
    scope(context);if(!Buffer.isBuffer(raw)||!raw.length||raw.length>65536||!Buffer.isBuffer(appSecret)||!/^[a-f0-9]{32}$/.test(appSecret.toString('ascii'))||typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature)||typeof authorize!=='function')fail('invalid_request');
    authorize();const expected=createHmac('sha256',appSecret).update(raw).digest(),supplied=Buffer.from(signature.slice(7),'hex');
    try{if(!timingSafeEqual(expected,supplied))fail('invalid_signature');}finally{expected.fill(0);supplied.fill(0);}
    // Parsing and all identity projections happen only after HMAC verification.
    let value;try{value=JSON.parse(raw.toString('utf8'));}catch{fail('invalid_request');}
    if(!value||value.object!=='page'||!Array.isArray(value.entry)||value.entry.length>1000)fail('invalid_request');
    const events=new Map();let changes=0;
    for(const entry of value.entry){if(!entry||!M.graphId(entry.id)||!Array.isArray(entry.changes))fail('invalid_request');for(const change of entry.changes){if(++changes>1000)fail('invalid_request');if(change?.field!=='leadgen')fail('scope_denied');if(entry.id!==context.page)continue;
      const v=change.value;if(!v||!M.graphId(v.leadgen_id)||!M.graphId(v.form_id)||v.page_id!=null&&v.page_id!==entry.id||v.ad_id!=null&&!M.graphId(v.ad_id))fail('invalid_request');
      const e=L.event({lead_id:v.leadgen_id,page_id:entry.id,form_id:v.form_id,ad_id:v.ad_id??null}),old=events.get(e.lead_id);if(old&&JSON.stringify(old)!==JSON.stringify(e))fail('idempotency_conflict');events.set(e.lead_id,e);
    }}
    const digest=createHash('sha256').update(raw).digest('hex');
    return store.transaction(()=>{authorize();const receipts=[];for(const e of events.values()){
      let row=store.db.prepare('SELECT * FROM meta_marketing_lead_receipts WHERE app=? AND page=? AND lead=?').get(context.app,context.page,e.lead_id);
      if(row){const settled=settledDuplicate(row,context,digest,e);if(!settled&&(keys.some(k=>row[k]!==context[k])||row.recipient_clinic!==context.recipientClinicId||row.form!==e.form_id||row.ad!==e.ad_id||row.expires_at<=now()))fail('meta_lead_receipt_review_required');if(!allowNew()&&!settled&&row.body_digest!==digest)fail('connection_blocked');}
      else{if(!allowNew())fail('connection_blocked');const id=randomUUID(),at=now();store.db.prepare('INSERT INTO meta_marketing_lead_receipts(id,app,subject,tenant,connection,enrollment,generation,page,account,lead,form,ad,body_digest,created_at,expires_at,recipient_clinic) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,...keys.map(k=>context[k]),e.lead_id,e.form_id,e.ad_id,digest,at,at+RETENTION_MS,context.recipientClinicId);row={id};}
      receipts.push({receiptRef:row.id,event:e});
    }authorize();return {receipts,persisted:true};});
  }
  return {accept,read};
}
module.exports={createMetaMarketingLeadReceipts,RETENTION_MS};
