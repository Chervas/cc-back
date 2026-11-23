'use strict';

const { createHash,randomUUID } = require('node:crypto');
const { canonical } = require('./canonical');
const { BrokerError,fail } = require('./errors');
const { firstAnalyticsSubjectDigest } = require('./google-property-discovery-contract');
const { TABLE:PUBLICATIONS } = require('./google-first-publication-journal');

const TABLE = 'google_first_analytics_corroborations_v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
 attempt_id TEXT PRIMARY KEY,crm_intent_id TEXT NOT NULL UNIQUE,pins TEXT NOT NULL,pin_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','published','quarantined')),
 receipt_id TEXT,receipt_digest TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 CHECK((state='published' AND receipt_id IS NOT NULL AND receipt_digest IS NOT NULL)
    OR (state<>'published' AND receipt_id IS NULL AND receipt_digest IS NULL))) STRICT`;
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const typed = (value,pattern) => typeof value === 'string' && pattern.test(value);
const equal = (left,right) => canonical(left) === canonical(right);
const domainDigest = pins => digest(['clinicaclick/google-first-analytics-recovery/1',pins]);

function createFirstAnalyticsRecovery({ store,ledger,journal,reobserveCurrent,assertReaderCertificate,policyVersion,maxBacklog,now=Date.now }) {
 if (!store?.db||!ledger?.cancelLocked||!ledger?.getPrivateState||!journal?.getPrivateState
  ||typeof reobserveCurrent!=='function'||typeof assertReaderCertificate!=='function'
  ||!Number.isSafeInteger(maxBacklog)||maxBacklog<1) fail('invalid_request');

 const clock = () => {
  const at=now();
  if(!Number.isSafeInteger(at)||at<=0)fail('invalid_request');
  return at;
 };
 const rowFor = attemptId => store.db.prepare('SELECT * FROM '+TABLE+' WHERE attempt_id=?').get(attemptId);
 store.transaction(() => {
  store.db.exec(DDL);
  const normalize = text => text.replace('IF NOT EXISTS ','').replace(/\s+/g,' ').trim();
  const rows = store.db.prepare('SELECT name,type,sql FROM sqlite_schema WHERE tbl_name=? ORDER BY name').all(TABLE);
  const base = rows.find(row => row.name===TABLE&&row.type==='table');
  if (!base||normalize(base.sql)!==normalize(DDL)||rows.length!==3
    ||rows.filter(row=>row.type==='index'&&row.name.startsWith('sqlite_autoindex_'+TABLE+'_')&&row.sql===null).length!==2) fail('invalid_request');
 });

 function subjectFor(pins) {
  const identity=journal.getPrivateState(pins.proof,pins.owner);
  if (!identity.metadata||!identity.stageIntent||identity.scopeKey!==pins.selection.scopeKey
    ||identity.metadataDigest!==digest(identity.metadata)||identity.stageIntent.metadataDigest!==identity.metadataDigest
    ||identity.stageIntent.versionId!==pins.proof.attemptId
    ||firstAnalyticsSubjectDigest(identity.metadata.googleUserId)!==pins.expectedSubjectDigest) fail('scope_denied');
  return identity;
 }
 function record(pins) {
  const row=rowFor(pins.proof.attemptId);
  if (!row) return null;
  if (row.crm_intent_id!==pins.crmIntentId||row.pins!==canonical(pins)||row.pin_digest!==domainDigest(pins)
    ||row.state==='published'&&(!typed(row.receipt_id,UUID)||!typed(row.receipt_digest,SHA))) fail('idempotency_conflict');
  return row;
 }
 function reserve(pins) {
  const same=record(pins);
  if(same)return same;
  if(store.db.prepare('SELECT 1 FROM '+TABLE+' WHERE crm_intent_id=?').get(pins.crmIntentId))fail('idempotency_conflict');
  subjectFor(pins);
  store.db.prepare('INSERT INTO '+TABLE+' VALUES (?,?,?,?,\'prepared\',NULL,NULL,?,?)')
    .run(pins.proof.attemptId,pins.crmIntentId,canonical(pins),domainDigest(pins),clock(),clock());
  return record(pins);
 }
 function source(pins) {
  if (!store.db.prepare('SELECT 1 FROM '+PUBLICATIONS+' WHERE attempt_id=?').get(pins.proof.attemptId)) return null;
  const current=ledger.getPrivateState(pins.proof,pins.owner);
  if (current.selection&&!equal(current.selection,pins.selection)) fail('idempotency_conflict');
  const plan=current.activationIntent?.vaultPlan;
  if (plan&&(plan.version!==pins.proof.attemptId||plan.scopeKey!==pins.selection.scopeKey
    ||firstAnalyticsSubjectDigest(plan.googleUserId)!==pins.expectedSubjectDigest)) fail('idempotency_conflict');
  return current;
 }
 const asset = pins => ({
  tenantRef:'clinic:'+pins.selection.clinicId,connectionRef:'google-first:analytics:'+pins.selection.scopeKey,assetRef:pins.selection.assetRef,
 });
 const view = (pins,state,receipt=null,includeReceipt=false) => Object.freeze({
  attemptId:pins.proof.attemptId,scopeKey:pins.selection.scopeKey,service:'analytics',
  crmIntentId:pins.crmIntentId,clinicId:pins.selection.clinicId,assetRef:pins.selection.assetRef,secretVersion:pins.proof.attemptId,
  state,receiptId:receipt?.receiptId??null,receiptDigest:receipt?digest(receipt):null,receipt:includeReceipt?receipt:null,
 });
 function assertReceipt(row,receipt,expected) {
  if (!receipt||receipt.receiptId!==expected.receiptId||digest(receipt)!==expected.receiptDigest
    ||row.state==='published'&&(row.receipt_id!==expected.receiptId||row.receipt_digest!==expected.receiptDigest)) fail('idempotency_conflict');
 }
 function audit(pins,operation,requestId,action,reason) {
  const at=clock();
  return { version:2,eventId:randomUUID(),occurredAt:new Date(at).toISOString(),actorType:'service',actorId:pins.owner.principalId,
    tenantRef:asset(pins).tenantRef,connectionRef:asset(pins).connectionRef,resourceRef:asset(pins).assetRef,
    correlationId:requestId,policyVersion,operation,action,result:action==='integration.requested'?'accepted':'success',reason };
 }
 function quarantined(pins) {
  try { store.assertAssetActive(asset(pins)); }
  catch(error) {
   if(error instanceof BrokerError&&error.code==='asset_revoked')return view(pins,'quarantined');
   throw error;
  }
  fail('idempotency_conflict');
 }
 function assertOpen(pins) {
  const row=record(pins);
  if (!row||row.state==='quarantined') fail('asset_revoked');
  store.assertAssetActive(asset(pins));
  return row;
 }
 function begin(pins) {
  return store.transaction(() => {
   reserve(pins);
   assertOpen(pins);
  });
 }
 function readAllowed({ proof,owner,receipt },verification=false) {
  const saved=rowFor(proof.attemptId);
  if (!saved) return false;
  let pins;
  try { pins=JSON.parse(saved.pins); } catch { fail('scope_denied'); }
  if (!pins?.proof||!pins.owner||!pins.selection||!equal(pins.proof,proof)||!equal(pins.owner,owner)
   ||pins.selection.scopeKey!==receipt.scopeKey||pins.selection.clinicId!==receipt.clinicId||pins.selection.assetRef!==receipt.assetRef
   ||pins.expectedSubjectDigest!==firstAnalyticsSubjectDigest(receipt.googleUserId))fail('scope_denied');
  const row=record(pins);
  if(row.state==='quarantined')return false;
  return verification?receipt.validUntil>clock():
   row.state==='published'&&row.receipt_id===receipt.receiptId&&row.receipt_digest===digest(receipt);
 }
 async function observe(pins,{ signal }={}) {
  const row=record(pins);
  if (!row) return view(pins,'unknown');
  if (row.state==='quarantined') return quarantined(pins);
  assertOpen(pins);
  const before=source(pins),plan=before?.activationIntent?.vaultPlan;
  if (!plan) return view(pins,'unknown');
  try { await reobserveCurrent(plan,{ signal }); }
  catch(error) {
   if(!(error instanceof BrokerError)||!['secret_unavailable','secret_version_changed','provider_timeout','broker_unavailable'].includes(error.code))throw error;
   return record(pins)?.state==='quarantined'?quarantined(pins):view(pins,'unknown');
  }
  const fresh=record(pins);
  if(fresh?.state==='quarantined')return quarantined(pins);
  assertOpen(pins);
  const after=source(pins);
  if (!after?.activationIntent||!equal(before.activationIntent,after.activationIntent))fail('idempotency_conflict');
  const closed=after.cancelRequested||after.state!=='confirmed'||subjectFor(pins).cancelRequested;
  if (fresh.state==='published') {
   if(closed)fail('asset_revoked');
   assertReceipt(fresh,after.receipt,{ receiptId:fresh.receipt_id,receiptDigest:fresh.receipt_digest });
   assertReaderCertificate({proof:pins.proof,owner:pins.owner,receipt:after.receipt});
  }
  return view(pins,fresh.state==='published'?'published':'confirmed_current',closed?null:after.receipt,true);
 }
 async function ack(pins,expected,{ signal,operation,requestId }) {
  const start=assertOpen(pins),before=source(pins);
  assertReceipt(start,before?.receipt,expected);
  if (before.state!=='confirmed'||before.cancelRequested||!before.activationReadbackDigest||!before.activationIntent
    ||subjectFor(pins).cancelRequested) fail('scope_denied');
  assertReaderCertificate({proof:pins.proof,owner:pins.owner,receipt:before.receipt});
  await reobserveCurrent(before.activationIntent.vaultPlan,{ signal });
  return store.transaction(() => {
   const current=assertOpen(pins),after=source(pins);
   assertReceipt(current,after?.receipt,expected);
   if(after.state!=='confirmed'||after.cancelRequested||!equal(before.activationIntent,after.activationIntent)
     ||before.activationReadbackDigest!==after.activationReadbackDigest||subjectFor(pins).cancelRequested)fail('idempotency_conflict');
   assertReaderCertificate({proof:pins.proof,owner:pins.owner,receipt:after.receipt});
   if(current.state!=='published'){
    if(store.backlog().pending>=maxBacklog)fail('audit_unavailable');
    const changed=store.db.prepare("UPDATE "+TABLE+" SET state='published',receipt_id=?,receipt_digest=?,updated_at=? WHERE attempt_id=? AND state='prepared'")
      .run(expected.receiptId,expected.receiptDigest,clock(),pins.proof.attemptId).changes;
    if(changed!==1)fail('idempotency_conflict');
    store.appendAudit(audit(pins,operation,requestId,'integration.completed','google_first_analytics_sql_acknowledged'));
   }
   return view(pins,'published',after.receipt);
  });
 }
 function quarantine(pins,{ operation,requestId }) {
  // The database writer reserves a tombstone and invokes the ledger closure
  // in the same SQLite transaction. It works before a reader certificate.
  const before=record(pins);
  if (before?.state==='published')fail('idempotency_conflict');
  if (before?.state==='quarantined')return quarantined(pins);
  const target={...asset(pins),requestId};
  store.revokeAsset(pins.owner.principalId,target,domainDigest(pins),
    audit(pins,operation,requestId,'integration.requested','google_first_analytics_quarantine_requested'),
    audit(pins,operation,requestId,'asset.revoked','google_first_analytics_quarantined'),maxBacklog,clock(),() => {
     const current=reserve(pins);
     if(current.state!=='prepared')fail('idempotency_conflict');
     source(pins);
     ledger.cancelLocked(pins.proof,pins.owner);
     const changed=store.db.prepare("UPDATE "+TABLE+" SET state='quarantined',updated_at=? WHERE attempt_id=? AND state='prepared'")
       .run(clock(),pins.proof.attemptId).changes;
     if(changed!==1)fail('idempotency_conflict');
    });
  return quarantined(pins);
 }
 return Object.freeze({ begin,assertOpen,readAllowed,observe,ack,quarantine });
}
module.exports = { createFirstAnalyticsRecovery,TABLE };
