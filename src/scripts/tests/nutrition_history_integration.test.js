'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {Op}=require('sequelize');
const {createNutritionEpisodeResolver}=require('../../services/nutritionEpisodeContext.service');
const fixtureFile=path.join(__dirname,'nutrition_measurement_context.test.js');
const fixtureModule={exports:{}};
const localRequire=createRequire(fixtureFile);
vm.runInNewContext(`(function(require,module,exports,__dirname){${fs.readFileSync(fixtureFile,'utf8')}\nmodule.exports={fixture};})`,{console,Buffer,process})(name=>name==='node:test'?()=>{}:localRequire(name),fixtureModule,fixtureModule.exports,__dirname);
const fixture=fixtureModule.exports.fixture;
const episodeId='e73c936f-213c-45cd-a118-519e435e712b';
function linkedFixture(){
 const f=fixture(),episode={id:9,public_id:episodeId,patient_id:1,clinic_id:10,status:'draft',appointment_id:100};
 f.db.AppointmentClinicalReport={findOne:async options=>{f.state.calls.push({name:'episode',...options});return Object.entries(options.where).every(([key,value])=>episode[key]===value)?episode:null;}};
 f.db.ClinicalEpisodeAppointment={findOne:async options=>options.where.appointment_id===101?{report_id:9,appointment_id:101}:null};
 return {...f,episode};
}
test('independent measurement never loads or invents an episode',async()=>{
 const f=linkedFixture();const result=await f.save({notes:'Nota independiente',measured_at:'2026-10-20T22:30:00Z'});
 assert.equal(result.episode_id,null);assert.equal(f.state.calls.filter(call=>call.name==='episode').length,0);
 assert.equal(result.notes,'Nota independiente');assert.equal(new Date(result.measured_at).toISOString(),'2026-10-20T22:30:00.000Z');
});
test('measurement stores one explicit episode reference and both canonical appointment links without narrative writes',async()=>{
 for(const appointment_id of [null,100,101]){
  const f=linkedFixture();const result=await f.save({episode_id:episodeId,appointment_id,treatment_id:appointment_id===101?5:undefined,notes:'Notas de esta toma'});
  assert.equal(result.episode_id,episodeId);assert.equal(result.appointment_id,appointment_id);assert.equal(f.state.rows.length,1);
  const lookup=f.state.calls.find(call=>call.name==='episode');assert.equal(lookup.transaction,f.tx);assert.equal(lookup.lock,'UPDATE');
  assert.equal(f.episode.status,'draft');assert.equal(f.episode.version,undefined);assert.equal(result.notes,'Notas de esta toma');
 }
});
test('foreign patient, clinic, unlinked appointment and final episode refuse the new relation before any measurement exists',async()=>{
 for(const mutate of [f=>f.episode.patient_id=2,f=>f.episode.clinic_id=20,f=>f.episode.status='final']){
  const f=linkedFixture();mutate(f);await assert.rejects(f.save({episode_id:episodeId}),error=>[404,409].includes(error.status));assert.equal(f.state.rows.length,0);
 }
 const f=linkedFixture();f.episode.appointment_id=999;f.db.ClinicalEpisodeAppointment.findOne=async()=>null;
 await assert.rejects(f.save({episode_id:episodeId,appointment_id:100}),error=>error.code==='nutrition_episode_appointment_mismatch');assert.equal(f.state.rows.length,0);
});
test('link requires exact-clinic clinical permissions and rejects malformed IDs before persistence',async()=>{
 for(const feature of ['clinical.reports.view','clinical.reports.manage']){const f=linkedFixture();f.state.deniedFeatures=[feature];await assert.rejects(f.save({episode_id:episodeId}),error=>error.status===403);assert.equal(f.state.rows.length,0);}
 for(const value of [true,11,'not-an-episode',{},[]]){const f=linkedFixture();await assert.rejects(f.save({episode_id:value}),error=>error.code==='nutrition_episode_invalid');assert.equal(f.state.rows.length,0);}
});
test('the nutrition report can be finalized after its linked narrative episode closes, retaining its exact reference',async()=>{
 const f=linkedFixture();const measurement=await f.save({episode_id:episodeId,notes:'Nota exacta de la toma'});f.episode.status='final';
 const result=await f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio',measurement.id,7);
 assert.equal(result.status,'final');assert.equal(f.state.rows[0].episode_id,episodeId);assert.equal(f.state.rows[0].notes,'Nota exacta de la toma');assert.equal(f.episode.status,'final');
});
function historyFixture(){
 const f=fixture();f.state.rows=Array.from({length:55},(_,index)=>({id:index+1,patient_id:1,clinic_id:10,profile_code:'quick',measured_at:new Date('2026-10-01T08:00:00Z'),raw_values:{weight_kg:70,stature_cm:170},derived_values:{bmi:24.2},notes:'Nota '+(index+1)}));
 f.state.rows.push({id:99,patient_id:2,clinic_id:10,measured_at:new Date('2026-10-21T00:00:00Z')},{id:100,patient_id:1,clinic_id:30,measured_at:new Date('2026-10-21T00:00:00Z')});
 const matches=(row,where)=>Reflect.ownKeys(where).every(key=>{const expected=where[key];if(key===Op.or)return expected.some(clause=>matches(row,clause));if(expected&&typeof expected==='object'&&!(expected instanceof Date)){if(expected[Op.in])return expected[Op.in].includes(row[key]);if(expected[Op.lt]!==undefined)return row[key]<expected[Op.lt];}return row[key] instanceof Date?row[key].getTime()===new Date(expected).getTime():row[key]===expected;});
 f.db.PatientNutritionMeasurement.findAll=async options=>f.state.rows.filter(row=>matches(row,options.where)).sort((a,b)=>b.measured_at-a.measured_at||b.id-a.id).slice(0,options.limit);
 f.db.PatientNutritionMeasurement.findOne=async options=>f.state.rows.find(row=>matches(row,options.where))||null;
 return f;
}
test('stable cursor pages every same-timestamp measurement once, retaining authorized patient and clinic scope',async()=>{
 const f=historyFixture();const first=await f.service.getPatientNutritionWorkspace('pac_ficticio',{actorUserId:7,clinicId:10});
 assert.equal(first.measurements.length,50);assert.equal(first.latest.id,55);assert(first.meta.next_measurement_cursor);
 const second=await f.service.getPatientNutritionWorkspace('pac_ficticio',{actorUserId:7,clinicId:10,before:first.meta.next_measurement_cursor});
 assert.equal(second.measurements.length,5);assert.equal(second.meta.next_measurement_cursor,null);const ids=[...first.measurements,...second.measurements].map(row=>row.id);assert.equal(new Set(ids).size,55);assert(!ids.includes(99));assert(!ids.includes(100));
});
test('opening an older measurement includes that exact authorized record without shifting the first-page cursor',async()=>{
 const f=historyFixture();const base=await f.service.getPatientNutritionWorkspace('pac_ficticio',{actorUserId:7,clinicId:10});
 const focus=await f.service.getPatientNutritionWorkspace('pac_ficticio',{actorUserId:7,clinicId:10,measurementId:2});
 assert.equal(focus.latest.id,55);assert(focus.measurements.some(row=>row.id===2));assert.equal(focus.meta.next_measurement_cursor,base.meta.next_measurement_cursor);
 for(const measurementId of [99,100,'2oops'])await assert.rejects(f.service.getPatientNutritionWorkspace('pac_ficticio',{actorUserId:7,clinicId:10,measurementId}),error=>error.status===404);
});
test('malformed and non-positive history cursors fail before returning data',async()=>{
 for(const before of ['bad',Buffer.from(JSON.stringify({id:-1,at:'2026-10-20'})).toString('base64url'),Buffer.from(JSON.stringify({id:2,at:'invalid'})).toString('base64url')]){
  await assert.rejects(historyFixture().service.getPatientNutritionWorkspace('pac_ficticio',{actorUserId:7,before}),error=>error.status===400&&error.code==='nutrition_history_cursor_invalid');
 }
});
test('History adapter can request exact active-clinic rows without changing the native shared workspace or leaking focused foreign-clinic IDs',async()=>{
 const f=fixture();await f.save({clinic_id:10,measured_at:'2026-10-19T22:30:00Z',notes:'Nota clínica10'});await f.save({clinic_id:20,measured_at:'2026-10-20T09:30:00Z',notes:'Nota clínica20'});
 const shared=await f.service.getPatientNutritionWorkspace('pac_ficticio',{actorUserId:7,clinicId:10});assert.equal(shared.measurements.length,2);
 const scoped=await f.service.getPatientNutritionWorkspace('pac_ficticio',{actorUserId:7,clinicId:10,scopeClinicOnly:true});assert.equal(scoped.measurements.length,1);assert.equal(scoped.latest.clinic_id,10);assert.equal(scoped.latest.notes,'Nota clínica10');
 await assert.rejects(f.service.getPatientNutritionWorkspace('pac_ficticio',{actorUserId:7,clinicId:10,scopeClinicOnly:true,measurementId:2}),error=>error.status===404);
});
