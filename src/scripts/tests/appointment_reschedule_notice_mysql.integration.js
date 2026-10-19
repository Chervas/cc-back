'use strict';
const assert = require('node:assert/strict'), S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
const { suppressRescheduleNotice } = require('../../lib/appointment-reschedule-notice');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const f = await createOwnedBookingDurationFixture({ sql, models: db });
  db.sequelize = sql; db.Sequelize = S;
  db.Conversation = sql.define('NoticeTestConversation', { id:{type:S.DataTypes.INTEGER,primaryKey:true,autoIncrement:true},
    clinic_id:S.DataTypes.INTEGER,patient_id:S.DataTypes.INTEGER,channel:S.DataTypes.STRING }, {tableName:'Conversations',timestamps:false});
  db.Message = require('../../../models/message')(sql,S.DataTypes);
  db.FlowExecutionV2 = require('../../../models/flowexecutionv2')(sql,S.DataTypes);
  await db.Conversation.sync(); await db.Message.sync(); await db.FlowExecutionV2.sync();
  const row = await f.reserve({ appointmentValues:f.values({tratamiento_id:4,inicio:'2030-01-07T10:00:00Z',fin:'2030-01-07T10:30:00Z'}) });
  const input = { existingAppointmentId:row.id_cita, appointmentValues:{inicio:'2030-01-08T10:00:00Z',fin:'2030-01-08T10:30:00Z',
    estado:'reprogramada',reschedule_reason:'clinic_schedule',updated_by:1},rescheduleNotice:{actorId:1} };
  async function seed({clinic=100,patient=1,type='template',status='delivered',name='clinicaclick_cita_reprogramada_peticion_paciente_v15'}={}) {
    const conversation=await db.Conversation.create({clinic_id:clinic,patient_id:patient,channel:'whatsapp'});
    const execution=await db.FlowExecutionV2.create({idempotency_key:`TESTONLY_notice_${conversation.id}`,created_by:1,template_version_id:1,status:'completed',context:{},trigger_type:'appointment_rescheduled',
      trigger_entity_type:'appointment',trigger_entity_id:900,clinic_id:clinic});
    return db.Message.create({conversation_id:conversation.id,direction:'outbound',message_type:type,status,sent_at:new Date(),
      content:'TESTONLY synthetic notice',metadata:{source:'automations_v2',execution_id:execution.id,template_name:name}});
  }
  await seed({clinic:200});await seed({patient:2});await seed({type:'event'});await seed({status:'failed'});
  await seed({name:'clinicaclick_confirmacion_datos_cita_48_sin_respuesta_v10'});
  const noFalseWarning=await f.reserve(input);assert.equal(noFalseWarning.import_metadata.reschedule_notice,undefined);
  await f.reserve({...input,appointmentValues:{...input.appointmentValues,inicio:'2030-01-07T10:00:00Z',fin:'2030-01-07T10:30:00Z'}});
  const sent=await seed();
  const before={row:JSON.stringify((await row.reload()).toJSON()),occupancy:JSON.stringify(await f.occupancy(row.id_cita))};
  let warning;
  await assert.rejects(f.reserve(input), error=>{warning=error;return error.code==='appointment_notice_already_sent_today'&&error.details.notice_count===1;});
  assert.equal(JSON.stringify((await row.reload()).toJSON()),before.row);assert.equal(JSON.stringify(await f.occupancy(row.id_cita)),before.occupancy);
  const response={status(code){this.code=code;return this;},json(value){this.body=value;}};
  require('../../services/treatmentBookingProfile.service').bookingErrorMiddleware(warning,{},response,()=>assert.fail('Warning escaped HTTP booking middleware'));
  assert.equal(response.code,409);assert.equal(response.body.details.acknowledgement,warning.details.acknowledgement);
  const decision={acknowledgement:warning.details.acknowledgement,send:false};
  const saved=await f.reserve({...input,rescheduleNotice:{actorId:1,decision}});
  assert.equal(suppressRescheduleNotice(saved),true);assert.equal(saved.import_metadata.reschedule_notice.previous_message_ids[0],sent.id);
  assert.equal(saved.import_metadata.booking.phases.length,1);
  report.checks.push('Actual booking writer and real JSON SQL distinguish same clinic/patient sent notices from failed/event/other-clinic/other-patient traffic; warning HTTP409 preserves exact appointment and occupancy, explicit no-send commits one scoped receipt');
  const next={...input,appointmentValues:{...input.appointmentValues,inicio:'2030-01-09T10:00:00Z',fin:'2030-01-09T10:30:00Z'}};
  await assert.rejects(f.reserve({...next,rescheduleNotice:{actorId:1,decision}}),error=>{warning=error;return error.code==='appointment_notice_already_sent_today';});
  await seed();
  await assert.rejects(f.reserve({...next,rescheduleNotice:{actorId:1,decision:{acknowledgement:warning.details.acknowledgement,send:true}}}),
    error=>{warning=error;return error.code==='appointment_notice_already_sent_today';});
  const confirm={acknowledgement:warning.details.acknowledgement,send:true};
  const send=await f.reserve({...next,rescheduleNotice:{actorId:1,decision:confirm}});assert.equal(suppressRescheduleNotice(send),false);
  const acceptedCount=await db.Message.count();
  await f.reserve({...next,appointmentValues:{...next.appointmentValues,nota:'TESTONLY same-time resource edit'},rescheduleNotice:{actorId:1}});
  assert.equal(await db.Message.count(),acceptedCount);
  report.checks.push('Changed reservation and newly arrived notice invalidate prior acceptance; explicit send commits while keeping patient/room constraints; same-time edit does not prompt or produce messages');
}).catch(error=>{console.error(error);process.exitCode=1;});
