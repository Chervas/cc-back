#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const C = require('../lib/appointment-notice-recovery');
const { hash } = require('../lib/appointment-single-notice-publication');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
function dates(row, keys) { for (const key of keys) if (row[key]!=null) row[key]=new Date(C.instant(row[key])).toISOString(); return row; }

async function load(query, id) {
  const [a] = await query('SELECT * FROM CitasPacientes WHERE id_cita=?', [id]);
  if (!a) throw Error('notice_recovery_appointment_missing');
  dates(a,['inicio','fin','created_at','updated_at','hold_expires_at','arrived_at','care_started_at','care_schedule_start','care_completed_at']);
  a.import_metadata = json(a.import_metadata);
  const [patient] = await query("SELECT id_paciente,clinica_id,nombre,apellidos,numero_historia,telefono_movil IS NOT NULL AND LENGTH(telefono_movil)>6 AS has_phone,SHA2(COALESCE(telefono_movil,''),256) AS phone_fingerprint FROM Pacientes WHERE id_paciente=?", [a.paciente_id]);
  const events = await query("SELECT id,event_type,occurred_at,metadata FROM PatientOperationalEvents WHERE clinic_id=? AND patient_id=? AND CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.appointment_id')) AS UNSIGNED)=? AND occurred_at>=? ORDER BY id", [a.clinica_id,a.paciente_id,id,new Date(C.incident.from)]);
  events.forEach(e => { e.metadata = json(e.metadata); dates(e,['occurred_at']); });
  const executions = await query("SELECT id,template_version_id,status,trigger_type,created_at,last_error,JSON_EXTRACT(context,'$.__simulation') simulation FROM FlowExecutionsV2 WHERE clinic_id=? AND trigger_entity_type='appointment' AND trigger_entity_id=? ORDER BY id", [a.clinica_id,id]);
  const messages = await query(`SELECT m.id,m.conversation_id,m.direction,m.message_type,m.status,m.content,m.createdAt,m.sent_at,
    JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.source')) source,JSON_EXTRACT(m.metadata,'$.execution_id') execution_id,
    JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.template_name')) template_name,
    JSON_EXTRACT(m.metadata,'$.outcome_unknown') outcome_unknown,JSON_EXTRACT(m.metadata,'$.delivery_unknown') delivery_unknown,
    JSON_EXTRACT(m.metadata,'$.dispatch_wait') dispatch_wait
    FROM Messages m JOIN Conversations c ON c.id=m.conversation_id
    WHERE c.clinic_id=? AND c.patient_id=? AND c.channel='whatsapp' AND m.createdAt>=? ORDER BY m.id`,
  [a.clinica_id,a.paciente_id,new Date(C.incident.from)]);
  const [treatment] = a.tratamiento_id ? await query('SELECT id_tratamiento,appointment_automation_template_key,appointment_automation_template_version,automation_template_bindings FROM Tratamientos WHERE id_tratamiento=?', [a.tratamiento_id]) : [];
  executions.forEach(e=>dates(e,['created_at'])); messages.forEach(m=>dates(m,['createdAt','sent_at']));
  if(treatment)treatment.automation_template_bindings=json(treatment.automation_template_bindings);
  return { appointment: a, patient, events, executions, messages, treatment: treatment || null };
}
async function candidates(query) {
  const rows = await query(`SELECT DISTINCT a.id_cita FROM CitasPacientes a
    WHERE a.clinica_id IN (?) AND (a.created_at BETWEEN ? AND ? OR
      (a.estado='reprogramada' AND a.reschedule_reason IS NOT NULL AND a.updated_at BETWEEN ? AND ?) OR a.id_cita IN (
      SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.appointment_id')) AS UNSIGNED) FROM PatientOperationalEvents
      WHERE occurred_at BETWEEN ? AND ? AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.route'))='reagendarCita')) ORDER BY a.id_cita`,
  [C.incident.clinics,new Date(C.incident.from),new Date(C.incident.until),new Date(C.incident.from),new Date(C.incident.until),new Date(C.incident.from),new Date(C.incident.until)]);
  return rows.map(r => Number(r.id_cita));
}
async function main(args) {
  const [mode, dir, expectedHash] = args;
  if (!['plan','apply','status'].includes(mode) || !dir?.startsWith('/home/ubuntu/secure-imports/')
    || fs.realpathSync(dir)!==dir || fs.statSync(dir).mode&0o077
    || new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Madrid'}).format(new Date())!=='2026-10-20') throw Error('notice_recovery_arguments_invalid');
  const planPath = path.join(dir,'notice-plan.json'), approvalsPath = path.join(dir,'approvals.json');
  const journal = value => fs.appendFileSync(path.join(dir,'recovery.jsonl'),JSON.stringify({at:new Date().toISOString(),...value})+'\n',{mode:0o600});
  if (mode === 'plan') {
    const c = await connectOperatorDatabase('crm');
    try {
      await c.query('SET TRANSACTION READ ONLY'); await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
      const query = async (q,v) => (await c.query(q,v))[0];
      const items=[];
      for (const id of await candidates(query)) { const snapshot=await load(query,id),assessment=C.assess(snapshot);
        items.push({appointmentId:id,clinicId:snapshot.appointment.clinica_id,patient:snapshot.patient,
          ...assessment,snapshot}); }
      const plan={version:1,purpose:'explicit_omitted_appointment_notices_20261020',at:new Date().toISOString(),items};
      fs.writeFileSync(planPath,JSON.stringify(plan,null,2),{mode:0o600,flag:'wx'});
      return {mode,cases:items.length,eligible:items.filter(i=>i.eligible).length,review:items.filter(i=>i.eligible&&i.reviewRequired).length,sha256:hash(plan)};
    } finally {await c.rollback();await c.end();}
  }
  const plan=json(fs.readFileSync(planPath,'utf8'));
  if (plan.version!==1 || plan.purpose!=='explicit_omitted_appointment_notices_20261020' || hash(plan)!==expectedHash) throw Error('notice_recovery_plan_invalid');
  if (mode==='status') {
    const c=await connectOperatorDatabase('crm');try{
      await c.query('START TRANSACTION READ ONLY');
      const receipts=fs.readFileSync(path.join(dir,'recovery.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.executionId);
      const ids=[...new Set(receipts.map(r=>Number(r.executionId)))];
      const [rows]=ids.length?await c.query(`SELECT e.id,e.clinic_id,e.trigger_entity_id,e.status,e.last_error,
        m.id AS message_id,m.message_type,m.status AS message_status,
        JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.error')) message_error
        FROM FlowExecutionsV2 e LEFT JOIN Messages m ON CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.execution_id')) AS UNSIGNED)=e.id
        AND m.direction='outbound' AND m.message_type<>'event' WHERE e.id IN (?) ORDER BY e.id,m.id`,[ids]):[[]];
      fs.writeFileSync(path.join(dir,'status-'+Date.now()+'.json'),JSON.stringify(rows,null,2),{mode:0o600,flag:'wx'});
      return {mode,rows};
    }finally{await c.rollback();await c.end();}
  }
  if (Date.now()-Date.parse(plan.at)>3600000) throw Error('notice_recovery_plan_expired');
  const approvals=json(fs.readFileSync(approvalsPath,'utf8'));
  if (approvals.planHash!==expectedHash || approvals.approvedBy!==44 || approvals.items.length!==plan.items.length
    || new Set(approvals.items.map(i=>i.appointmentId)).size!==plan.items.length) throw Error('notice_recovery_approvals_invalid');
  const observed=require('./security-email-login-metadata').observedEnvironment('staging');
  if (observed.root!==path.resolve(__dirname,'../..')) throw Error('notice_recovery_staging_checkout_required');
  require('../lib/whatsappBrokerClient').assertStaging(observed.env);
  Object.assign(process.env,observed.env,{JOBS_CRON_LEADER:'false'});process.chdir(observed.root);
  // Enqueue on the existing CRM scheduler, never start a second executor here.
  require('../services/jobScheduler.service').setExternalDispatcher(async()=>false);
  const db=require('../../models'),runtime=require('../services/appointmentAutomationV2Runtime.service');
  const loader=(id,transaction)=>load(async(q,v)=>(await db.sequelize.query(q,{replacements:v,transaction}))[0],id);
  const results=[];
  for (const item of plan.items) {
    const approval=approvals.items.find(i=>i.appointmentId===item.appointmentId);
    if (!approval || !['send','skip'].includes(approval.decision) || !approval.reason) throw Error('notice_recovery_case_not_reviewed');
    if (approval.decision==='skip') {journal({appointmentId:item.appointmentId,stage:'reviewed_skip',reason:approval.reason});continue;}
    if (!item.eligible || approval.evidenceHash!==item.evidenceHash) throw Error('notice_recovery_case_not_eligible');
    const approved={...item,approved:true,eventName:item.source.type};
    journal({appointmentId:item.appointmentId,stage:'native_enqueue_requested',evidenceHash:item.evidenceHash});
    try {const result=await C.recoverOne({db,runtime,item:approved,load:loader,actorId:44});
      const receipt={appointmentId:item.appointmentId,clinicId:item.clinicId,success:result.success,skipped:!!result.skipped,
        reason:result.reason||null,executionId:result.execution?.id||null,queueJobId:result.queue_job_id||null,deduplicated:!!result.deduplicated};
      journal(receipt);results.push(receipt);
    } catch(error) {const receipt={appointmentId:item.appointmentId,skipped:true,reason:/^[a-z_]+$/.test(error.message)?error.message:'notice_recovery_requires_review'};journal(receipt);results.push(receipt);}
  }
  return {mode,results};
}
if (require.main===module) {
  const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
  console.log=console.warn=console.error=()=>{};
  main(process.argv.slice(2)).then(output).catch(e=>{output({error:/^[a-z_]+$/.test(e.message)?e.message:'notice_recovery_failed'});process.exitCode=1;})
    .finally(async()=>{const m=require.cache[require.resolve('../../models')];if(m)await m.exports.sequelize.close();
      const q=require.cache[require.resolve('../services/queue.service')];if(q)await Promise.all(Object.values(q.exports.queues||{}).map(queue=>queue.disconnect()));});
}
module.exports={main,load,candidates};
