'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Sequelize=require('sequelize'),history=require('../../lib/external-patient-history');

function fixture(){
  const patient={id_paciente:44,public_id:'pac_TESTONLY_ARRIAGA',clinica_id:1,clinicasVinculadas:[{clinica_id:70}]};
  const state={sourceReads:0,audits:[],permissions:new Map([
    [1,new Map([[1,new Set(['patients.view','patients.sensitive.view'])]])],
    [2,new Map([[70,new Set(['patients.view','patients.sensitive.view'])]])],
    [3,new Map([[70,new Set(['patients.view'])]])],
    [4,new Map([[70,new Set(['patients.sensitive.view'])]])],
  ])};
  const allowed=({actorId,featureKey,clinicId})=>state.permissions.get(actorId)?.get(clinicId)?.has(featureKey)===true;
  const rows=[1,70].map((clinicId,index)=>{
    const source_instance=`arriaga-excel-20261026:clinic-${clinicId}`,source_key=String(index+1).repeat(64),source_patient_id='master-row-2';
    return{id:index+1,clinic_id:clinicId,source_system:'arriaga_excel',source_instance,source_patient_id,source_key,imported_at:'2026-10-26',record_json:JSON.stringify({
      version:'arriaga_patient_source_record/1',provider:'arriaga_excel',source_instance,source_patient_id,source_key,clinic_id:clinicId,
      source_database:'TESTONLY.xlsx',source_table:'TESTONLY',source_row:index+2,category:'historical',record_date:'2025-01-01',
      record:{service_label:`TESTONLY clinical service clinic ${clinicId}`,service_family:'TESTONLY Podología',site_assignment:clinicId===1?'explicit_aju':'default_arenal'},
    })};
  });
  const models={Paciente:{findOne:async()=>patient,findAll:async()=>[patient]},PatientCustomField:{findAll:async options=>{
    state.sourceReads++;assert.equal(options.where.paciente_id,44);assert([1,70].includes(options.where.clinica_id));return [];
  }},sequelize:{query:async(sql,options)=>{
    state.sourceReads++;assert.match(sql,/INNER JOIN PatientImportedIdentities/);assert.match(sql,/i\.patient_id=r\.patient_id/);assert.match(sql,/i\.clinic_id=r\.clinic_id/);
    assert.match(sql,/r\.patient_id=:patientId AND r\.clinic_id=:clinicId/);assert.match(sql,/i\.source_system/);assert.match(sql,/i\.source_instance/);
    assert.equal(options.replacements.patientId,44);return rows.filter(row=>row.clinic_id===options.replacements.clinicId);
  }}};
  const dependencies={'../../models':models,sequelize:Sequelize,crypto:require('node:crypto'),
    '../services/platformAudit.patientReads':{patientIds:patients=>patients.map(row=>row.id_paciente),track:(_req,snapshot,revalidate)=>state.audits.push({snapshot:snapshot(),revalidate}),wrap:(_action,handler)=>handler},
    '../lib/access-policy':{getAccessibleClinicIdsForFeature:async({clinicIds,...context})=>clinicIds.filter(clinicId=>allowed({...context,clinicId})),canUserAccessFeature:async context=>allowed(context)},
    '../lib/external-patient-history':history,'../lib/cliniccloud-patient-history':require('../../lib/cliniccloud-patient-history'),
  };
  const inactive=new Set(['../lib/phone','../lib/patient-declared-origin','../lib/name','../lib/patient-language','../lib/patient-profile-fields','../services/patientContact.service','../services/appointmentActivity.service','../services/marketingOptOut.service']);
  const filename=path.resolve(__dirname,'../../controllers/paciente.controller.js'),module={exports:{}};
  const load=vm.runInNewContext(`(function(require,module,exports){\n${fs.readFileSync(filename,'utf8')}\n})`,{Buffer},{filename});
  load(name=>{if(Object.hasOwn(dependencies,name))return dependencies[name];if(inactive.has(name))return{};throw Error('TESTONLY unexpected dependency:'+name);},module,module.exports);
  async function invoke(actorId,clinicId){const result={status:200};const res={status(code){result.status=code;return this;},json(body){result.body=JSON.parse(JSON.stringify(body));return this;}};
    await module.exports.getImportedPatientHistory({params:{id:patient.public_id},query:{clinic_id:String(clinicId),scope:'clinical'},userData:{userId:actorId}},res);return result;}
  return{state,invoke,rows};
}

test('native Arriaga history reads each linked clinic independently with the stored provider and audited sensitive scope',async()=>{
  const {state,invoke}=fixture();
  const aju=await invoke(1,1);assert.equal(aju.status,200);assert.equal(aju.body.total,1);assert.deepEqual(aju.body.providers,['arriaga_excel']);
  assert(aju.body.entries.every(e=>e.clinic_id===1));assert.doesNotMatch(JSON.stringify(aju.body),/clinic 70|Eurodent|cliniccloud/);
  const arenal=await invoke(2,70);assert.equal(arenal.status,200);assert.equal(arenal.body.total,1);assert(arenal.body.entries.every(e=>e.clinic_id===70));
  assert.doesNotMatch(JSON.stringify(arenal.body),/clinic 1\b|Eurodent|cliniccloud/);
  assert.equal(state.audits.length,2);await state.audits[0].revalidate();
  state.permissions.get(1).get(1).delete('patients.sensitive.view');
  await assert.rejects(state.audits[0].revalidate(),error=>error.status===403);
});

test('native Arriaga patient and sensitive ACL rejects another linked clinic, an unlinked clinic and missing feature before archive reads',async()=>{
  const {state,invoke}=fixture();
  for(const [actor,clinic] of [[1,70],[2,1],[2,67],[3,70],[4,70]])assert.equal((await invoke(actor,clinic)).status,403);
  assert.equal(state.sourceReads,0);assert.equal(state.audits.length,0);
});

test('native source identity mismatch fails closed even for a permitted patient and clinic',async()=>{
  const {invoke,rows}=fixture();rows.find(row=>row.clinic_id===70).source_instance='arriaga-excel-20261026:clinic-1';
  const response=await invoke(2,70);assert.equal(response.status,200);assert.equal(response.body.total,0);assert.deepEqual(response.body.providers,[]);
});
