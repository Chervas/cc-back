'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),D=require('../../lib/dental-plan-contract'),Dep=require('../../lib/dental-dependencies');
const {combineProfile,selectedActs}=require('../../services/dentalPlanBooking.service');
const {createDentalPlanService}=require('../../services/dentalPlans.service');
const base=()=>{const state=D.initialState('Consulta dental');state.acts=[D.act({title:'Corona',duration_minutes:30,targets:[{kind:'tooth',fdi:16,surfaces:['O','M']},{kind:'tooth',fdi:17}]}),D.act({title:'Revisión',duration_minutes:20,targets:[{kind:'general'}]})];return state;};
const change=(s,p)=>D.changeState(s,p,{actorId:7,now:'2030-01-01T10:00:00Z'});
test('Dental stable identities validate FDI permanent/deciduous, independent surfaces and typed scope',()=>{
 const a=base().acts[0],updated=D.act({...a,title:'Etiqueta nueva'},{previous:a});assert.equal(updated.id,a.id);assert.deepEqual(updated.targets.map(t=>t.id),a.targets.map(t=>t.id));
 for(const fdi of [11,18,28,48,51,55,85])assert.equal(D.target({kind:'tooth',fdi}).fdi,fdi);
 for(const fdi of [0,19,49,56,86,99,'not-a-number'])assert.throws(()=>D.target({kind:'tooth',fdi}),{code:'dental_target_invalid'});
 assert.throws(()=>D.target({kind:'tooth',fdi:16,surfaces:['O','I']}),{code:'dental_surface_invalid'});
 assert.throws(()=>D.target({kind:'tooth',fdi:16,surfaces:['M','M']}),{code:'dental_surface_invalid'});
 assert.throws(()=>D.target({kind:'arch',arch:'unrecognized'}),{code:'dental_target_invalid'});
 assert.equal(D.act({title:'Duración pendiente'}).duration_minutes,null);
});
test('provisional generation orders pinned dependencies without appointments and retains merge/split lineage',()=>{
 let s=base();s.dependencies=D.dependencies([{from_act_id:s.acts[1].id,to_act_id:s.acts[0].id,min_wait_days:7}],s.acts);
 s=change(s,{command:'generate'});assert.equal(s.sessions[0].act_ids[0],s.acts[1].id);assert.equal(s.reservations.length,0);
 const parents=s.sessions.map(s=>s.id);s=change(s,{command:'merge_sessions',session_ids:parents});const merged=s.sessions.at(-1);assert.deepEqual(merged.parent_ids,parents);assert(s.sessions.slice(0,2).every(s=>s.status==='absorbed'));
 s=change(s,{command:'split_session',session_id:merged.id,act_ids:[merged.act_ids[0]]});assert.deepEqual(s.sessions.at(-1).parent_ids,[merged.id]);assert.equal(s.sessions.at(-1).status,'pending');
 assert.throws(()=>D.dependencies([{from_act_id:s.acts[0].id,to_act_id:s.acts[1].id},{from_act_id:s.acts[1].id,to_act_id:s.acts[0].id}],s.acts),{code:'dental_dependency_cycle'});
});
test('booked or executed composition cannot be moved, relabeled or removed silently',()=>{
 let s=change(base(),{command:'generate'}),session=s.sessions[0];session.appointment_ids=[10];session.status='booked';
 assert.throws(()=>change(s,{command:'move_act',session_id:session.id,target_session_id:s.sessions[1].id,act_id:session.act_ids[0]}),{code:'dental_session_locked'});
 s.reservations.push({appointment_id:10,act_ids:session.act_ids});assert.throws(()=>change(s,{command:'remove_act',act_id:session.act_ids[0],reason:'Cambio'}),{code:'dental_act_started'});
 assert.throws(()=>change(s,{command:'generate'}),{code:'dental_plan_started'});
});
test('selected reservation acts are explicit, scoped and cannot claim a sibling reservation',()=>{
 let s=change(base(),{command:'generate'});s=change(s,{command:'merge_sessions',session_ids:s.sessions.map(s=>s.id)});const session=s.sessions.at(-1);session.status='reviewed';
 assert.equal(selectedActs(s,{session_id:session.id,act_ids:[s.acts[0].id]}).acts.length,1);
 s.reservations.push({appointment_id:10,act_ids:[s.acts[0].id],session_id:session.id});assert.throws(()=>selectedActs(s,{session_id:session.id,act_ids:[s.acts[0].id]}),{code:'dental_reservation_scope_invalid'});
 assert.deepEqual(selectedActs(s,{session_id:session.id}).acts.map(a=>a.id),[s.acts[1].id]);
 s.reservations[0].active=false;assert.equal(selectedActs(s,{session_id:session.id}).acts.length,2);
});
test('clinical waits use clinic civil dates across DST, not UTC milliseconds; only reasoned configured overrides qualify',()=>{
 const s=base(),[from,to]=s.acts;s.dependencies=D.dependencies([{from_act_id:from.id,to_act_id:to.id,min_wait_days:1,action:'override'}],s.acts);
 s.reservations=[{act_ids:[from.id],end_at:'2026-10-24T22:30:00Z'}];
 let issues=Dep.dependencyIssues(s,{actIds:[to.id],startAt:'2026-10-25T22:00:00Z',timeZone:'Europe/Madrid'});assert.equal(issues.length,1);assert.equal(issues[0].not_before,'2026-10-26');
 assert.throws(()=>Dep.assertDependencies(issues),{code:'dental_dependencies_pending'});assert.doesNotThrow(()=>Dep.assertDependencies(issues,'Espera revisada por el profesional'));
 issues[0].action='block';assert.throws(()=>Dep.assertDependencies(issues,'No puede eludir bloqueo de sistema'),{code:'dental_dependencies_pending'});
 assert.equal(Dep.dependencyIssues(s,{actIds:[to.id],startAt:'2026-10-25T23:00:00Z',timeZone:'Europe/Madrid'}).length,0);
 assert.equal(Dep.dependencyIssues(s,{actIds:[to.id],startAt:'2026-10-26T10:00:00Z',timeZone:'Europe/Madrid',execution:true})[0].reason,'source_not_performed');
});
test('received laboratory is distinct from approved work; archived or unapproved required evidence does not clear readiness',()=>{
 const tools={lab_orders:[{id:'lab',needed_session_id:'session',status:'received'}],evidences:[{id:'rx',required:true,act_ids:['act'],clinical_status:'pending'}]};
 assert.throws(()=>Dep.assertToolsReady(tools,'session',['act']),{code:'dental_materials_pending'});tools.lab_orders[0].status='approved';assert.throws(()=>Dep.assertToolsReady(tools,'session',['act']),{code:'dental_materials_pending'});tools.evidences[0].clinical_status='approved';assert.doesNotThrow(()=>Dep.assertToolsReady(tools,'session',['act']));tools.evidences[0].status='archived';assert.throws(()=>Dep.assertToolsReady(tools,'session',['act']),{code:'dental_materials_pending'});
});
test('execution selects individual target identities, preserves unknown scope and rejects duplicate target claims',()=>{
 const s=base(),a=s.acts[0],r={act_id:a.id,target_id:a.targets[0].id,status:'partial'};assert.deepEqual(D.executionResults(s,{results:[r]})[0],{...r,notes:null});
 assert.throws(()=>D.executionResults(s,{results:[{...r,target_id:'foreign-target'}]}),{code:'dental_execution_invalid'});assert.throws(()=>D.executionResults(s,{results:[r,r]}),{code:'dental_execution_invalid'});
});
test('booking uses pinned itinerary phases and resources without manufacturing program/voucher identity',()=>{
 const s=base(),profile=combineProfile(s.acts,{doctorIds:[7],installationIds:[12]});assert.equal(profile.phases.length,2);assert.deepEqual(profile.phases.map(p=>p.duration_minutes),[30,20]);assert(profile.phases.every(p=>p.professionals.ids[0]===7&&p.installation_ids[0]===12));
 const tx={},values={clinica_id:72,paciente_id:1,estado:'pendiente'},ctx={transaction:tx,clinicId:72,patientId:1,profile};const K=require('../../lib/dental-booking-context'),token=K.createDentalBookingContext(ctx);
 assert.equal(K.requireDentalBookingContext(token,{transaction:tx,values}).profile,profile);assert.throws(()=>K.requireDentalBookingContext(JSON.parse(JSON.stringify(token)),{transaction:tx,values}),/context_invalid/);assert.throws(()=>K.requireDentalBookingContext(token,{transaction:tx,values:{...values,voucher_id:1}}),/context_invalid/);
});
test('clinical validation stays doctor-owned while authorised auxiliary staff can plan logistics',async()=>{
 const db={Clinica:{findByPk:async()=>({configuracion:{disciplinas:['dental']}})},UsuarioClinica:{findOne:async()=>({rol_clinica:'personaldeclinica',subrol_clinica:'Auxiliares y enfermeros'})}},service=createDentalPlanService({db,canAccess:async()=>true});
 const caps=await service.capabilities({clinicId:72,actorId:7});assert.equal(caps.clinical_manage,false);assert.equal(caps.logistics_manage,true);await assert.rejects(service.authorize({clinicId:72,actorId:7},'clinical_manage'),{code:'dental_forbidden'});
 const denied=createDentalPlanService({db,canAccess:async({featureKey})=>featureKey!=='patients.sensitive.view'});assert.equal((await denied.capabilities({clinicId:72,actorId:7})).view,false);
 db.UsuarioClinica.findOne=async()=>({rol_clinica:'agencia',subrol_clinica:null});assert.equal((await service.capabilities({clinicId:72,actorId:7})).view,false);
});
test('canonical consent lookup resolves every claimed act and rejects forged Dental provenance',async()=>{
 const {dentalAppointmentContext}=require('../../lib/dental-appointment-context'),appointment={id_cita:10,clinica_id:72,paciente_id:1,import_metadata:{dental_plan:{id:'owned',session_id:'session',act_ids:['a','b']}}};
 const db={DentalPlan:{findOne:async({where})=>{assert.deepEqual(where,{public_id:'owned',clinic_id:72,patient_id:1});return{public_id:'owned',state:{acts:[{id:'a',treatment_id:20},{id:'b',treatment_id:21}],reservations:[{appointment_id:10,session_id:'session',act_ids:['a','b']}]}};}}};
 assert.deepEqual((await dentalAppointmentContext(db,appointment,{})).treatment_ids,[20,21]);appointment.import_metadata.dental_plan.act_ids=['a'];await assert.rejects(dentalAppointmentContext(db,appointment,{}),{code:'dental_appointment_scope_changed'});
});
test('normal appointment edits cannot silently replan Dental while cancellation and independent notes preserve it',()=>{
 const {assertCoordinatedDentalScheduleChange:f}=require('../../lib/dental-appointment-context'),old={inicio:'2030-01-01T10:00:00Z',fin:'2030-01-01T10:30:00Z',paciente_id:1,clinica_id:72,tratamiento_id:20,import_metadata:{dental_plan:{id:'plan'}}};
 assert.doesNotThrow(()=>f(old,{...old,estado:'cancelada'},false));assert.throws(()=>f(old,{...old,inicio:'2030-01-01T11:00:00Z'},false),{code:'dental_coordinated_schedule_required'});assert.doesNotThrow(()=>f(old,{...old,inicio:'2030-01-01T11:00:00Z'},true));
});
test('four calendar months and month-end waits remain clinical waits across DST and provisional grouping',()=>{
 const {advanceCivil}=require('../../lib/dental-civil-wait');assert.equal(advanceCivil('2026-01-31',1,'months'),'2026-02-28');assert.equal(advanceCivil('2028-01-31',1,'months'),'2028-02-29');assert.equal(advanceCivil('2026-10-31',4,'months'),'2027-02-28');
 const s=base(),[from,to]=s.acts;s.dependencies=D.dependencies([{from_act_id:from.id,to_act_id:to.id,min_wait_days:0,wait_min_value:4,wait_min_unit:'months'}],s.acts);
 s.reservations=[{act_ids:[from.id],end_at:'2026-01-31T10:00:00Z'}];
 const issues=Dep.dependencyIssues(s,{actIds:[to.id],startAt:'2026-05-30T22:00:00Z',timeZone:'Europe/Madrid'});assert.equal(issues.length,0);
 assert.equal(Dep.dependencyIssues(s,{actIds:[to.id],startAt:'2026-05-30T10:00:00Z',timeZone:'Europe/Madrid'})[0].not_before,'2026-05-31');
 assert.equal(Dep.dependencyIssues({...s,reservations:[]},{actIds:[from.id,to.id],selectedTogether:[from.id,to.id],startAt:'2026-01-31T10:00:00Z',timeZone:'Europe/Madrid'}).length,1);
 const provisional=D.changeState(s,{command:'generate'},{actorId:7,now:'2026-01-31T10:00:00Z',localDate:'2026-01-31'});assert.equal(provisional.sessions[1].earliest_date,'2026-05-31');
});
test('published structured protocols resolve exact catalogue references and targets, unknown conditions require review',()=>{
 const s=base(),[a,b]=s.acts;a.treatment_id=20;a.catalog_snapshot={code:'seno',clinical_config:{protocol_tags:['sinus_augmentation']}};b.treatment_id=21;b.catalog_snapshot={code:'implant',clinical_config:{protocol_tags:['implant_placement']}};
 s.protocol_snapshot={protocol_rules:[{code:'sinus-wait',enabled:true,source_type:'treatment',source_ref:'sinus_augmentation',target_type:'treatment',target_ref:'implant_placement',wait_min_value:4,wait_min_unit:'months',action:'system_block'},{code:'ambiguous-condition',enabled:true,source_type:'clinical_condition',source_ref:'unmapped-condition',target_ref:'implant_placement',condition:'Revisión profesional necesaria',action:'block'}]};
 const P=require('../../lib/dental-protocol'),r=P.deriveProtocol(s);assert.equal(r.dependencies[0].wait_min_unit,'months');assert.equal(r.dependencies[0].wait_min_value,4);assert.equal(r.dependencies[0].action,'block');assert.equal(r.protocol_warnings.length,1);Object.assign(s,r);
 assert.throws(()=>P.validateReview(s,{}),{code:'dental_protocol_review_required'});assert.doesNotThrow(()=>P.validateReview(s,{protocol_acknowledgements:['ambiguous-condition']}));
 assert.equal(P.matches({...b,title:'sinus_augmentation'},'sinus_augmentation'),false,'Display names never establish protocol applicability');
});
test('clinical DTO uses allowlists recursively and hides imported price review even in historical change snapshots',()=>{
 const service=createDentalPlanService({db:{}}),state=base(),raw={id:20,title:'Tratamiento',code:'DENT',clinical_config:{imported_price_review:{gross_amount:456.78},cost:456.78,booking_profile:null,protocol_tags:['dental_surgery']}};
 state.acts[0].catalog_snapshot=raw;state.changes=[{before:{catalog_snapshot:raw},after:{catalog_snapshot:raw}}];state.source_budget={snapshot:{lines:[{key:'a',name:'Acto',quantity:1,total:456.78,imported_price_review:{gross_amount:456.78}}],totals:{total:456.78},payment_proposal:{amount:456.78},acceptance:{event_id:1,accepted_at:'2030-01-01',selected_payment_mode:'by_work'}}};
 const dto=service.serialize({public_id:'plan',clinic_id:72,patient_id:1,version_number:1,status:'accepted',state});assert(!JSON.stringify(dto).includes('456.78'));assert.equal(dto.source_budget.snapshot.acceptance.selected_payment_mode,undefined);assert.equal(dto.source_budget.snapshot.acceptance.event_id,1);assert.deepEqual(dto.acts[0].catalog_snapshot.clinical_config,{protocol_tags:['dental_surgery']});
 const billing=service.serialize({public_id:'plan',clinic_id:72,patient_id:1,version_number:1,status:'accepted',state},{billing_view:true});assert.equal(billing.source_budget.snapshot.lines[0].total,456.78);assert.equal(billing.acts[0].catalog_snapshot.clinical_config.imported_price_review,undefined);
});
test('explicit visuals, bridge role, indications and professional unassignment survive an act edit',()=>{
 const a=D.act({title:'Puente',duration_minutes:60,professional_id:7,notes:'Indicaciones exactas',visual_type:'puente',targets:[{kind:'tooth',fdi:16,role:'abutment'},{kind:'tooth',fdi:17,role:'pontic'}]});
 const b=D.act({...a,professional_id:null,title:'Puente revisado'},{previous:a});assert.equal(b.professional_id,null);assert.equal(b.notes,a.notes);assert.equal(b.targets[1].role,'pontic');assert.equal(b.visual_type,'puente');assert.throws(()=>D.act({...a,visual_type:'invented-icon'}),{code:'dental_visual_type_invalid'});
});
test('linking an existing reservation checks its actual time/resources, not a proposed replacement profile',()=>{
 const {assertExistingItinerary}=require('../../services/dentalPlanBooking.service'),expected=combineProfile([base().acts[0]],{doctorIds:[7],installationIds:[12]});
 const appointment={inicio:'2030-01-01T10:00:00Z',fin:'2030-01-01T10:30:00Z',doctor_id:7,instalacion_id:12};assert.equal(assertExistingItinerary(appointment,expected).phases[0].key,'appointment');
 assert.throws(()=>assertExistingItinerary({...appointment,fin:'2030-01-01T10:15:00Z'},expected),{code:'dental_appointment_profile_mismatch'});assert.throws(()=>assertExistingItinerary({...appointment,doctor_id:8},expected),{code:'dental_appointment_profile_mismatch'});
});
test('preferences bind clinic-profile resources and duration without dropping canonical phases',()=>{
 const P=require('../../lib/dental-preferences'),s=base(),profile=combineProfile(s.acts,{doctorIds:[7],installationIds:[12]});const preferences=P.normalize({doctor_id:7,installation_id:12,max_duration_minutes:60,exclude_weekdays:[5],prefer_after_minutes:600,notes:'Planificación'});
 assert.equal(P.selections(preferences,profile,s)[profile.phases[0].key].doctor_id,7);assert.equal(profile.phases.length,2);assert.throws(()=>P.selections({...preferences,max_duration_minutes:40},profile,s),{code:'dental_preference_duration_exceeded'});assert.throws(()=>P.selections({...preferences,doctor_id:99},profile,s),{code:'dental_preference_profile_mismatch'});
});
test('the canonical care consent assessment checks the second Dental act and cannot clear it with the first signature',async()=>{
 const S=require('sequelize'),appointment={id_cita:10,clinica_id:72,paciente_id:1,tratamiento_id:20,import_metadata:{dental_plan:{id:'owned',session_id:'session',act_ids:['a','b']}}},transaction={LOCK:{SHARE:'SHARE'}};
 let documents=[];const db={Sequelize:S,ClinicConsentTemplate:{},ConsentTemplateCatalog:{},DentalPlan:{findOne:async()=>({public_id:'owned',state:{acts:[{id:'a',treatment_id:20},{id:'b',treatment_id:21}],reservations:[{appointment_id:10,session_id:'session',act_ids:['a','b']}]}})},Tratamiento:{findAll:async()=>[]},
  TreatmentConsentRequirement:{findAll:async({where})=>{assert.deepEqual(where.tratamiento_id[S.Op.in],[20,21]);return[{id:1,tratamiento_id:21,clinic_template_id:50,required:true,blocking_policy:'hard',clinicTemplate:{id:50,purpose:'clinical',status:'active',validity_mode:'per_treatment',requires_professional_signature:false}}];}},PatientConsentDocument:{findAll:async()=>documents}};
 const assess=require('../../services/appointmentConsentEligibility.service').assessAppointmentClinicalConsent,options={db,appointment,transaction,now:new Date('2030-01-01T10:00:00Z')};
 assert.equal((await assess(options)).allowed,false);documents=[{id:1,paciente_id:1,clinica_id:72,tratamiento_id:20,cita_id:10,clinic_template_id:50,purpose:'clinical',status:'signed',signed_at:'2030-01-01T09:00:00Z'}];assert.equal((await assess(options)).allowed,false);documents[0].tratamiento_id=21;assert.equal((await assess(options)).allowed,true);
});
test('configured Dental discipline gates writing, while historical reading ignores unpublished workspace flags',async()=>{
 const A=require('../../lib/dental-area-scope');
 for(const config of [{disciplinas:['dental']},{disciplinas:[{codigo:'Odontología'}]},{disciplinas:['odontologia_general']},{disciplinas:[{code:'dental_clinica'}]}])assert(A.configuredDentalArea({configuracion:JSON.stringify(config)}));
 assert.equal(A.configuredDentalArea({configuracion:{disciplinas:['estetica'],patient_workspace:{enabled:true}}}),false);
 assert.throws(()=>A.assertDentalAreaConfigured({configuracion:{disciplinas:['estetica']}}),{code:'dental_area_not_configured'});
 let areas=['estetica'];const db={Clinica:{findByPk:async()=>({configuracion:{disciplinas:areas,patient_workspace:{enabled:false}}})},UsuarioClinica:{findOne:async()=>({rol_clinica:'personaldeclinica',subrol_clinica:'Doctores'})}};
 const service=createDentalPlanService({db,canAccess:async()=>true}),options={clinicId:72,actorId:7};let caps=await service.capabilities(options);assert(caps.view);assert.equal(caps.prepare_plan,false);assert.equal(caps.write_block_reason,'dental_area_not_configured');await assert.rejects(service.authorize(options,'clinical_manage'),{code:'dental_area_not_configured'});
 areas=['dental'];caps=await service.capabilities(options);assert(caps.clinical_manage);assert.equal(caps.write_block_reason,null);
 const noClinicalView=createDentalPlanService({db,canAccess:async({featureKey})=>featureKey!=='clinical.reports.view'});caps=await noClinicalView.capabilities(options);assert(caps.logistics_manage);assert.equal(caps.clinical_view,false);assert.equal(caps.clinical_manage,false);
});
test('every protocol-required act needs its own reviewed RX and laboratory coverage, or explicit whole-session scope',()=>{
 const requirements=[{code:'rx',source_type:'test',source_ref:'rx',action:'block',act_ids:['a','b']},{code:'lab',source_type:'laboratory',action:'block',act_ids:['a','b']}];
 const tools={evidences:[{id:'rx-a',kind:'rx',act_ids:['a'],clinical_status:'approved',status:'active'}],lab_orders:[{id:'lab-a',act_ids:['a'],status:'approved'}]};
 assert.throws(()=>Dep.assertToolsReady(tools,'session',['a','b'],requirements),error=>error.code==='dental_evidence_required'&&error.details.act_id==='b');
 tools.evidences[0].session_ids=['session'];assert.throws(()=>Dep.assertToolsReady(tools,'session',['a','b'],requirements),error=>error.code==='dental_laboratory_required'&&error.details.act_id==='b');
 tools.lab_orders[0].needed_session_id='session';assert.doesNotThrow(()=>Dep.assertToolsReady(tools,'session',['a','b'],requirements));
 tools.evidences[0].session_ids=[];tools.evidences.push({id:'rx-b',kind:'rx',act_ids:['b'],clinical_status:'approved'});tools.lab_orders[0].needed_session_id=null;tools.lab_orders.push({id:'lab-b',act_ids:['b'],status:'approved'});assert.doesNotThrow(()=>Dep.assertToolsReady(tools,'session',['a','b'],requirements));
 tools.lab_orders[1].status='received';assert.throws(()=>Dep.assertToolsReady(tools,'session',['a','b'],requirements),{code:'dental_materials_pending'});
});
test('auxiliary reasons cannot approve clinical dependency overrides, while reviewed exceptions stay usable',()=>{
 const {allowedIssues}=require('../../services/dentalPlanBooking.service'),issues=[{id:'wait',action:'override'},{id:'block',action:'block'},{id:'notice',action:'warn'}],session={};
 assert.deepEqual(allowedIssues(issues,session,'A logistics note',false),[issues[2]]);assert.deepEqual(allowedIssues(issues,session,'Professional exception',true),[issues[0],issues[2]]);
 assert.deepEqual(allowedIssues(issues,{dependency_overrides:['wait'],dependency_override_reason:'Reviewed',reviewed_by:7},null,false),[issues[0],issues[2]]);
 const {recordOverrides}=require('../../services/dentalPlanBooking.service'),state={changes:[]};recordOverrides(state,[issues[0]],{dependency_override_reason:'Doctor-approved reason',reviewed_by:7},{reason:'Auxiliary logistics note'},{clinical_manage:false},8,'2030-01-01',10);assert.equal(state.changes[0].reason,'Doctor-approved reason');assert.equal(state.changes[0].reviewed_by,7);assert.equal(state.changes[0].actor_id,8);
});
test('existing itinerary rejects forged first resources and altered canonical staff policies',()=>{
 const {assertExistingItinerary}=require('../../services/dentalPlanBooking.service'),profile=combineProfile([base().acts[0]],{doctorIds:[7],installationIds:[12]}),appointment={inicio:'2030-01-01T10:00:00Z',fin:'2030-01-01T10:30:00Z',doctor_id:7,instalacion_id:12};
 const phase={start_at:appointment.inicio,end_at:appointment.fin,doctor_ids:[7],installation_id:12};appointment.import_metadata={booking:{profile,phases:[phase]}};assert.doesNotThrow(()=>assertExistingItinerary(appointment,profile));
 assert.throws(()=>assertExistingItinerary({...appointment,doctor_id:99,instalacion_id:99},profile),{code:'dental_appointment_profile_mismatch'});
 phase.staff_time_scope='appointment';assert.throws(()=>assertExistingItinerary(appointment,profile),{code:'dental_appointment_profile_mismatch'});phase.staff_time_scope='phase';phase.staff_intervals=[{start_at:appointment.inicio,end_at:appointment.fin}];assert.throws(()=>assertExistingItinerary(appointment,profile),{code:'dental_appointment_profile_mismatch'});
});
test('logistics DTO preserves scoped work and booking identity without narratives in current or revision snapshots',()=>{
 const service=createDentalPlanService({db:{}}),state=change(base(),{command:'generate'});state.acts[0].notes='PRIVATE clinical indications';state.sessions[0].notes='PRIVATE history';state.execution=[{id:'event',act_id:state.acts[0].id,target_id:state.acts[0].targets[0].id,status:'performed',notes:'PRIVATE examination',reason:'PRIVATE correction'}];state.changes=[{before:{notes:'PRIVATE original'},reason:'PRIVATE changed'}];state.protocol_snapshot={description:'PRIVATE clinical metadata'};
 const dto=service.serialize({public_id:'plan',clinic_id:72,patient_id:1,version_number:1,status:'provisional',state},{clinical_view:false,billing_view:false});assert(!JSON.stringify(dto).includes('PRIVATE'));assert.equal(dto.execution[0].status,'performed');assert.equal(dto.acts[0].targets[0].fdi,16);assert.equal(dto.sessions[0].act_ids[0],state.sessions[0].act_ids[0]);
});
test('independent execution never reports performed or partial work against a future episode date',()=>{
 const {assertIndependentExecutionDate}=require('../../services/dentalPlanExecution.service'),now=new Date('2030-01-01T10:00:00Z');
 assert.throws(()=>assertIndependentExecutionDate({occurred_at:'2030-01-02T10:00:00Z'},[{status:'performed'}],now),{code:'dental_execution_date_invalid'});assert.throws(()=>assertIndependentExecutionDate({occurred_at:'2030-01-02T10:00:00Z'},[{status:'partial'}],now),{code:'dental_execution_date_invalid'});assert.doesNotThrow(()=>assertIndependentExecutionDate({occurred_at:'2029-12-30T10:00:00Z'},[{status:'performed'}],now));
});
test('a review indication creates no clinical work until explicit professional preparation, preserving its original scope',()=>{
 const initial=change(base(),{command:'generate'}),count=initial.acts.length,indicated=change(initial,{command:'review',due_on:'2030-02-01',title:'Control de cicatrización',notes:'Indicación del profesional',act_ids:[initial.acts[0].id]});
 assert.equal(indicated.acts.length,count);assert.equal(indicated.sessions.length,initial.sessions.length);assert.equal(indicated.reservations.length,0);
 const review=indicated.review,preparedAct=D.act({title:'Revisión clínica',duration_minutes:20,professional_id:7,targets:[{kind:'tooth',fdi:16}]}),payload={command:'prepare_review',review_id:review.id};
 const ready=D.changeState(indicated,payload,{actorId:7,now:'2030-01-01T10:00:00Z',preparedAct}),act=ready.acts.at(-1),session=ready.sessions.at(-1);
 assert.equal(act.review_id,review.id);assert.equal(act.source,null);assert.equal(act.commercial_scope,'not_contracted');assert.equal(session.status,'pending');assert.deepEqual(session.review_ids,[review.id]);assert.equal(session.tentative_on,'2030-02-01');
 assert.deepEqual(ready.review.act_ids,review.act_ids);assert.equal(ready.review.prepared_act_id,act.id);assert.equal(ready.review.prepared_session_id,session.id);assert.equal(ready.review.status,'prepared');assert.deepEqual(ready.review.appointment_ids,[]);assert.equal(ready.reservations.length,0);
 assert.throws(()=>D.changeState(ready,payload,{actorId:7,preparedAct}),{code:'dental_review_already_prepared'});
 assert.throws(()=>D.changeState(indicated,{...payload,review_id:'foreign-review'},{actorId:7,preparedAct}),{code:'dental_review_not_found'});
 assert.throws(()=>D.changeState(indicated,{...payload,review_session:'yes'},{actorId:7,preparedAct}),{code:'dental_review_validation_invalid'});
 assert.throws(()=>D.changeState(indicated,payload,{actorId:7,preparedAct:D.act({title:'Sin profesional',duration_minutes:20})}),{code:'dental_review_scope_required'});
 assert.deepEqual(indicated.review,review,'Preparation does not mutate its earlier indication snapshot');
});
test('review identity survives editing and session composition, and tracks real reservation history without duplicate appointments',()=>{
 let s=change(change(base(),{command:'generate'}),{command:'review',due_on:'2030-02-01',act_ids:[]});const reviewId=s.review.id;
 s=D.changeState(s,{command:'prepare_review',review_id:reviewId},{actorId:7,preparedAct:D.act({title:'Revisión elegida',duration_minutes:20,professional_id:7})});
 const reviewAct=s.acts.at(-1),oldSession=s.review.prepared_session_id,target=s.sessions[0].id;
 const edited=D.act({...reviewAct,title:'Control actualizado'},{previous:reviewAct});assert.equal(edited.review_id,reviewId);assert.equal(D.act({...reviewAct,review_id:'forged'}).review_id,undefined);
 s=change(s,{command:'move_act',session_id:oldSession,target_session_id:target,act_id:reviewAct.id});assert.equal(s.review.prepared_session_id,target);assert(s.sessions.find(row=>row.id===target).review_ids.includes(reviewId));
 s.reservations=[{appointment_id:50,session_id:target,act_ids:[reviewAct.id],active:true}];D.syncReviewLinks(s);assert.equal(s.review.status,'booked');assert.deepEqual(s.review.appointment_ids,[50]);
 s.reservations[0].active=false;D.syncReviewLinks(s);assert.equal(s.review.status,'prepared');assert.deepEqual(s.review.appointment_ids,[50]);
 s.reservations.push({appointment_id:51,session_id:target,act_ids:[reviewAct.id],active:true});D.syncReviewLinks(s);D.syncReviewLinks(s);assert.deepEqual(s.review.appointment_ids,[50,51]);
 s.acts.find(row=>row.id===reviewAct.id).status='performed';D.syncReviewLinks(s);assert.equal(s.review.status,'completed');
 const dto=createDentalPlanService({db:{}}).serialize({public_id:'plan',patient_id:1,clinic_id:72,version_number:3,status:s.phase,state:s},{clinical_view:false,billing_view:false});assert.equal(dto.review.prepared_session_id,target);assert.deepEqual(dto.review.appointment_ids,[50,51]);assert.equal(dto.acts.at(-1).review_id,reviewId);
});
