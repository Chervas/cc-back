'use strict';
// Documentary booking profiles, never clinical approval or a price/activation.
const assert = require('node:assert/strict');
const { hash } = require('./adapter');
const { normalizeBookingProfile } = require('../booking-profile');
const { equipmentFitsRoom } = require('../booking-equipment');
const { normalizeValues, payloadHash } = require('../treatmentPrograms.contract');
const { prepare: preparePrograms } = require('./corporal-program-drafts');
const VERSION = 'cliniccloud-corporal-program-profiles/1';
const SPECS = [
  { key:'recovery', programs:['COR-09','COR-09-SHORT'], pages:[18,19], minutes:45,
    phases:[[87,28,14,'Valoración incluida e INDIBA'],[82,17,11,'Colocación, Lymphastim y registro']] },
  { key:'lymphedema', programs:['COR-11','COR-11-CONT'], pages:[22,23], minutes:60,
    phases:[[87,40,14,'Revisión documental, medición e INDIBA'],[82,20,11,'Colocación, Lymphastim y registro']] },
  { key:'lipedema', programs:['COR-10'], pages:[20,21], minutes:60,
    phases:[[87,35,14,'Valoración incluida e INDIBA'],[82,25,11,'Lymphastim y registro']] },
  { key:'firmness', programs:['COR-06'], pages:[12,13], minutes:45,
    phases:[[87,20,4,'Preparación y EXION'],[87,25,14,'INDIBA y registro, sin cambio de cabina']] },
  { key:'cellulite', programs:['COR-07'], pages:[14,15], minutes:45,
    phases:[[85,27,6,'Preparación y ondas de choque BTL'],[85,18,10,'RF Cyclone y registro, sin cambio de cabina']] },
];
const FAMILIES = {4:'exion',6:'btl_shockwave',10:'cyclone',11:'btl_lymphastim',14:'indiba_rf'};
const canonical = row => ({...row,clinical_config:typeof row.clinical_config==='string'?JSON.parse(row.clinical_config):row.clinical_config});

function prepare({plan,sourceHashes,before}) {
  const original=preparePrograms({plan,sourceHashes,clinics:before.clinics,treatments:before.treatments,existingPrograms:before.programs});
  const staff=before.staff.find(s=>s.doctor_id===221&&s.clinica_id===72);
  assert(staff?.activo&&staff.recibe_citas,'Documented staff unavailable');
  assert(before.staff_hours.some(h=>h.doctor_clinica_id===staff.id&&h.activo&&h.hora_inicio<h.hora_fin));
  const operations=SPECS.map(spec=>{
    const row=canonical(before.treatments.find(t=>t.id_tratamiento===original.bindings[spec.key].id));
    const current=row.clinical_config, prior=current.booking_profile;
    // A new custom/expanded profile is not ours to replace on preparation.
    if(spec.key==='cellulite')assert(!prior,'Combined profile already edited');
    else {
      assert(prior&&prior.phases.length===1);
      const phase=prior.phases[0];
      assert.deepEqual(phase.installation_ids,[spec.key==='firmness'?81:87]);
      assert.deepEqual(phase.professionals,{ids:[221],mode:'any',preferred_id:221});
      assert.equal(phase.duration_minutes,spec.minutes);
      assert.deepEqual(phase.equipment_requirements||[],spec.key==='recovery'?[{equipment_ids:[14]}]:[]);
    }
    assert(!current.source_corporal_profile,'Already prepared: use reviewed package for replay');
    const profile=normalizeBookingProfile({version:2,phases:spec.phases.map(([roomId,minutes,equipment,label],i)=>{
      const room=before.rooms.find(r=>r.id===roomId),unit=before.units.find(u=>u.id===equipment);
      assert(room&&room.clinica_id===72&&room.activo&&room.capacidad===1&&room.tiempo_preparacion_minutos===0);
      assert(room.profesionales_permitidos.includes(221));
      assert(before.room_hours.some(h=>h.instalacion_id===roomId&&h.activo&&h.hora_inicio<h.hora_fin));
      assert(unit&&unit.group_id===29&&unit.owner_clinic_id===72&&unit.family_key===FAMILIES[equipment]);
      assert(unit.mobility===(equipment===4||equipment===6?'mobile':'fixed')&&unit.turnaround_minutes===0);
      assert.equal(before.units.filter(u=>u.family_key===unit.family_key&&u.status==='available').length,1);
      assert(before.shares.some(s=>s.equipment_id===equipment&&s.clinic_id===72));
      const canonicalId=id=>before.aliases.find(a=>a.installation_id===id)?.canonical_installation_id||id;
      assert(equipmentFitsRoom({...unit,fixed_resource_key:'installation:'+canonicalId(unit.home_installation_id)},
        {resource_key:'installation:'+canonicalId(roomId),equipment_policy:before.policies.find(p=>p.installation_id===canonicalId(roomId))}), 'Equipment not physically compatible');
      return {key:'phase_'+(i+1),label,duration_minutes:minutes,installation_ids:[roomId],
        professionals:{mode:'any',ids:[221],preferred_id:221},equipment_requirements:[{equipment_ids:[equipment]}]};
    })});
    assert.equal(profile.phases.reduce((sum,p)=>sum+p.duration_minutes,0),row.duracion_min);
    const config={...current,booking_profile:profile,
      import_issues:[...new Set((current.import_issues||[]).filter(i=>!['INSTALLATION_INACTIVE','MULTI_CABIN_PHASE_DISTRIBUTION_REQUIRED'].includes(i))
        .concat('CORPORAL_PROFILE_CLINICAL_REVIEW_REQUIRED',spec.key==='lymphedema'?['LYMPHEDEMA_STAFF_QUALIFICATION_UNVERIFIED']:[]))],
      source_corporal_profile:{version:VERSION,pdf_sha256:sourceHashes['BS-Medical-Protocolos-V1-Corporal (2) - copia.pdf'],pages:spec.pages,
        previous_profile:prior||null,before_sha256:hash(row),clinical_approval:false,qualification_verified:false,
        grouping:'Consecutive source steps by required machine; preparation and recording included, no added minutes.',
        assignment:'Piedad retained from workbook; not an accreditation or prescription.'}};
    return {key:spec.key,id:row.id_tratamiento,before:row,before_sha256:hash(row),after_config:config};
  });
  const programs=original.programs.filter(p=>SPECS.some(s=>s.programs.includes(p.code))).map(p=>{
    const row=before.programs.find(r=>r.request_key===payloadHash([72,p.payload.idempotency_key]));
    assert(row&&row.version_number===1,'Only unchanged original definitions');
    assert.equal(hash(normalizeValues(row)),hash(normalizeValues(p.payload)),'Program was edited');
    const spec=SPECS.find(s=>s.programs.includes(p.code));
    const resources=spec.phases.map(([room,minutes,equipment])=>`C${{82:9,85:11,87:12}[room]}: ${minutes} min (${FAMILIES[equipment]})`).join(' → ');
    let notes=row.notes
      .replace('Falta conciliar su perfil con el INDIBA fijo de C12 y el EXION móvil.','EXION móvil e INDIBA fijo ya tienen un perfil documental en C12.')
      .replace('Ondas BTL y Cyclone son equipos distintos; no mantener C10 como sala de ondas móviles.','Ondas BTL y Cyclone son equipos distintos: perfil documental en C11, no en C10.')
      .replace('Requiere alta escrita del cirujano y conciliación de las dos salas fijas.','Requiere alta escrita del cirujano; el perfil documental ya distingue las dos salas fijas.')
      .replace('queda por conciliar el perfil de ambas salas.','el perfil documental ya distingue ambas salas.');
    notes+='\n\nPerfil de agenda preparado desde el protocolo: '+resources+'. Piedad conserva la asignación documental. No añade minutos de limpieza ni traslado. Revisión clínica, formación cuando proceda, consentimientos, pauta y fiscalidad siguen pendientes; no habilita ventas ni reservas.';
    return {code:p.code,before:row,payload:{expected_version:1,status:'draft',notes}};
  });
  assert.equal(operations.length,5);assert.equal(programs.length,7);
  const body={version:VERSION,source_hashes:sourceHashes,plan_sha256:plan.plan_sha256,before,operations,programs,
    policy:{draft_only:true,activation:false,clinical_approval:false,prices_changed:false,appointments_changed:false,reminders_activated:false}};
  return {...body,package_sha256:hash(body)};
}
function verifyTreatment(row,op) {
  const current=canonical(row);assert.equal(hash(current.clinical_config),hash(op.after_config));
  assert.equal(hash({...current,clinical_config:op.before.clinical_config,updatedAt:op.before.updatedAt}),op.before_sha256,'Non-profile field changed');
}
function verifyProgram(row,p) {
  assert.equal(row.version_number,2);
  assert.equal(hash(normalizeValues(row)),hash(normalizeValues(p.payload,{current:p.before})));
  for(const k of ['id','public_id','clinic_id','request_key','request_payload_hash','created_by'])assert.equal(hash(row[k]),hash(p.before[k]),'Program identity changed: '+k);
  // SQL dateStrings and canonical JSON snapshots serialize the same UTC instant differently.
  const instant=value=>new Date(typeof value==='string'&&/^\d{4}-\d\d-\d\d /.test(value)?value.replace(' ','T')+'Z':value).toISOString();
  assert.equal(instant(row.created_at),instant(p.before.created_at));
}
function verifyState(actual,pkg,{complete=false,profilesComplete=false}={}) {
  assert.equal(actual.treatments.length,pkg.before.treatments.length);assert.equal(actual.programs.length,pkg.before.programs.length);
  for(const old of pkg.before.treatments){
    const row=actual.treatments.find(t=>t.id_tratamiento===old.id_tratamiento),op=pkg.operations.find(o=>o.id===old.id_tratamiento);assert(row);
    if(op&&(complete||profilesComplete||hash(row)!==hash(old)))verifyTreatment(row,op);else assert.equal(hash(row),hash(old));
  }
  for(const old of pkg.before.programs){
    const row=actual.programs.find(p=>p.id===old.id),op=pkg.programs.find(p=>p.before.id===old.id);assert(row);
    if(op&&(complete||hash(row)!==hash(old)))verifyProgram(row,op);else assert.equal(hash(row),hash(old));
  }
  assert.equal(hash({...actual,treatments:pkg.before.treatments,programs:pkg.before.programs}),hash(pkg.before),'Resource state changed');
}
module.exports={VERSION,SPECS,FAMILIES,prepare,verifyTreatment,verifyProgram,verifyState};
