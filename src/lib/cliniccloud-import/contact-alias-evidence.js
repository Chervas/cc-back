'use strict';
const {hash}=require('./adapter');
const {phoneKey}=require('./contact-aliases');

// Operator-only, explicitly reviewed exception for native intake names that
// differ from the source surname. This is not a fuzzy identity resolver and
// never deduplicates or changes the corroborating appointment.
function prepareNativeCorroboration({link,source,contacts,appointments,plan,comparison,now=Date.now()}) {
  const review=link.native_first_visit;
  if(!review||!String(review.reason||'').trim()||!Number.isSafeInteger(review.source_row)
    ||!Number.isSafeInteger(review.appointment_id)||review.appointment_id<=0
    ||!Number.isSafeInteger(review.created_by)||review.created_by<=0
    ||![66,72].includes(review.clinic_id)) throw Error('CONTACT_ALIAS_NATIVE_REVIEW_REQUIRED');
  if(hash({manifest:plan.manifest,actions:plan.actions})!==plan.plan_sha256
    ||plan.manifest.source_system!=='cliniccloud'||plan.manifest.source_account!=='cliniccloud-5880'
    ||plan.manifest.automation_policy!=='hold') throw Error('CONTACT_ALIAS_SOURCE_PLAN_INVALID');
  const {comparison_sha256,...body}=comparison;
  const captured=Date.parse(comparison.captured_at);
  if(hash(body)!==comparison_sha256||comparison.plan_sha256!==plan.plan_sha256
    ||!Number.isFinite(captured)||captured>now||now-captured>2*3600000) throw Error('CONTACT_ALIAS_LIVE_EVIDENCE_INVALID_OR_EXPIRED');
  const selected=appointments.filter(a=>a.provenance.source_row===review.source_row);
  const appointment=selected[0];
  if(selected.length!==1||appointment.kind!=='appointment'||appointment.source_contact_id!==source.source_contact_id
    ||appointment.validation_errors.length||appointment.status!=='pendiente') throw Error('CONTACT_ALIAS_SOURCE_APPOINTMENT_INVALID');
  const actions=plan.actions.filter(a=>a.entity==='appointment'&&a.source&&hash(a.source)===hash(appointment));
  if(actions.length!==1) throw Error('CONTACT_ALIAS_SOURCE_APPOINTMENT_NOT_IN_PLAN');
  const rows=comparison.rows.filter(r=>r.action_key===actions[0].action_key&&r.source_row===review.source_row);
  if(rows.length!==1||rows[0].status!=='unique_live_identity_corroborated'||rows[0].state!=='pendiente'
    ||rows[0].live_ids?.length!==1||!/^[1-9]\d*$/.test(rows[0].live_ids[0])) throw Error('CONTACT_ALIAS_LIVE_APPOINTMENT_NOT_UNIQUE');
  const phone=phoneKey(source.fields.phone);
  const sourceOwners=new Set(contacts.filter(c=>phone&&phoneKey(c.fields.phone)===phone).map(c=>c.source_contact_id));
  if(sourceOwners.size!==1||!sourceOwners.has(source.source_contact_id)) throw Error('CONTACT_ALIAS_SOURCE_PHONE_NOT_UNIQUE');
  return {kind:'unique_phone_given_name_and_native_first_visit',source_contact_id:source.source_contact_id,
    source_phone_unique:true,clinic_id:review.clinic_id,native_appointment_id:review.appointment_id,native_created_by:review.created_by,
    start_utc:appointment.start_utc,source_row:review.source_row,source_provenance:appointment.provenance,
    live_appointment_id:rows[0].live_ids[0],comparison_sha256,reason:review.reason.trim()};
}
module.exports={prepareNativeCorroboration};
