'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {isFlexibleDoctor,allowFlexibleConflicts}=require('../../lib/flexible-agenda');
const {solveBookingProfile}=require('../../lib/booking-profile-solver');
const {buildLegacySlots}=require('../../lib/availability-request-snapshot');
const start=new Date('2030-01-07T10:00:00Z'),end=new Date('2030-01-07T10:30:00Z');
function fixture(flexible=true){return {profile:{version:1,phases:[{key:'visit',duration_minutes:30,installation_ids:[9],professionals:{mode:'any',ids:[50],preferred_id:50}}]},
  start,selections:{visit:{doctor_id:50,installation_id:9}},
  doctors:new Map([[50,{name:'Profesional',agenda_flexible:flexible,windows:[],busy:[{start,end,appointment_id:2}]}]]),
  installations:new Map([[9,{name:'C2',windows:[],profesionales_permitidos:[99],busy:[{start,end,appointment_id:2}]}]]),
  clinicWindows:[],equipment:null};}
test('scoped exception requires an active appointment-receiving clinic membership',()=>{
  assert.equal(isFlexibleDoctor({agenda_flexible:true,activo:1,recibe_citas:1}),true);
  for(const value of [{agenda_flexible:true,activo:0,recibe_citas:1},{agenda_flexible:true,activo:1,recibe_citas:0},{activo:1,recibe_citas:1}])assert.equal(isFlexibleDoctor(value),false);
});
test('a scoped reservation outside hours/room policy and overlapping requires confirmation',()=>{
  const options=fixture();assert.equal(solveBookingProfile(options),null);
  const result=solveBookingProfile({...options,allowOverlap:true});assert.ok(result);
  assert.equal(result.requires_overlap_acknowledgement,true);assert.equal(result.phases[0].doctor_ids[0],50);
  assert.ok(result.warnings.find(w=>w.code==='FLEXIBLE_AGENDA'));
  assert.equal(options.doctors.get(50).busy.length,1);assert.equal(options.installations.get(9).profesionales_permitidos.length,1);
});
test('the same request remains rejected outside the configured professional/clinic scope',()=>{
  assert.equal(solveBookingProfile({...fixture(false),allowOverlap:true}),null);
});
test('manual blocks are never removed by a flexible reservation',()=>{
  for(const field of ['doctors','installations']){const options=fixture();options[field].values().next().value.busy.push({start,end});
    assert.equal(solveBookingProfile({...options,allowOverlap:true}),null);}
});
test('equipment occupancy can be confirmed without pretending a missing or maintenance machine exists',()=>{
  const options=fixture();options.profile.version=2;options.profile.phases[0].equipment_requirements=[{equipment_ids:[3]}];
  options.equipment=new Map([[3,{id:3,name:'EMS',status:'available',turnaround_minutes:0,installation_ids:new Set([9]),busy:[{start,end,appointment_id:2}]}]]);
  assert.ok(solveBookingProfile({...options,allowOverlap:true}));
  options.equipment.get(3).status='maintenance';assert.equal(solveBookingProfile({...options,allowOverlap:true}),null);
});
test('legacy slots and manual-block shading retain the same scoped exception',()=>{
  const options={baseStart:start,baseEnd:end,clinicHasSchedule:true,clinicWins:[],inst:{profesionales_permitidos:[99]},instWins:[],
    doctorCtx:{doctorId:50,docWins:[],agendaFlexible:true},timeZone:'Europe/Madrid',durMin:15,stepMin:5,maxSlots:50,
    docCitasRows:[{inicio:start,fin:end}],instCitasRows:[{inicio:start,fin:end}]};
  assert.ok(buildLegacySlots(options).length);assert.equal(buildLegacySlots({...options,docBlocksRows:[{fecha_inicio:start,fecha_fin:end}]}).length,0);
  assert.equal(buildLegacySlots({...options,doctorCtx:{...options.doctorCtx,agendaFlexible:false}}).length,0);
});
test('manual blocks, foreign IDs and supporting staff remain non-forceable',()=>{
  const rows=[{code:'STAFF_OVERLAP',can_force:false},{code:'STAFF_BLOCKED',can_force:false},
    {code:'INSTALLATION_BLOCKED',can_force:false},{code:'STAFF_OVERLAP',resource_role:'additional_staff',can_force:false}];
  allowFlexibleConflicts(rows,true);assert.deepEqual(rows.map(r=>r.can_force),[true,false,false,false]);
});
