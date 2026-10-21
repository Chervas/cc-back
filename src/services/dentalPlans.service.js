'use strict';
const {Op}=require('sequelize'),C=require('../lib/clinical-episode-contract'),D=require('../lib/dental-plan-contract');
const {isGlobalAdmin}=require('../lib/role-helpers');
const DentalArea=require('../lib/dental-area-scope');
const plain=row=>row?.toJSON?row.toJSON():row;
const json=value=>typeof value==='string'?JSON.parse(value):value;
const DENTAL_AREAS=['dental','dental_clinica','odontologia','odontologia_general'];
function clinicalLineDTO(line,billing=false,clinical=true){const keys=['key','treatment_id','code','name','description','product_type','area_code','specialty','category','tooth','zone','quantity','unit_label',...(clinical?['notes']:[]),...(billing?['unit_price','discount_percent','base','total']:[])];return Object.fromEntries(keys.filter(k=>C.has(line,k)).map(k=>[k,line[k]]));}
function clinicalStateDTO(value){if(Array.isArray(value))return value.map(clinicalStateDTO);if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='clinical_config'?D.clinicalConfig(item):key==='catalog_snapshot'&&item?{id:item.id,title:item.title,code:item.code||null,clinical_config:D.clinicalConfig(item.clinical_config)}:clinicalStateDTO(item)]));}
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>C.has(value,key)).map(key=>[key,value[key]]));
function logisticsStateDTO(state){
 const result=pick(state,['schema_version','title','phase','source_budget','preferences']);
 if(result.source_budget)result.source_budget.snapshot.lines=result.source_budget.snapshot.lines.map(line=>{const output={...line};delete output.notes;return output;});
 result.acts=state.acts.map(act=>({...pick(act,['id','treatment_id','title','label','duration_minutes','professional_id','targets','status','visual_type','duration_selection','source','commercial_scope','review_id']),catalog_snapshot:act.catalog_snapshot?{...pick(act.catalog_snapshot,['id','title','code']),clinical_config:pick(act.catalog_snapshot.clinical_config||{},['booking_profile'])}:null}));
 result.sessions=state.sessions.map(session=>pick(session,['id','title','label','order','act_ids','status','parent_ids','appointment_ids','absorbed_into','earliest_date','tentative_on','reviewed_by','reviewed_at','review_ids']));
 result.dependencies=state.dependencies.map(dependency=>pick(dependency,['id','from_act_id','to_act_id','min_wait_days','action','source','wait_min_value','wait_min_unit']));
 result.reservations=state.reservations.map(reservation=>pick(reservation,['appointment_id','session_id','act_ids','start_at','end_at','profile_snapshot','phases','appointment_status','active','appointment_revision']));
 result.execution=state.execution.map(event=>pick(event,['id','act_id','target_id','status','plan_version','episode_id','appointment_id','session_id','actor_id','recorded_at','tools_version']));
 result.changes=[];
 if(result.preferences)result.preferences=pick(result.preferences,['exclude_weekdays','prefer_after_minutes','prefer_before_minutes','keep_professional','doctor_id','installation_id','max_duration_minutes']);
 const reviewKeys=['id','due_on','status','created_at','actor_id','prepared_act_id','prepared_session_id','appointment_ids','prepared_by','prepared_at'];
 if(state.review)result.review=pick(state.review,reviewKeys);
 if(state.reviews)result.reviews=state.reviews.map(review=>pick(review,reviewKeys));
 return result;
}
function createDentalPlanService({db,canAccess=(...args)=>require('../lib/access-policy').canUserAccessFeature(...args),now=()=>new Date(),loadProtocol,
 validateMaterials,booking,toolsState}={}){
 const Plan=db.DentalPlan,Revision=db.DentalPlanRevision;
 async function patientInClinic(identifier,clinicId,transaction,lock=false){
  clinicId=C.integer(clinicId);const raw=String(identifier??'');if(!raw||raw.length>80)D.fail('patient_invalid','Selecciona un paciente.');
  const patient=await db.Paciente.findOne({where:/^[1-9]\d*$/.test(raw)?{id_paciente:C.integer(raw)}:{public_id:raw},transaction,...(lock?{lock:transaction.LOCK.UPDATE}:{})});
  if(!patient||Number(patient.clinica_id)!==clinicId&&!await db.PacienteClinica.findOne({where:{paciente_id:patient.id_paciente,clinica_id:clinicId},transaction}))D.fail('patient_not_found','Paciente no encontrado en esta clínica.',404);return patient;
 }
 async function capabilities({clinicId,actorId}){
  C.integer(clinicId);C.integer(actorId);
  const member=isGlobalAdmin(actorId)?null:await db.UsuarioClinica.findOne({where:{id_usuario:actorId,id_clinica:clinicId,[Op.or]:[{estado_invitacion:'aceptada'},{estado_invitacion:null}]}});
  const staff=isGlobalAdmin(actorId)||member&&['propietario','personaldeclinica'].includes(member.rol_clinica);
  const professional=isGlobalAdmin(actorId)||member&&(member.rol_clinica==='propietario'||member.subrol_clinica==='Doctores');
  if(!staff)return{view:false,clinical_manage:false,logistics_manage:false,prepare_plan:false,billing_view:false};
  const keys=['patients.view','patients.sensitive.view','clinical.reports.view','clinical.reports.manage','appointments.manage','billing.reports.view'];
  const values=await Promise.all(keys.map(featureKey=>canAccess({actorId,clinicId,featureKey}))),p=Object.fromEntries(keys.map((k,i)=>[k,values[i]]));
  const view=!!(p['patients.view']&&p['patients.sensitive.view']&&(p['clinical.reports.view']||p['appointments.manage']));
  const clinic=await db.Clinica.findByPk(clinicId),area_configured=DentalArea.configuredDentalArea(clinic);
  const clinical_view=!!(view&&p['clinical.reports.view']),clinical_manage=!!(clinical_view&&area_configured&&professional&&p['clinical.reports.manage']),logistics_manage=!!(view&&area_configured&&p['appointments.manage']);
  return{view,clinical_view,clinical_manage,logistics_manage,prepare_plan:clinical_manage||logistics_manage,billing_view:!!(view&&p['billing.reports.view']),area_configured,write_block_reason:area_configured?null:'dental_area_not_configured'};
 }
 async function authorize(options,kind='view'){const caps=await capabilities(options);if(!caps[kind]){if(kind!=='view'&&caps.view&&!caps.area_configured)DentalArea.assertDentalAreaConfigured(null);D.fail('forbidden','No tienes permiso para esta acción dental.',403);}return caps;}
 async function assertWritingClinic(clinicId,transaction){DentalArea.assertDentalAreaConfigured(await db.Clinica.findByPk(clinicId,{transaction,lock:transaction.LOCK.SHARE}));}
 function assertRequestedPatient(patient,options){if(options.requestedPatientIdentifier!==undefined&&Number(options.requestedPatientIdentifier)!==Number(patient.id_paciente))D.fail('patient_not_found','El contexto no corresponde a este paciente.',404);}
 async function scopedPlan({id,clinicId,patientIdentifier,transaction,lock=false}){
  const row=await Plan.findOne({where:{public_id:D.id(id),clinic_id:C.integer(clinicId)},transaction,...(lock?{lock:transaction.LOCK.UPDATE}:{})});
  if(!row)D.fail('plan_not_found','Plan dental no encontrado.',404);
  const p=await patientInClinic(patientIdentifier??row.patient_id,clinicId,transaction);if(Number(p.id_paciente)!==Number(row.patient_id))D.fail('plan_not_found','Plan dental no encontrado.',404);return row;
 }
 function serialize(row,caps={billing_view:false}){
  const value=plain(row);let state=clinicalStateDTO(D.clone(json(value.state)));
  if(state.source_budget){state.source_budget.snapshot.lines=state.source_budget.snapshot.lines.map(line=>clinicalLineDTO(line,caps.billing_view));if(!caps.billing_view){delete state.source_budget.snapshot.payment_proposal;delete state.source_budget.snapshot.totals;if(state.source_budget.snapshot.acceptance)delete state.source_budget.snapshot.acceptance.selected_payment_mode;}}
  if(caps.clinical_view===false)state=logisticsStateDTO(state);
  return{id:value.public_id,clinic_id:Number(value.clinic_id),patient_id:Number(value.patient_id),version:Number(value.version_number),status:value.status,...state,created_at:value.created_at,updated_at:value.updated_at};
 }
 async function reservationReadState(row,transaction=null,locking=false){
  const state=D.clone(json(row.state)),ids=state.reservations.map(r=>r.appointment_id);if(!ids.length)return D.syncReviewLinks(state);
  const appointments=await db.CitaPaciente.findAll({where:{id_cita:{[Op.in]:ids},clinica_id:row.clinic_id,paciente_id:row.patient_id},transaction,...(locking?{lock:transaction.LOCK.SHARE}:{})});
  for(const r of state.reservations){const a=appointments.find(a=>Number(a.id_cita)===r.appointment_id);if(!a){if(locking)D.fail('appointment_scope_changed','Falta una reserva del historial dental.',409);r.active=false;r.appointment_status='unavailable';continue;}r.appointment_status=a.estado;r.active=!['cancelada','no_asistio'].includes(a.estado);r.start_at=new Date(a.inicio).toISOString();r.end_at=new Date(a.fin).toISOString();r.appointment_revision=require('../lib/appointment-import-review').importReviewVersion(plain(a));}
  return D.syncReviewLinks(state);
 }
 async function acceptedBudget(raw,patientId,clinicId,transaction){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))D.fail('budget_invalid','Selecciona un presupuesto aceptado.');
  const budget=await db.EconomicBudget.findOne({where:{public_id:D.id(raw.id),patient_id:patientId,clinic_id:clinicId},transaction,lock:transaction.LOCK.SHARE});
  if(!budget||!['accepted','partially_accepted'].includes(budget.status)||raw.version!==Number(budget.current_version))D.fail('budget_not_accepted','Actualiza el presupuesto y elige su versión aceptada.',409);
  const [version,event]=await Promise.all([
   db.EconomicBudgetVersion.findOne({where:{budget_id:budget.id,version_number:budget.current_version},transaction}),
   db.EconomicBudgetEvent.findOne({where:{budget_id:budget.id,version_number:budget.current_version,event_type:budget.status==='accepted'?'accepted':'partially_accepted'},order:[['id','DESC']],transaction}),
  ]);
  if(!version||!event)D.fail('acceptance_missing','No se encuentra la aceptación de esta versión del presupuesto.',409);
  const lines=json(version.lines),metadata=json(event.metadata)||{},accepted=budget.status==='accepted'?lines.map(l=>l.key):metadata.accepted_line_keys||[];
  const keys=D.list(raw.line_keys??accepted,200);if(!keys.length||new Set(keys).size!==keys.length||keys.some(key=>typeof key!=='string'||!accepted.includes(key)||!lines.some(l=>l.key===key&&l.product_type==='treatment'&&DENTAL_AREAS.includes(l.area_code))))D.fail('budget_scope_invalid','Selecciona sólo tratamientos dentales aceptados de esta versión.');
  return{budget,source:{id:budget.public_id,number:budget.number,version:Number(version.version_number),line_keys:keys.slice(),snapshot:{lines:D.clone(lines.filter(l=>keys.includes(l.key))),payment_proposal:D.clone(json(version.payment_proposal)),totals:D.clone(json(version.totals)),acceptance:{event_id:Number(event.id),selected_payment_mode:metadata.selected_payment_mode||null,accepted_at:event.created_at}}}};
 }
 async function prepareAct(raw,clinicId,transaction,previous=null,source=null){
  const clinic=await db.Clinica.findByPk(clinicId,{transaction});
  const treatment=raw.treatment_id?await require('./treatmentBookingProfile.service').loadScopedTreatment({db,treatmentId:raw.treatment_id,clinic,transaction}):null;
  if(treatment&&!DENTAL_AREAS.includes(treatment.disciplina))D.fail('treatment_area_invalid','Selecciona un tratamiento del catálogo dental.');
  if(previous&&raw.treatment_id&&Number(raw.treatment_id)!==previous.treatment_id)D.fail('act_identity_preserved','Añade el tratamiento nuevo como un acto diferente para conservar el anterior.',409);
  const a=D.act(raw,{previous,treatment,source});
  if(a.professional_id&&!await db.DoctorClinica.findOne({where:{doctor_id:a.professional_id,clinica_id:clinicId,activo:true,recibe_citas:true},transaction}))D.fail('professional_invalid','Selecciona un profesional activo de esta clínica.');
  if(treatment?.requiere_pieza&&a.targets.some(t=>t.kind!=='tooth'))D.fail('tooth_required','Este tratamiento necesita una pieza dental.');return a;
 }
 async function inheritedDependencies(state,clinicId,transaction){
  const ids=[...new Set(state.acts.map(a=>a.treatment_id).filter(Boolean))];
  const rows=ids.length?await db.DependenciaTratamiento.findAll({where:{id_tratamiento_origen:{[Op.in]:ids},id_tratamiento_destino:{[Op.in]:ids}},transaction,limit:500}):[];
  const dependencies=[];
  for(const row of rows)for(const from of state.acts.filter(a=>a.treatment_id===Number(row.id_tratamiento_origen)))for(const to of state.acts.filter(a=>a.treatment_id===Number(row.id_tratamiento_destino))){
   const teeth=a=>a.targets.filter(t=>t.kind==='tooth').map(t=>t.fdi),first=teeth(from),second=teeth(to);if(first.length&&second.length&&!first.some(t=>second.includes(t)))continue;
   dependencies.push({from_act_id:from.id,to_act_id:to.id,min_wait_days:Number(row.dias_espera)||0,action:row.tipo==='recomendada'?'warn':'override',source:`catalog:${row.id}`,notes:row.notas||null});
  }
  state.catalog_dependency_snapshot??=rows.map(r=>({id:Number(r.id),id_tratamiento_origen:Number(r.id_tratamiento_origen),id_tratamiento_destino:Number(r.id_tratamiento_destino),tipo:r.tipo,dias_espera:Number(r.dias_espera)||0,notas:r.notas||null}));
  const protocol=loadProtocol?await loadProtocol(clinicId,transaction):await require('./medicalAreaContracts.service').createMedicalAreaContractsService(db).getContractForArea('dental',{clinicId,transaction});
  state.protocol_snapshot=protocol?{code:protocol.code||'dental',revision:protocol.revision||null,protocol_rules:D.clone(protocol.protocol_rules||[]),contract_sha256:C.hash(protocol)}:null;Object.assign(state,require('../lib/dental-protocol').deriveProtocol(state,state.catalog_dependency_snapshot));return state;
 }
 async function revision(row,actorId,command,payload,transaction){
  const snapshot={id:row.public_id,clinic_id:Number(row.clinic_id),patient_id:Number(row.patient_id),version:Number(row.version_number),status:row.status,...D.clone(json(row.state))};
  return Revision.create({plan_id:row.id,version_number:row.version_number,snapshot,sha256:C.hash(snapshot),command,mutation_key:C.hash(D.key(payload)),request_hash:C.hash(payload),actor_id:actorId,created_at:now()},{transaction});
 }
 async function replay(row,payload,transaction){const prior=await Revision.findOne({where:{plan_id:row.id,mutation_key:C.hash(D.key(payload))},transaction});if(!prior)return false;if(prior.request_hash!==C.hash(payload))D.fail('idempotency_conflict','Esta referencia ya se utilizó con otra acción.',409);return true;}
 function compare(row,payload){if(Number(row.version_number)!==D.version(payload))D.fail('version_conflict','El plan ha cambiado. Conserva tus cambios y revisa su versión actual.',409,{current_version:Number(row.version_number)});}
 async function mutation(options,command,apply,kind='clinical_manage'){
  const caps=await authorize(options,kind);D.version(options.payload);D.key(options.payload);
  return db.sequelize.transaction({isolationLevel:'READ COMMITTED'},async transaction=>{
   await assertWritingClinic(options.clinicId,transaction);
   const current=await scopedPlan({...options,transaction});await patientInClinic(current.patient_id,options.clinicId,transaction,true);
   const row=await scopedPlan({...options,transaction,lock:true});if(await replay(row,options.payload,transaction))return{item:serialize(row,caps),replayed:true};compare(row,options.payload);
   const state=await reservationReadState(row,transaction,true);
   const extra=await apply({row,state,transaction,caps})||{};
   if(Buffer.byteLength(JSON.stringify(state))>1500000)D.fail('plan_too_large','El plan supera el tamaño permitido.',413);
   await row.update({state,status:state.phase,version_number:Number(row.version_number)+1,updated_by:options.actorId},{transaction});await revision(row,options.actorId,command,options.payload,transaction);
   const after=extra.afterPersist?await extra.afterPersist(row):{};delete extra.afterPersist;
   return{item:serialize({...plain(row),state:await reservationReadState(row,transaction)},caps),replayed:false,...extra,...after};
  });
 }
 async function create(options){
  const caps=await authorize(options,'prepare_plan'),payload=options.payload;if(!caps.clinical_manage&&(!payload.source_budget||(payload.acts?.length??0)>0))D.fail('clinical_validation_required','El profesional debe preparar la consulta sin presupuesto o añadir trabajo clínico.',403);if(D.version(payload)!==0)D.fail('version_conflict','El plan nuevo debe comenzar en la versión inicial.',409);D.key(payload);
  return db.sequelize.transaction({isolationLevel:'READ COMMITTED'},async transaction=>{
   await assertWritingClinic(options.clinicId,transaction);
   const patient=await patientInClinic(options.patientIdentifier,options.clinicId,transaction,true),creationKey=C.hash([options.clinicId,Number(patient.id_paciente),D.key(payload)]),creationHash=C.hash(payload);
   assertRequestedPatient(patient,options);
   const old=await Plan.findOne({where:{creation_key:creationKey},transaction});if(old){if(old.creation_hash!==creationHash)D.fail('idempotency_conflict','La solicitud ya creó otro plan.',409);return{item:serialize(old,caps),created:false,replayed:true};}
   const state=D.initialState(payload.title);let budgetId=null;
   if(payload.source_budget){
    const source=await acceptedBudget(payload.source_budget,patient.id_paciente,options.clinicId,transaction);state.source_budget=source.source;budgetId=source.budget.id;
    const existing=await Plan.findAll({where:{budget_id:budgetId,clinic_id:options.clinicId,patient_id:patient.id_paciente},transaction});const duplicate=existing.find(plan=>!['archived','cancelled'].includes(plan.status)&&json(plan.state).source_budget.line_keys.some(key=>source.source.line_keys.includes(key)));if(duplicate)D.fail('accepted_scope_already_planned','Parte de este alcance aceptado ya tiene un plan. Ábrelo para continuar sin duplicar trabajo.',409,{plan_id:duplicate.public_id});
    const breakdowns=D.list(payload.line_breakdown??[],200);if(new Set(breakdowns.map(b=>b?.line_key)).size!==breakdowns.length||breakdowns.some(b=>!b||!source.source.line_keys.includes(b.line_key)))D.fail('budget_scope_review_required','Revisa las líneas del desglose clínico.');
    for(const line of state.source_budget.snapshot.lines){
     const quantity=Number(line.quantity),breakdown=breakdowns.find(b=>b.line_key===line.key)?.acts;
     if(quantity!==1&&!breakdown)D.fail('budget_scope_review_required','Esta línea contiene varias unidades. El profesional debe indicar su desglose clínico antes de generar actos.',409,{line_key:line.key,quantity});
     const entries=breakdown?D.list(breakdown,100):[{allocated_quantity:1}];if(!caps.clinical_manage&&breakdown)D.fail('clinical_validation_required','El desglose clínico necesita revisión profesional.',403);
     if(!entries.length||entries.some(a=>typeof a.allocated_quantity!=='number'||!Number.isFinite(a.allocated_quantity)||a.allocated_quantity<=0||Math.abs(a.allocated_quantity*100-Math.round(a.allocated_quantity*100))>1e-8)||Math.round(entries.reduce((sum,a)=>sum+a.allocated_quantity,0)*100)!==Math.round(quantity*100))D.fail('budget_scope_review_required','Las unidades del desglose deben conservar exactamente el alcance aceptado.',409,{line_key:line.key,quantity});
     for(const entry of entries){const raw={...entry,treatment_id:line.treatment_id,title:line.name,targets:entry.targets??[line.tooth?{kind:'tooth',fdi:line.tooth}:{kind:'general'}]};state.acts.push(await prepareAct(raw,options.clinicId,transaction,null,{budget_id:source.source.id,version:source.source.version,line_key:line.key,allocated_quantity:entry.allocated_quantity,accepted_quantity:quantity}));}
    }
   }
   for(const raw of D.list(payload.acts??[],100))state.acts.push(await prepareAct(raw,options.clinicId,transaction));
   await inheritedDependencies(state,options.clinicId,transaction);
   const row=await Plan.create({public_id:D.uuid(),clinic_id:options.clinicId,patient_id:patient.id_paciente,budget_id:budgetId,version_number:1,status:state.phase,state,creation_key:creationKey,creation_hash:creationHash,created_by:options.actorId,updated_by:options.actorId},{transaction});await revision(row,options.actorId,'created',payload,transaction);return{item:serialize(row,caps),created:true,replayed:false};
  });
 }
 async function get(options){const caps=await authorize(options),row=await scopedPlan(options);if(options.query?.version){const rev=await Revision.findOne({where:{plan_id:row.id,version_number:C.integer(options.query.version)}});if(!rev)D.fail('revision_not_found','Versión no encontrada.',404);return{item:serialize({...plain(row),version_number:rev.version_number,status:rev.snapshot.phase,state:rev.snapshot},caps),capabilities:caps};}return{item:serialize({...plain(row),state:await reservationReadState(row)},caps),capabilities:caps};}
 async function list(options){const caps=await authorize(options),patient=await patientInClinic(options.patientIdentifier,options.clinicId);assertRequestedPatient(patient,options);const limit=options.query?.limit?C.integer(options.query.limit):30;if(limit>100)D.fail('limit_invalid','Solicita como máximo 100 planes.');const cursor=C.decodeCursor(options.query?.cursor),where={clinic_id:options.clinicId,patient_id:patient.id_paciente};if(cursor){if(cursor.patient!==Number(patient.id_paciente)||cursor.clinic!==options.clinicId)D.fail('cursor_invalid','La página no corresponde a este paciente.');where.id={[Op.lt]:C.integer(cursor.id)};}const rows=await Plan.findAll({where,order:[['id','DESC']],limit:limit+1});return{items:await Promise.all(rows.slice(0,limit).map(async r=>serialize({...plain(r),state:await reservationReadState(r)},caps))),next_cursor:rows.length>limit?C.encodeCursor({patient:Number(patient.id_paciente),clinic:options.clinicId,id:Number(rows[limit-1].id)}):null,capabilities:caps};}
 async function command(options){
  const clinical=options.payload.command!=='preferences',preparation=['generate','move_act','merge_sessions','split_session'].includes(options.payload.command);return mutation(options,options.payload.command,async({state,transaction})=>{
   let preparedAct=null;const p=options.payload;
   if(p.command==='add_act'||p.command==='prepare_review'){
    if(p.command==='prepare_review'&&(!p.act||!Array.isArray(p.act.targets)||!p.act.targets.length||!Number.isInteger(p.act.duration_minutes)||p.act.duration_minutes<1||!Number.isSafeInteger(p.act.professional_id)||p.act.professional_id<1))D.fail('review_scope_required','Elige explícitamente trabajo, alcance, profesional y duración de la revisión.');
    preparedAct=await prepareAct(p.act,options.clinicId,transaction);
   }
   if(p.command==='update_act'){const old=state.acts.find(a=>a.id===p.act_id);if(!old)D.fail('act_not_found','Tratamiento no encontrado.',404);preparedAct=await prepareAct({...old,...p.act},options.clinicId,transaction,old);}
   if(p.command==='review_session')require('../lib/dental-protocol').validateReview(state,p);
   if(p.command==='preferences'){
    const prefs=require('../lib/dental-preferences').normalize(p.preferences);
    if(prefs?.doctor_id&&!await db.DoctorClinica.findOne({where:{doctor_id:prefs.doctor_id,clinica_id:options.clinicId,activo:true,recibe_citas:true},transaction}))D.fail('professional_invalid','Selecciona un profesional activo de esta clínica.');
    if(prefs?.installation_id&&!await db.Instalacion.findOne({where:{id:prefs.installation_id,clinica_id:options.clinicId,activo:true},transaction}))D.fail('installation_invalid','Selecciona un gabinete activo de esta clínica.');
   }
   const clinic=await db.Clinica.findByPk(options.clinicId,{transaction}),calendar=require('../lib/availability-calendar');
   const updated=D.changeState(state,p,{actorId:options.actorId,now:now().toISOString(),localDate:calendar.formatDateLocal(now(),calendar.resolveClinicTimezone(clinic)),preparedAct});for(const k of Object.keys(state))delete state[k];Object.assign(state,updated);
   if(['add_act','update_act','remove_act','prepare_review'].includes(p.command)){
    const ids=[...new Set(state.acts.map(a=>a.treatment_id).filter(Boolean))],rules=ids.length?await db.DependenciaTratamiento.findAll({where:{id_tratamiento_origen:{[Op.in]:ids},id_tratamiento_destino:{[Op.in]:ids}},transaction,limit:500}):[];
    const pinned=state.catalog_dependency_snapshot||[];for(const rule of rules)if(!pinned.some(r=>r.id===Number(rule.id)))pinned.push({id:Number(rule.id),id_tratamiento_origen:Number(rule.id_tratamiento_origen),id_tratamiento_destino:Number(rule.id_tratamiento_destino),tipo:rule.tipo,dias_espera:Number(rule.dias_espera)||0,notas:rule.notas||null});state.catalog_dependency_snapshot=pinned;Object.assign(state,require('../lib/dental-protocol').deriveProtocol(state,pinned));
   }
   if(p.command==='prepare_review'&&p.review_session===true){
    require('../lib/dental-protocol').validateReview(state,p);
    const review=D.reviewEntries(state).find(review=>review.id===p.review_id),reviewed=D.changeState(state,{...p,command:'review_session',session_id:review.prepared_session_id},{actorId:options.actorId,now:now().toISOString()});
    Object.assign(state,reviewed,{phase:'agenda'});
   }
  },preparation?'prepare_plan':clinical?'clinical_manage':'logistics_manage');
 }
 async function revisions(options){await authorize(options);const row=await scopedPlan(options),limit=options.query?.limit?C.integer(options.query.limit):25;if(limit>100)D.fail('limit_invalid','Solicita como máximo 100 versiones.');const cursor=C.decodeCursor(options.query?.cursor),where={plan_id:row.id};if(cursor){if(cursor.plan!==row.public_id)D.fail('cursor_invalid','La página no corresponde al plan.');where.version_number={[Op.lt]:C.integer(cursor.version)};}const rows=await Revision.findAll({where,order:[['version_number','DESC']],limit:limit+1}),caps=await capabilities(options);return{items:rows.slice(0,limit).map(r=>({version:Number(r.version_number),command:r.command,actor_id:r.actor_id,created_at:r.created_at,sha256:r.sha256,snapshot:serialize({...plain(row),state:r.snapshot,version_number:r.version_number,status:r.snapshot.phase},caps)})),next_cursor:rows.length>limit?C.encodeCursor({plan:row.public_id,version:Number(rows[limit-1].version_number)}):null};}
 async function readTools(row,transaction){if(toolsState)return toolsState({planPublicId:row.public_id,clinicId:Number(row.clinic_id),patientId:Number(row.patient_id),transaction});const r=db.DentalSupportingTools&&await db.DentalSupportingTools.findOne({where:{plan_id:row.id,clinic_id:row.clinic_id,patient_id:row.patient_id},transaction,...(transaction?{lock:transaction.LOCK.SHARE}:{})});return r?{...json(r.state),version:Number(r.version_number)}:null;}
 async function workspace(options){
  const caps=await authorize(options),patient=await patientInClinic(options.patientIdentifier,options.clinicId),clinic=await db.Clinica.findByPk(options.clinicId);assertRequestedPatient(patient,options);
  const [plans,budgets,professionals,rooms,appointments,catalog]=await Promise.all([
   list({...options,query:{limit:100}}),db.EconomicBudget.findAll({where:{clinic_id:options.clinicId,patient_id:patient.id_paciente,status:{[Op.in]:['accepted','partially_accepted']}},order:[['id','DESC']],limit:100}),
   db.DoctorClinica.findAll({where:{clinica_id:options.clinicId,activo:true,recibe_citas:true},attributes:['doctor_id'],limit:100}),
   db.Instalacion.findAll({where:{clinica_id:options.clinicId,activo:true},attributes:['id','nombre'],limit:100}),
   db.CitaPaciente.findAll({where:{clinica_id:options.clinicId,paciente_id:patient.id_paciente},order:[['inicio','DESC']],limit:200}),
   db.Tratamiento.findAll({where:{disciplina:{[Op.in]:DENTAL_AREAS},activo:true,[Op.or]:[{origen:'sistema'},{origen:'clinica',clinica_id:options.clinicId},...(clinic.grupoClinicaId?[{origen:'grupo',grupo_clinica_id:clinic.grupoClinicaId}]:[])]},order:[['nombre','ASC']],limit:250}),
  ]);
  const accepted=[];for(const b of budgets){const v=await db.EconomicBudgetVersion.findOne({where:{budget_id:b.id,version_number:b.current_version}}),event=await db.EconomicBudgetEvent.findOne({where:{budget_id:b.id,version_number:b.current_version,event_type:b.status==='accepted'?'accepted':'partially_accepted'},order:[['id','DESC']]});if(!v||!event)continue;const lines=json(v.lines).filter(l=>l.product_type==='treatment'&&DENTAL_AREAS.includes(l.area_code)),keys=b.status==='accepted'?lines.map(l=>l.key):(json(event.metadata)?.accepted_line_keys||[]);const filtered=lines.filter(l=>keys.includes(l.key));if(!filtered.length)continue;accepted.push({id:b.public_id,number:b.number,version:Number(v.version_number),status:b.status,accepted_line_keys:filtered.map(l=>l.key),lines:filtered.map(l=>clinicalLineDTO(l,caps.billing_view,caps.clinical_view)),...(caps.billing_view?{payment_proposal:json(v.payment_proposal)}:{})});}
  const users=professionals.length?await db.Usuario.findAll({where:{id_usuario:{[Op.in]:professionals.map(p=>p.doctor_id)}},attributes:['id_usuario','nombre','apellidos']}):[];
  return{patient:{id:Number(patient.id_paciente),public_id:patient.public_id||null,name:[patient.nombre,patient.apellidos].filter(Boolean).join(' ')},clinic:{id:options.clinicId,name:clinic.nombre_clinica||'Clínica',timezone:require('../lib/availability-calendar').resolveClinicTimezone(clinic)},plans:plans.items,accepted_budgets:accepted,catalog:catalog.filter(t=>!json(t.eliminado_por_clinica||[])?.map(Number).includes(options.clinicId)).map(t=>({id:Number(t.id_tratamiento),title:t.nombre,duration_minutes:t.duracion_min,requires_piece:!!t.requiere_pieza,code:t.codigo,clinical_config:caps.clinical_view?D.clinicalConfig(t.clinical_config):pick(D.clinicalConfig(t.clinical_config),['booking_profile'])})),professionals:users.map(p=>({id:Number(p.id_usuario),name:[p.nombre,p.apellidos].filter(Boolean).join(' ')})),installations:rooms.map(r=>({id:Number(r.id),name:r.nombre})),appointments:appointments.map(a=>({id:Number(a.id_cita),start:a.inicio,end:a.fin,status:a.estado,title:a.titulo,treatment_id:a.tratamiento_id?Number(a.tratamiento_id):null,revision:require('../lib/appointment-import-review').importReviewVersion(plain(a))})),capabilities:caps};
 }
 const bookingService=()=>booking||require('./dentalPlanBooking.service').createDentalPlanBookingService({db,now,core:{authorize,scopedPlan,patientInClinic,serialize,reservationReadState,mutation,compare,readTools}});
 return{patientInClinic,scopedPlan,capabilities,authorize,serialize,reservationReadState,create,get,list,command,revisions,workspace,mutation,compare,readTools,
  availability:options=>bookingService().availability(options),book:options=>bookingService().book(options),execution:options=>require('./dentalPlanExecution.service').createDentalPlanExecutionService({db,now,core:{mutation,readTools},validateMaterials}).execute(options)};
}
const lazy=()=>createDentalPlanService({db:require('../../models')});
module.exports={createDentalPlanService,DENTAL_AREAS,...Object.fromEntries(['create','get','list','command','revisions','workspace','availability','book','execution'].map(k=>[k,(...args)=>lazy()[k](...args)]))};
