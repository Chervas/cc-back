'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {prepare,PDF_SHA256}=require('../../lib/cliniccloud-import/capillary-program-drafts');
const {summarize,payloadHash}=require('../../lib/treatmentPrograms.contract');
function fixture(){
  const rows=[],treatments=[];
  for(const [index,[row,minutes]]of [[22,30],[24,30],[33,20],[31,20],[43,10]].entries()){
    const source={sheet:'Capilar · sesiones y bonos',source_row:row,kind:'treatment',clinic_id:66,
      proposed_code:'synthetic-'+row,display_name:'Synthetic treatment '+row,source_catalog_key:'key-'+row,
      provenance:{file_sha256:'synthetic',source_row:row}};
    rows.push(source);treatments.push({id_tratamiento:index+1,codigo:source.proposed_code,clinica_id:66,origen:'clinica',
      nombre:source.display_name,sesiones_defecto:1,duracion_min:minutes,activo:0,
      clinical_config:{source_catalog:source.provenance,source_catalog_key:source.source_catalog_key,catalog_status:'draft'}});
  }
  const body={version:1,mode:'catalog_dry_run_only',rows,workbook_sha256:hash('synthetic'),clinics:{medical:72,capilar:66}};
  return {plan:{...body,plan_sha256:hash(body)},pdfSha256:PDF_SHA256,clinics:[{id_clinica:66,grupoClinicaId:29}],treatments,existingPrograms:[]};
}
test('five draft compositions retain 8/9/11/14/15 visits and do not apply future prices',()=>{
 const f=fixture(),before=hash(f),p=prepare(f);assert.equal(hash(f),before);
 assert.deepEqual(p.programs.map(p=>p.payload.appointments.length),[8,9,11,14,15]);
 assert.deepEqual(p.programs.map(p=>p.source_gross_price),[690,790,840,990,1350]);
 for(const {payload:v}of p.programs){assert.equal(v.status,'draft');assert.equal(v.total_price,null);assert.equal(v.cadence,null);
   assert.equal(summarize(v,new Map()).summary.ready_for_scheduling,false);
   assert(v.appointments.slice(-2).every(a=>a.treatment_ids.length===0&&a.label.startsWith('Revisión médica')));
   assert.match(v.notes,/cuatro recetas.*no cuatro citas adicionales/);
 }
});
test('LED is not doubled for PRP/dutasteride, but Dermapen and CYJ have two sequential components',()=>{
 const {programs}=prepare(fixture());
 assert(programs[0].payload.appointments.slice(0,6).every(a=>a.treatment_ids.length===1));
 assert(programs[1].payload.appointments.slice(3,7).every(a=>a.treatment_ids.length===2));
 assert(programs[4].payload.appointments.slice(0,4).every(a=>a.treatment_ids.length===2));
});
test('unknown clinical variants/review cadence remain unresolved, only CYJ has explicit fortnightly offsets',()=>{
 const p=prepare(fixture());const all=p.programs.flatMap(p=>p.payload.appointments);
 for(const a of all)if(/variante|Revisión/.test(a.label))assert.deepEqual(a.treatment_ids,[]);
 assert.deepEqual(p.programs[4].payload.appointments.slice(0,4).map(a=>a.offset_days),[0,14,28,42]);
 assert(all.filter(a=>!a.key.includes('_cyj_')).every(a=>a.offset_days===null));
});
for(const [label,change]of [
 ['different PDF',f=>f.pdfSha256='unknown'],['different group',f=>f.clinics[0].grupoClinicaId=5],
 ['missing clinic',f=>f.clinics=[]],['changed source plan',f=>f.plan.rows[0].name='changed'],
 ['wrong clinic treatment',f=>f.treatments[0].clinica_id=72],['already active',f=>f.treatments[0].activo=1],
 ['source provenance edited',f=>f.treatments[0].clinical_config.source_catalog={changed:true}],
 ['wrong duration',f=>f.treatments[0].duracion_min=20],['voucher instead of session',f=>f.treatments[0].sesiones_defecto=3],
 ['ambiguous reference',f=>f.treatments.push({...f.treatments[0],id_tratamiento:100})],
 ['human program name collision',f=>f.existingPrograms.push({name:'BS ESENCIAL',request_key:'human'})],
])test('rejects '+label,()=>{const f=fixture();change(f);assert.throws(()=>prepare(f));});
test('stable request keys permit replay without generating another definition',()=>{
 const f=fixture(),first=prepare(f);
 f.existingPrograms=first.programs.map(p=>({name:p.payload.name,request_key:payloadHash([66,p.payload.idempotency_key])}));
 assert.deepEqual(prepare(f),first);
});
module.exports={fixture};
