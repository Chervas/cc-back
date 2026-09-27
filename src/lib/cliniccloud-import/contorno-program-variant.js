'use strict';
// Closed documentary variant: no clinical approval, price, sale or appointment.
const assert=require('node:assert/strict');
const {hash}=require('./adapter');
const {normalizeBookingProfile}=require('../booking-profile');
const {equipmentFitsRoom}=require('../booking-equipment');
const {normalizeValues,payloadHash}=require('../treatmentPrograms.contract');
const {prepare:prepareOriginal}=require('./corporal-program-drafts');
const VERSION='cliniccloud-contorno-program-variant/1';
const CODE='BS26-COR43-PROGRAM';
const parse=value=>typeof value==='string'?JSON.parse(value):value;

function prepare({plan,sourceHashes,before}){
 const original=prepareOriginal({plan,sourceHashes,clinics:before.clinics,treatments:before.treatments,existingPrograms:before.programs});
 assert.equal(before.existingVariants.length,0,'Use original reviewed package for replay');
 assert(before.clinics.some(c=>c.id_clinica===72&&c.equipment_booking_enabled));
 const staff=before.staff.find(s=>s.doctor_id===221&&s.clinica_id===72);
 assert(staff?.activo&&staff.recibe_citas);
 assert(before.staff_hours.some(h=>h.doctor_clinica_id===staff.id&&h.activo&&h.hora_inicio<h.hora_fin));
 const mesotherapy=before.treatments.find(t=>t.id_tratamiento===original.bindings.mesotherapy.id);
 const mesoProfile=normalizeBookingProfile(parse(mesotherapy.clinical_config).booking_profile);
 assert.equal(mesoProfile.phases.length,1);
 assert.equal(mesoProfile.phases[0].duration_minutes,10);
 assert.deepEqual(mesoProfile.phases[0].installation_ids,[82]);
 assert.deepEqual(mesoProfile.phases[0].professionals,{mode:'any',ids:[221],preferred_id:221});
 assert.deepEqual(mesoProfile.phases[0].equipment_requirements||[],[]);
 for(const id of [82,85]){
  const room=before.rooms.find(r=>r.id===id);
  assert(room&&room.clinica_id===72&&room.activo&&room.capacidad===1&&room.tiempo_preparacion_minutos===0);
  assert(parse(room.profesionales_permitidos).includes(221));
  assert(before.room_hours.some(h=>h.instalacion_id===id&&h.activo&&h.hora_inicio<h.hora_fin));
 }
 const profile=normalizeBookingProfile({version:2,phases:[
  [35,10,'Preparación y Cyclone'],[10,4,'EXION y registro, sin cambio de cabina'],
 ].map(([minutes,id,label],i)=>{
  const unit=before.units.find(u=>u.id===id);
  assert(unit&&unit.group_id===29&&unit.owner_clinic_id===72&&unit.status==='available'&&unit.turnaround_minutes===0);
  assert.equal(unit.family_key,id===10?'cyclone':'exion');assert.equal(unit.mobility,id===10?'fixed':'mobile');
  assert.equal(before.units.filter(u=>u.family_key===unit.family_key&&u.status==='available').length,1);
  assert(before.shares.some(s=>s.equipment_id===id&&s.clinic_id===72));
  const canonical=id=>before.aliases.find(a=>a.installation_id===id)?.canonical_installation_id||id;
  assert(equipmentFitsRoom({...unit,fixed_resource_key:'installation:'+canonical(unit.home_installation_id)},
   {resource_key:'installation:'+canonical(85),equipment_policy:before.policies.find(p=>p.installation_id===canonical(85))}));
  return{key:'phase_'+(i+1),label,duration_minutes:minutes,installation_ids:[85],
   professionals:{mode:'any',ids:[221],preferred_id:221},equipment_requirements:[{equipment_ids:[id]}]};
 })});
 const payload={codigo:CODE,nombre:'Cyclone + EXION · sesión de programa (COR-43)',disciplina:'estetica',categoria:'Sesiones de programas corporales',
  origen:'clinica',clinica_id:72,activo:false,precio_base:null,duracion_min:45,sesiones_defecto:1,
  descripcion:'Sesión COR-43 de BS Contorno: 45 minutos en total. No es COR-42 (75 min) ni dos sesiones sueltas. Borrador documental. '+
   'La tarifa de 145 € desde 01/10/2026 se conserva como referencia, no como precio vigente. Requiere prescripción y revisión clínica, profesional, documental y fiscal.',
  clinical_config:{catalog_status:'draft',product_type:'treatment',medical_area_code:'estetica',import_batch:VERSION,fiscal_mapping_pending:true,
   import_issues:['PROGRAM_VARIANT_CLINICAL_REVIEW_REQUIRED','PROGRAM_VARIANT_CONSENT_REVIEW_REQUIRED'],
   source_price:{mode:'unresolved',currency:'EUR',includes_tax:true},
   source_program_variant:{version:1,protocol:'COR-43',program_codes:['COR-05'],pdf_pages:[10,11,32],source_hashes:sourceHashes,
    plan_sha256:plan.plan_sha256,documentary_gross_price:145,effective_date:'2026-10-01',clinical_approval:false,qualification_verified:false,activation:false,
    grouping:'35 min: revisión 5 + preparación 3 + HIFU 10 + cavitación 9 + RF 8. Después: EXION 8 + registro 2. Sin minutos añadidos.',
    assignment:'Piedad según catálogo corporal; no acredita prescripción ni cualificación clínica.'},booking_profile:profile}};
 const definition=original.programs.find(p=>p.code==='COR-05');
 const row=before.programs.find(r=>r.request_key===payloadHash([72,definition.payload.idempotency_key]));
 assert(row&&row.clinic_id===72&&row.version_number===1);
 assert.equal(hash(normalizeValues(row)),hash(normalizeValues(definition.payload)),'Human edit requires review');
 const body={version:VERSION,source_hashes:sourceHashes,plan_sha256:plan.plan_sha256,before,variants:[{key:'contorno',payload}],
  programs:[{code:'COR-05',before:row,mesotherapy_id:mesotherapy.id_tratamiento}],
  policy:{draft_only:true,old_treatments_unchanged:true,clinical_approval:false,prices_assigned:false,appointments_created:false,reminders_activated:false}};
 return{...body,package_sha256:hash(body)};
}
function verifyVariant(row,variant){
 assert(row&&row.clinica_id===72);
 for(const [key,value]of Object.entries(variant.payload)){
  if(key==='activo')assert.equal(Number(row.activo),0);
  else assert.equal(hash(row[key]),hash(value),'Variant field changed: '+key);
 }
}
function programUpdate(program,variants){
 const row=variants.find(t=>t.codigo===CODE);assert(row?.id_tratamiento);
 const appointments=parse(program.before.appointments).map((a,i)=>{
  assert.equal(a.key,'cor_05_'+(i+1));assert.equal(a.treatment_ids.length,0);assert.equal(a.offset_days,i*7);
  const injection=[2,5,8].includes(i+1);
  return{...a,label:`${i+1}/8 · Cyclone + EXION${injection?' + mesoterapia':''}`,
   treatment_ids:[row.id_tratamiento,...(injection?[program.mesotherapy_id]:[])]};
 });assert.equal(appointments.length,8);
 let notes=program.before.notes;
 for(const old of ['Falta crear su variante individual.','No se vincula solo la mesoterapia mientras falte la base.']){assert(notes.includes(old));notes=notes.replace(old,'');}
 notes+='\n\nCOR-43 vinculada como borrador específico de 45 min: C11, Cyclone y preparación 35 min → EXION y registro 10 min, sin cambio de sala. '+
  'En citas 2, 5 y 8 sigue mesoterapia en C9 durante 10 min: total 55 min. Piedad conserva la asignación documental, provisional para inyectables. '+
  'No habilita ventas ni reservas; prescripción, revisión clínica, cualificación, consentimientos y fiscalidad siguen pendientes.';
 return{expected_version:1,status:'draft',appointments,notes};
}
function verifyProgram(row,program,variants){
 assert.equal(row.version_number,2);
 assert.equal(hash(normalizeValues(row)),hash(normalizeValues(programUpdate(program,variants),{current:program.before})));
 for(const key of ['id','public_id','clinic_id','request_key','request_payload_hash','created_by'])assert.equal(hash(row[key]),hash(program.before[key]));
 const instant=value=>new Date(typeof value==='string'&&/^\d{4}-\d\d-\d\d /.test(value)?value.replace(' ','T')+'Z':value).toISOString();
 assert.equal(instant(row.created_at),instant(program.before.created_at));
}
function verifyState(actual,pkg,{complete=false}={}){
 assert.equal(hash({...actual,existingVariants:[],programs:pkg.before.programs}),hash(pkg.before),'Catalog or resources changed');
 assert(actual.existingVariants.length<=1);if(complete)assert.equal(actual.existingVariants.length,1);
 for(const row of actual.existingVariants)verifyVariant(row,pkg.variants[0]);
 assert.equal(actual.programs.length,pkg.before.programs.length);
 for(const old of pkg.before.programs){
  const row=actual.programs.find(p=>p.id===old.id);assert(row);
  const target=pkg.programs.find(p=>p.before.id===old.id);
  if(!target||(!complete&&row.version_number===old.version_number))assert.equal(hash(row),hash(old),'Program edited concurrently');
  else verifyProgram(row,target,actual.existingVariants);
 }
}
module.exports={VERSION,CODE,prepare,programUpdate,verifyVariant,verifyProgram,verifyState};
