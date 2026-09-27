'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {prepare:originalPrograms,PDF_SHA256}=require('../../lib/cliniccloud-import/capillary-program-drafts');
const {prepare,verifyVariant,programUpdate,verifyProgram}=require('../../lib/cliniccloud-import/capillary-program-variants');
const {verifyState}=require('../cliniccloud-import-capillary-program-variants');
const {normalizeValues,payloadHash}=require('../../lib/treatmentPrograms.contract');

function fixture(){
  const rows=[],treatments=[];
  for(const [row,minutes,id]of [[22,30,1],[24,30,2],[33,20,3],[31,20,4],[43,10,5],[26,30,2001],[36,10,2005],[39,20,2006]]){
    const source={sheet:'Capilar · sesiones y bonos',source_row:row,kind:'treatment',clinic_id:66,
      proposed_code:'SYNTHETIC-'+row,display_name:'Prueba ficticia '+row,source_catalog_key:'key-'+row,
      provenance:{file_sha256:hash('fiction'),source_row:row}};rows.push(source);
    treatments.push({id_tratamiento:id,nombre:source.display_name,codigo:source.proposed_code,clinica_id:66,origen:'clinica',activo:0,
      duracion_min:minutes,sesiones_defecto:1,clinical_config:{catalog_status:'draft',source_catalog_key:source.source_catalog_key,source_catalog:source.provenance}});
  }
  const body={version:1,mode:'catalog_dry_run_only',workbook_sha256:hash('fiction'),clinics:{medical:72,capilar:66},rows};
  const plan={...body,plan_sha256:hash(body)},clinics=[{id_clinica:66,grupoClinicaId:29}];
  const initial=originalPrograms({plan,pdfSha256:PDF_SHA256,clinics,treatments,existingPrograms:[]});
  const programs=initial.programs.map((p,i)=>({...normalizeValues(p.payload),id:i+1,public_id:'p-'+i,clinic_id:66,version_number:1,
    request_key:payloadHash([66,p.payload.idempotency_key]),request_payload_hash:payloadHash(normalizeValues(p.payload)),created_by:7,created_at:'2026-09-26',updated_by:7}));
  return {plan,pdfSha256:PDF_SHA256,before:{clinics,treatments,programs,existingVariants:[],
    staff:[{id:20,doctor_id:50,clinica_id:66,activo:1,recibe_citas:1}],staff_hours:[{doctor_clinica_id:20,activo:1,hora_inicio:'10:00',hora_fin:'13:00'}],
    rooms:[75,83,86].map(id=>({id,clinica_id:66,activo:1,capacidad:1,tiempo_preparacion_minutos:0,profesionales_permitidos:[50]})),
    room_hours:[75,83,86].map(instalacion_id=>({instalacion_id,activo:1,hora_inicio:'10:00',hora_fin:'13:00'})),
    units:[[12,'carboxytherapy',84],[14,'indiba_rf',87],[15,'capillary_led',75]].map(([id,family_key,home_installation_id])=>({id,family_key,home_installation_id,status:'available',mobility:'fixed',turnaround_minutes:0,group_id:29})),
    shares:[12,14,15].map(equipment_id=>({equipment_id,clinic_id:66})),
    aliases:[{installation_id:83,canonical_installation_id:84},{installation_id:86,canonical_installation_id:87}]}};
}
test('three specific 30-minute variants retain standalone duration, no prices or active treatments',()=>{
  const f=fixture(),before=hash(f),pkg=prepare(f);assert.equal(hash(f),before);
  assert.deepEqual(pkg.variants.map(v=>v.payload.duracion_min),[30,30,30]);
  for(const v of pkg.variants){assert.equal(v.payload.activo,false);assert.equal(v.payload.precio_base,null);assert.equal(v.payload.clinical_config.catalog_status,'draft');assert.equal(v.payload.clinical_config.fiscal_mapping_pending,true);}
  assert.deepEqual(pkg.variants[1].payload.clinical_config.booking_profile.phases.map(p=>[p.duration_minutes,p.installation_ids[0],p.equipment_requirements[0].equipment_ids[0]]),[[18,83,12],[12,75,15]]);
  assert.equal(pkg.variants[0].payload.clinical_config.booking_profile.phases[0].equipment_requirements[0].equipment_ids[0],15);
  assert.equal(pkg.variants[2].payload.clinical_config.booking_profile.phases[0].equipment_requirements[0].equipment_ids[0],14);
});
test('three program updates fill precisely 15 placeholders, preserve all cadence and medical reviews',()=>{
  const f=fixture(),pkg=prepare(f),variants=pkg.variants.map((v,i)=>({...v.payload,id_tratamiento:3000+i}));
  for(const p of pkg.programs){
    const update=programUpdate(p,variants);assert.equal(update.expected_version,1);assert.equal(update.status,'draft');
    assert.deepEqual(update.appointments.map(a=>a.offset_days),p.before.appointments.map(a=>a.offset_days));
    assert.deepEqual(update.appointments.slice(-2),p.before.appointments.slice(-2));
    const row={...p.before,...normalizeValues(update,{current:p.before}),version_number:2};verifyProgram(row,p,variants);
    assert.equal(row.total_price,null);assert.equal(row.cadence,null);
  }
});
test('readback and replay allow only exactly the reviewed partial or complete outcome',()=>{
  const f=fixture(),pkg=prepare(f),state=structuredClone(pkg.before);verifyState(state,pkg);
  state.existingVariants=pkg.variants.map((v,i)=>({...v.payload,id_tratamiento:3000+i}));
  for(const p of pkg.programs){const at=state.programs.findIndex(r=>r.id===p.before.id);state.programs[at]={...p.before,...normalizeValues(programUpdate(p,state.existingVariants),{current:p.before}),version_number:2};verifyState(state,pkg);}
  verifyState(state,pkg,{complete:true});
  state.programs[0].name='Concurrent human edit';assert.throws(()=>verifyState(state,pkg));
});
for(const [label,mutate]of [
  ['wrong PDF',f=>f.pdfSha256='changed'],['wrong clinic',f=>f.before.clinics[0].grupoClinicaId=4],
  ['source alteration',f=>f.plan.rows[0].display_name='changed'],['previous variation',f=>f.before.existingVariants=[{}]],
  ['missing doctor',f=>f.before.staff=[]],['no staff hours',f=>f.before.staff_hours=[]],
  ['closed room',f=>f.before.rooms[0].activo=0],['foreign room',f=>f.before.rooms[0].clinica_id=72],
  ['no room permission',f=>f.before.rooms[0].profesionales_permitidos=[]],['missing room hours',f=>f.before.room_hours=[]],
  ['room buffer',f=>f.before.rooms[0].tiempo_preparacion_minutos=5],['equipment moved',f=>f.before.units[0].home_installation_id=999],
  ['unit unavailable',f=>f.before.units[0].status='maintenance'],['unit mobile',f=>f.before.units[0].mobility='mobile'],
  ['unit not shared',f=>f.before.shares=[]],['wrong unit',f=>f.before.units[0].family_key='shockwave'],
  ['alias missing',f=>f.before.aliases=[]],['program edited',f=>f.before.programs[2].notes+=' human edit'],
  ['program advanced',f=>f.before.programs[2].version_number=2],['base duration edited',f=>f.before.treatments.at(-1).duracion_min=25],
])test('preparation rejects '+label,()=>{const f=fixture();mutate(f);assert.throws(()=>prepare(f));});
test('readback rejects silently free, active, wrong duration and changed phase',()=>{
  const pkg=prepare(fixture()),variant=pkg.variants[0];
  for(const mutate of [r=>r.precio_base=0,r=>r.activo=true,r=>r.duracion_min=40,r=>r.clinical_config.booking_profile.phases[0].installation_ids=[999]]){
    const row={...structuredClone(variant.payload),id_tratamiento:3000};mutate(row);assert.throws(()=>verifyVariant(row,variant));
  }
});
module.exports={fixture};
