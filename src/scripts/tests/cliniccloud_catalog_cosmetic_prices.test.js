'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {buildCatalogPlan}=require('../../lib/cliniccloud-import/catalog');
const {treatmentDraft}=require('../../lib/cliniccloud-import/catalog-drafts');
const {PROFILE,LEGAL,prepareCosmeticPrices,reviewedConfig,verifyCosmeticPrices,verifyPricedState}=require('../../lib/cliniccloud-import/catalog-cosmetic-prices');
const {capture,execute,run}=require('../cliniccloud-import-catalog-cosmetic-prices');
const {mergeClinicalConfig,applyImportedPriceReview,catalogPrice}=require('../../lib/treatment-catalog-contract');
const {resolveBudgetPriceProfiles,budgetBreakdown}=require('../../lib/economicPriceProfile');
function fixture(){
  const plan=buildCatalogPlan({workbookHash:'a'.repeat(64),repliesHash:'b'.repeat(64),local:{installations:[],professionals:[],treatments:[]},
    sheets:[{name:'Tratamientos individuales',rows:[{source_row:22,cells:{A:'Remodelación estética sintética',B:'Sesión sintética',C:'30 min',D:'121 €',G:'8',H:'Aux. Piedad'}}]}]});
  const source=plan.rows[0];
  const treatment={id_tratamiento:10,...structuredClone(treatmentDraft(source)),createdAt:'2026-09-21',updatedAt:'2026-09-21'};
  const anchors=[1,2].map(id=>({id_tratamiento:id,clinica_id:72,codigo:'ANCHOR'+id,clinical_config:{price_profile:{...PROFILE},
    fiscal_mapping_pending:false,imported_price_review:{reviewed_by:7,price_profile:{...PROFILE}}}}));
  const purposeDocument='Documento sintético: modalidad estética de remodelación corporal sin finalidad terapéutica.';
  const review={version:1,scope:'explicit_non_therapeutic_cosmetic_modalities',plan_sha256:plan.plan_sha256,purpose_document_sha256:hash(purposeDocument),
    profile:{...PROFILE},legal_sources:[...LEGAL],anchors:anchors.map(a=>({codigo:a.codigo,sha256:hash(a)})),bindings:[{
      source_catalog_key:source.source_catalog_key,treatment_sha256:hash(treatment),classification:'cosmetic_non_therapeutic',
      source_quote:'Remodelación estética sintética',purpose_quote:'modalidad estética de remodelación corporal sin finalidad terapéutica',
      reason:'Modalidad sintética expresamente estética, sin extrapolar esta revisión a prestaciones sanitarias o de finalidad mixta.'}]};
  const before={clinics:[{id_clinica:72,grupo_clinica_id:29}],treatments:[treatment],anchors,appointments:[],requirements:[]};
  return {plan,review,purposeDocument,before,createdAt:'2026-09-22T00:45:00.000Z'};
}
function priced(pkg){return {...structuredClone(pkg.before),treatments:pkg.operations.map(op=>({...structuredClone(op.before),precio_base:op.gross_amount.toFixed(2),clinical_config:reviewedConfig(op,pkg),updatedAt:'2026-09-22'}))};}
test('preserves final source amount, computes backend tax and attributes technical review to no human',()=>{
  const f=fixture(),before=hash(f),p=prepareCosmeticPrices(f),after=priced(p),cfg=after.treatments[0].clinical_config;
  assert.equal(hash(f),before);assert.equal(p.operations[0].gross_amount,121);
  assert.deepEqual(p.operations[0].breakdown,{price_semantics:'gross_tax_included',tax_percent:21,exemption_reason:null,taxable_base:100,tax_amount:21,total:121});
  assert.equal(cfg.imported_price_review.reviewed_by,null);assert.equal(cfg.imported_price_review.review_method,'documentary_import');
  assert.equal(cfg.catalog_status,'draft');assert.equal(after.treatments[0].activo,0);
  assert.deepEqual(cfg.source_price,f.before.treatments[0].clinical_config.source_price);
  assert.equal(catalogPrice(after.treatments[0]).amount,121);assert.equal(catalogPrice(after.treatments[0]).label,'IVA 21% incluido');
  verifyCosmeticPrices(p,f.plan,f.purposeDocument);assert(verifyPricedState(after,p));
});
for(const [name,mutate,pattern] of [
  ['changed protocol',f=>f.purposeDocument+=' editado',/REVIEW_INVALID/],
  ['different tax rate',f=>f.review.profile.tax_percent=10,/REVIEW_INVALID/],
  ['invented medical exemption',f=>{f.review.profile.tax_percent=0;f.review.profile.exemption_reason='Es una clínica';},/REVIEW_INVALID/],
  ['different legal basis',f=>f.review.legal_sources=[],/REVIEW_INVALID/],
  ['active treatment',f=>f.before.treatments[0].activo=1,/DRAFT_CHANGED/],
  ['edited price',f=>f.before.treatments[0].precio_base='100.00',/DRAFT_CHANGED/],
  ['previous fiscal review',f=>f.before.treatments[0].clinical_config.fiscal_mapping_pending=false,/DRAFT_CHANGED/],
  ['other clinic',f=>f.before.treatments[0].clinica_id=66,/DRAFT_CHANGED/],
  ['edited duration',f=>f.before.treatments[0].duracion_min=45,/DRAFT_CHANGED/],
  ['missing ordinary import key',f=>delete f.before.treatments[0].clinical_config.source_catalog_key,/DRAFT_CHANGED/],
  ['wrong import key',f=>f.before.treatments[0].clinical_config.source_catalog_key='f'.repeat(64),/DRAFT_CHANGED/],
  ['group changed',f=>f.before.clinics[0].grupo_clinica_id=30,/CLINIC_CHANGED/],
  ['appointment already using the draft',f=>f.before.appointments.push({id_cita:7,tratamiento_id:10}),/DRAFT_ALREADY_USED/],
  ['changed anchor',f=>f.before.anchors[0].clinical_config.price_profile.tax_percent=10,/ANCHOR_CHANGED/],
  ['nonhuman anchor approval',f=>{f.before.anchors[0].clinical_config.imported_price_review.reviewed_by=null;f.review.anchors[0].sha256=hash(f.before.anchors[0]);},/ANCHOR_CHANGED/],
  ['duplicate anchor',f=>f.review.anchors[1]={...f.review.anchors[0]},/ANCHORS_INVALID/],
  ['duplicate treatment',f=>f.review.bindings.push({...f.review.bindings[0]}),/TREATMENT_NOT_UNIQUE/],
  ['mixed therapeutic modality',f=>f.review.bindings[0].classification='therapeutic_or_cosmetic',/PURPOSE_EVIDENCE/],
  ['missing source quotation',f=>f.review.bindings[0].source_quote='Texto no presente en el origen',/PURPOSE_EVIDENCE/],
  ['missing purpose quotation',f=>f.review.bindings[0].purpose_quote='Texto no presente en el protocolo original',/PURPOSE_EVIDENCE/],
  ['unexplained decision',f=>f.review.bindings[0].reason='Por defecto',/PURPOSE_EVIDENCE/],
  ['tampered plan',f=>f.plan.rows[0].price='1 €',/PLAN_INTEGRITY/],
  ['too many treatments',f=>f.review.bindings=Array.from({length:31},()=>({...f.review.bindings[0]})),/REVIEW_INVALID/],
])test('rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>prepareCosmeticPrices(f),pattern);});
test('original program-example format requires exact reconstructable source and is preserved without adding identity fields',()=>{
  const f=fixture(),source=f.plan.rows[0];
  Object.assign(source,{source_row:31,cabin:'11',professional:'Aux. Piedad',duration_info:{mode:'fixed',minutes:30}});
  source.source_price.gross_amount=120;source.provenance.source_row=31;
  source.proposed_clinical_config.source_catalog=structuredClone(source.provenance);
  source.proposed_clinical_config.source_price=structuredClone(source.source_price);
  const other=structuredClone(source);other.source_row=33;other.proposed_code='other-example';other.source_catalog_key='c'.repeat(64);other.source_price.gross_amount=85;
  const programs=[['BS Tono',6,620],['BS Suelo Pélvico',14,420]].map(([name,row,price])=>({...structuredClone(source),
    name,sheet:'Programas y mantenimientos',source_row:row,kind:'program',detail:'6 citas, 2 por semana en días no consecutivos.',source_price:{mode:'fixed',gross_amount:price}}));
  f.plan.rows.push(other,...programs);const{plan_sha256,...body}=f.plan;f.plan.plan_sha256=hash(body);f.review.plan_sha256=f.plan.plan_sha256;
  const treatment=f.before.treatments[0];delete treatment.clinical_config.source_catalog_key;
  Object.assign(treatment.clinical_config,{source_price:structuredClone(source.source_price),source_catalog:structuredClone(source.provenance),import_batch:'cliniccloud-program-examples-20260914'});
  f.review.bindings[0].treatment_sha256=hash(treatment);
  const pkg=prepareCosmeticPrices(f);assert.equal(pkg.operations[0].gross_amount,120);
  assert.equal(reviewedConfig(pkg.operations[0],pkg).source_catalog_key,undefined);
  programs[0].detail='Nueva pauta';const{plan_sha256:old,...changed}=f.plan;f.plan.plan_sha256=hash(changed);f.review.plan_sha256=f.plan.plan_sha256;
  assert.throws(()=>prepareCosmeticPrices(f),/REAL_PROGRAM_SOURCE_CHANGED/);
});
test('unknown, from, included, free, invalid precision and non-EUR prices are never converted into a fixed price',()=>{
  for(const price of [{mode:'included',gross_amount:null,includes_tax:true,currency:'EUR'},
    {mode:'from',gross_amount:30,includes_tax:true,currency:'EUR'},
    ...[0,null,-1,1.001,100000000].map(gross_amount=>({mode:'fixed',gross_amount,includes_tax:true,currency:'EUR'})),
    {mode:'fixed',gross_amount:121,includes_tax:false,currency:'EUR'},
    {mode:'fixed',gross_amount:121,includes_tax:true,currency:'USD'}]){
    const f=fixture();f.plan.rows[0].source_price=price;const{plan_sha256,...body}=f.plan;f.plan.plan_sha256=hash(body);
    f.review.plan_sha256=f.plan.plan_sha256;f.before.treatments[0].clinical_config.source_price=price;f.review.bindings[0].treatment_sha256=hash(f.before.treatments[0]);
    assert.throws(()=>prepareCosmeticPrices(f),/FIXED_GROSS_REQUIRED/);
  }
});
test('HTTP cannot forge or remove technical approval and its existing authenticated confirmation guard remains intact',()=>{
  const f=fixture(),p=prepareCosmeticPrices(f),next=reviewedConfig(p.operations[0],p),previous=f.before.treatments[0].clinical_config;
  const forged=mergeClinicalConfig(previous,{fiscal_mapping_pending:false,imported_price_review:next.imported_price_review,price_profile:PROFILE});
  assert.equal(forged.fiscal_mapping_pending,true);assert.equal(forged.imported_price_review,undefined);
  assert.throws(()=>applyImportedPriceReview(previous,forged,{confirm:true,amount:121}),{code:'imported_price_actor_required'});
  const echoed=mergeClinicalConfig(next,{imported_price_review:{reviewed_by:999}});assert.deepEqual(echoed.imported_price_review,next.imported_price_review);
  assert.throws(()=>applyImportedPriceReview(next,{...next,price_profile:null},{amount:121}),{code:'imported_price_profile_required'});
});
test('new budget snapshots use exact gross price while old classified and unclassified offers retain fiscal history',async()=>{
  const p=prepareCosmeticPrices(fixture()),treatment=priced(p).treatments[0];let calls=0;
  const oldProfile={...PROFILE,tax_percent:10};
  const previous=[{key:'old',treatment_id:10,price_snapshot:{schema_version:1,source:{kind:'treatment',id:10},profile:oldProfile}},
    {key:'unclassified',treatment_id:10}];
  const lines=await resolveBudgetPriceProfiles([{key:'new',treatment_id:10,total:121},{key:'old',treatment_id:10,total:110},{key:'unclassified',treatment_id:10,total:99}],
    {previousLines:previous,resolveTreatments:async ids=>{calls++;assert.deepEqual(ids,[10]);return new Map([[10,treatment]]);}});
  assert.equal(calls,1);assert.equal(lines[0].price_snapshot.profile.tax_percent,21);assert.equal(lines[1].price_snapshot.profile.tax_percent,10);
  assert.equal(lines[2].price_snapshot,undefined);assert.equal(budgetBreakdown([lines[0]],121).total,121);assert.equal(budgetBreakdown([lines[0]],121).taxes,21);
});
test('package and after-state reject unrelated changes and tampering even with a recomputed package hash',()=>{
  const f=fixture(),p=prepareCosmeticPrices(f);p.operations[0].gross_amount=99;const{package_sha256,...body}=p;p.package_sha256=hash(body);
  assert.throws(()=>verifyCosmeticPrices(p,f.plan,f.purposeDocument),/PACKAGE_CHANGED/);
  const clean=prepareCosmeticPrices(f);
  for(const mutate of [s=>s.treatments[0].activo=1,s=>s.treatments[0].precio_base='146.41',s=>s.treatments[0].clinical_config.fiscal_mapping_pending=true,
    s=>s.anchors[0].codigo='other',s=>s.requirements.push({id:1}),s=>s.treatments.pop()]){
    const state=priced(clean);mutate(state);assert.throws(()=>verifyPricedState(state,clean),/COSMETIC_PRICE_/);
  }
});
function fakeConnection(initial,{failWrite=false}={}){
  let state=structuredClone(initial),snapshot;const writes=[];
  return{writes,getState:()=>state,beginTransaction:async()=>{snapshot=structuredClone(state);},rollback:async()=>{if(snapshot)state=structuredClone(snapshot);},
    query:async(sql,args)=>{
      if(sql.startsWith('SET TRANSACTION'))return[[]];
      if(sql.includes(' FROM Clinicas '))return[structuredClone(state.clinics)];
      if(sql.includes(' FROM Tratamientos '))return[[...state.anchors,...state.treatments].map(t=>structuredClone(t))];
      if(sql.includes(' FROM CitasPacientes '))return[structuredClone(state.appointments)];
      if(sql.includes(' FROM TreatmentConsentRequirements '))return[structuredClone(state.requirements)];
      assert(sql.startsWith('UPDATE Tratamientos SET precio_base=?,clinical_config=?'));writes.push({sql,args});
      if(failWrite)throw Error('TEST_WRITE_FAILED');
      const row=state.treatments.find(t=>t.id_tratamiento===args[2]);row.precio_base=args[0].toFixed(2);row.clinical_config=JSON.parse(args[1]);row.updatedAt='2026-09-22';
      return[{affectedRows:1}];
    }};
}
test('SQL dry-run parameterizes only three columns, verifies rollback and replay never writes',async()=>{
  const f=fixture(),pkg=prepareCosmeticPrices(f),c=fakeConnection(pkg.before),journal={append:async()=>{}};
  const result=await execute({c,pkg,plan:f.plan,journal,dryRun:true});assert.equal(result.status,'rolled_back_and_verified');
  assert.deepEqual(c.getState(),pkg.before);assert.equal(c.writes.length,1);assert.equal(c.writes[0].args[0],121);
  const replay=fakeConnection(priced(pkg));assert.equal((await execute({c:replay,pkg,plan:f.plan,journal})).status,'replay_preserved');assert.equal(replay.writes.length,0);
  const broken=fakeConnection(pkg.before,{failWrite:true});await assert.rejects(execute({c:broken,pkg,plan:f.plan,journal}),/TEST_WRITE_FAILED/);assert.deepEqual(broken.getState(),pkg.before);
});
test('target and mode must be explicit before opening a database connection',async()=>{
  await assert.rejects(run(['--mode','apply','--target','dev']),/EXPLICIT_CRM/);
  await assert.rejects(run(['--mode','activate','--target','crm']),/EXPLICIT_CRM/);
});
