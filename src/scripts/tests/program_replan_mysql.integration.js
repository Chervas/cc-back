'use strict';
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { snapshot } = require('../../lib/economicProgramSnapshot');
const { createPatientProgramBookingService } = require('../../services/patientProgramBooking.service');
const { mutateAppointmentBooking } = require('../../services/appointmentBookingCommand.service');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const D = Sequelize.DataTypes; db.Sequelize = Sequelize;
  Object.assign(process.env, { TREATMENT_PROGRAM_BOOKING_ENABLED:'true', TREATMENT_PROGRAM_ECONOMICS_ENABLED:'true', BOOKING_PROFILES_ENABLED:'true', BOOKING_MULTI_RESOURCE_ENABLED:'true', BOOKING_EQUIPMENT_ENABLED:'true' });
  // Production appointment, calendar, equipment and ledger models. Minimal
  // identity tables contain synthetic IDs only; no application bootstrap.
  const define = (name, fields) => db[name] = sql.define(name, fields, { timestamps:false });
  define('Clinica', { id_clinica:{type:D.INTEGER,primaryKey:true}, grupoClinicaId:D.INTEGER, configuracion:D.JSON, equipment_booking_enabled:D.BOOLEAN });
  define('Usuario', { id_usuario:{type:D.INTEGER,primaryKey:true}, nombre:D.STRING, apellidos:D.STRING });
  define('Paciente', { id_paciente:{type:D.INTEGER,primaryKey:true} });
  define('Tratamiento', { id_tratamiento:{type:D.INTEGER,primaryKey:true}, clinica_id:D.INTEGER, origen:D.STRING, activo:D.BOOLEAN, clinical_config:D.JSON });
  for (const file of ['doctorclinica','doctorhorario','doctorhorarioexcepcion','doctorbloqueo','doctorbloqueoexcepcion','instalacion','instalacionhorario','instalacionbloqueo','clinicahorario',
    'citapaciente','appointmentbookingoccupancy','appointmentbookingresource','installationphysicalalias','bookingequipment','bookingequipmentclinic','bookingequipmentroompolicy',
    'economicbudget','economicbudgetversion','economicbudgetevent','patientvoucher','patientvouchermovement','patientprogramsession','patientprogrambookingrequest','patientoperationalevent']) {
    const m = require('../../../models/' + file)(sql,D); db[m.name]=m;
  }
  for (const name of ['DoctorClinica','DoctorHorario','DoctorHorarioExcepcion','DoctorBloqueo','DoctorBloqueoExcepcion','Instalacion','InstalacionHorario','InstalacionBloqueo','ClinicaHorario','CitaPaciente','AppointmentBookingOccupancy','BookingEquipment','PatientOperationalEvent']) db[name].associate?.(db);
  for (const name of ['ClinicConsentTemplate','ConsentTemplateCatalog']) define(name,{id:{type:D.INTEGER,primaryKey:true},purpose:D.STRING,status:D.STRING,validity_mode:D.STRING,requires_professional_signature:D.BOOLEAN});
  define('TreatmentConsentRequirement',{id:{type:D.INTEGER,primaryKey:true},tratamiento_id:D.INTEGER,clinica_id:D.INTEGER,required:D.BOOLEAN,blocking_policy:D.STRING,clinic_template_id:D.INTEGER,catalog_template_id:D.INTEGER});
  db.TreatmentConsentRequirement.belongsTo(db.ClinicConsentTemplate,{foreignKey:'clinic_template_id',as:'clinicTemplate'});
  db.TreatmentConsentRequirement.belongsTo(db.ConsentTemplateCatalog,{foreignKey:'catalog_template_id',as:'catalogTemplate'});
  // Production schema is migrated, never sync'd. This private fixture needs
  // short explicit names instead of Sequelize's overlong generated indexes.
  for (const model of Object.values(sql.models)) (model.options.indexes || []).forEach((index, i) => { index.name = `qa_${model.name.slice(0,35)}_${i}`; });
  await sql.sync();
  await db.Clinica.create({id_clinica:1,grupoClinicaId:1,configuracion:{timezone:'Europe/Madrid'},equipment_booking_enabled:true});
  await db.Paciente.create({id_paciente:1});
  for (const id of [1,2]) {
    await db.Usuario.create({id_usuario:id,nombre:'Persona ficticia '+id});
    const dc=await db.DoctorClinica.create({doctor_id:id,clinica_id:1,recibe_citas:true});
    for(let day=1;day<=5;day++) await db.DoctorHorario.create({doctor_clinica_id:dc.id,dia_semana:day,hora_inicio:'09:00',hora_fin:'20:00'});
    await db.Instalacion.create({id,clinica_id:1,nombre:'Consulta ficticia '+id,profesionales_permitidos:[1,2]});
    for(let day=1;day<=5;day++) await db.InstalacionHorario.create({instalacion_id:id,dia_semana:day,hora_inicio:'09:00',hora_fin:'20:00'});
    await db.BookingEquipmentRoomPolicy.create({installation_id:id,mode:'all'});
  }
  const machine=await db.BookingEquipment.create({owner_clinic_id:1,group_id:1,name:'Máquina ficticia',family_key:'ems',mobility:'mobile',status:'available'});
  await db.BookingEquipmentClinic.create({equipment_id:machine.id,clinic_id:1});
  const treatments=[];
  for (const id of [1,2]) {
    const profile={version:2,phases:[{key:'care',duration_minutes:30,installation_ids:[id],professionals:{mode:'any',ids:[1],preferred_id:1},equipment_requirements:[{equipment_ids:[machine.id]}]}]};
    await db.Tratamiento.create({id_tratamiento:id,clinica_id:1,origen:'clinica',activo:true,clinical_config:{catalog_status:'active',booking_profile:profile}});
    treatments.push({id,name:'Tratamiento ficticio '+id,booking_profile:profile});
  }
  const frozen=snapshot({id:'qa-program',version:1,status:'active',name:'Programa ficticio',kind:'program',total_price:100,summary:{issues:[]},cadence:{mode:'weekly',sessions_per_week:2,min_days_between:2},
    appointments:Array.from({length:4},(_,i)=>({key:'s'+i,label:'Sesión '+(i+1),offset_days:null,treatment_ids:[1,2],duration_minutes:60,treatments}))});
  const budget=await db.EconomicBudget.create({public_id:'qa-budget',clinic_id:1,patient_id:1,number:'QA',status:'accepted'});
  await db.EconomicBudgetVersion.create({budget_id:budget.id,version_number:1,lines:[{key:'line',program_snapshot:frozen}],totals:{},payment_proposal:{},design_config:{},clinic_snapshot:{},patient_snapshot:{}});
  const voucher=await db.PatientVoucher.create({public_id:'qa-voucher',clinic_id:1,patient_id:1,budget_id:budget.id,budget_line_key:'line',name:'QA',total_units:4,available_units:4,sold_amount:100,status:'active',source_system:'treatment_program'});
  let clock=new Date('2030-01-01T00:00:00Z');
  const service=createPatientProgramBookingService({db,now:()=>clock});
  const options={publicId:voucher.public_id,clinicId:1,actorId:1};
  const choices = proposal => proposal.proposals.map(row=>({key:row.key,start_at:row.solution.start_at,selections:Object.fromEntries(row.solution.phases.map(p=>[p.key,{installation_id:p.installation_id,doctor_id:p.doctor_ids[0]}]))}));
  let proposed=await service.propose({...options,payload:{from_date:'2030-01-07',days:30}});
  assert.equal(proposed.proposals.length,4); assert(proposed.proposals.every(row=>row.solution.phases.length===2));
  const initial=await service.book({...options,payload:{request_key:'qa-initial-booking',snapshot_sha256:frozen.sha256,sessions:choices(proposed)}});
  assert.equal(initial.sessions.length,4);
  const change=async(id,values,other={})=>mutateAppointmentBooking({db,existingAppointmentId:id,appointmentValues:values,...other,persist:({existing,values,transaction})=>existing.update(values,{transaction})});
  await change(initial.sessions[0].appointment_id,{estado:'completada',updated_by:1},{stateOnly:true});
  await change(initial.sessions[1].appointment_id,{estado:'no_asistio',updated_by:1},{stateOnly:true});
  await change(initial.sessions[2].appointment_id,{updated_by:1},{additionalStaffIds:[2]});
  const completed=(await db.CitaPaciente.findByPk(initial.sessions[0].appointment_id)).toJSON();
  const missed=(await db.CitaPaciente.findByPk(initial.sessions[1].appointment_id)).toJSON();
  clock=new Date('2030-01-10T00:00:00Z');
  let plan=await service.read(options);
  assert.equal(plan.sessions[1].scheduling_status,'missed'); assert(plan.can_resume); assert.equal(plan.resume.existing_reservations_count,2);
  assert.equal(Number((await voucher.reload()).available_units),3);
  const mode=()=>({mode:'resume',replan_from_key:plan.resume.from_key,expected_plan_revision:plan.plan_revision});
  // The old two future slots must be excluded from ALL bulk occupancy reads.
  proposed=await service.propose({...options,payload:{from_date:'2030-01-14',days:30,...mode()}});
  assert.equal(proposed.proposals.length,3); assert(proposed.proposals.every(row=>row.solution));
  assert.equal(proposed.proposals[0].solution.start_at,initial.sessions[2].start_at);
  report.checks.push('real bulk SQL proposals reuse own released future slots and reserve both sequential rooms and the physical machine');
  let request={request_key:'qa-resume-booking',snapshot_sha256:frozen.sha256,sessions:choices(proposed),...mode()};
  await assert.rejects(service.book({...options,payload:{...request,sessions:request.sessions.slice(1)}}),{code:'program_resume_incomplete'});
  const changed=await db.CitaPaciente.findByPk(initial.sessions[3].appointment_id);
  await changed.update({nota:'Cambio concurrente ficticio'});
  await assert.rejects(service.book({...options,payload:request}),{code:'program_resume_changed'});
  plan=await service.read(options);request={...request,...mode()};
  const before=(await db.CitaPaciente.findAll({order:[['id_cita','ASC']]})).map(row=>row.toJSON());
  const eventsBefore=await db.PatientOperationalEvent.count();
  const conflicting=await db.CitaPaciente.create({clinica_id:1,paciente_id:1,doctor_id:2,instalacion_id:2,inicio:request.sessions[2].start_at,fin:new Date(new Date(request.sessions[2].start_at).getTime()+60000),estado:'pendiente'});
  await assert.rejects(service.book({...options,payload:request}),{code:'program_booking_unavailable'});
  await conflicting.destroy();
  assert.deepEqual((await db.CitaPaciente.findAll({order:[['id_cita','ASC']]})).map(row=>row.toJSON()),before);
  assert.equal(await db.PatientOperationalEvent.count(),eventsBefore);
  assert.equal(await db.PatientProgramBookingRequest.count(),1);
  report.checks.push('late conflict rolls back replacement, later moves, occupancy, pointer and activity together; partial batch and stale revision rejected');
  const result=await service.book({...options,payload:request});
  assert.deepEqual(result.sessions.map(s=>s.action),['created','rescheduled','rescheduled']);
  assert.notEqual(result.sessions[0].appointment_id,missed.id_cita);
  assert.deepEqual((await db.CitaPaciente.findByPk(completed.id_cita)).toJSON(),completed);
  assert.deepEqual((await db.CitaPaciente.findByPk(missed.id_cita)).toJSON(),missed);
  assert.deepEqual(result.sessions.slice(1).map(s=>s.appointment_id),initial.sessions.slice(2).map(s=>s.appointment_id));
  assert.equal(Number((await voucher.reload()).available_units),3);assert.equal(await db.PatientVoucherMovement.count(),1);
  const support=await db.AppointmentBookingOccupancy.findAll({where:{appointment_id:result.sessions[1].appointment_id,doctor_id:2}}); assert(support.length);
  assert.equal(new Date(support[0].start_at).getTime(),new Date(result.sessions[1].start_at).getTime());
  for(const row of await db.CitaPaciente.findAll())assert.equal(row.import_metadata.automation_policy,'hold');
  const replay=await service.book({...options,payload:request});assert(replay.replayed);assert.deepEqual(replay.sessions,result.sessions);
  report.checks.push('completed and absent appointments unchanged; future IDs/support retained; one consumption, HOLD and idempotent replay');
  // Resume a second time and race two valid confirmations on the same ledger.
  await change(result.sessions[0].appointment_id,{estado:'no_asistio',updated_by:1},{stateOnly:true});
  clock=new Date(new Date(result.sessions[0].start_at).getTime()+3600000);
  plan=await service.read(options);
  proposed=await service.propose({...options,payload:{from_date:'2030-02-04',days:30,...mode()}});
  assert(proposed.proposals.every(row=>row.solution));
  request={request_key:'qa-resume-race-a',snapshot_sha256:frozen.sha256,sessions:choices(proposed),...mode()};
  const race=await Promise.allSettled([service.book({...options,payload:request}),service.book({...options,payload:{...request,request_key:'qa-resume-race-b'}})]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(race.find(r=>r.status==='rejected').reason.code,'program_resume_changed');
  assert.equal(Number((await voucher.reload()).available_units),3);assert.equal(await db.PatientVoucherMovement.count(),1);
  report.checks.push('competing real SQL confirmations produce one batch only, with no duplicate sessions or economic movement');
}).catch(error=>{console.error(error);process.exitCode=1;});
