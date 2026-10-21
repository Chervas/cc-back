'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const fixtureFile=path.join(__dirname,'nutrition_measurement_context.test.js'),moduleFixture={exports:{}};
vm.runInNewContext(`(function(require,module,exports,__dirname){${fs.readFileSync(fixtureFile,'utf8')}\nmodule.exports={fixture};})`,{console,Buffer,process})(name=>name==='node:test'?()=>{}:createRequire(fixtureFile)(name),moduleFixture,moduleFixture.exports,__dirname);
const fixture=moduleFixture.exports.fixture;
test('final stores the explicitly selected comparison, equation and branding; repeat preserves its exact identity and immutable bytes',async()=>{
 const f=fixture();await f.save({measured_at:'2026-09-01T09:00:00Z'});await f.save({measured_at:'2026-09-08T09:00:00Z'});const current=await f.save({measured_at:'2026-09-15T09:00:00Z'});
 const result=await f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio',current.id,7,{compareMeasurementId:1,fatMassEquationCode:'faulkner_1966',brandingMode:'clinic'});
 const row=f.state.reports.find(row=>row.id===result.id),before=JSON.stringify(row);assert.equal(row.snapshot_json.previous_measurement.id,1);assert.equal(row.snapshot_json.meta.fat_mass_equation_code,'faulkner_1966');assert.deepEqual(JSON.parse(JSON.stringify(row.snapshot_json.meta.report_options)),{branding_mode:'clinic',compare_measurement_id:1,fat_mass_equation_code:'faulkner_1966'});assert.match(row.snapshot_html,/Principal ficticia/);
 const repeat=await f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio',current.id,7,{compareMeasurementId:null,fatMassEquationCode:'sloan_1962'});assert.equal(repeat.id,result.id);assert.equal(JSON.stringify(row),before);assert.equal(f.state.reports.filter(row=>row.measurement_id===current.id&&row.status==='final').length,1);
 const lock=f.state.calls.find(call=>call.name==='measurement'&&call.lock==='UPDATE');assert(lock);assert.equal(lock.transaction,f.tx);assert(f.state.calls.some(call=>call.name==='report'&&call.lock==='UPDATE'&&call.transaction===f.tx));
});
test('an explicit no-comparison final remains without comparison and rejects malformed/foreign selections before mutating reports',async()=>{
 const f=fixture();await f.save({measured_at:'2026-09-01'});const current=await f.save({measured_at:'2026-09-08'});
 for(const options of [{compareMeasurementId:-1},{compareMeasurementId:current.id},{fatMassEquationCode:'invented'},{brandingMode:'remote'}])await assert.rejects(f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio',current.id,7,options),error=>error.status===400&&error.code==='nutrition_report_options_invalid');
 await assert.rejects(f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio',current.id,7,{compareMeasurementId:99}),error=>error.status===404);assert.equal(f.state.reports.filter(row=>row.status==='final').length,0);
 const final=await f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio',current.id,7,{compareMeasurementId:null,fatMassEquationCode:'faulkner_1966'});const row=f.state.reports.find(row=>row.id===final.id);assert.equal(row.snapshot_json.previous_measurement,null);assert.equal(row.snapshot_json.report.comparison.available,false);
});
test('final options cannot supply a different actor or weaker feature to bypass exact-clinic finalization permission',async()=>{
 const f=fixture();const current=await f.save({});f.state.deniedFeatures=['nutrition.reports.finalize'];await assert.rejects(f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio',current.id,7,{actorUserId:999,featureKey:'nutrition.workspace.view'}),error=>error.status===403);assert.equal(f.state.reports.filter(row=>row.status==='final').length,0);
 const call=f.state.calls.findLast(call=>call.name==='permission'&&call.featureKey==='nutrition.reports.finalize');assert.equal(call.actorId,7);assert.equal(call.clinicId,10);
});
test('HTTP finalization forwards only parsed options and authenticated actor, rejecting malformed comparison privately',async()=>{
 const file=path.resolve(__dirname,'../../controllers/nutritionWorkspace.controller.js'),mod={exports:{}};let calls=0,args;
 vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(file,'utf8')}\n})`,{Buffer})(name=>name==='express-async-handler'?fn=>fn:{finalizeNutritionMeasurementReportSnapshot:async(...input)=>{calls++;args=input;return{id:1};}},mod,mod.exports);
 const req={params:{id:'pac_ficticio',measurementId:'3'},userData:{userId:7},query:{compare_measurement_id:'1',fat_mass_equation:'faulkner_1966',report_branding_mode:'clinic',actorUserId:999},body:{actorUserId:999}},res={code:0,status(value){this.code=value;return this;},json(value){this.body=value;return this;}};
 await mod.exports.finalizePatientNutritionMeasurementReport(req,res);assert.equal(args[2],7);assert.deepEqual(JSON.parse(JSON.stringify(args[3])),{actorUserId:7,compareMeasurementId:1,fatMassEquationCode:'faulkner_1966',brandingMode:'clinic'});req.query.compare_measurement_id='1oops';await mod.exports.finalizePatientNutritionMeasurementReport(req,res);assert.equal(calls,1);assert.equal(res.code,400);assert.equal(res.body.code,'nutrition_report_options_invalid');
});

test('new report dates use the measurement clinic timezone across Madrid DST and never process timezone',async()=>{
 const f=fixture();f.patient.clinica.configuracion={timezone:'Europe/Madrid'};const measurement=await f.save({measured_at:'2026-09-30T08:00:00Z'}),data=await f.service.getNutritionMeasurementReport('pac_ficticio',measurement.id,{actorUserId:7,compareMeasurementId:null});assert.equal(data.meta.clinic_timezone,'Europe/Madrid');
 for(const[instant,date,time]of [['2026-09-30T08:00:00Z','30/09/2026','10:00'],['2026-12-01T09:00:00Z','01/12/2026','10:00'],['2026-03-29T00:30:00Z','29/03/2026','01:30'],['2026-03-29T01:30:00Z','29/03/2026','03:30'],['2026-10-25T00:30:00Z','25/10/2026','02:30'],['2026-10-25T01:30:00Z','25/10/2026','02:30']]){
  const value=structuredClone(data);value.measurement.measured_at=instant;value.appointment={inicio:instant};value.meta.generated_at=instant;const html=f.service.__testing.buildNutritionReportHtml(value);assert(html.includes('<dt>Medición</dt><dd>'+date+', '+time));assert(html.includes('<dt>Cita</dt><dd>'+date+', '+time));assert(html.includes('Generado el '+date+', '+time));
 }
 const originalZone=process.env.TZ;try{process.env.TZ='Pacific/Honolulu';const naive=structuredClone(data);naive.measurement.measured_at='2026-09-30 08:00:00';assert(f.service.__testing.buildNutritionReportHtml(naive).includes('<dt>Medición</dt><dd>30/09/2026, 10:00'));}finally{if(originalZone===undefined)delete process.env.TZ;else process.env.TZ=originalZone;}
 f.patient.clinica.configuracion={timezone:'Atlantic/Canary'};const canary=await f.service.getNutritionMeasurementReport('pac_ficticio',measurement.id,{actorUserId:7,compareMeasurementId:null});assert.equal(canary.meta.clinic_timezone,'Atlantic/Canary');assert(f.service.__testing.buildNutritionReportHtml(canary).includes('<dt>Medición</dt><dd>30/09/2026, 09:00'));
});
