'use strict';
const {hash,norm,localDateTime,localToUtc}=require('./adapter');
const {phoneKey}=require('./contact-aliases');

// Operator-only, explicitly reviewed exception for native intake names that
// differ from the source surname. This is not a fuzzy identity resolver and
// never deduplicates or changes the corroborating appointment.
function prepareNativeCorroboration({link,source,contacts,appointments,plan,comparison,now=Date.now()}) {
  const review=link.native_first_visit;
  if(!review||link.native_history_visit||!String(review.reason||'').trim()||!Number.isSafeInteger(review.source_row)
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
function prepareHistoryCorroboration({link,source,contacts,histories,now=Date.now()}) {
  const review=link.native_history_visit,captured=Date.parse(histories.captured_at);
  if(!review||!String(review.reason||'').trim()||!Number.isSafeInteger(review.appointment_id)||review.appointment_id<=0
    ||!Number.isSafeInteger(review.created_by)||review.created_by<=0||![66,72].includes(review.clinic_id)
    ||!/^[1-9]\d*$/.test(review.source_appointment_id||'')||link.native_first_visit) throw Error('CONTACT_ALIAS_NATIVE_REVIEW_REQUIRED');
  if(histories.version!==1||histories.origin!=='https://app.clinic-cloud.com'
    ||histories.source_endpoint!=='/apps/contacto/pestanas-contacto-ficha/php/citas/citas.api.php/get-citas'
    ||histories.policy!=='read_only_no_clinical_or_economic_mutations'||!Number.isFinite(captured)
    ||captured>now||now-captured>2*3600000||!Array.isArray(histories.patients)) throw Error('CONTACT_ALIAS_LIVE_EVIDENCE_INVALID_OR_EXPIRED');
  const patients=histories.patients.filter(p=>p.contact_id===source.source_contact_id);
  if(patients.length!==1||!Array.isArray(patients[0].rows)||patients[0].rows.length>5000
    ||patients[0].rows.some(r=>String(r.idContacto)!==source.source_contact_id||Number(r.agenda?.idEmpresa)!==5880)) throw Error('CONTACT_ALIAS_HISTORY_SCOPE_INVALID');
  const rows=patients[0].rows.filter(r=>String(r.idCita)===review.source_appointment_id),appointment=rows[0];
  const start=appointment&&localToUtc(localDateTime(appointment.fechaIni,appointment.horaIni));
  const end=appointment&&localToUtc(localDateTime(appointment.fechaFin,appointment.horaFin));
  if(rows.length!==1||!start||!end||end<=start||![0,1,3,-1,-2].includes(Number(appointment.estado))) throw Error('CONTACT_ALIAS_LIVE_APPOINTMENT_NOT_UNIQUE');
  const phone=phoneKey(source.fields.phone),owners=new Set(contacts.filter(c=>phone&&phoneKey(c.fields.phone)===phone).map(c=>c.source_contact_id));
  if(owners.size!==1||!owners.has(source.source_contact_id)) throw Error('CONTACT_ALIAS_SOURCE_PHONE_NOT_UNIQUE');
  return {kind:'unique_phone_given_name_and_observed_history',source_contact_id:source.source_contact_id,source_phone_unique:true,
    clinic_id:review.clinic_id,native_appointment_id:review.appointment_id,native_created_by:review.created_by,
    start_utc:start,live_appointment_id:review.source_appointment_id,comparison_sha256:hash(histories),source_appointment_sha256:hash(appointment),
    source_state:appointment.estado,reason:review.reason.trim(),identity_only:true};
}
function prepareConfirmedIdentity({link,source,confirmation,now=Date.now()}) {
  const captured=Date.parse(confirmation?.confirmed_at);
  if(link.confirmed_identity!==true||link.native_first_visit||link.native_history_visit
    ||confirmation?.version!==1||confirmation.source!=='user_conversation'
    ||!String(confirmation.confirmation_reference||'').trim()||!String(confirmation.answer||'').trim()
    ||!Number.isFinite(captured)||captured>now||now-captured>2*3600000
    ||!Array.isArray(confirmation.pairs)||!confirmation.pairs.length||confirmation.pairs.length>20
    ||new Set(confirmation.pairs.map(p=>p.source_contact_id)).size!==confirmation.pairs.length
    ||new Set(confirmation.pairs.map(p=>p.patient_id)).size!==confirmation.pairs.length) throw Error('CONTACT_ALIAS_USER_CONFIRMATION_REQUIRED');
  const pairs=confirmation.pairs.filter(p=>p.source_contact_id===source.source_contact_id&&p.patient_id===link.patient_id);
  const pair=pairs[0],sourceName=norm(`${source.fields.name||''} ${source.fields.surname||''}`);
  if(pairs.length!==1||norm(pair.source_full_name)!==sourceName||!norm(pair.patient_full_name)) throw Error('CONTACT_ALIAS_CONFIRMED_PAIR_NOT_IN_EVIDENCE');
  return {kind:'user_confirmed_identity_pair',source_contact_id:source.source_contact_id,patient_id:link.patient_id,
    source_full_name:sourceName,patient_full_name:norm(pair.patient_full_name),confirmation_reference:confirmation.confirmation_reference,
    confirmation_sha256:hash(confirmation)};
}
module.exports={prepareNativeCorroboration,prepareHistoryCorroboration,prepareConfirmedIdentity};
