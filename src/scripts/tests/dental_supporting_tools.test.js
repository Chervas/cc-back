'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../../lib/dental-supporting-tools-contract');
let serial=0;
const ctx={actorId:7,actorName:'Profesional ficticio',patientId:11,clinical:true,at:'2026-10-21T12:00:00.000Z',newId:()=>`record-${++serial}`};
const apply=(state,command,extra={})=>C.applyCommand(state,command,{...ctx,...extra});
const point=()=>({profundidad:3,sangrado:false,supuracion:false,recesion:0,nivelInsercion:2});
const record=()=>({fecha:'2026-10-21T10:00:00Z',pacienteId:'forged-patient',profesionalId:'forged-doctor',profesionalNombre:'Forged',mediciones:[{numero:16,vestibular:{distal:point(),medio:point(),mesial:point()},lingual:{distal:point(),medio:point(),mesial:point()},movilidad:0,furca:1,placa:false,calculo:false}],notas:'Sondaje de prueba'});
const piece=numero=>({numero,estado:'sano',superficies:[{superficie:'M',estado:'sano'}],tratamientos:[]});
test('empty tools have no invented findings, model, tests, laboratory or clinical results',()=>{
  assert.deepEqual(C.emptyState(),{schema_version:1,odontogram:null,periodontal_records:[],evidences:[],lab_orders:[],messages:[]});
});
test('periodontal reuses all six points, validates bounds and pins server authorship instead of client claims',()=>{
  const state=apply(null,{type:'periodontal.save',record:{...record(),id:'nuevo'}});const saved=state.periodontal_records[0];
  assert.equal(saved.pacienteId,'11');assert.equal(saved.profesionalId,'7');assert.equal(saved.profesionalNombre,ctx.actorName);assert.equal(saved.mediciones[0].lingual.mesial.profundidad,3);
  assert.equal(saved.fecha,'2026-10-21T10:00:00.000Z');assert.equal(saved.version,1);
  const changed=structuredClone(saved);changed.mediciones[0].vestibular.distal.profundidad=8;
  const next=apply(state,{type:'periodontal.save',record:changed});assert.equal(next.periodontal_records[0].version,2);assert.equal(state.periodontal_records[0].mediciones[0].vestibular.distal.profundidad,3);
  const invalid=record();invalid.mediciones[0].lingual.medio.profundidad=16;assert.throws(()=>apply(null,{type:'periodontal.save',record:invalid}),{code:'dental_tools_number_invalid'});
  const incomplete=record();delete incomplete.mediciones[0].lingual.mesial;assert.throws(()=>apply(null,{type:'periodontal.save',record:incomplete}),{code:'dental_tools_periodontal_point_invalid'});
  const duplicate=record();duplicate.mediciones.push(duplicate.mediciones[0]);assert.throws(()=>apply(null,{type:'periodontal.save',record:duplicate}),{code:'dental_tools_periodontal_invalid'});
});
test('odontogram supports permanent and temporary FDI without confusing proposed/executed acts with baseline',()=>{
  const state=apply(null,{type:'odontogram.save',odontogram:{dentition:'mixed',pieces:[piece(16),piece(55)]}});assert.equal(state.odontogram.pieces[1].tipo,'molar');assert.equal(state.odontogram.pieces[1].cuadrante,1);
  for(const [dentition,numero]of[['permanent',55],['temporary',16],['mixed',19],['mixed',86]])assert.throws(()=>apply(null,{type:'odontogram.save',odontogram:{dentition,pieces:[piece(numero)]}}));
  const proposed=piece(16);proposed.tratamientos=[{id:'act-1',nombre:'Corona',estado:'pendiente',orden:1,origen:'propuesto'}];
  assert.throws(()=>apply(null,{type:'odontogram.save',odontogram:{dentition:'permanent',pieces:[proposed]}}),{code:'dental_tools_baseline_execution_invalid'});
  assert.throws(()=>apply(null,{type:'odontogram.save',odontogram:{dentition:'mixed',pieces:[piece(16),piece(16)]}}),{code:'dental_tools_tooth_duplicate'});
});
test('physical reception is different from clinical approval and auxiliary cannot approve or write clinical observations',()=>{
  let state=apply(null,{type:'lab.create',order:{title:'Corona de prueba',laboratory:'Laboratorio ficticio',act_ids:['act-1'],needed_session_id:'session-2'}});const id=state.lab_orders[0].id;
  assert.throws(()=>apply(state,{type:'lab.review',id,decision:'approved'}),{code:'dental_tools_lab_state'});
  state=apply(state,{type:'lab.request',id},{clinical:false});assert.equal(state.lab_orders[0].status,'requested');
  state=apply(state,{type:'lab.delivery',id,expected_delivery_on:'2026-10-24'},{clinical:false});assert.equal(state.lab_orders[0].status,'requested');assert.equal(state.lab_orders[0].expected_delivery_on,'2026-10-24');assert.equal(state.lab_orders[0].received_on,undefined);
  state=apply(state,{type:'lab.receive',id,notes:'Recibido en clínica'},{clinical:false});assert.equal(state.lab_orders[0].status,'received');assert.equal(state.lab_orders[0].reviewed_by,undefined);
  assert.throws(()=>apply(state,{type:'lab.review',id,decision:'approved'},{clinical:false}),{code:'dental_tools_clinical_forbidden'});
  assert.throws(()=>apply(state,{type:'periodontal.save',record:record()},{clinical:false}),{code:'dental_tools_clinical_forbidden'});
  const approved=apply(state,{type:'lab.review',id,decision:'approved'});assert.equal(approved.lab_orders[0].status,'approved');assert.equal(approved.lab_orders[0].reviewed_by,7);assert.equal(approved.lab_orders[0].events.length,5);
  assert.equal(state.lab_orders[0].status,'received');
  assert.throws(()=>apply(approved,{type:'lab.update',id,patch:{title:'Silently changed'}}),{code:'dental_tools_lab_state'});
});
test('evidence retains immutable asset identity, explicit clinical approval and normalized image annotations',()=>{
  let state=apply(null,{type:'evidence.add',evidence:{title:'RX de prueba',kind:'rx',asset_id:'asset-1',act_ids:['act-1'],required:true}});const id=state.evidences[0].id;
  assert.equal(state.evidences[0].clinical_status,'pending');assert.equal(state.evidences[0].required,true);
  assert.throws(()=>apply(state,{type:'evidence.update',id,patch:{asset_id:'replace-original'}}),{code:'dental_tools_evidence_field_invalid'});
  assert.throws(()=>apply(state,{type:'evidence.update',id,patch:{act_ids:[]}},{clinical:false}),{code:'dental_tools_clinical_forbidden'});
  state=apply(state,{type:'evidence.annotate',id,annotations:[{x:.2,y:.8,text:'Revisar',author_id:100}]});assert.equal(state.evidences[0].annotations[0].author_id,7);
  assert.throws(()=>apply(state,{type:'evidence.annotate',id,annotations:[{x:2,y:.8,text:'Fuera'}]}),{code:'dental_tools_number_invalid'});
  state=apply(state,{type:'evidence.review',id,decision:'approved'});assert.equal(state.evidences[0].clinical_status,'approved');
  assert.throws(()=>apply(state,{type:'evidence.review',id,decision:'rejected'}),{code:'dental_tools_text_invalid'});
  state=apply(state,{type:'evidence.update',id,patch:{act_ids:['another-act']}});assert.equal(state.evidences[0].clinical_status,'pending');assert.equal(state.evidences[0].reviewed_by,undefined);
});
test('a rejected laboratory job needs a traced rework, new reception and fresh clinical review',()=>{
  let state=apply(null,{type:'lab.create',order:{title:'Prueba ficticia',laboratory:'Lab ficticio'}});const id=state.lab_orders[0].id;
  for(const command of [{type:'lab.request',id},{type:'lab.receive',id},{type:'lab.review',id,decision:'rejected',notes:'Revisar ajuste'}])state=apply(state,command);
  assert.throws(()=>apply(state,{type:'lab.rework',id,notes:'Ajustar'},{clinical:false}),{code:'dental_tools_clinical_forbidden'});
  state=apply(state,{type:'lab.rework',id,notes:'Ajustar según la prueba',instructions:'Nueva indicación'});assert.equal(state.lab_orders[0].status,'requested');assert.equal(state.lab_orders[0].received_on,undefined);
  state=apply(state,{type:'lab.receive',id});state=apply(state,{type:'lab.review',id,decision:'approved'});
  state=apply(state,{type:'lab.attach',id,evidence_ids:[]},{clinical:false});assert.equal(state.lab_orders[0].status,'received');assert.equal(state.lab_orders[0].reviewed_by,undefined);
});
test('messages keep text/context and server author; dependency or test receipt is not fabricated by a message',()=>{
  const state=apply(null,{type:'message.add',text:'Consultar la prueba',context:{kind:'evidence',id:'evidence-1'},author_id:999},{clinical:false});
  assert.equal(state.messages[0].author_id,7);assert.equal(state.messages[0].context.id,'evidence-1');assert.equal(state.evidences.length,0);assert.equal(state.lab_orders.length,0);
  assert.throws(()=>apply(state,{type:'message.add',text:'',context:{kind:'plan'}}),{code:'dental_tools_text_invalid'});
});
function upload(buffer,filename='model.stl',content_type='model/stl'){return C.validateFile({filename,content_type,data_base64:buffer.toString('base64')});}
test('binary and ASCII STL enforce real triangles and finite coordinates instead of trusting extension/MIME',()=>{
  const binary=Buffer.alloc(134);binary.writeUInt32LE(1,80);assert.equal(upload(binary).contentType,'application/octet-stream');
  const ascii=Buffer.from('solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid test\n');assert.equal(upload(ascii).buffer.length,ascii.length);
  const nan=Buffer.from(binary);nan.writeFloatLE(NaN,84);assert.throws(()=>upload(nan),{code:'dental_tools_stl_coordinate'});
  assert.throws(()=>upload(Buffer.from('<script>model</script>')),{code:'dental_tools_stl_invalid'});
  assert.throws(()=>upload(Buffer.from('solid test\nendsolid test')),{code:'dental_tools_stl_invalid'});
  assert.throws(()=>upload(Buffer.concat([ascii,Buffer.from('<script>extra</script>\n')])) ,{code:'dental_tools_stl_invalid'});
  assert.throws(()=>upload(Buffer.from(ascii.toString().replace('endloop','garbage\nendloop'))),{code:'dental_tools_stl_invalid'});
  assert.throws(()=>upload(binary,'model.exe'),{code:'dental_tools_stl_filename'});
});
test('PDF/image signature checks and strict base64 reject renamed or malformed payloads',()=>{
  assert.equal(upload(Buffer.from('%PDF-1.7\n%%EOF'),'test.pdf','application/pdf').contentType,'application/pdf');
  assert.throws(()=>upload(Buffer.from('not a PDF'),'test.pdf','application/pdf'),{code:'dental_tools_file_signature'});
  assert.throws(()=>upload(Buffer.from('not a PNG'),'test.png','image/png'),{code:'dental_tools_file_signature'});
  assert.throws(()=>C.validateFile({filename:'test.pdf',content_type:'application/pdf',data_base64:'@@evil@@'}),{code:'dental_tools_file_invalid'});
});
test('calendar validation rejects invalid dates and laboratory chronology',()=>{
  assert.throws(()=>C.date('2026-02-30'),{code:'dental_tools_date_invalid'});
  let state=apply(null,{type:'lab.create',order:{title:'Pedido ficticio',laboratory:'Lab'}});const id=state.lab_orders[0].id;
  state=apply(state,{type:'lab.request',id,requested_on:'2026-10-21'});assert.throws(()=>apply(state,{type:'lab.receive',id,received_on:'2026-10-20'}),{code:'dental_tools_lab_date'});
});
test('controller carries trusted actor/clinic identity and hides unexpected storage errors',async()=>{
  const {createController}=require('../../controllers/dentalSupportingTools.controller');let seen;
  const controller=createController({getService:()=>({command:async input=>{seen=input;return{item:{version:1}};},read:async()=>{throw Error('private SQL credential detail');}})});
  const response=()=>({statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;}});
  const req={params:{planId:'plan-1'},query:{clinic_id:'72'},userData:{userId:7},body:{clinic_id:72,actor_id:999}};
  let res=response();await controller.command(req,res);assert.equal(seen.actorId,7);assert.equal(seen.clinicId,'72');assert.equal(res.body.item.version,1);assert.equal(res.headers['Cache-Control'],'private, no-store');
  res=response();await controller.read(req,res);assert.equal(res.statusCode,500);assert.equal(res.body.error.code,'dental_tools_unavailable');assert(!JSON.stringify(res.body).includes('credential'));
  res=response();await controller.command({...req,body:{clinic_id:99}},res);assert.equal(res.statusCode,400);assert.equal(res.body.error.code,'dental_tools_scope_mismatch');
});
test('historical tools version zero stays empty and read-only even after later observations exist',async()=>{
  const {createDentalSupportingToolsService}=require('../../services/dentalSupportingTools.service');
  const db={Clinica:{findByPk:async()=>({configuracion:{disciplinas:['dental']}})},DentalPlan:{findOne:async()=>({id:1,public_id:'plan-1',patient_id:11,clinic_id:72})},Paciente:{findByPk:async()=>({id_paciente:11,public_id:'patient-11',clinica_id:72})},DentalSupportingTools:{findOne:async()=>({public_id:'tools-1',version_number:9,state:{...C.emptyState(),odontogram:{pieces:[piece(16)]}}})}};
  const service=createDentalSupportingToolsService({db,canAccess:async()=>true,resolveRole:async()=>'doctor'}),scope={actorId:7,clinicId:72,planId:'plan-1',patientIdentifier:11};
  const old=await service.read({...scope,version:'0'});assert.equal(old.historical,true);assert.equal(old.item.version,0);assert.equal(old.item.id,null);assert.equal(old.item.odontogram,null);assert.deepEqual(old.item.evidences,[]);assert.equal(old.capabilities.clinical_edit,false);assert.equal(old.capabilities.logistics_edit,false);assert.equal(old.capabilities.upload,false);assert.equal(old.capabilities.message,false);
  const actual=await service.read(scope);assert.equal(actual.item.version,9);assert.equal(actual.item.odontogram.pieces[0].numero,16);assert.equal(actual.capabilities.clinical_edit,true);
  db.Clinica.findByPk=async()=>({configuracion:{disciplinas:['nutricion']}});const disabled=await service.read(scope);assert.equal(disabled.item.version,9);assert.equal(disabled.capabilities.clinical_edit,false);assert.equal(disabled.capabilities.logistics_edit,false);assert.equal(disabled.capabilities.area_configured,false);
  await assert.rejects(service.read({...scope,clinicId:73,patientIdentifier:'other'}),{code:'dental_tools_patient_scope'});
});
