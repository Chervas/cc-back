'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture:sourceFixture}=require('./fixtures/corporal_program_drafts.fixture');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {prepare:preparePrograms}=require('../../lib/cliniccloud-import/corporal-program-drafts');
const {normalizeValues,payloadHash}=require('../../lib/treatmentPrograms.contract');
const {prepare,verifyState,SPECS,FAMILIES}=require('../../lib/cliniccloud-import/corporal-program-profiles');

function fixture(){
 const f=sourceFixture(),original=preparePrograms(f);
 const programs=original.programs.map((p,i)=>({id:i+1,public_id:'synthetic-'+i,clinic_id:72,version_number:1,
  request_key:payloadHash([72,p.payload.idempotency_key]),request_payload_hash:payloadHash(normalizeValues(p.payload)),
  created_by:7,created_at:'2026-09-27 00:00:00',...normalizeValues(p.payload)}));
 for(const spec of SPECS){
  const row=f.treatments.find(t=>t.id_tratamiento===original.bindings[spec.key].id);
  row.updatedAt='2026-09-27 00:00:00';row.precio_base=null;
  row.clinical_config.fiscal_mapping_pending=true;row.clinical_config.source_price={amount:123,includes_tax:true};
  row.clinical_config.import_issues=['INSTALLATION_INACTIVE','KEEP_UNRESOLVED_REVIEW'];
  if(spec.key!=='cellulite')row.clinical_config.booking_profile={version:spec.key==='recovery'?2:1,phases:[{key:'phase_1',label:'Synthetic',
   installation_ids:[spec.key==='firmness'?81:87],duration_minutes:spec.minutes,professionals:{ids:[221],mode:'any',preferred_id:221},
   ...(spec.key==='recovery'?{equipment_requirements:[{equipment_ids:[14]}]}:{})}]};
 }
 const before={clinics:f.clinics,treatments:f.treatments,programs,
  staff:[{id:119,doctor_id:221,clinica_id:72,activo:1,recibe_citas:1}],
  staff_hours:[{id:1,doctor_clinica_id:119,activo:1,hora_inicio:'09:30',hora_fin:'13:30'}],
  rooms:[82,85,87].map(id=>({id,clinica_id:72,activo:1,capacidad:1,tiempo_preparacion_minutos:0,profesionales_permitidos:[221]})),
  room_hours:[82,85,87].map(id=>({id,instalacion_id:id,activo:1,hora_inicio:'09:00',hora_fin:'20:00'})),
  units:Object.entries(FAMILIES).map(([s,family_key])=>{const id=Number(s);return{id,family_key,group_id:29,owner_clinic_id:72,status:'available',turnaround_minutes:0,
   mobility:id<10?'mobile':'fixed',home_installation_id:({10:85,11:82,14:87})[id]||null};}),
  shares:Object.keys(FAMILIES).map(id=>({equipment_id:Number(id),clinic_id:72})),aliases:[],
  policies:[{installation_id:82,mode:'none',equipment_ids:[]},...[85,87].map(id=>({installation_id:id,mode:'selected',equipment_ids:[4,6]}))]};
 return{plan:f.plan,sourceHashes:f.sourceHashes,before};
}
function after(pkg){
 const state=structuredClone(pkg.before);
 for(const op of pkg.operations){const row=state.treatments.find(t=>t.id_tratamiento===op.id);row.clinical_config=structuredClone(op.after_config);row.updatedAt='2026-09-27 01:00:00';}
 for(const p of pkg.programs){const row=state.programs.find(t=>t.id===p.before.id);Object.assign(row,normalizeValues(p.payload,{current:p.before}),{version_number:2});}
 return state;
}
test('five documentary profiles, ten ordered resource phases, seven notes-only revisions',()=>{
 const f=fixture(),pkg=prepare(f);assert.equal(pkg.operations.length,5);assert.equal(pkg.programs.length,7);
 for(const [key,rooms,times,equipment]of [
  ['recovery',[87,82],[28,17],[14,11]],['lymphedema',[87,82],[40,20],[14,11]],['lipedema',[87,82],[35,25],[14,11]],
  ['firmness',[87,87],[20,25],[4,14]],['cellulite',[85,85],[27,18],[6,10]]]){
  const op=pkg.operations.find(o=>o.key===key),p=op.after_config.booking_profile;
  assert.equal(p.version,2);assert.deepEqual(p.phases.map(p=>p.installation_ids[0]),rooms);
  assert.deepEqual(p.phases.map(p=>p.duration_minutes),times);assert.deepEqual(p.phases.map(p=>p.equipment_requirements[0].equipment_ids[0]),equipment);
  assert.equal(times.reduce((n,m)=>n+m,0),op.before.duracion_min);assert(p.phases.every(p=>p.professionals.preferred_id===221));
  assert.deepEqual(op.after_config.source_price,op.before.clinical_config.source_price);
  assert.equal(op.after_config.catalog_status,'draft');assert(op.after_config.fiscal_mapping_pending);
  assert(op.after_config.import_issues.includes('KEEP_UNRESOLVED_REVIEW'));assert(!op.after_config.import_issues.includes('INSTALLATION_INACTIVE'));
 }
 const lymph=pkg.operations.find(o=>o.key==='lymphedema');assert(lymph.after_config.import_issues.includes('LYMPHEDEMA_STAFF_QUALIFICATION_UNVERIFIED'));
 for(const p of pkg.programs)assert.deepEqual(Object.keys(p.payload).sort(),['expected_version','notes','status']);
 verifyState(after(pkg),pkg,{complete:true});assert.equal(hash(f.before),hash(pkg.before));
});
test('separate mobile equipment phases do not reserve it during the fixed-machine phase',()=>{
 const pkg=prepare(fixture());for(const key of ['firmness','cellulite']){
  const phases=pkg.operations.find(o=>o.key===key).after_config.booking_profile.phases;
  assert.deepEqual(phases[0].installation_ids,phases[1].installation_ids);
  assert(!phases[1].equipment_requirements[0].equipment_ids.includes(phases[0].equipment_requirements[0].equipment_ids[0]));
 }
});
test('canonical solver and occupancy respect each physical phase and reject a later-room or machine conflict',()=>{
 const {solveBookingProfile,occupancyForSolution}=require('../../lib/booking-profile-solver');
 const pkg=prepare(fixture()),start='2030-01-07T09:00:00Z',windows=[{start:'2030-01-07T08:00:00Z',end:'2030-01-07T20:00:00Z'}];
 for(const op of pkg.operations){
  const profile=op.after_config.booking_profile;
  const context={doctors:new Map([[221,{windows,busy:[]}]]),
   installations:new Map([82,85,87].map(id=>[id,{windows,busy:[],resource_key:'installation:'+id,profesionales_permitidos:[221]}])),
   equipment:new Map(pkg.before.units.map(u=>[u.id,{...u,installation_ids:new Set(u.mobility==='fixed'?[u.home_installation_id]:[85,87]),busy:[]}]))};
  const solution=solveBookingProfile({profile,start,...context});assert(solution);assert.equal(solution.phases.length,2);
  assert.equal(new Date(solution.end_at)-new Date(solution.start_at),op.before.duracion_min*60000);
  const occupancy=occupancyForSolution(solution),machines=occupancy.filter(r=>r.resource_kind==='equipment');
  assert.equal(machines.length,2);assert.equal(machines[0].end_at,machines[1].start_at);
  const second=profile.phases[1],machine=context.equipment.get(second.equipment_requirements[0].equipment_ids[0]);
  machine.busy.push({start:solution.phases[1].start_at,end:solution.end_at});assert.equal(solveBookingProfile({profile,start,...context}),null);machine.busy=[];
  const room=context.installations.get(second.installation_ids[0]);room.busy.push({start:solution.phases[1].start_at,end:solution.end_at});
  assert.equal(solveBookingProfile({profile,start,...context}),null);room.busy=[];
  if(op.key==='firmness'||op.key==='cellulite'){
   context.equipment.get(profile.phases[0].equipment_requirements[0].equipment_ids[0]).busy.push({start:solution.phases[1].start_at,end:solution.end_at});
   assert(solveBookingProfile({profile,start,...context}),'Mobile unit is free after its own phase');
  }
 }
});
for(const [name,mutate]of Object.entries({
 'PDF mismatch':f=>f.sourceHashes[Object.keys(f.sourceHashes)[0]]='wrong',
 'foreign clinic':f=>f.before.rooms[0].clinica_id=66,
 'room capacity':f=>f.before.rooms[0].capacidad=2,
 'staff restriction':f=>f.before.rooms[0].profesionales_permitidos=[],
 'room closed':f=>f.before.room_hours[0].activo=0,
 'staff inactive':f=>f.before.staff[0].activo=0,
 'no staff hours':f=>f.before.staff_hours=[],
 'machine maintenance':f=>f.before.units[0].status='maintenance',
 'machine duplicates':f=>f.before.units.push({...f.before.units[0],id:99}),
 'extra turnaround':f=>f.before.units[0].turnaround_minutes=5,
 'wrong fixed room':f=>f.before.units.find(u=>u.id===14).home_installation_id=82,
 'disallowed mobile':f=>f.before.policies.find(p=>p.installation_id===87).equipment_ids=[],
 'foreign equipment':f=>f.before.units[0].group_id=99,
 'missing equipment access':f=>f.before.shares=[],
 'wrong equipment family':f=>f.before.units[0].family_key='emshape',
 'active treatment':f=>f.before.treatments[0].activo=1,
 'duration changed':f=>f.before.treatments[0].duracion_min=46,
 'new human profile':f=>f.before.treatments[0].clinical_config.booking_profile.phases.push({}),
 'edited program':f=>f.before.programs.find(p=>p.name==='BS Firmeza').notes='Human change',
}))test('rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>prepare(f));});
test('readback rejects unrelated data changes and human edits, preserving all original programs and catalog fields',()=>{
 const pkg=prepare(fixture());verifyState(pkg.before,pkg);assert.throws(()=>verifyState(pkg.before,pkg,{complete:true}));
 for(const mutate of [s=>s.treatments[0].precio_base=99,s=>s.treatments[0].activo=1,s=>s.programs[0].notes='Unexpected',s=>s.staff[0].activo=0,
  s=>s.treatments[0].clinical_config.booking_profile.phases[0].duration_minutes=29]){
  const state=after(pkg);mutate(state);assert.throws(()=>verifyState(state,pkg,{complete:true}));
 }
});
module.exports={fixture};
