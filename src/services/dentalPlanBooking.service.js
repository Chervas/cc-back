'use strict';
const {Op}=require('sequelize'),C=require('../lib/clinical-episode-contract'),D=require('../lib/dental-plan-contract');
const {normalizeBookingProfile,bookingProfileDurationMinutes}=require('../lib/booking-profile');
const {bookingCapabilities,assertOperationalBookingProfile,loadScopedTreatment}=require('./treatmentBookingProfile.service');
const A=require('./appointmentBookingAvailability.service'),B=require('./appointmentBookingCommand.service');
const {resolveClinicTimezone}=require('../lib/availability-calendar'),{resolveLocalInstant}=require('../lib/voucher-schedule-calendar');
const {addDays}=require('../lib/personal-schedule-recurring'),P=require('../lib/program-booking-preferences'),Dep=require('../lib/dental-dependencies');
const Preferences=require('../lib/dental-preferences');
function bookingSelections(profile,input,expected={}){if(!input||typeof input!=='object'||Array.isArray(input))D.fail('selection_invalid','Revisa el profesional y el gabinete.');const selected={...expected};for(const [key,choice]of Object.entries(input)){if(!profile.phases.some(p=>p.key===key)||!choice||typeof choice!=='object'||Array.isArray(choice)||Object.keys(choice).some(k=>!['doctor_id','installation_id'].includes(k)))D.fail('selection_invalid','Revisa los recursos elegidos para cada paso.');const normalized={};for(const [field,value]of Object.entries(choice)){normalized[field]=C.integer(value);if(expected[key]?.[field]&&expected[key][field]!==normalized[field])D.fail('preference_conflict','La hora elegida no respeta el profesional o gabinete preferido.',409);}selected[key]={...selected[key],...normalized};}return selected;}
function allowedIssues(issues,session,reason,clinical){const persisted=session.dependency_overrides||[];return issues.filter(i=>i.action==='warn'||i.action==='override'&&(persisted.includes(i.id)&&session.dependency_override_reason||clinical&&D.text(reason)));}
function recordOverrides(state,issues,session,payload,caps,actorId,createdAt,appointmentId=null){const direct=caps.clinical_manage?D.text(payload.reason):null;if(issues.some(i=>i.action!=='warn'))state.changes.push({id:D.uuid(),type:'dependency_override',reason:direct||D.text(session.dependency_override_reason),issues,actor_id:actorId,reviewed_by:direct?actorId:session.reviewed_by,appointment_id:appointmentId,created_at:createdAt});}
function selectedActs(state,payload){
 const session=state.sessions.find(s=>s.id===D.id(payload.session_id)&&s.status!=='absorbed');if(!session)D.fail('session_not_found','Sesión no encontrada.',404);
 if(!['reviewed','booked'].includes(session.status))D.fail('session_review_required','El profesional debe revisar la sesión antes de reservarla.',409);
 const moving=payload.mode==='reschedule'?state.reservations.find(r=>r.appointment_id===Number(payload.appointment_id)&&r.session_id===session.id):null;
 if(payload.mode==='reschedule'&&!moving)D.fail('reservation_scope_invalid','Selecciona la reserva del plan que deseas replanificar.',409);
 const ids=payload.act_ids??moving?.act_ids??session.act_ids.filter(id=>!state.reservations.some(r=>r.active!==false&&r.act_ids.includes(id)));
 if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!session.act_ids.includes(id)||state.reservations.some(r=>r.active!==false&&r!==moving&&r.act_ids.includes(id)))||moving&&JSON.stringify(ids.slice().sort())!==JSON.stringify(moving.act_ids.slice().sort()))D.fail('reservation_scope_invalid','Selecciona trabajo revisado sin otra reserva activa.',409);
 const acts=ids.map(id=>state.acts.find(a=>a.id===id&&a.status!=='cancelled'));if(acts.some(a=>!a))D.fail('reservation_scope_invalid','Revisa los tratamientos de esta sesión.',409);return{session,acts,moving};
}
function assertExistingItinerary(appointment,expected){
 const start=new Date(appointment.inicio),end=new Date(appointment.fin),duration=(end-start)/60000;
 if(duration!==bookingProfileDurationMinutes(expected))D.fail('appointment_profile_mismatch','La duración de la reserva no coincide con el trabajo. Replanifica la cita desde agenda.',409);
 let metadata=appointment.import_metadata||{};if(typeof metadata==='string')metadata=JSON.parse(metadata);
 const stored=metadata.booking?.profile,actual=metadata.booking?.phases;
 const phases=actual?.length?actual:[{start_at:start.toISOString(),end_at:end.toISOString(),installation_id:appointment.instalacion_id,doctor_ids:appointment.doctor_id?[Number(appointment.doctor_id)]:[]}];
 if(phases.length!==expected.phases.length||expected.version>=2&&!stored)D.fail('appointment_profile_mismatch','La reserva no conserva todos los pasos y recursos necesarios. Replanifícala antes de vincularla.',409);
 if(Number(phases[0]?.installation_id)!==Number(appointment.instalacion_id)||Number(phases[0]?.doctor_ids?.[0])!==Number(appointment.doctor_id))D.fail('appointment_profile_mismatch','La reserva original no coincide con el profesional o gabinete de la cita. Revísala desde agenda.',409);
 let elapsed=0;for(let i=0;i<expected.phases.length;i++){
  const required=expected.phases[i],phase=phases[i],offset=expected.version===4?required.start_offset_minutes:elapsed;
  if(+new Date(phase.start_at)!==+start+offset*60000||!B.phaseFitsClassification(required,phase,{profileVersion:expected.version,appointmentStart:start,sourceProfessionals:stored?.phases?.[i]?.professionals}))D.fail('appointment_profile_mismatch','El profesional, gabinete o los pasos reservados no coinciden con el plan. Revisa su replanificación.',409);
  elapsed+=required.duration_minutes;
 }
 return stored?normalizeBookingProfile(stored):normalizeBookingProfile({version:1,phases:[{key:'appointment',label:'Reserva existente',duration_minutes:duration,installation_ids:[Number(appointment.instalacion_id)],professionals:{mode:'any',ids:[Number(appointment.doctor_id)],preferred_id:Number(appointment.doctor_id)}}]});
}
function combineProfile(acts,{doctorIds,installationIds}){
 const definitions=acts.map(act=>{
  let raw=act.catalog_snapshot?.clinical_config;if(typeof raw==='string')raw=JSON.parse(raw);
  const selection=act.duration_selection||(raw?.booking_profile?.phases?.length===1&&raw.booking_profile.phases[0].duration_minutes==null?{duration_minutes:act.duration_minutes}:undefined);
  const profile=(raw?.booking_profile?require('../lib/booking-profile-duration').resolveBookingProfileDuration(raw.booking_profile,{durationSelection:selection}).profile:null)||normalizeBookingProfile({version:1,phases:[{key:'appointment',label:act.title,duration_minutes:act.duration_minutes,installation_ids:installationIds,professionals:{mode:'any',ids:act.professional_id?[act.professional_id]:doctorIds}}]});
  if(bookingProfileDurationMinutes(profile)!==act.duration_minutes)D.fail('profile_duration_changed','La duración del acto debe coincidir con sus pasos de agenda. Revisa el perfil del tratamiento.',409);
  if(act.professional_id&&profile.phases.some(p=>!p.professionals.ids.includes(act.professional_id)))D.fail('professional_profile_mismatch','El profesional elegido no está habilitado en los pasos del tratamiento.',409);
  return{act,profile};
 });
 const version=Math.max(...definitions.map(d=>d.profile.version));let offset=0;
 const phases=definitions.flatMap(({act,profile})=>{
  let sequential=offset;
  const result=profile.phases.map(phase=>{const result={...phase,key:`a_${act.id.slice(0,8)}_${phase.key.slice(0,32)}`,label:phase.label||act.title,
   ...(act.professional_id&&phase.professionals.mode==='any'?{professionals:{mode:'any',ids:[act.professional_id],preferred_id:act.professional_id}}:{}),
   ...(version===4?{start_offset_minutes:offset+(profile.version===4?phase.start_offset_minutes:sequential-offset)}:{})};sequential+=phase.duration_minutes;return result;});
  offset+=bookingProfileDurationMinutes(profile);return result;
 });
 return normalizeBookingProfile({version,phases});
}
function createDentalPlanBookingService({db,core,now=()=>new Date(),availability=A,writer=B,capabilities=bookingCapabilities}={}){
 async function context(row,state,payload,transaction=null){
  const selected=selectedActs(state,payload),clinic=await db.Clinica.findByPk(row.clinic_id,{transaction});
  const [doctors,rooms]=await Promise.all([db.DoctorClinica.findAll({where:{clinica_id:row.clinic_id,activo:true,recibe_citas:true},transaction}),db.Instalacion.findAll({where:{clinica_id:row.clinic_id,activo:true},transaction})]);
  for(const act of selected.acts)if(act.treatment_id){const treatment=await loadScopedTreatment({db,treatmentId:act.treatment_id,clinic,transaction});let config=treatment.clinical_config;if(typeof config==='string')config=JSON.parse(config);if(!treatment.activo||['draft','obsolete'].includes(config?.catalog_status))D.fail('treatment_not_bookable','Selecciona un tratamiento vigente del catálogo.',409);}
  const profile=combineProfile(selected.acts,{doctorIds:doctors.map(d=>Number(d.doctor_id)),installationIds:rooms.map(r=>Number(r.id))});assertOperationalBookingProfile(profile,{capabilities:capabilities()});
  return{...selected,clinic,profile,timeZone:resolveClinicTimezone(clinic)};
 }
 async function availabilityFor(options){
  const caps=await core.authorize(options,'logistics_manage');const row=await core.scopedPlan(options);core.compare(row,options.payload);const state=await core.reservationReadState(row),p=options.payload;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(p.from_date||'')||!Number.isInteger(p.days??7)||(p.days??7)<1||(p.days??7)>14)D.fail('search_invalid','Indica una fecha y un intervalo de hasta 14 días.');
  const plan=await context(row,state,p),tools=await core.readTools(row);Dep.assertToolsReady(tools,plan.session.id,plan.acts.map(a=>a.id),state.protocol_requirements);
  const start=resolveLocalInstant(p.from_date,'00:00:00',plan.timeZone),end=resolveLocalInstant(addDays(p.from_date,p.days??7),'00:00:00',plan.timeZone);
  const calendar=await availability.loadBookingContext({db,clinic:plan.clinic,profile:plan.profile,start,end,patientId:row.patient_id,occupancyEnabled:true,includeDiagnosticLabels:true,...(plan.moving?{ignoreAppointmentId:plan.moving.appointment_id}:{})});
  const selections=Preferences.selections(state.preferences,plan.profile,state);
  const solutions=availability.solutionsForCalendar({profile:plan.profile,context:calendar,date:p.from_date,days:p.days??7,limit:300,now:now(),selections});
  const actIds=plan.acts.map(a=>a.id),issues=[];
  const proposals=solutions.filter(s=>{if(!P.allowedInterval(state.preferences,s.start_at,s.end_at,plan.timeZone))return false;const deps=Dep.dependencyIssues(state,{actIds,startAt:s.start_at,timeZone:plan.timeZone,selectedTogether:actIds});if(allowedIssues(deps,plan.session,p.reason,caps.clinical_manage).length!==deps.length){issues.push(...deps);return false;}return true;}).map(solution=>({...solution,act_ids:actIds,selections:Object.fromEntries(solution.phases.map(p=>[p.key,{installation_id:p.installation_id,...(p.doctor_ids.length===1?{doctor_id:p.doctor_ids[0]}:{})}])),warnings:[...(solution.warnings||[]),...P.timeWarning(state.preferences,solution,plan.timeZone)]}));
  proposals.sort((a,b)=>Number(P.preferredStart(state.preferences,b.start_at,plan.timeZone))-Number(P.preferredStart(state.preferences,a.start_at,plan.timeZone))||new Date(a.start_at)-new Date(b.start_at));
  return{plan_id:row.public_id,version:Number(row.version_number),session_id:plan.session.id,timezone:plan.timeZone,proposals:proposals.slice(0,30),issues:[...new Map(issues.map(i=>[i.id+':'+i.reason,i])).values()]};
 }
 async function book(options){return core.mutation(options,'book',async({row,state,transaction,caps})=>{
  const p=options.payload,plan=await context(row,state,p,transaction),actIds=plan.acts.map(a=>a.id),tools=await core.readTools(row,transaction);Dep.assertToolsReady(tools,plan.session.id,actIds,state.protocol_requirements);
  await require('./dentalProtocolEvidence.service').assertProtocolConsents({db,row,state,actIds,transaction,appointmentId:p.appointment_id||null,startAt:p.start_at,now:now()});
  let appointment;
  if(p.appointment_id&&p.mode!=='reschedule'){
   appointment=await db.CitaPaciente.findOne({where:{id_cita:C.integer(p.appointment_id),clinica_id:row.clinic_id,paciente_id:row.patient_id},transaction,lock:transaction.LOCK.UPDATE});
   if(!appointment||['cancelada','no_asistio'].includes(appointment.estado))D.fail('appointment_not_found','Selecciona una cita vigente de este paciente y clínica.',404);
   if(actIds.length!==1||Number(appointment.tratamiento_id||0)!==Number(plan.acts[0].treatment_id||0))D.fail('appointment_scope_mismatch','Vincula el tratamiento exacto reservado en esta cita.',409);
   plan.profile=assertExistingItinerary(appointment,plan.profile);
   const expected=require('../lib/appointment-import-review').importReviewVersion(appointment.toJSON?appointment.toJSON():appointment);if(p.expected_appointment_revision!==expected)D.fail('appointment_changed','La cita ha cambiado. Revísala antes de vincularla.',409);
   const claims=await db.DentalPlan.findAll({where:{clinic_id:row.clinic_id,patient_id:row.patient_id},transaction});if(claims.some(r=>r.state.reservations.some(a=>Number(a.appointment_id)===Number(appointment.id_cita))))D.fail('appointment_already_linked','La cita ya forma parte de un plan dental.',409);
   let metadata=appointment.import_metadata||{};if(typeof metadata==='string')metadata=JSON.parse(metadata);if(metadata.program_session||appointment.voucher_id)D.fail('appointment_scope_mismatch','Esta reserva pertenece a un programa o bono. Conserva su circuito de agenda.',409);
   const issues=Dep.dependencyIssues(state,{actIds,startAt:appointment.inicio,timeZone:plan.timeZone,selectedTogether:actIds});if(allowedIssues(issues,plan.session,p.reason,caps.clinical_manage).length!==issues.length)Dep.assertDependencies(issues,caps.clinical_manage?p.reason:null);
   recordOverrides(state,issues,plan.session,p,caps,options.actorId,now().toISOString(),Number(appointment.id_cita));
   await appointment.update({import_metadata:{...metadata,dental_plan:{id:row.public_id,session_id:plan.session.id,act_ids:actIds}},updated_by:options.actorId},{transaction});
  }else{
   const start=new Date(p.start_at);if(!Number.isFinite(+start)||start<=now()||start-now()>366*86400000)D.fail('booking_date_invalid','Elige una hora futura dentro del próximo año.');
   const end=new Date(+start+bookingProfileDurationMinutes(plan.profile)*60000);P.assertAllowed(state.preferences,[{start_at:start,end_at:end}],plan.timeZone);
   const issues=Dep.dependencyIssues(state,{actIds,startAt:start,timeZone:plan.timeZone,selectedTogether:actIds});if(allowedIssues(issues,plan.session,p.reason,caps.clinical_manage).length!==issues.length)Dep.assertDependencies(issues.filter(i=>!allowedIssues(issues,plan.session,p.reason,caps.clinical_manage).includes(i)),null);
   recordOverrides(state,issues,plan.session,p,caps,options.actorId,now().toISOString(),plan.moving?.appointment_id||null);
   if(plan.moving){
    if(!D.text(p.reason)||state.execution.some(e=>e.appointment_id===plan.moving.appointment_id))D.fail('reschedule_reason_required','Explica el cambio de una reserva sin trabajo ya registrado.',409);
    const old=await db.CitaPaciente.findByPk(plan.moving.appointment_id,{transaction,lock:transaction.LOCK.UPDATE});if(!old||old.care_started_at||['cancelada','completada','no_asistio'].includes(old.estado))D.fail('reservation_not_movable','La atención o el estado de esta reserva no permiten moverla.',409);
    if(require('../lib/appointment-import-review').importReviewVersion(old.toJSON?old.toJSON():old)!==p.expected_appointment_revision)D.fail('appointment_changed','La cita ha cambiado. Actualízala antes de replanificar.',409);
    const downstream=state.dependencies.filter(d=>actIds.includes(d.from_act_id));for(const reservation of state.reservations.filter(r=>r.active!==false&&r!==plan.moving&&downstream.some(d=>r.act_ids.includes(d.to_act_id)))){const projected=D.clone(state);projected.reservations.find(r=>r.appointment_id===plan.moving.appointment_id).end_at=end.toISOString();const dependentIssues=Dep.dependencyIssues(projected,{actIds:reservation.act_ids,startAt:reservation.start_at,timeZone:plan.timeZone});Dep.assertDependencies(dependentIssues,caps.clinical_manage?p.reason:null);recordOverrides(state,dependentIssues,{},p,caps,options.actorId,now().toISOString(),reservation.appointment_id);}
   }
   const capability=require('../lib/dental-booking-context').createDentalBookingContext({transaction,clinicId:Number(row.clinic_id),patientId:Number(row.patient_id),planId:row.public_id,sessionId:plan.session.id,actIds,profile:plan.profile,existingAppointmentId:plan.moving?.appointment_id||null});
   appointment=await writer.mutateAppointmentBooking({db,transaction,trustedDentalReservation:capability,capabilities:capabilities(),selections:bookingSelections(plan.profile,p.selection||p.selections||{},Preferences.selections(state.preferences,plan.profile,state)),priorityAcknowledged:p.priority_acknowledged===true,...(plan.moving?{existingAppointmentId:plan.moving.appointment_id}:{}),
    appointmentValues:plan.moving?{inicio:start,fin:end,estado:'reprogramada',reschedule_reason:'clinic_schedule',updated_by:options.actorId}:{clinica_id:row.clinic_id,paciente_id:row.patient_id,tratamiento_id:plan.acts.find(a=>a.treatment_id)?.treatment_id||null,inicio:start,fin:end,estado:'pendiente',tipo_cita:'continuacion',titulo:`${state.title} · ${plan.session.title}`.slice(0,255),created_by:options.actorId,updated_by:options.actorId,source_system:'dental_plan',source_reference:`dental:${row.public_id}:${plan.session.id}`.slice(0,120),import_metadata:{automation_policy:'hold',notification_suppression:{appointment_details:true,day_before:true,same_day:true}}},
    persist:({values,existing})=>existing?existing.update(values,{transaction}):db.CitaPaciente.create(values,{transaction})});
  }
  let metadata=appointment.import_metadata;if(typeof metadata==='string')metadata=JSON.parse(metadata);
  const result={appointment_id:Number(appointment.id_cita),session_id:plan.session.id,act_ids:actIds,start_at:new Date(appointment.inicio).toISOString(),end_at:new Date(appointment.fin).toISOString(),profile_snapshot:plan.profile,phases:metadata?.booking?.phases||[],appointment_status:appointment.estado,active:true,appointment_revision:require('../lib/appointment-import-review').importReviewVersion(appointment.toJSON?appointment.toJSON():appointment)};
  if(plan.moving){state.changes.push({id:D.uuid(),type:'rescheduled',before:D.clone(plan.moving),after:result,reason:D.text(p.reason),actor_id:options.actorId,created_at:now().toISOString()});Object.assign(plan.moving,result);}else{state.reservations.push(result);plan.session.appointment_ids.push(result.appointment_id);}plan.session.status='booked';state.phase='execution';
  return{appointment:{id:result.appointment_id,...result}};
 },'logistics_manage');}
 return{availability:availabilityFor,book};
}
module.exports={createDentalPlanBookingService,combineProfile,selectedActs,assertExistingItinerary,bookingSelections,allowedIssues,recordOverrides};
