'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),Sequelize=require('sequelize');
const {createRequire}=require('node:module');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async({sql,models:db,report})=>{
  const D=Sequelize.DataTypes;
  db.CitaPaciente=sql.define('CitaPaciente',{id_cita:{type:D.INTEGER,primaryKey:true},clinica_id:D.INTEGER,
    paciente_id:D.INTEGER,estado:D.STRING,lead_intake_id:D.INTEGER},{timestamps:false});
  for(const file of ['appointmentclinicalreport','appointmentclinicalreportrevision','clinicalepisodeappointment']){
    const model=require('../../../models/'+file)(sql,D);db[model.name]=model;
  }
  db.ConsentSignaturePackage=sql.define('ConsentSignaturePackage',{id:{type:D.INTEGER,primaryKey:true},cita_id:D.INTEGER},{timestamps:false});
  db.PatientConsentDocument=sql.define('PatientConsentDocument',{id:{type:D.INTEGER,primaryKey:true},cita_id:D.INTEGER},{timestamps:false});
  await sql.sync();
  // Reproduce the legacy destructive FK so the race would really cascade
  // without the reservation lock and history guard.
  await sql.getQueryInterface().addConstraint('AppointmentClinicalReports',{fields:['appointment_id'],type:'foreign key',
    name:'owned_report_appointment_fk',references:{table:db.CitaPaciente.getTableName(),field:'id_cita'},onDelete:'CASCADE'});
  await db.CitaPaciente.bulkCreate([1,2,3,4,5,6,7,8,9].map(id_cita=>({id_cita,clinica_id:72,paciente_id:9,estado:'cancelada'})));
  const values=(public_id,appointment_id)=>({public_id,clinic_id:72,patient_id:9,appointment_id,status:'draft',summary:'Texto clínico ficticio'});
  await db.AppointmentClinicalReport.create(values('OWNED-PRIMARY',1));
  const independent=await db.AppointmentClinicalReport.create(values('OWNED-INDEPENDENT',null));
  await db.ClinicalEpisodeAppointment.create({appointment_id:2,report_id:independent.id,clinic_id:72,patient_id:9});
  await db.ConsentSignaturePackage.create({id:5,cita_id:5});await db.PatientConsentDocument.create({id:5,cita_id:5});
  const unlinked=await db.AppointmentClinicalReport.create(values('OWNED-UNLINKED',6));
  await db.ClinicalEpisodeAppointment.create({appointment_id:7,report_id:unlinked.id,clinic_id:72,patient_id:9});
  await db.AppointmentClinicalReportRevision.create({report_id:unlinked.id,version_number:1,status:'draft',change_type:'created',snapshot:{appointment_id:6,appointment_ids:[6,7]}});
  await unlinked.update({appointment_id:null});await db.ClinicalEpisodeAppointment.destroy({where:{appointment_id:7}});
  await db.AppointmentClinicalReportRevision.create({report_id:unlinked.id,version_number:2,status:'draft',change_type:'edited',snapshot:{appointment_id:null,appointment_ids:[80]}});
  const controllerFile=require.resolve('../../controllers/citas.controller'),nativeRequire=createRequire(controllerFile);
  const source=fs.readFileSync(controllerFile,'utf8'),method=source.slice(source.indexOf('exports.deleteCita ='),source.indexOf('exports.reagendarCita ='));
  const calls=[];const exports={};
  vm.runInNewContext(method,{exports,db,CitaPaciente:db.CitaPaciente,asyncHandler:fn=>fn,
    denyAppointmentManageAccessIfNeeded:async()=>false,
    appointmentAutomationV2Runtime:{cancelActiveExecutionsForCita:async cita=>calls.push(['cancel',cita.id_cita])},
    appointmentNotificationCleanup:{markAutomationNotificationsReadForAppointment:async id=>calls.push(['read',id])},
    syncLeadStatusFromAppointments:async()=>{},emitAppointmentSocketEvent:(event,row)=>calls.push(['emit',row.id_cita]),
    require:name=>name==='../services/appointmentPatientLinks.service'?{membership:async()=>false}:
      name==='../lib/program-appointment-context'?{hasProgramAppointmentReference:()=>false}:nativeRequire(name),
  });
  const remove=async id=>{let status=200,body;const res={status:code=>{status=code;return res;},json:value=>{body=value;return res;}};
    await exports.deleteCita({params:{id:String(id)}},res);return{status,body};};
  for(const id of [1,2,6,7]){const result=await remove(id);assert.equal(result.status,409);assert.equal(result.body.code,'appointment_clinical_history_preserved');
    assert(await db.CitaPaciente.findByPk(id));assert(!calls.some(([,sourceId])=>sourceId===id));}

  const writer=await sql.transaction();await db.CitaPaciente.findByPk(3,{transaction:writer,lock:writer.LOCK.UPDATE});
  let announceAttempt;const attempted=new Promise(resolve=>{announceAttempt=resolve;});
  const originalFind=db.CitaPaciente.findByPk.bind(db.CitaPaciente);
  db.CitaPaciente.findByPk=async(id,options)=>{if(Number(id)===3&&options?.lock)announceAttempt();return originalFind(id,options);};
  const deleting=remove(3);await attempted;
  const saved=await db.AppointmentClinicalReport.create(values('OWNED-CONCURRENT',3),{transaction:writer});
  await writer.commit();const race=await deleting;db.CitaPaciente.findByPk=originalFind;
  assert.equal(race.status,409);assert.equal(race.body.code,'appointment_clinical_history_preserved');
  assert(await db.CitaPaciente.findByPk(3));assert.equal((await db.AppointmentClinicalReport.findByPk(saved.id)).summary,'Texto clínico ficticio');
  assert(!calls.some(([,id])=>id===3));

  // A first writer may leave only a revision reference, without a current link.
  const revisionWriter=await sql.transaction();await db.CitaPaciente.findByPk(9,{transaction:revisionWriter,lock:revisionWriter.LOCK.UPDATE});
  let announceRevisionAttempt;const revisionAttempted=new Promise(resolve=>{announceRevisionAttempt=resolve;});
  db.CitaPaciente.findByPk=async(id,options)=>{if(Number(id)===9&&options?.lock)announceRevisionAttempt();return originalFind(id,options);};
  const deletingRevision=remove(9);await revisionAttempted;
  await db.AppointmentClinicalReportRevision.create({report_id:unlinked.id,version_number:3,status:'draft',change_type:'edited',snapshot:{appointment_id:null,appointment_ids:[9]}},{transaction:revisionWriter});
  await revisionWriter.commit();const revisionRace=await deletingRevision;db.CitaPaciente.findByPk=originalFind;
  assert.equal(revisionRace.status,409);assert.equal(revisionRace.body.code,'appointment_clinical_history_preserved');assert(await db.CitaPaciente.findByPk(9));assert(!calls.some(([,id])=>id===9));
  const notSubstring=await remove(8);assert.equal(notSubstring.status,200);assert.equal(await db.CitaPaciente.findByPk(8),null);

  const clean=await remove(4);assert.equal(clean.status,200);assert.equal(await db.CitaPaciente.findByPk(4),null);
  const update=db.PatientConsentDocument.update;
  db.PatientConsentDocument.update=async()=>{throw Error('OWNED_DETACH_FAILURE');};
  await assert.rejects(remove(5),/OWNED_DETACH_FAILURE/);db.PatientConsentDocument.update=update;
  assert(await db.CitaPaciente.findByPk(5));assert.equal((await db.ConsentSignaturePackage.findByPk(5)).cita_id,5);
  assert.equal((await db.PatientConsentDocument.findByPk(5)).cita_id,5);assert(!calls.some(([,id])=>id===5));
  report.checks.push('Actual delete controller and owned SQL with legacy CASCADE FK: primary/shared/revision-only history reject before flows after real unlink; numeric JSON IDs match exactly, never by substring; concurrent first report and revision-only writes win the reservation lock; empty cancelled reservation deletes; failed consent detach rolls back all SQL with no false deletion or cleanup. No DEV database, external storage or providers.');
}).catch(error=>{console.error(error);process.exitCode=1;});
