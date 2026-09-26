'use strict';
// This operational draft assignment is NOT approval of an injectable procedure
// or of the staff member's clinical qualification. The clinical warning stays.
const { hash } = require('./adapter');
const { BATCH } = require('./catalog-drafts');
const { normalizeBookingProfile } = require('../booking-profile');
const VERSION = 'cliniccloud-catalog-provisional-staff/1';
const SOURCE = 'cc1beeda3e882f2811f08a0111b5ddab660dff973b7d79d1bec48367ef0705aa';
const CONFIRMATION = 'Carlos: de momento ponme a piedad, luego vemos si se cambia; respuesta a carboxiterapia y mesoterapia corporal.';
const WARNING = 'INJECTABLE_STAFF_REQUIRES_CLINICAL_VALIDATION';
const TARGETS = Object.freeze([
  { id:1973, name:'INYECTABLES CORPORALES · Carboxiterapia corporal · 500–800 cc', cabin:'10', room:84, equipment:12 },
  { id:1974, name:'INYECTABLES CORPORALES · Mesoterapia lipolítica y anticelulítica', cabin:'9', room:82, equipment:null },
]);
const fail = code => { throw Error(code); };
function config(row) { return typeof row.clinical_config === 'string' ? JSON.parse(row.clinical_config) : row.clinical_config; }
function prepare({ before, review, createdAt = new Date().toISOString() }) {
  if (review?.version !== 1 || review.confirmation_reference !== CONFIRMATION || review.workbook_sha256 !== SOURCE
    || review.scope !== 'provisional_piedad_body_injectables_drafts' || review.bindings?.length !== 2
    || new Set(review.bindings.map(r=>r.id)).size !== 2 || before.treatments.length !== 2) fail('PROVISIONAL_STAFF_REVIEW_INVALID');
  if (before.clinics.length !== 1 || before.clinics[0].id_clinica !== 72 || before.clinics[0].grupoClinicaId !== 29
    || before.appointments.length) fail('PROVISIONAL_STAFF_SCOPE_CHANGED');
  const staff = before.staff.find(s=>s.doctor_id === 221 && s.clinica_id === 72);
  if (before.staff.length !== 1 || !staff || !Number(staff.activo) || !Number(staff.recibe_citas)
    || !before.staff_hours.some(h=>h.doctor_clinica_id === staff.id)) fail('PROVISIONAL_STAFF_MEMBERSHIP_CHANGED');
  const equipment = before.equipment.find(e=>e.id === 12);
  if (before.equipment.length !== 1 || !equipment || equipment.owner_clinic_id !== 72 || equipment.group_id !== 29
    || equipment.family_key !== 'carboxytherapy' || equipment.mobility !== 'fixed' || equipment.status !== 'available'
    || equipment.home_installation_id !== 84 || equipment.turnaround_minutes !== 0
    || !before.equipment_clinics.some(r=>r.equipment_id === 12 && r.clinic_id === 72)) fail('PROVISIONAL_STAFF_EQUIPMENT_CHANGED');
  const operations = TARGETS.map(target=>{
    const row = before.treatments.find(r=>r.id_tratamiento === target.id), binding = review.bindings.find(r=>r.id === target.id);
    if (!row || !binding || binding.before_sha256 !== hash(row)) fail('PROVISIONAL_STAFF_TREATMENT_CHANGED');
    const c = config(row), room = before.rooms.find(r=>r.id === target.room);
    if (row.nombre !== target.name || row.clinica_id !== 72 || Number(row.activo) !== 0 || row.duracion_min !== 10
      || c?.catalog_status !== 'draft' || c.product_type !== 'treatment' || c.import_batch !== BATCH
      || c.booking_profile || c.source_staff_confirmation || c.source_catalog?.file_sha256 !== SOURCE
      || c.source_catalog?.sheet !== 'Tratamientos individuales' || c.source_cabin !== target.cabin
      || c.source_professional !== 'Aux. Piedad' || !c.import_issues?.includes(WARNING)) fail('PROVISIONAL_STAFF_DRAFT_NOT_ELIGIBLE');
    if (!room || room.clinica_id !== 72 || !Number(room.activo) || room.capacidad !== 1
      || !room.profesionales_permitidos?.includes(221) || !before.room_hours.some(h=>h.instalacion_id === room.id)) fail('PROVISIONAL_STAFF_ROOM_CHANGED');
    const phase = {key:'phase_1',label:target.name.slice(0,120),duration_minutes:10,installation_ids:[target.room],
      professionals:{mode:'any',ids:[221],preferred_id:221},
      ...(target.equipment ? {equipment_requirements:[{equipment_ids:[target.equipment]}]} : {})};
    const profile = normalizeBookingProfile({version:target.equipment ? 2 : 1,phases:[phase]});
    return {id:target.id,before:row,before_sha256:hash(row),after_config:{...c,booking_profile:profile,
      import_issues:c.import_issues.filter(issue=>issue !== 'INSTALLATION_INACTIVE'),
      source_staff_confirmation:{version:1,scope:'provisional_agenda_assignment',confirmed_staff_id:221,
        confirmation_reference:CONFIRMATION,recorded_at:createdAt,source_catalog_sha256:hash(c.source_catalog),review_sha256:hash(review),
        qualification_verified:false,activation:false,existing_reservations_reconciled:false}}};
  });
  const body = {version:VERSION,target:'crm',created_at:createdAt,review,before,before_sha256:hash(before),operations,
    policy:{inactive_drafts_only:true,clinical_warning_preserved:true,clinical_qualification_approved:false,
      prices_changed:false,appointments_changed:false,reminders_activated:false}};
  return {...body,package_sha256:hash(body)};
}
function verifyPackage(pkg) {
  if (hash(pkg) !== hash(prepare({before:pkg.before,review:pkg.review,createdAt:pkg.created_at}))) fail('PROVISIONAL_STAFF_PACKAGE_CHANGED');
}
function verifyAfter(actual,pkg) {
  for (const op of pkg.operations) {
    const row=actual.treatments.find(r=>r.id_tratamiento === op.id);
    if (!row || hash(config(row)) !== hash(op.after_config)
      || hash({...row,clinical_config:op.before.clinical_config,updatedAt:op.before.updatedAt}) !== op.before_sha256) fail('PROVISIONAL_STAFF_READBACK_MISMATCH');
  }
  if (hash({...actual,treatments:pkg.before.treatments}) !== pkg.before_sha256) fail('PROVISIONAL_STAFF_UNRELATED_CHANGE');
}
module.exports = {VERSION,SOURCE,CONFIRMATION,WARNING,TARGETS,prepare,verifyPackage,verifyAfter};
