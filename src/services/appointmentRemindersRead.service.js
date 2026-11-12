'use strict';

const { QueryTypes } = require('sequelize');
const { domainError, positiveInteger, boundedText, dateOnly } = require('../lib/patientFollowUps.contract');
const { buildProjection } = require('../lib/appointment-reminders-read-query');
const { localDateTimeToUtc } = require('../lib/availability-calendar');
const STATUSES = Object.freeze(['scheduled','queued','processing','sent','delivered','read','failed','cancelled','blocked','unknown','skipped']);
const PENDING = Object.freeze(['scheduled','queued','processing','blocked','failed','unknown']);
const SORTS = Object.freeze(['scheduled_at','appointment_start','patient_name','status','created_at']);
const REASONS = Object.freeze({
  unknown: ['delivery_unconfirmed', 'Pendiente de comprobar: no hay una entrega acreditada.'],
  failed: ['delivery_failed', 'No se pudo completar el envío. Revisa su origen.'],
  cancelled: ['reminder_cancelled', 'La programación se ha cancelado o sustituido.'],
  blocked: ['reminder_blocked', 'El envío está detenido por su estado o por las condiciones de la automatización.'],
  skipped: ['reminder_skipped', 'La automatización decidió no enviar este recordatorio según sus condiciones.'],
});
const SKIPS=Object.freeze({
  appointment_already_confirmed:'La cita ya estaba confirmada; no se envió este recordatorio.',
  appointment_not_confirmed:'La cita no cumplía la condición de confirmación de este recordatorio.',
  template_not_active:'La automatización ya no estaba activa para esta cita.',
  stale_schedule_window:'Esta programación fue sustituida al cambiar su horario o sus reglas.',
  patient_day_uses_first_arrival:'El aviso de este paciente corresponde a su primera cita del día.',
  patient_day_reminder_already_owned:'Ya existe el aviso correspondiente a este paciente y día.',
  appointment_notification_suppressed:'Las comunicaciones de esta cita están desactivadas.',
  imported_historical_appointment:'La actividad histórica importada no genera avisos al paciente.',
});

function filters(query = {}) {
  const integer = (value, fallback, max) => {
    if (value == null || value === '') return fallback;
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)>max) throw domainError(400,'appointment_reminders_invalid_page','La paginación no es válida.');
    return Number(value);
  };
  const page=integer(query.page,0,100000), pageSize=integer(query.page_size,25,100);
  if (!pageSize) throw domainError(400,'appointment_reminders_invalid_page','El tamaño de página no es válido.');
  const status=query.status || 'pending', sort=query.sort || 'scheduled_at', direction=String(query.direction || 'asc').toLowerCase();
  if (!['all','pending',...STATUSES].includes(status) || !SORTS.includes(sort) || !['asc','desc'].includes(direction)) throw domainError(400,'appointment_reminders_invalid_filter','El filtro u orden no es válido.');
  const from=dateOnly(query.date_from,'date_from'), to=dateOnly(query.date_to,'date_to');
  if (from && to && from>to || from>'9998-12-31' || to>'9998-12-31') throw domainError(400,'appointment_reminders_invalid_filter','El intervalo de fechas no es válido.');
  return {page,pageSize,status,sort,direction,q:boundedText(query.q,'q',160) || '',from,to};
}
function nextDate(value) { const date=new Date(value+'T12:00:00Z'); date.setUTCDate(date.getUTCDate()+1); return date.toISOString().slice(0,10); }
function iso(value) { if (!value) return null; const date=new Date(value); return Number.isFinite(+date)?date.toISOString():null; }
const number = value => value == null ? null : Number(value);

function createAppointmentRemindersReadService({ db, canAccess, now=()=>new Date(), runtimePolicy=null,
  nativeEnabled=()=>process.env.APPOINTMENT_VISIT_COMMUNICATIONS_V1_ENABLED==='true',
  adminIds=()=>String(process.env.ADMIN_USER_IDS || '1,44').split(',').map(Number) } = {}) {
  async function authorize(actorId,clinicId) {
    if (!canAccess) canAccess=(...args)=>require('../lib/access-policy').canUserAccessFeature(...args);
    const checks=await Promise.all(['appointments.view','patients.view','patients.sensitive.view'].map(featureKey=>canAccess({actorId,clinicId,featureKey})));
    if (checks.some(allowed=>!allowed)) throw domainError(403,'access_policy_forbidden','No tienes permisos para ver los recordatorios de esta clínica.');
  }
  async function list({actorId:actor,clinicId:clinic,query={}}) {
    const actorId=positiveInteger(actor,'actor_id'),clinicId=positiveInteger(clinic,'clinic_id');
    await authorize(actorId,clinicId);
    const filter=filters(query);
    const clinicRow=await db.Clinica.findByPk(clinicId,{attributes:['id_clinica','grupoClinicaId','configuracion'],raw:true});
    if (!clinicRow) throw domainError(404,'appointment_reminders_clinic_not_found','Clínica no encontrada.');
    const timezone=require('./clinicOpeningHours.service').resolveClinicTimeZone(clinicRow);
    const tables=await db.sequelize.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('AppointmentVisitCommunications','AppointmentVisits')",{type:QueryTypes.SELECT,logging:false});
    const native=tables.length===2;
    const runtime=runtimePolicy || (()=>{const r=require('./jobRequests.service');return {namespaces:[r.getCurrentRuntimeNamespace(),...r.getRuntimeNamespaceAliases()],claimUnscoped:r.shouldClaimUnscopedJobs()};})();
    const replacements={clinic_id:clinicId,now:now(),native_enabled:nativeEnabled()?1:0,claim_unscoped:runtime.claimUnscoped?1:0,runtime_namespaces:runtime.namespaces.length?runtime.namespaces:['__no_runtime__']};
    const where=[];
    if (filter.status==='pending') {where.push('status IN (:statuses)');replacements.statuses=PENDING;}
    else if (filter.status!=='all') {where.push('status = :status');replacements.status=filter.status;}
    if (filter.q) {where.push("(patient_name LIKE :search ESCAPE '=' OR appointment_title LIKE :search ESCAPE '=' OR template_name LIKE :search ESCAPE '=')");replacements.search='%'+filter.q.replace(/[=%_]/g,character=>'='+character)+'%';}
    if (filter.from) {where.push('scheduled_at >= :from');replacements.from=localDateTimeToUtc(filter.from,'00:00:00',timezone);}
    if (filter.to) {where.push('scheduled_at < :to');replacements.to=localDateTimeToUtc(nextDate(filter.to),'00:00:00',timezone);}
    const cte=buildProjection({native}), predicate=where.length?' WHERE '+where.join(' AND '):'';
    const read = async transaction => {
      const opts={type:QueryTypes.SELECT,replacements,transaction,logging:false};
      const [count]=await db.sequelize.query(cte+' SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) total FROM classified'+predicate,opts);
      const rows=await db.sequelize.query(cte+' SELECT /*+ MAX_EXECUTION_TIME(5000) */ * FROM classified'+predicate+` ORDER BY (${filter.sort} IS NULL) ASC,${filter.sort} ${filter.direction.toUpperCase()},id ASC LIMIT :limit OFFSET :offset`,{...opts,replacements:{...replacements,limit:filter.pageSize,offset:filter.page*filter.pageSize}});
      return {count,rows};
    };
    let result;
    try { result=await db.sequelize.transaction({readOnly:true,isolationLevel:'REPEATABLE READ'},read); }
    catch(error) {
      if (['ER_QUERY_TIMEOUT','ER_QUERY_INTERRUPTED'].includes(error.original?.code||error.parent?.code)) throw domainError(503,'appointment_reminders_query_busy','La consulta está tardando demasiado. Prueba con un intervalo de fechas más corto.');
      throw error;
    }
    const {count,rows}=result;
    // A revocation during the query must not turn an earlier check into a stale
    // permission grant. No content is returned before this final projection gate.
    await authorize(actorId,clinicId);
    const [canChat,canMarketing,membership]=await Promise.all([
      ...['quickchat.read_patients','marketing'].map(featureKey=>canAccess({actorId,clinicId,featureKey})),
      db.UsuarioClinica?.findOne({where:{id_usuario:actorId,id_clinica:clinicId,estado_invitacion:'aceptada'},attributes:['rol_clinica'],raw:true}),
    ]);
    const templateAccess=canMarketing && (adminIds().includes(actorId) || ['propietario','personaldeclinica','administrador','admin'].includes(String(membership?.rol_clinica||'').toLowerCase()));
    const items=rows.map(row=>{
      const templateInScope=Number(row.template_is_system)===1 || Number(row.template_clinic_id)===clinicId
        || !!row.template_group_id && Number(row.template_group_id)===Number(clinicRow.grupoClinicaId)
        || !row.template_clinic_id && !row.template_group_id && Number(row.template_created_by)===actorId;
      const automation=templateAccess && templateInScope && row.template_public_id && row.template_version
        ? `/marketing/automatizaciones/${encodeURIComponent(row.template_public_id)}/${String(row.template_name||'automatizacion').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'automatizacion'}/v/${Number(row.template_version)}?clinica_id=${clinicId}` : null;
      const reason=REASONS[row.status];
      return {id:row.id,source_kind:row.source_kind,clinic_id:clinicId,patient_id:Number(row.patient_id),patient_public_id:row.patient_public_id||null,
        patient_name:row.patient_name,appointment_id:Number(row.appointment_id),appointment_title:row.appointment_title||'Cita',appointment_start:iso(row.appointment_start),appointment_status:row.appointment_status,
        scheduled_at:iso(row.scheduled_at),created_at:iso(row.created_at),stage:['day_before','same_day','week_before'].includes(row.stage)?row.stage:null,
        channel:row.message_id?'whatsapp':null,status:row.status,sent_at:iso(row.sent_at),template_name:row.template_name||null,template_version:number(row.template_version),
        source:{job_id:number(row.job_id),communication_id:row.communication_id||null,execution_id:number(row.execution_id),message_id:number(row.message_id),conversation_id:canChat?number(row.conversation_id):null},
        delivery:{message_status:row.message_status||null,job_status:row.job_status||null,execution_status:row.execution_status||null,communication_status:row.communication_status||null},
        reason_code:row.status==='skipped'&&SKIPS[row.skip_reason]?row.skip_reason:reason?.[0]||null,
        reason:row.status==='skipped'&&SKIPS[row.skip_reason]?SKIPS[row.skip_reason]:reason?.[1]||null,
        links:{patient:`/pacientes/detalle/${encodeURIComponent(row.patient_public_id||row.patient_id)}/historia-clinica?clinica_id=${clinicId}`,
          appointment:`/agenda-de-citas?clinica_id=${clinicId}&appointment_id=${Number(row.appointment_id)}&action=view`,automation},read_only:true};
    });
    return {items,total:Number(count.total),page:filter.page,page_size:filter.pageSize,timezone,available_sources:{automation:true,visit:native},read_only:true};
  }
  return {list};
}
let singleton;
module.exports={STATUSES,PENDING,SORTS,filters,createAppointmentRemindersReadService,
  list:options=>(singleton || (singleton=createAppointmentRemindersReadService({db:require('../../models')}))).list(options)};
