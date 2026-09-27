'use strict';
const assert=require('node:assert/strict'),Sequelize=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {hash}=require('../../lib/cliniccloud-import/adapter');
withIsolatedCampaignMysql(async({sql,models:db,report})=>{
 const D=Sequelize.DataTypes;db.Sequelize=Sequelize;
 db.CitaPaciente=sql.define('CitaPaciente',{id_cita:{type:D.INTEGER,primaryKey:true},clinica_id:D.INTEGER,paciente_id:D.INTEGER,
  tratamiento_id:D.INTEGER,doctor_id:D.INTEGER,titulo:D.STRING,motivo:D.STRING,inicio:D.DATE,fin:D.DATE,estado:D.STRING,
  source_system:D.STRING,import_metadata:D.JSON},{timestamps:false});
 db.Paciente=sql.define('Paciente',{id_paciente:{type:D.INTEGER,primaryKey:true},public_id:D.STRING,clinica_id:D.INTEGER},{timestamps:false});
 db.Tratamiento=sql.define('Tratamiento',{id_tratamiento:{type:D.INTEGER,primaryKey:true},nombre:D.STRING},{timestamps:false});
 db.Usuario=sql.define('Usuario',{id_usuario:{type:D.INTEGER,primaryKey:true},nombre:D.STRING,apellidos:D.STRING},{timestamps:false});
 for(const file of ['appointmentclinicalreport','appointmentclinicalreportrevision']){const m=require('../../../models/'+file)(sql,D);db[m.name]=m;}
 await sql.sync();await db.Paciente.create({id_paciente:1,public_id:'fictitious-patient',clinica_id:72});
 await db.Tratamiento.create({id_tratamiento:1,nombre:'Tratamiento ficticio'});
 await db.Usuario.bulkCreate([7,8].map(id_usuario=>({id_usuario,nombre:'Profesional ficticio '+id_usuario})));
 await db.CitaPaciente.create({id_cita:1,clinica_id:72,paciente_id:1,tratamiento_id:1,doctor_id:7,
  titulo:'Cita ficticia',motivo:'Motivo ficticio',inicio:'2030-01-07T10:00:00Z',fin:'2030-01-07T10:30:00Z',estado:'pendiente',source_system:'cliniccloud',import_metadata:{suppress_automations:true}});
 const service=require('../../services/appointmentClinicalReports.service');
 const appointmentsBefore=hash(await db.CitaPaciente.findAll({raw:true}));
 const call=(actorId,payload,finalize=false)=>service.save({appointmentId:1,actorId,payload,finalize});
 const read=()=>service.getByAppointment({appointmentId:1});
 assert.equal((await read()).version,0);
 await assert.rejects(call(7,{summary:'No expected version'}),{code:'clinical_report_version_required'});assert.equal(await db.AppointmentClinicalReport.count(),0);
 // Both editors start with version zero; the appointment lock serializes
 // the absent-report case too, so no writer can win by waiting for the lock.
 const race=await Promise.allSettled([call(7,{expected_version:0,summary:'Editor A'}),call(8,{expected_version:0,summary:'Editor B'})]);
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(race.find(r=>r.status==='rejected').reason.code,'clinical_report_version_conflict');
 assert.equal(await db.AppointmentClinicalReport.count(),1);assert.equal(await db.AppointmentClinicalReportRevision.count(),1);
 const first=await read();assert.equal(first.version,1);
 const v2=await call(8,{expected_version:1,summary:'Cambio más reciente'});assert.equal(v2.version,2);
 for(const finalize of [false,true])await assert.rejects(call(7,{expected_version:1,summary:'Editor antiguo'},finalize),{code:'clinical_report_version_conflict'});
 assert.equal((await read()).summary,'Cambio más reciente');assert.equal(await db.AppointmentClinicalReportRevision.count(),2);
 const closed=await call(8,{expected_version:2,summary:'Informe cerrado'},true);assert.equal(closed.status,'final');assert.equal(closed.version,3);
 await assert.rejects(call(7,{expected_version:2,summary:'Reapertura antigua',reopen:true}),{code:'clinical_report_version_conflict'});
 await assert.rejects(call(7,{expected_version:3,summary:'Sin reapertura'}),{code:'clinical_report_final'});
 const reopened=await call(7,{expected_version:3,summary:'Informe cerrado',reopen:true});assert.equal(reopened.status,'draft');assert.equal(reopened.version,4);
 const initialRevision=await db.AppointmentClinicalReportRevision.findOne({where:{version_number:1},raw:true});assert.equal(initialRevision.snapshot.summary,first.summary);
 const finalRevision=await db.AppointmentClinicalReportRevision.findOne({where:{version_number:3},raw:true});assert.equal(finalRevision.snapshot.status,'final');assert.equal(finalRevision.snapshot.summary,'Informe cerrado');
 // A failed revision insert rolls back the update/version too.
 const originalCreate=db.AppointmentClinicalReportRevision.create;
 db.AppointmentClinicalReportRevision.create=async()=>{throw Error('FICTITIOUS_REVISION_FAILURE');};
 await assert.rejects(call(7,{expected_version:4,summary:'Must roll back'}),/FICTITIOUS_REVISION_FAILURE/);db.AppointmentClinicalReportRevision.create=originalCreate;
 assert.equal((await read()).version,4);assert.equal((await read()).summary,'Informe cerrado');
 assert.equal(await db.AppointmentClinicalReportRevision.count(),4);
 assert.equal(hash(await db.CitaPaciente.findAll({raw:true})),appointmentsBefore);
 report.checks.push('Two simultaneous initial saves: one winner and one conflict. Stale edit/finalize/reopen rejected without revisions; final report requires explicit reopen; rollback and immutable history verified; appointment, status and HOLD unchanged.');
}).catch(e=>{console.error(e);process.exitCode=1;});
