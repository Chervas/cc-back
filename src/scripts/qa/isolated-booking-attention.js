#!/usr/bin/env node
'use strict';
// Real SQL only on isolated, fictitious DEV. Always rollback; no send/socket hooks.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
async function main() {
  assert.equal(process.env.QA_ATTENTION_SQL, 'isolated-dev-rollback');
  require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  Object.assign(process.env, { BOOKING_EQUIPMENT_ENABLED:'true', BOOKING_PROFILES_ENABLED:'true', BOOKING_MULTI_RESOURCE_ENABLED:'true' });
  const log = console.log; let db;
  try { console.log=()=>{}; db=require('../../../models'); } finally { console.log=log; }
  const { mutateAppointmentBooking } = require('../../services/appointmentBookingCommand.service');
  const { bookingSegments } = require('../../lib/appointment-booking-segments');
  const marker=`qa-attention-${randomUUID()}`, checks=[];
  let tx;
  try {
    assert.equal(db.sequelize.config.database,'clinicaclick_dev_isolated');
    tx=await db.sequelize.transaction({isolationLevel:'READ COMMITTED'});
    const [protection]=require('../../services/appointmentBookingAvailability.service').nonShareableBookingAttribute(db,'fixture');
    for(const [metadata,expected]of [[null,0],[{booking:{profile:{version:1,phases:[{professionals:{mode:'any'}}]}}},0],
      [{booking:{profile:{version:2,phases:[{professionals:{mode:'any'},equipment_requirements:[{equipment_ids:[1]}]}]}}},1],
      [{booking:{profile:{version:1,phases:[{professionals:{mode:'all'}}]}}},1],
      [{booking:{profile:{version:3,phases:[{professionals:{mode:'any'}}]}}},1]]) {
      const [[row]]=await db.sequelize.query(`SELECT ${protection.val} AS protected FROM (SELECT CAST(:metadata AS JSON) AS import_metadata) fixture`,{replacements:{metadata:metadata===null?null:JSON.stringify(metadata)},transaction:tx});
      assert.equal(Number(row.protected),expected,'SQL must protect machine/team snapshots before v3');
    }
    const clinic=await db.Clinica.findByPk(1,{transaction:tx});
    assert.equal(clinic.nombre_clinica,'Clinica ficticia DEV');
    await clinic.update({equipment_booking_enabled:true},{transaction:tx});
    const staff=await db.Usuario.findAll({where:{notas_usuario:'bs-startup-isolated-20260920'},order:[['id_usuario','ASC']],transaction:tx});
    assert.equal(staff.length,2);
    const link=await db.DoctorClinica.findOne({where:{doctor_id:staff[0].id_usuario,clinica_id:1},transaction:tx});
    await link.update({allow_overlap_confirmation:true},{transaction:tx});
    const patients=[];
    for(let i=0;i<4;i++)patients.push(await db.Paciente.create({public_id:`pac_${randomUUID()}`,nombre:'Prueba atención',apellidos:'Ficticio',clinica_id:1},{transaction:tx}));
    const rooms=[],units=[],treatments=[];
    const policies=[{mode:'start_end',start_minutes:5,start_window_minutes:10,end_minutes:5,end_window_minutes:10},{mode:'continuous',patient_preparation_minutes:5},{mode:'start_end',start_minutes:5,start_window_minutes:10,end_minutes:5,end_window_minutes:10}];
    for(let i=0;i<4;i++) {
      const room=await db.Instalacion.create({clinica_id:1,nombre:`${marker}-${i}`,activo:true,tipo:'consulta',capacidad:i===3?2:1,allow_overlap_confirmation:i===3},{transaction:tx});rooms.push(room);
      for(let day=1;day<=5;day++)await db.InstalacionHorario.create({instalacion_id:room.id,dia_semana:day,activo:true,hora_inicio:'09:00',hora_fin:'20:00'},{transaction:tx});
      if(i<3) {
        const unit=await db.BookingEquipment.create({owner_clinic_id:1,name:`${marker}-${i}`,family_key:`qa-attention-${i}`,mobility:'fixed',status:'available',turnaround_minutes:0,home_installation_id:room.id,attention_policy:policies[i]},{transaction:tx});units.push(unit);
        await db.BookingEquipmentClinic.create({equipment_id:unit.id,clinic_id:1},{transaction:tx});
      }
      const phase={key:'care',duration_minutes:i===1?20:30,installation_ids:[room.id],professionals:{mode:'any',ids:[staff[0].id_usuario],preferred_id:staff[0].id_usuario},...(i<3?{equipment_requirements:[{equipment_ids:[units[i].id]}]}:{})};
      treatments.push(await db.Tratamiento.create({nombre:`${marker}-${i}`,disciplina:'estetica',origen:'clinica',clinica_id:1,activo:true,duracion_min:phase.duration_minutes,clinical_config:{booking_profile:{version:i<3?2:1,phases:[phase]}}},{transaction:tx}));
    }
    const start='2031-01-06T10:00:00Z';
    const values=(i,patient=i,time=start)=>({clinica_id:1,paciente_id:patients[patient].id_paciente,doctor_id:staff[0].id_usuario,instalacion_id:rooms[i].id,tratamiento_id:treatments[i].id_tratamiento,inicio:time,fin:new Date(+new Date(time)+(i===1?20:30)*60000).toISOString(),estado:'pendiente',source_system:'qa_attention',source_reference:`${marker}-${i}-${patient}-${time}`});
    const persist=({values,existing,transaction})=>existing?existing.update(values,{transaction}):db.CitaPaciente.create(values,{transaction});
    const reserve=(i,opts={})=>mutateAppointmentBooking({db,transaction:tx,persist,capabilities:{simple:true,multi:true,equipment:true},appointmentValues:values(i),...opts});
    const ems=await reserve(0),wave=await reserve(1);
    checks.push('EMS and shockwaves coexist with real, non-overlapping staff intervals');
    await assert.rejects(reserve(2,{force:true}),error=>error.code==='booking_unavailable'&&!error.details.can_force);
    checks.push('third same-start setup rejected, even with force');
    const rows=await db.AppointmentBookingOccupancy.findAll({where:{appointment_id:ems.id_cita},transaction:tx});
    assert.equal(rows.filter(r=>r.resource_kind==='doctor').length,2);
    assert.equal(rows.filter(r=>r.resource_kind==='equipment').length,1);
    assert.equal(rows.find(r=>r.resource_kind==='equipment').end_at.toISOString(),'2031-01-06T10:30:00.000Z');
    assert.equal(bookingSegments(ems.toJSON()).length,1);
    const reloaded=await db.CitaPaciente.findByPk(ems.id_cita,{transaction:tx});
    assert.equal(bookingSegments(reloaded.toJSON()).length,1,'SQL round-trip must preserve the visible appointment');
    assert.equal(ems.import_metadata.booking.profile.version,3);
    checks.push('staff split persisted; patient card remains one appointment; machine occupied throughout');
    await assert.rejects(reserve(0,{appointmentValues:values(0,2),force:true}),error=>error.code==='booking_unavailable'&&!error.details.can_force);
    checks.push('single physical machine cannot be double booked');
    await units[0].update({attention_policy:{mode:'continuous',patient_preparation_minutes:0}},{transaction:tx});
    const moved=await reserve(0,{existingAppointmentId:ems.id_cita,appointmentValues:values(0,0,'2031-01-06T11:00:00Z')});
    assert.equal(moved.import_metadata.booking.profile.version,3);
    assert.equal(moved.import_metadata.booking.phases[0].staff_intervals.length,2);
    checks.push('rescheduling preserves the booked attention protocol despite a later equipment-default change');
    await reserve(3,{appointmentValues:values(3,0,'2031-01-06T12:00:00Z')});
    await assert.rejects(reserve(3,{appointmentValues:values(3,1,'2031-01-06T12:00:00Z')}),error=>error.code==='booking_unavailable'&&error.details.can_force);
    await reserve(3,{appointmentValues:values(3,1,'2031-01-06T12:00:00Z'),force:true});
    checks.push('configured professional and consultation require confirmation for the second appointment');
    await assert.rejects(reserve(3,{appointmentValues:values(3,2,'2031-01-06T12:00:00Z'),force:true}),error=>error.code==='booking_unavailable'&&!error.details.can_force);
    checks.push('consultation capacity remains a hard limit');
    await assert.rejects(reserve(3,{appointmentValues:values(3,1,'2031-01-06T12:00:00Z'),force:true}),error=>error.code==='booking_unavailable'&&!error.details.can_force);
    checks.push('the same patient cannot be booked simultaneously');
    await reserve(1,{existingAppointmentId:wave.id_cita,appointmentValues:{estado:'cancelada'},stateOnly:true});
    checks.push('cancellation uses canonical state and releases occupancy');
    await tx.rollback();tx=null;
    console.log(JSON.stringify({success:true,target:'isolated-dev',rolled_back:true,checks}));
  } finally {if(tx)await tx.rollback();await db.sequelize.close();}
}
main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
