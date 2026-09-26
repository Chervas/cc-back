#!/usr/bin/env node
'use strict';
// Deliberate synthetic attendance state for authenticated public-UI QA.
// Never routes through a notification controller or loads application bootstrap.
// Historical fixture dates are artificial; this is not a real attendance record.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Sequelize=require('sequelize');
const {databaseOptions}=require('../../lib/cliniccloud-import/operator-database');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {parseArgs,writePrivateJson}=require('../../lib/cliniccloud-import/io');
const {validateBackup}=require('../cliniccloud-import-contacts-apply');
const {openJournal}=require('../cliniccloud-import-appointments-apply');
const VOUCHER='9a959236-3a68-484f-90ea-b09fbed81591',APPOINTMENT=75147;
function normalized(row){
 const out=structuredClone(row);
 for(const key of ['inicio','fin','created_at','updated_at','hold_expires_at'])if(out[key])out[key]=new Date(out[key] instanceof Date?out[key]:String(out[key]).replace(' ','T')+'Z').toISOString();
 if(typeof out.import_metadata==='string')out.import_metadata=JSON.parse(out.import_metadata);
 if(out.es_provisional!=null)out.es_provisional=Boolean(Number(out.es_provisional));
 return out;
}
function verifyCommitted(readback,after){
 // updated_at is DATETIME(0); the ORM retains milliseconds until reload.
 assert.equal(new Date(readback.updated_at).getTime(),Math.floor(new Date(after.updated_at).getTime()/1000)*1000);
 assert.deepEqual({...readback,updated_at:after.updated_at},after);
}
function validateScope({clinic,patient,voucher,budget,appointment,session}){
 const cfg=typeof clinic.configuracion==='string'?JSON.parse(clinic.configuracion):clinic.configuracion;
 assert.equal(clinic.id_clinica,82);assert.equal(cfg.qa_demo.key,'bs-medical-accounting-demo-v1');assert.equal(cfg.qa_demo.synthetic_data_only,true);
 assert.equal(patient.public_id,'demo_bsmedical_capillary_v1');assert.equal(patient.clinica_id,82);
 assert.equal(voucher.public_id,VOUCHER);assert.equal(voucher.clinic_id,82);assert.equal(voucher.patient_id,patient.id_paciente);
 assert.equal(voucher.source_system,'treatment_program');assert.equal(Number(voucher.available_units),2);
 assert.equal(budget.source_reference,'program-booking-20260914-v1-regression');assert.equal(budget.id,Number(voucher.budget_id));assert.equal(budget.clinic_id,82);
 assert.equal(appointment.id_cita,APPOINTMENT);assert.equal(appointment.clinica_id,82);assert.equal(appointment.paciente_id,patient.id_paciente);assert.equal(Number(appointment.voucher_id),Number(voucher.id));
 assert.equal(appointment.source_system,'treatment_program');assert.equal(appointment.estado,'reprogramada');
 const meta=normalized(appointment).import_metadata;assert.equal(meta.automation_policy,'hold');assert.deepEqual(meta.notification_suppression,{same_day:true,day_before:true,appointment_details:true});
 assert.equal(session.session_key,'session_2');assert.equal(Number(session.voucher_id),Number(voucher.id));assert.equal(session.appointment_id,APPOINTMENT);assert.equal(session.consumption_movement_id,null);
}
async function main(args){
 const o=parseArgs(args,['--mode','--backup-manifest','--before','--private-journal','--private-output']);
 assert(['dry-run','apply'].includes(o['--mode']));assert.equal(process.cwd(),'/home/ubuntu/wt/back-dev');
 assert.equal(require('node:child_process').execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),'dev');
 const backup=JSON.parse(fs.readFileSync(o['--backup-manifest']));assert(backup.database_target==='crm'&&backup.full_gzip_verified&&backup.dump_completion_verified);
 const age=Date.now()-Date.parse(backup.generated_at);assert(age>=0&&age<7200000);await validateBackup(o['--backup-manifest']);
 const before=JSON.parse(fs.readFileSync(o['--before']));assert.equal(before.voucher.public_id,VOUCHER);assert.equal(before.budget.source_reference,'program-booking-20260914-v1-regression');
 const expected=before.appointments.find(a=>a.id_cita===APPOINTMENT);assert(expected);
 const opt=databaseOptions('crm'),sql=new Sequelize(opt.database,opt.user,opt.password,{host:opt.host,port:opt.port,dialect:'mysql',logging:false,timezone:'+00:00',pool:{max:2,min:0},dialectOptions:{...(opt.ssl?{ssl:opt.ssl}:{})}});
 const db={sequelize:sql,Sequelize};
 for(const file of ['citapaciente','patientprogramsession','patientvoucher','clinica','patientoperationalevent']){const m=require('../../../models/'+file)(sql,Sequelize.DataTypes);db[m.name]=m;}
 const journal=openJournal(o['--private-journal'],hash({appointment:normalized(expected),mode:o['--mode']}));let tx,commitAttempted=false;
 try{
  // Private operator process only; do not change the API/gateway environment.
  for(const key of ['TREATMENT_PROGRAM_BOOKING_ENABLED','TREATMENT_PROGRAM_ECONOMICS_ENABLED','BOOKING_PROFILES_ENABLED','BOOKING_MULTI_RESOURCE_ENABLED'])process.env[key]='true';
  tx=await sql.transaction({isolationLevel:'READ COMMITTED'});
  const query=async(q,replacements=[])=>sql.query(q,{replacements,type:Sequelize.QueryTypes.SELECT,transaction:tx});
  const [clinic]=await query('SELECT id_clinica,configuracion FROM Clinicas WHERE id_clinica=82 FOR SHARE');
  const [patient]=await query('SELECT id_paciente,public_id,clinica_id FROM Pacientes WHERE public_id=? FOR SHARE',['demo_bsmedical_capillary_v1']);
  const voucher=await db.PatientVoucher.findOne({where:{public_id:VOUCHER},transaction:tx,lock:tx.LOCK.UPDATE});
  const [budget]=await query('SELECT id,source_reference,clinic_id FROM EconomicBudgets WHERE id=? FOR SHARE',[voucher.budget_id]);
  const appointment=await db.CitaPaciente.findByPk(APPOINTMENT,{transaction:tx,lock:tx.LOCK.UPDATE});
  const session=await db.PatientProgramSession.findOne({where:{appointment_id:APPOINTMENT},transaction:tx,lock:tx.LOCK.UPDATE});
  validateScope({clinic,patient,voucher:voucher.toJSON(),budget,appointment:appointment.toJSON(),session:session.toJSON()});
  assert.equal(hash(normalized(appointment.toJSON())),hash(normalized(expected)),'Fixture changed since snapshot');
  const [actor]=await query('SELECT id_usuario FROM Usuarios WHERE email_usuario=?',['carlos@clinicaclick.com']);assert(actor);
  await journal.append({stage:'before',appointment:appointment.toJSON(),session:session.toJSON(),voucher:voucher.toJSON(),synthetic_only:true});
  const saved=await require('../../services/appointmentBookingCommand.service').mutateAppointmentBooking({db,transaction:tx,existingAppointmentId:APPOINTMENT,
   capabilities:{simple:true,multi:true},stateOnly:true,appointmentValues:{estado:'no_asistio',updated_by:actor.id_usuario},
   persist:({existing,values,transaction})=>existing.update(values,{transaction})});
  await require('../../services/appointmentActivity.service').recordAppointmentStatusChange({appointment:saved,previousStatus:'reprogramada',newStatus:'no_asistio',actorUserId:actor.id_usuario,
   source:'qa_synthetic',metadata:{fixture:'public-program-resume-20260926',synthetic_only:true,clinical_attendance:false},transaction:tx,eventModel:db.PatientOperationalEvent});
  const after=normalized(saved.toJSON()),old=normalized(expected);
  assert.deepEqual({...after,estado:old.estado,updated_by:old.updated_by,updated_at:old.updated_at},old);
  await journal.append({stage:'verified_before_commit',after});
  if(o['--mode']==='dry-run'){await tx.rollback();tx=null;assert.equal(hash(normalized((await db.CitaPaciente.findByPk(APPOINTMENT)).toJSON())),hash(old));await journal.append({stage:'rolled_back_and_verified'});return{status:'rolled_back_and_verified'};}
  commitAttempted=true;await tx.commit();tx=null;await journal.append({stage:'committed',appointment_id:APPOINTMENT});
  const readback=normalized((await db.CitaPaciente.findByPk(APPOINTMENT)).toJSON());verifyCommitted(readback,after);
  writePrivateJson(o['--private-output'],{synthetic_only:true,appointment:readback,notifications_enqueued:false});
  return{status:'committed_and_verified',appointment_id:APPOINTMENT,synthetic_only:true,notifications_enqueued:false};
 }catch(e){if(tx&&!tx.finished)await tx.rollback();if(commitAttempted)throw Error('QA_COMMIT_REQUIRES_JOURNAL_REVIEW');throw e;}
 finally{journal.close();await sql.close();}
}
if(require.main===module)main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.code||e.name, e.code==='ERR_ASSERTION'?e.stack:e.message);process.exitCode=1;});
module.exports={normalized,validateScope,verifyCommitted};
