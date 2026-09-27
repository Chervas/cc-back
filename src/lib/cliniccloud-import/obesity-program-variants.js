'use strict';
// Documentary import only. No diagnosis, prescriptions, activation or patient writes.
const assert=require('node:assert/strict');
const {hash}=require('./adapter');
const {verifyPlan}=require('./catalog-drafts');
const {normalizeBookingProfile}=require('../booking-profile');
const {equipmentFitsRoom}=require('../booking-equipment');
const VERSION='cliniccloud-obesity-program-variants/1';
const SOURCES=Object.freeze({
 'BS-Medical-Protocolos-V4-Obesidad.pdf':'ec28b4ea7bdfcb204afd6af0b2e638f8db1f570e3dc743fc82cec25e0c768672',
 'Tarifa-2026-Obesidad (2).pdf':'e5f1158c07ead27bfbcf2139d2011f657bc547a4f8a6944011347911fd3bc136',
});
const CODES=['BS26-OBE22-PROGRAM','BS26-OBE27-PROGRAM'];
function sourceTreatment(plan,treatments,sheet,sourceRow,minutes,{allowMissingKey=false}={}){
 const sources=plan.rows.filter(r=>r.sheet===sheet&&r.source_row===sourceRow&&r.kind==='treatment');
 assert.equal(sources.length,1);const source=sources[0];assert.equal(source.clinic_id,72);
 const rows=treatments.filter(t=>t.codigo===source.proposed_code);assert.equal(rows.length,1);
 const row=rows[0],config=row.clinical_config;
 assert.equal(row.clinica_id,72);assert.equal(row.origen,'clinica');assert.equal(row.nombre,source.display_name);
 assert.equal(Number(row.sesiones_defecto),1);assert.equal(Number(row.duracion_min),minutes);
 assert.equal(Number(row.activo),0);assert.equal(config.catalog_status,'draft');
 assert.equal(hash(config.source_catalog),hash(source.provenance));
 if(!allowMissingKey||config.source_catalog_key!=null)assert.equal(config.source_catalog_key,source.source_catalog_key);
 return row;
}
function definitions({plan,sourceHashes,treatments}){
 verifyPlan(plan);assert.equal(hash(sourceHashes),hash(SOURCES),'OBESITY_SOURCES_CHANGED');
 const glp=sourceTreatment(plan,treatments,'Obesidad · tarifa',16,5);
 const recovery=sourceTreatment(plan,treatments,'Tratamientos individuales',9,45);
 const gp=normalizeBookingProfile(glp.clinical_config.booking_profile),rp=normalizeBookingProfile(recovery.clinical_config.booking_profile);
 assert.equal(gp.phases.length,1);assert.deepEqual(gp.phases[0].installation_ids,[80]);
 assert.deepEqual(gp.phases[0].professionals,{mode:'any',ids:[53],preferred_id:53});assert.equal(gp.phases[0].duration_minutes,5);
 assert.deepEqual(gp.phases[0].equipment_requirements||[],[]);
 assert.equal(rp.phases.length,2);
 assert.deepEqual(rp.phases.map(p=>[p.duration_minutes,p.installation_ids,p.equipment_requirements]),
  [[28,[87],[{equipment_ids:[14]}]],[17,[82],[{equipment_ids:[11]}]]]);
 for(const p of rp.phases)assert.deepEqual(p.professionals,{mode:'any',ids:[221],preferred_id:221});
 return [
  {key:'glp',code:CODES[0],base:glp,protocol:'OBE-22',pages:[24],minutes:30,discipline:'general',
   name:'Seguimiento médico GLP-1 · sesión de programa (30 min)',
   detail:'Consulta del programa de tres seguimientos; no sustituye la receta individual de 5 min. No prescribe ni dispensa medicación. Camacho/C7 conserva la asignación documental; elección de otro médico pendiente de configurar, sin incluir a Garrido.',
   profile:{version:2,phases:[{...gp.phases[0],label:'Seguimiento médico GLP-1',duration_minutes:30}]}},
  {key:'ligereza',code:CODES[1],base:recovery,protocol:'OBE-27',pages:[29,30],minutes:45,discipline:'estetica',
   name:'BS Ligereza · INDIBA + Lymphastim (45 min)',
   detail:'Variante de pérdida de peso; no sustituye al drenaje postoperatorio. C12: valoración incluida 5 + INDIBA 18 = 23 min. Después C9: colocación 3 + Lymphastim 17 + registro 2 = 22 min. Piedad conserva la asignación documental, sin acreditar cualificación ni prescripción.',
   profile:{version:2,phases:rp.phases.map((p,i)=>({...p,duration_minutes:[23,22][i],label:['Valoración incluida e INDIBA · Ligereza','Colocación, Lymphastim y registro · Ligereza'][i]}))}},
 ].map(s=>({key:s.key,payload:{codigo:s.code,nombre:s.name,disciplina:s.discipline,categoria:'Sesiones de programas de obesidad',
   origen:'clinica',clinica_id:72,activo:false,precio_base:null,duracion_min:s.minutes,sesiones_defecto:1,
   descripcion:s.detail+' Borrador documental: revisar clínica, consentimientos y fiscalidad antes de activar.',
   clinical_config:{catalog_status:'draft',product_type:'treatment',medical_area_code:s.discipline,import_batch:VERSION,
    fiscal_mapping_pending:true,import_issues:['PROGRAM_VARIANT_CLINICAL_REVIEW_REQUIRED','PROGRAM_VARIANT_CONSENT_REVIEW_REQUIRED'],
    source_price:{mode:'included',currency:'EUR',includes_tax:true},
    source_program_variant:{version:1,protocol:s.protocol,pdf_pages:s.pages,source_hashes:sourceHashes,plan_sha256:plan.plan_sha256,
     base_treatment_id:s.base.id_tratamiento,base_sha256:hash(s.base),effective_date:'2026-10-01',clinical_approval:false,qualification_verified:false,activation:false},
    booking_profile:normalizeBookingProfile(s.profile)}}}));
}
function prepare({plan,sourceHashes,before}){
 assert.equal(before.existingVariants.length,0,'Replay must use original package');
 assert(before.clinics.some(c=>c.id_clinica===72&&c.grupoClinicaId===29&&c.equipment_booking_enabled));
 const variants=definitions({plan,sourceHashes,treatments:before.treatments});
 for(const v of variants)for(const p of v.payload.clinical_config.booking_profile.phases){
  const doctor=p.professionals.ids[0],staff=before.staff.find(s=>s.doctor_id===doctor&&s.clinica_id===72);
  assert(staff?.activo&&staff.recibe_citas);assert(before.staff_hours.some(h=>h.doctor_clinica_id===staff.id&&h.activo&&h.hora_inicio<h.hora_fin));
  const room=before.rooms.find(r=>r.id===p.installation_ids[0]);
  assert(room&&room.clinica_id===72&&room.activo&&room.capacidad===1&&room.tiempo_preparacion_minutos===0);
  assert(!room.profesionales_permitidos?.length||room.profesionales_permitidos.includes(doctor));
  assert(before.room_hours.some(h=>h.instalacion_id===room.id&&h.activo&&h.hora_inicio<h.hora_fin));
  for(const id of (p.equipment_requirements||[]).flatMap(r=>r.equipment_ids)){
   const unit=before.units.find(u=>u.id===id);
   assert(unit&&unit.group_id===29&&unit.owner_clinic_id===72&&unit.status==='available'&&unit.turnaround_minutes===0);
   assert.equal(unit.mobility,'fixed');assert.equal(unit.family_key,id===14?'indiba_rf':'btl_lymphastim');
   assert.equal(before.units.filter(u=>u.family_key===unit.family_key&&u.status==='available').length,1);
   assert(before.shares.some(s=>s.equipment_id===id&&s.clinic_id===72));
   const canonical=id=>before.aliases.find(a=>a.installation_id===id)?.canonical_installation_id||id;
   assert(equipmentFitsRoom({...unit,fixed_resource_key:'installation:'+canonical(unit.home_installation_id)},
    {resource_key:'installation:'+canonical(room.id),equipment_policy:before.policies.find(r=>r.installation_id===canonical(room.id))}));
  }
 }
 const body={version:VERSION,source_hashes:sourceHashes,plan_sha256:plan.plan_sha256,before,variants,
  policy:{draft_only:true,old_treatments_unchanged:true,old_programs_unchanged:true,clinical_approval:false,prices_assigned:false,
   prescriptions_created:false,appointments_created:false,reminders_activated:false}};
 return{...body,package_sha256:hash(body)};
}
function verifyVariant(row,variant){
 assert(row&&row.clinica_id===72);
 for(const [key,value]of Object.entries(variant.payload)){
  if(key==='activo')assert.equal(Number(row.activo),0);
  else assert.equal(hash(row[key]),hash(value),'Variant changed: '+key);
 }
}
function verifyState(actual,pkg,{complete=false}={}){
 assert.equal(hash({...actual,existingVariants:[]}),hash(pkg.before),'Existing catalog or resources changed');
 assert(actual.existingVariants.length<=pkg.variants.length);
 if(complete)assert.equal(actual.existingVariants.length,pkg.variants.length);
 for(const v of pkg.variants){
  const rows=actual.existingVariants.filter(t=>t.codigo===v.payload.codigo);assert(rows.length<=1);
  if(complete)assert.equal(rows.length,1);if(rows.length)verifyVariant(rows[0],v);
 }
 assert(actual.existingVariants.every(t=>CODES.includes(t.codigo)));
}
module.exports={VERSION,SOURCES,CODES,sourceTreatment,definitions,prepare,verifyVariant,verifyState};
