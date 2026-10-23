'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Sequelize=require('sequelize');
const history=require('../../lib/external-patient-history');

// Exercise the native exported handler and projection together. Every storage
// and permission dependency is isolated; models, providers and SQL never start.
function fixture(){
  const patient={id_paciente:1,public_id:'pac_TESTONLY_ARCHIVE',clinica_id:67,clinicasVinculadas:[]};
  const state={patientReads:0,sourceReads:0,audits:[],billingUnavailable:false,
    permissions:new Map([[1,new Set(['patients.view','patients.sensitive.view'])],
      [2,new Set(['patients.view','patients.sensitive.view','billing.reports.view'])],
      [3,new Set(['patients.sensitive.view','billing.reports.view'])],
      [4,new Set(['patients.view','billing.reports.view'])]])};
  const rows=[
    ['Paciente',{ID:'1','NºHist':'TESTONLY source profile'}],
    ['Historial',{ID:'2',Fecha:'2020-01-01',Tipolin:'T',Obs:'TESTONLY clinical annotation'}],
    ['Historial',{ID:'3',Fecha:'2020-01-01',Tipolin:'C',Precio_euro:'17.25'}],
    ['Presupuesto',{ID:'4',Fecha:'2020-01-01',Precio_euro:'17.25'}],
    ['Hist_Borr',{ID:'5',Fecha:'2020-01-01',Tipolin:'T',Obs:'TESTONLY deleted clinical annotation'}],
    ['Hist_Borr',{ID:'6',Fecha:'2020-01-01',Tipolin:'A',Precio_euro:'17.25'}],
  ].map(([source_table,record],i)=>({id:i+1,clinic_id:67,imported_at:'2026-10-22',record_json:JSON.stringify({
    version:'eurodent_source_record/1',source_instance:'testonly-scope-acl',source_database:'TESTONLY.MDB',source_table,source_pk:{ID:record.ID},row_sha256:'a'.repeat(64),record,
  })}));
  const allowed=({actorId,featureKey,clinicId})=>clinicId===67&&state.permissions.get(actorId)?.has(featureKey)===true;
  const models={Paciente:{findOne:async()=>{state.patientReads++;return patient;},findAll:async()=>[patient]},
    PatientCustomField:{findAll:async options=>{
      state.sourceReads++;assert.equal(options.where.paciente_id,1);assert.equal(options.where.clinica_id,67);return [];
    }},
    sequelize:{query:async(sql,options)=>{
      state.sourceReads++;assert.match(sql,/INNER JOIN PatientImportedIdentities/);assert.match(sql,/i\.clinic_id=r\.clinic_id/);
      assert.equal(options.replacements.patientId,1);assert.equal(options.replacements.clinicId,67);return rows;
    }}};
  const dependencies={
    '../../models':models,sequelize:Sequelize,crypto:require('node:crypto'),
    '../services/platformAudit.patientReads':{
      patientIds:patients=>patients.map(row=>row.id_paciente),
      track:(_req,snapshot,revalidate)=>state.audits.push({snapshot:snapshot(),revalidate}),
      wrap:(_action,handler)=>handler,
    },
    '../lib/access-policy':{
      getAccessibleClinicIdsForFeature:async({clinicIds,...context})=>clinicIds.filter(clinicId=>allowed({...context,clinicId})),
      canUserAccessFeature:async context=>{
        if(state.billingUnavailable&&context.featureKey==='billing.reports.view')throw Error('TESTONLY permission storage unavailable');
        return allowed(context);
      },
    },
    '../lib/external-patient-history':history,
    '../lib/cliniccloud-patient-history':require('../../lib/cliniccloud-patient-history'),
  };
  const inactive=new Set(['../lib/phone','../lib/patient-declared-origin','../lib/name','../lib/patient-language',
    '../lib/patient-profile-fields','../services/patientContact.service','../services/appointmentActivity.service','../services/marketingOptOut.service']);
  const filename=path.resolve(__dirname,'../../controllers/paciente.controller.js'),module={exports:{}};
  const load=vm.runInNewContext(`(function(require,module,exports){\n${fs.readFileSync(filename,'utf8')}\n})`,{Buffer},{filename});
  load(request=>{
    if(Object.hasOwn(dependencies,request))return dependencies[request];
    if(inactive.has(request))return {};
    throw Error(`TESTONLY unexpected dependency: ${request}`);
  },module,module.exports);
  const invoke=async(query={},actor=1)=>{
    const result={status:200};
    const response={status(code){result.status=code;return this;},json(body){result.body=JSON.parse(JSON.stringify(body));return this;}};
    await module.exports.getImportedPatientHistory({params:{id:patient.public_id},query:{clinic_id:'67',...query},userData:{userId:actor}},response);
    return result;
  };
  return {state,invoke};
}

test('native history handler scopes profile and clinical reads, preserves legacy redaction and rejects explicit economy before source reads',async()=>{
  const {state,invoke}=fixture();
  const legacy=await invoke();assert.equal(legacy.status,200);assert.equal(legacy.body.total,4);assert.equal(legacy.body.financial_values_visible,false);
  assert.deepEqual(legacy.body.category_counts,{budget:1,historical:1,deleted_history:1,profile:1});
  assert.doesNotMatch(JSON.stringify(legacy.body),/17\.25/);
  const profile=await invoke({scope:'profile'});assert.equal(profile.status,200);assert.equal(profile.body.total,1);assert.deepEqual(profile.body.category_counts,{profile:1});
  const clinical=await invoke({scope:'clinical',limit:'1'});assert.equal(clinical.status,200);assert.equal(clinical.body.total,2);
  assert.deepEqual(clinical.body.category_counts,{historical:1,deleted_history:1});assert(clinical.body.next_cursor);
  const next=await invoke({scope:'clinical',limit:'1',cursor:clinical.body.next_cursor});assert.equal(next.status,200);assert.notEqual(next.body.entries[0].id,clinical.body.entries[0].id);
  const reads=state.sourceReads;
  for(const query of [{scope:'economy'},{scope:'economy',category:'historical'}]){
    const denied=await invoke(query);assert.equal(denied.status,403);assert.equal(denied.body.details.feature_key,'billing.reports.view');
  }
  assert.equal(state.sourceReads,reads);
});

test('native history handler requires patient, sensitive and clinic membership access for profile and economy',async()=>{
  const {state,invoke}=fixture();
  for(const scope of ['profile','economy']){
    for(const actor of [3,4])assert.equal((await invoke({scope},actor)).status,403);
    assert.equal((await invoke({scope,clinic_id:'68'},2)).status,403);
  }
  assert.equal(state.sourceReads,0);assert.equal(state.audits.length,0);
});

test('authorized economy reads include only financial counts and retain deleted-source notice, with scope-bound cursors and billing audit recheck',async()=>{
  const {state,invoke}=fixture();
  const result=await invoke({scope:'economy',limit:'1'},2);assert.equal(result.status,200);assert.equal(result.body.total,3);
  assert.equal(result.body.financial_values_visible,true);assert.deepEqual(result.body.category_counts,{budget:1,economic:2});assert(result.body.next_cursor);
  const deleted=await invoke({scope:'economy',search:'Anotación eliminada'},2);assert.equal(deleted.body.total,1);
  assert.equal(deleted.body.entries[0].category,'economic');assert.equal(deleted.body.entries[0].source_deleted,true);
  assert.equal(deleted.body.entries[0].source_document.table,'Hist_Borr');assert.match(deleted.body.entries[0].content_note,/eliminado en origen/);
  assert.equal((await invoke({scope:'profile',cursor:result.body.next_cursor},2)).status,400);
  assert.equal((await invoke({cursor:result.body.next_cursor},2)).status,400);
  const audit=state.audits[0];await audit.revalidate();
  state.permissions.get(2).delete('billing.reports.view');
  await assert.rejects(audit.revalidate(),error=>error.status===403&&error.details.feature_key==='billing.reports.view');
});

test('legacy cursors issued before scopes remain valid only for the legacy domain',async()=>{
  const {invoke}=fixture();
  const filters={category:'',tooth:'',from:'',to:'',search:''};
  const filter=require('node:crypto').createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0,16);
  const cursor=Buffer.from(JSON.stringify({offset:1,filter})).toString('base64url');
  const first=await invoke({limit:'1'},2),next=await invoke({limit:'1',cursor},2);
  assert.equal(next.status,200);assert.notEqual(next.body.entries[0].id,first.body.entries[0].id);
  for(const scope of ['clinical','economy','profile'])assert.equal((await invoke({scope,limit:'1',cursor},2)).status,400);
});

test('invalid scopes fail validation without storage reads and unavailable financial authorization fails closed',async()=>{
  const {state,invoke}=fixture();
  for(const scope of ['','all','Clinical',['clinical','economy'],{domain:'clinical'}]){
    const invalid=await invoke({scope},2);assert.equal(invalid.status,400);assert.equal(invalid.body.error,'imported_history_scope_invalid');
  }
  assert.equal(state.patientReads,0);assert.equal(state.sourceReads,0);
  state.billingUnavailable=true;
  assert.equal((await invoke({scope:'economy'},2)).status,403);assert.equal(state.sourceReads,0);
  assert.equal((await invoke({scope:'profile'},2)).status,200);
});
