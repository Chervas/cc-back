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
const CAPILLARY_SCOPE = 'provisional_ainhoa_capillary_c2_drafts';
const CAPILLARY_CONFIRMATION = 'Carlos: C2 es un despacho para tratamientos capilares, y lo usa Ainhoa; ahí se pone también la luz LED. Asignación según el Excel, sin acreditación clínica.';
const CAPILLARY_TARGETS = Object.freeze([
  {id:1999,name:'Dutasteride · freno de la caída · Sesión suelta · mesoterapia con dutasteride más LED fotorregenerador',cabin:'2',room:75,equipment:15,duration:30,source_row:22},
  {id:2001,name:'Vitaminas y aminoácidos · Sesión suelta',cabin:'2',room:75,equipment:null,duration:30,source_row:26},
  {id:2002,name:'Hair Filler · Sesión suelta',cabin:'2',room:75,equipment:null,duration:20,source_row:29},
  {id:2003,name:'Dr. CYJ Hair Filler · protocolo de 4 sesiones · Sesión suelta',cabin:'2',room:75,equipment:null,duration:20,source_row:31},
]);
function scopeConfig(scope) {
  if(scope === 'provisional_piedad_body_injectables_drafts') return {clinic:72,staff:221,sourceProfessional:'Aux. Piedad',
    sourceSheet:'Tratamientos individuales',confirmation:CONFIRMATION,targets:TARGETS,equipment:12,family:'carboxytherapy',home:84};
  if(scope === CAPILLARY_SCOPE) return {clinic:66,staff:50,sourceProfessional:'Aux. Ainhoa',sourceSheet:'Capilar · sesiones y bonos',
    confirmation:CAPILLARY_CONFIRMATION,targets:CAPILLARY_TARGETS,equipment:15,family:'capillary_led',home:75};
  fail('PROVISIONAL_STAFF_SCOPE_INVALID');
}
const fail = code => { throw Error(code); };
function config(row) { return typeof row.clinical_config === 'string' ? JSON.parse(row.clinical_config) : row.clinical_config; }
function prepare({ before, review, createdAt = new Date().toISOString() }) {
  const scope = scopeConfig(review?.scope), count = scope.targets.length;
  if (review?.version !== 1 || review.confirmation_reference !== scope.confirmation || review.workbook_sha256 !== SOURCE
    || review.bindings?.length !== count || new Set(review.bindings.map(r=>r.id)).size !== count || before.treatments.length !== count) fail('PROVISIONAL_STAFF_REVIEW_INVALID');
  if (before.clinics.length !== 1 || before.clinics[0].id_clinica !== scope.clinic || before.clinics[0].grupoClinicaId !== 29
    || before.appointments.length) fail('PROVISIONAL_STAFF_SCOPE_CHANGED');
  const staff = before.staff.find(s=>s.doctor_id === scope.staff && s.clinica_id === scope.clinic);
  if (before.staff.length !== 1 || !staff || !Number(staff.activo) || !Number(staff.recibe_citas)
    || !before.staff_hours.some(h=>h.doctor_clinica_id === staff.id)) fail('PROVISIONAL_STAFF_MEMBERSHIP_CHANGED');
  const equipment = before.equipment.find(e=>e.id === scope.equipment);
  if (before.equipment.length !== 1 || !equipment || equipment.owner_clinic_id !== scope.clinic || equipment.group_id !== 29
    || equipment.family_key !== scope.family || equipment.mobility !== 'fixed' || equipment.status !== 'available'
    || equipment.home_installation_id !== scope.home || equipment.turnaround_minutes !== 0
    || !before.equipment_clinics.some(r=>r.equipment_id === scope.equipment && r.clinic_id === scope.clinic)) fail('PROVISIONAL_STAFF_EQUIPMENT_CHANGED');
  const operations = scope.targets.map(target=>{
    const row = before.treatments.find(r=>r.id_tratamiento === target.id), binding = review.bindings.find(r=>r.id === target.id);
    if (!row || !binding || binding.before_sha256 !== hash(row)) fail('PROVISIONAL_STAFF_TREATMENT_CHANGED');
    const c = config(row), room = before.rooms.find(r=>r.id === target.room);
    const duration = target.duration || 10;
    if (row.nombre !== target.name || row.clinica_id !== scope.clinic || Number(row.activo) !== 0 || row.duracion_min !== duration
      || c?.catalog_status !== 'draft' || c.product_type !== 'treatment' || c.import_batch !== BATCH
      || c.booking_profile || c.source_staff_confirmation || c.source_catalog?.file_sha256 !== SOURCE
      || c.source_catalog?.sheet !== scope.sourceSheet || c.source_cabin !== target.cabin
      || c.source_professional !== scope.sourceProfessional || !c.import_issues?.includes(WARNING)
      || (target.source_row && c.source_catalog.source_row !== target.source_row)) fail('PROVISIONAL_STAFF_DRAFT_NOT_ELIGIBLE');
    if (!room || room.clinica_id !== scope.clinic || !Number(room.activo) || room.capacidad !== 1
      || !room.profesionales_permitidos?.includes(scope.staff) || !before.room_hours.some(h=>h.instalacion_id === room.id)) fail('PROVISIONAL_STAFF_ROOM_CHANGED');
    const phase = {key:'phase_1',label:target.name.slice(0,120),duration_minutes:duration,installation_ids:[target.room],
      professionals:{mode:'any',ids:[scope.staff],preferred_id:scope.staff},
      ...(target.equipment ? {equipment_requirements:[{equipment_ids:[target.equipment]}]} : {})};
    const profile = normalizeBookingProfile({version:target.equipment ? 2 : 1,phases:[phase]});
    return {id:target.id,before:row,before_sha256:hash(row),after_config:{...c,booking_profile:profile,
      import_issues:c.import_issues.filter(issue=>issue !== 'INSTALLATION_INACTIVE'),
      source_staff_confirmation:{version:1,scope:'provisional_agenda_assignment',confirmed_staff_id:scope.staff,
        confirmation_reference:scope.confirmation,recorded_at:createdAt,source_catalog_sha256:hash(c.source_catalog),review_sha256:hash(review),
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
module.exports = {VERSION,SOURCE,CONFIRMATION,WARNING,TARGETS,CAPILLARY_SCOPE,CAPILLARY_CONFIRMATION,CAPILLARY_TARGETS,scopeConfig,prepare,verifyPackage,verifyAfter};
