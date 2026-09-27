'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/obesity_programs.fixture');
const variants=require('../../lib/cliniccloud-import/obesity-program-variants');
const programs=require('../../lib/cliniccloud-import/obesity-program-drafts');
const {hash}=require('../../lib/cliniccloud-import/adapter');
function ready(){const f=fixture(),pkg=variants.prepare(f);return{...f,pkg,rows:pkg.variants.map((v,i)=>({id_tratamiento:100+i,...structuredClone(v.payload),activo:0}))};}
function args(f){return{plan:f.plan,sourceHashes:f.sourceHashes,clinics:f.before.clinics,treatments:[...f.before.treatments,...f.rows],existingPrograms:f.before.programs};}
test('two distinct inactive variants preserve original services; GLP 30 and Ligereza 23+22',()=>{
 const f=ready(),s=structuredClone(f.before);s.existingVariants=f.rows;
 variants.verifyState(s,f.pkg,{complete:true});
 assert.deepEqual(f.rows.map(t=>t.clinical_config.booking_profile.phases.map(p=>p.duration_minutes)),[[30],[23,22]]);
 assert.deepEqual(f.before.treatments.slice(0,2).map(t=>t.duracion_min),[5,45]);
 assert(f.rows.every(t=>!t.activo&&t.precio_base===null&&t.clinical_config.fiscal_mapping_pending));
});
test('seven programmes and exact counts, alternate Transición, no invented mixed-series calendar',()=>{
 const f=ready(),pkg=programs.prepare(args(f));assert.equal(pkg.programs.length,7);
 assert.deepEqual(pkg.programs.map(p=>p.payload.appointments.length),[3,3,5,6,8,12,16]);
 assert.deepEqual(pkg.programs.map(p=>p.source_gross_price),[250,170,275,430,670,1090,1290]);
 assert(pkg.programs.every(p=>p.payload.status==='draft'&&p.payload.total_price===null&&p.payload.cadence===null));
 assert.deepEqual(pkg.programs[4].payload.appointments.map(a=>a.treatment_ids[0]),[101,5,101,5,101,5,101,5]);
 assert.deepEqual(pkg.programs[4].payload.appointments.map(a=>a.offset_days),[0,7,14,21,28,35,42,49]);
 for(const [index,counts]of [[5,[8,4]],[6,[10,6]]]){
  const p=pkg.programs[index];assert.deepEqual([5,6].map(id=>p.payload.appointments.filter(a=>a.treatment_ids[0]===id).length),counts);
  assert(p.payload.appointments.every(a=>a.treatment_ids.length===1&&a.offset_days===null&&a.label.startsWith('Serie')));
  assert(p.payload.notes.includes('NO'));assert(p.payload.notes.includes('no consecutivos'));
 }
 assert.equal(pkg.programs[5].payload.name,'BS Firmeza · pérdida de peso');
 assert(pkg.programs.every(p=>p.payload.notes.includes('01/10/2026')&&p.payload.notes.includes('NO como regla de caducidad')));
});
test('canonical solver reserves successive fixed rooms, refuses second phase conflicts',()=>{
 const f=ready(),profile=f.rows[1].clinical_config.booking_profile;
 const {solveBookingProfile}=require('../../lib/booking-profile-solver');
 const windows=[{start:'2030-01-07T08:00:00Z',end:'2030-01-07T20:00:00Z'}],start='2030-01-07T09:00:00Z';
 const context={doctors:new Map([[221,{windows,busy:[]}]]),installations:new Map([87,82].map(id=>[id,{windows,busy:[],resource_key:'installation:'+id,profesionales_permitidos:[221]}])),
  equipment:new Map(f.before.units.map(u=>[u.id,{...u,installation_ids:new Set([u.home_installation_id]),busy:[]}]))};
 const s=solveBookingProfile({profile,start,...context});assert(s);assert.equal(s.phases[1].start_at,'2030-01-07T09:23:00.000Z');assert.equal(s.end_at,'2030-01-07T09:45:00.000Z');
 context.installations.get(82).busy=[{start:s.phases[1].start_at,end:s.end_at}];assert.equal(solveBookingProfile({profile,start,...context}),null);
});
for(const [name,mutate]of Object.entries({
 'wrong source':f=>f.sourceHashes[Object.keys(f.sourceHashes)[0]]='wrong',
 'wrong clinic':f=>f.before.clinics[0].grupoClinicaId=30,
 'existing variant':f=>f.before.existingVariants.push({codigo:variants.CODES[0]}),
 'changed base':f=>f.before.treatments[0].duracion_min=30,
 'modified original profile':f=>f.before.treatments[1].clinical_config.booking_profile.phases[0].duration_minutes=23,
 'staff inactive':f=>f.before.staff[0].activo=0,
 'staff no hours':f=>f.before.staff_hours=[],
 'wrong room':f=>f.before.rooms[0].clinica_id=66,
 'staff restricted':f=>f.before.rooms[0].profesionales_permitidos=[999],
 'room closed':f=>f.before.room_hours[0].activo=0,
 'room capacity':f=>f.before.rooms[0].capacidad=2,
 'equipment disabled':f=>f.before.clinics[0].equipment_booking_enabled=0,
 'machine duplicate':f=>f.before.units.push({...f.before.units[0],id:99}),
 'machine maintenance':f=>f.before.units[0].status='maintenance',
 'machine wrong room':f=>f.before.units[0].home_installation_id=82,
 'machine unavailable to clinic':f=>f.before.shares=[],
}))test('obesity variants reject '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>variants.prepare(f));});
test('partial replay accepted, concurrent edits, duplicate variants and unintended activation rejected',()=>{
 const f=ready(),s=structuredClone(f.before);s.existingVariants=[f.rows[0]];variants.verifyState(s,f.pkg);
 assert.throws(()=>variants.verifyState(s,f.pkg,{complete:true}));
 for(const mutate of [s=>s.existingVariants[0].activo=1,s=>s.treatments[0].nombre='edited',s=>s.programs[0].name='edited',
  s=>s.existingVariants.push({...s.existingVariants[0],id_tratamiento:200}),s=>s.existingVariants[0].clinical_config.fiscal_mapping_pending=false]){
  const actual={...structuredClone(f.before),existingVariants:structuredClone(f.rows)};mutate(actual);assert.throws(()=>variants.verifyState(actual,f.pkg,{complete:true}));
 }
});
test('programme package refuses human edits and price/clinical changes to variants',()=>{
 const f=ready(),a=args(f),p=programs.prepare(a);const before=hash(a);
 assert.equal(hash(a),before);a.existingPrograms.push({name:p.programs[0].payload.name,request_key:'different'});assert.throws(()=>programs.prepare(a));
 a.existingPrograms.pop();a.treatments.at(-1).precio_base=85;assert.throws(()=>programs.prepare(a));
});
