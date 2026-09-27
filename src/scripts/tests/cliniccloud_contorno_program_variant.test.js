'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture:profilesFixture}=require('./cliniccloud_corporal_program_profiles.test');
const {prepare:prepareProfiles}=require('../../lib/cliniccloud-import/corporal-program-profiles');
const {prepare:prepareOriginal}=require('../../lib/cliniccloud-import/corporal-program-drafts');
const {prepare,programUpdate,verifyProgram,verifyState,CODE}=require('../../lib/cliniccloud-import/contorno-program-variant');
const {normalizeValues}=require('../../lib/treatmentPrograms.contract');
const {catalogPrice}=require('../../lib/treatment-catalog-contract');
const {hash}=require('../../lib/cliniccloud-import/adapter');
function fixture(){
 const f=profilesFixture(),profiles=prepareProfiles(f);
 for(const op of profiles.operations)f.before.treatments.find(t=>t.id_tratamiento===op.id).clinical_config=op.after_config;
 for(const p of profiles.programs)Object.assign(f.before.programs.find(r=>r.id===p.before.id),normalizeValues(p.payload,{current:p.before}),{version_number:2});
 f.before.clinics[0].equipment_booking_enabled=1;f.before.existingVariants=[];
 const originals=prepareOriginal({plan:f.plan,sourceHashes:f.sourceHashes,clinics:f.before.clinics,treatments:f.before.treatments,existingPrograms:f.before.programs});
 f.before.treatments.find(t=>t.id_tratamiento===originals.bindings.mesotherapy.id).clinical_config.booking_profile={version:1,phases:[{
  key:'meso',label:'Mesoterapia',duration_minutes:10,installation_ids:[82],professionals:{mode:'any',ids:[221],preferred_id:221}}]};
 return f;
}
function applied(pkg){
 const state=structuredClone(pkg.before),variant={id_tratamiento:100,...structuredClone(pkg.variants[0].payload),activo:0};
 state.existingVariants=[variant];const p=pkg.programs[0];
 Object.assign(state.programs.find(r=>r.id===p.before.id),normalizeValues(programUpdate(p,[variant]),{current:p.before}),{version_number:2});
 return state;
}
test('COR-43 creates one inactive price-less 45-min variant; all eight visits linked, mesotherapy only 2/5/8',()=>{
 const pkg=prepare(fixture()),state=applied(pkg),variant=pkg.variants[0].payload;
 assert.equal(variant.codigo,CODE);assert.equal(variant.activo,false);assert.equal(variant.precio_base,null);
 assert.equal(catalogPrice(variant).amount,null);assert(catalogPrice(variant).review_required);
 assert.deepEqual(variant.clinical_config.booking_profile.phases.map(p=>[p.duration_minutes,p.installation_ids,p.equipment_requirements[0].equipment_ids]),[[35,[85],[10]],[10,[85],[4]]]);
 const p=programUpdate(pkg.programs[0],state.existingVariants);
 assert.deepEqual(p.appointments.map(a=>a.offset_days),[0,7,14,21,28,35,42,49]);
 assert.deepEqual(p.appointments.map(a=>a.treatment_ids.length),[1,2,1,1,2,1,1,2]);
 assert(!p.notes.includes('Falta crear su variante'));assert(p.notes.includes('55 min'));assert(p.notes.includes('01/10/2026'));
 verifyState(state,pkg,{complete:true});assert.equal(hash(state.treatments),hash(pkg.before.treatments));
});
test('partial replay accepts created variant but never a changed program or duplicate',()=>{
 const pkg=prepare(fixture()),state=applied(pkg);state.programs=structuredClone(pkg.before.programs);
 verifyState(state,pkg);assert.throws(()=>verifyState(state,pkg,{complete:true}));
 state.existingVariants.push({...state.existingVariants[0],id_tratamiento:101});assert.throws(()=>verifyState(state,pkg));
});
test('canonical solver reserves C11 continuously and machines only during their phases; mesotherapy follows in C9',()=>{
 const {solveBookingProfile,occupancyForSolution}=require('../../lib/booking-profile-solver');
 const pkg=prepare(fixture()),profile=structuredClone(pkg.variants[0].payload.clinical_config.booking_profile);
 const meso=pkg.before.treatments.find(t=>t.id_tratamiento===pkg.programs[0].mesotherapy_id);
 profile.phases.push({...meso.clinical_config.booking_profile.phases[0],key:'phase_3'});
 const windows=[{start:'2030-01-07T08:00:00Z',end:'2030-01-07T20:00:00Z'}],context={
  doctors:new Map([[221,{windows,busy:[]}]]),installations:new Map([85,82].map(id=>[id,{windows,busy:[],resource_key:'installation:'+id,profesionales_permitidos:[221]}])),
  equipment:new Map(pkg.before.units.map(u=>[u.id,{...u,installation_ids:new Set(u.mobility==='fixed'?[u.home_installation_id]:[85,87]),busy:[]}]))};
 const start='2030-01-07T09:00:00Z',solution=solveBookingProfile({profile,start,...context});assert(solution);
 assert.equal(new Date(solution.end_at)-new Date(solution.start_at),55*60000);
 const machines=occupancyForSolution(solution).filter(r=>r.resource_kind==='equipment');assert.equal(machines.length,2);
 context.equipment.get(4).busy=[{start,end:solution.phases[1].start_at}];assert(solveBookingProfile({profile,start,...context}));
 context.equipment.get(4).busy=[{start:solution.phases[1].start_at,end:solution.end_at}];assert.equal(solveBookingProfile({profile,start,...context}),null);
 context.equipment.get(4).busy=[];context.installations.get(82).busy=[{start:solution.phases[2].start_at,end:solution.end_at}];
 assert.equal(solveBookingProfile({profile,start,...context}),null);
});
for(const [name,mutate]of Object.entries({
 'wrong PDF':f=>f.sourceHashes[Object.keys(f.sourceHashes)[0]]='wrong',
 'existing variant':f=>f.before.existingVariants.push({codigo:CODE}),
 'equipment disabled':f=>f.before.clinics[0].equipment_booking_enabled=0,
 'no staff hours':f=>f.before.staff_hours=[],
 'room capacity':f=>f.before.rooms.find(r=>r.id===85).capacidad=2,
 'room permissions':f=>f.before.rooms.find(r=>r.id===85).profesionales_permitidos=[],
 'machine unavailable':f=>f.before.units.find(u=>u.id===4).status='maintenance',
 'duplicate physical unit':f=>f.before.units.push({...f.before.units.find(u=>u.id===4),id:99}),
 'wrong mobile family':f=>f.before.units.find(u=>u.id===4).family_key='emshape',
 'mobile prohibited':f=>f.before.policies.find(p=>p.installation_id===85).equipment_ids=[],
 'mesotherapy duration':f=>f.before.treatments.at(-1).clinical_config.booking_profile.phases[0].duration_minutes=20,
 'human program edit':f=>f.before.programs[0].notes='Human edit',
}))test('contorno rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>prepare(f));});
test('readback preserves future-price review, clinical warnings, appointments, and all other programs',()=>{
 const pkg=prepare(fixture());assert.throws(()=>verifyState(pkg.before,pkg,{complete:true}));
 for(const mutate of [s=>s.existingVariants[0].activo=1,s=>s.existingVariants[0].precio_base=145,s=>s.treatments[0].nombre='Modified',
  s=>s.programs[1].notes='Modified',s=>s.programs[0].version_number=3,s=>s.existingVariants[0].clinical_config.fiscal_mapping_pending=false]){
  const state=applied(pkg);mutate(state);assert.throws(()=>verifyState(state,pkg,{complete:true}));
 }
 const state=applied(pkg),row=structuredClone(state.programs[0]);row.created_at='2026-09-27T00:00:00.000Z';
 verifyProgram(row,pkg.programs[0],state.existingVariants);
});
module.exports={fixture};
