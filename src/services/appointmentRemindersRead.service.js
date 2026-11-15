'use strict';

const { QueryTypes } = require('sequelize');
const { domainError, positiveInteger, boundedText, dateOnly } = require('../lib/patientFollowUps.contract');
const { buildProjection } = require('../lib/appointment-reminders-read-query');
const { localDateTimeToUtc } = require('../lib/availability-calendar');
const STATUSES = Object.freeze(['scheduled','queued','processing','sent','delivered','read','failed','cancelled','blocked','unknown','skipped','unplanned']);
const PENDING = Object.freeze(['scheduled','queued','processing','sent','blocked','failed','unknown','unplanned']);
const SORTS = Object.freeze(['scheduled_at','appointment_start','patient_name','status','created_at']);
const REASONS = Object.freeze({
  unknown: ['delivery_unconfirmed', 'Resultado del envío sin determinar. Requiere revisión técnica.'],
  failed: ['delivery_failed', 'No se pudo completar el envío. Revisa su origen.'],
  cancelled: ['reminder_cancelled', 'La programación se ha cancelado o sustituido.'],
  blocked: ['reminder_blocked', 'El envío está detenido por su estado o por las condiciones de la automatización.'],
  unplanned: ['no_schedule', 'No hay un recordatorio programado registrado para esta cita.'],
  skipped: ['reminder_skipped', 'La automatización decidió no enviar este recordatorio según sus condiciones.'],
});
const SKIPS=Object.freeze({
  appointment_already_confirmed:'La cita ya estaba confirmada; no se envió este recordatorio.',
  appointment_not_confirmed:'La cita no cumplía la condición de confirmación de este recordatorio.',
  template_not_active:'La automatización ya no estaba activa para esta cita.',
  stale_schedule_window:'Esta programación fue sustituida al cambiar su horario o sus reglas.',
  linked_appointment_uses_first_notice:'El aviso corresponde a otra cita vinculada.',
  whatsapp_config_missing:'No hay un WhatsApp configurado y operativo para este envío.',
  whatsapp_appointment_nonoperational_clinic_held:'El envío está retenido por la configuración operativa de la clínica.',
  rate_limited:'El servicio limitó temporalmente el envío. Consulta su estado.',
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
  if (!['all','pending','reception','confirmed',...STATUSES].includes(status) || !SORTS.includes(sort) || !['asc','desc'].includes(direction)) throw domainError(400,'appointment_reminders_invalid_filter','El filtro u orden no es válido.');
  const from=dateOnly(query.date_from,'date_from'), to=dateOnly(query.date_to,'date_to');
  if (from && to && from>to || from>'9998-12-31' || to>'9998-12-31') throw domainError(400,'appointment_reminders_invalid_filter','El intervalo de fechas no es válido.');
  const dateField=query.date_field || 'notice';
  if (!['notice','appointment'].includes(dateField)) throw domainError(400,'appointment_reminders_invalid_filter','El tipo de fecha no es válido.');
  const coverage=query.include_unplanned==='true' || query.include_unplanned===true;
  if (coverage && (!from || !to || (Date.parse(to)-Date.parse(from))/86400000>92)) throw domainError(400,'appointment_reminders_invalid_filter','Para comprobar citas sin aviso elige un intervalo de hasta 93 días.');
  return {page,pageSize,status,sort,direction,q:boundedText(query.q,'q',160) || '',from,to,dateField,coverage,history:query.include_history===undefined || query.include_history==='true' || query.include_history===true};
}
function nextDate(value) { const date=new Date(value+'T12:00:00Z'); date.setUTCDate(date.getUTCDate()+1); return date.toISOString().slice(0,10); }
function iso(value) { if (!value) return null; const date=new Date(value); return Number.isFinite(+date)?date.toISOString():null; }
const number = value => value == null ? null : Number(value);
function object(value) {
  try { if (typeof value==='string') value=JSON.parse(value); } catch { return {}; }
  return value && typeof value==='object' && !Array.isArray(value)?value:{};
}

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
    let filter;
    const clinicRow=await db.Clinica.findByPk(clinicId,{attributes:['id_clinica','grupoClinicaId','configuracion'],raw:true});
    if (!clinicRow) throw domainError(404,'appointment_reminders_clinic_not_found','Clínica no encontrada.');
    const timezone=require('./clinicOpeningHours.service').resolveClinicTimeZone(clinicRow);
    if (query.window && !['today_tomorrow','today','tomorrow','history','custom'].includes(query.window)) throw domainError(400,'appointment_reminders_invalid_filter','El periodo no es válido.');
    if (query.window && query.window!=='custom') {
      const today=require('luxon').DateTime.fromJSDate(now(),{zone:timezone}).toISODate();
      const from=query.window==='tomorrow'?nextDate(today):query.window==='history'?require('luxon').DateTime.fromISO(today).minus({days:30}).toISODate():today;
      const to=query.window==='history'?require('luxon').DateTime.fromISO(today).minus({days:1}).toISODate():query.window==='today'?today:nextDate(today);
      query={...query,date_from:from,date_to:to};
    }
    filter=filters(query);
    const tables=await db.sequelize.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('AppointmentVisitCommunications','AppointmentVisits','ConversationAutomationStates','AutomationInboundMessageClaims','AppointmentReminderSequences')",{type:QueryTypes.SELECT,logging:false});
    const has=name=>tables.some(row=>row.name===name);
    const native=has('AppointmentVisitCommunications') && has('AppointmentVisits');
    const columns=await db.sequelize.query("SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='CitasPacientes' AND COLUMN_NAME='import_metadata'",{type:QueryTypes.SELECT,logging:false});
    const runtime=runtimePolicy || (()=>{const r=require('./jobRequests.service');return {namespaces:[r.getCurrentRuntimeNamespace(),...r.getRuntimeNamespaceAliases()],claimUnscoped:r.shouldClaimUnscopedJobs()};})();
    const replacements={clinic_id:clinicId,actor_id:actorId,now:now(),native_enabled:nativeEnabled()?1:0,claim_unscoped:runtime.claimUnscoped?1:0,runtime_namespaces:runtime.namespaces.length?runtime.namespaces:['__no_runtime__'],timezone,
      limit_appointments:filter.dateField==='appointment'&&(filter.from||filter.to)?1:0,
      appointment_from:filter.from?localDateTimeToUtc(filter.from,'00:00:00',timezone):new Date('1900-01-01'),appointment_to:filter.to?localDateTimeToUtc(nextDate(filter.to),'00:00:00',timezone):new Date('9999-01-01'),
      include_unplanned:filter.coverage?1:0,coverage_from:filter.from?localDateTimeToUtc(filter.from,'00:00:00',timezone):now(),
      coverage_to:filter.to?localDateTimeToUtc(nextDate(filter.to),'00:00:00',timezone):now(),response_since:new Date(+now()-3*86400000)};
    const days=[];
    if (filter.coverage) for(let day=filter.from;day<=filter.to;day=nextDate(day)) days.push({day,
      from:localDateTimeToUtc(day,'00:00:00',timezone).toISOString().slice(0,19).replace('T',' '),
      to:localDateTimeToUtc(nextDate(day),'00:00:00',timezone).toISOString().slice(0,19).replace('T',' ')});
    replacements.clinic_days=JSON.stringify(days);
    const where=[], statusWhere=[];
    if (!filter.history) where.push("status<>'cancelled' AND superseded=0 AND historical_schedule=0");
    if (filter.status==='pending') {statusWhere.push('status IN (:statuses)');replacements.statuses=PENDING;}
    else if (filter.status==='reception') statusWhere.push("attention_status IN ('review','unclaimed')");
    else if (filter.status==='confirmed') statusWhere.push("appointment_status IN ('recordatorio_confirmado','ha_acudido','en_atencion','completada')");
    else if (filter.status!=='all') {statusWhere.push('status = :status');replacements.status=filter.status;}
    if (filter.q) {where.push("(patient_name LIKE :search ESCAPE '=' OR appointment_title LIKE :search ESCAPE '=' OR template_name LIKE :search ESCAPE '=')");replacements.search='%'+filter.q.replace(/[=%_]/g,character=>'='+character)+'%';}
    if (filter.from) {where.push((filter.dateField==='appointment'?'appointment_start':'scheduled_at')+' >= :from');replacements.from=localDateTimeToUtc(filter.from,'00:00:00',timezone);}
    if (filter.to) {where.push((filter.dateField==='appointment'?'appointment_start':'scheduled_at')+' < :to');replacements.to=localDateTimeToUtc(nextDate(filter.to),'00:00:00',timezone);}
    const cte=buildProjection({native,attention:has('ConversationAutomationStates'),claims:has('AutomationInboundMessageClaims'),sequence:has('AppointmentReminderSequences'),appointmentMetadata:columns.length>0});
    const predicate=where.length?' WHERE '+where.join(' AND '):'';
    const pagePredicate=[...where,...statusWhere].length?' WHERE '+[...where,...statusWhere].join(' AND '):'';
    const read = async transaction => {
      const opts={type:QueryTypes.SELECT,replacements,transaction,logging:false};
      const [summary]=await db.sequelize.query(cte+` SELECT /*+ MAX_EXECUTION_TIME(5000) */
        COUNT(*) records,COUNT(DISTINCT patient_id) patients,COUNT(DISTINCT appointment_id) appointments,
        SUM(source_kind<>'appointment') notices,SUM(status='scheduled') scheduled,
        SUM(status IN ('queued','processing','sent')) in_flight,SUM(status IN ('sent','delivered','read')) sent,
        COUNT(DISTINCT CASE WHEN appointment_status IN ('recordatorio_confirmado','ha_acudido','en_atencion','completada') THEN appointment_id END) confirmed,
        COUNT(DISTINCT CASE WHEN attention_status IN ('review','unclaimed') THEN patient_id END) reception,
        SUM(status IN ('failed','unknown','blocked')) errors,SUM(status='unplanned') unplanned,
        SUM(status='unplanned' AND JSON_UNQUOTE(JSON_EXTRACT(import_metadata,'$.notification_suppression.reason'))='manual_selection'
          AND JSON_UNQUOTE(JSON_EXTRACT(import_metadata,'$.notification_suppression.day_before'))='true'
          AND JSON_UNQUOTE(JSON_EXTRACT(import_metadata,'$.notification_suppression.same_day'))='true') suppressed
        FROM classified`+predicate,opts);
      const [count]=await db.sequelize.query(cte+' SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) total FROM classified'+pagePredicate,opts);
      const rows=await db.sequelize.query(cte+' SELECT /*+ MAX_EXECUTION_TIME(5000) */ * FROM classified'+pagePredicate+` ORDER BY (${filter.sort} IS NULL) ASC,${filter.sort} ${filter.direction.toUpperCase()},id ASC LIMIT :limit OFFSET :offset`,{...opts,replacements:{...replacements,limit:filter.pageSize,offset:filter.page*filter.pageSize}});
      const ids=rows.map(row=>Number(row.execution_id)).filter(Boolean);
      const history=ids.length?await db.sequelize.query(cte+` SELECT /*+ MAX_EXECUTION_TIME(5000) */ id,execution_id,status,sent_at,node_id,
        CASE WHEN id IN (SELECT id FROM notice_attempts) THEN 'notice_attempt' ELSE 'follow_up' END kind
        FROM valid_messages WHERE execution_id IN (:execution_ids) ORDER BY id`,{...opts,replacements:{...replacements,execution_ids:ids}}):[];
      const linked=filter.coverage?await db.sequelize.query(cte+` SELECT /*+ MAX_EXECUTION_TIME(5000) */ id_cita,anchor_id,inicio,estado
        FROM appointment_coverage WHERE anchor_id IS NOT NULL AND anchor_id<>id_cita`,opts):[];
      if (filter.coverage && filter.dateField==='appointment') {
        const [covered]=await db.sequelize.query(cte+`, selected AS (SELECT * FROM classified ${predicate}),
          covered AS (SELECT appointment_id id,appointment_status estado FROM selected
            UNION ALL SELECT a.id_cita,a.estado FROM appointment_coverage a
            WHERE EXISTS(SELECT 1 FROM selected r WHERE r.appointment_id=a.anchor_id AND r.patient_id=a.paciente_id))
          SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(DISTINCT id) appointments,
            COUNT(DISTINCT CASE WHEN estado IN ('recordatorio_confirmado','ha_acudido','en_atencion','completada') THEN id END) confirmed FROM covered`,opts);
        summary.appointments=Number(covered?.appointments)||0;summary.confirmed=Number(covered?.confirmed)||0;
      }
      return {count,rows,summary,history,linked};
    };
    let result;
    try { result=await db.sequelize.transaction({readOnly:true,isolationLevel:'REPEATABLE READ'},read); }
    catch(error) {
      if (['ER_QUERY_TIMEOUT','ER_QUERY_INTERRUPTED'].includes(error.original?.code||error.parent?.code)) throw domainError(503,'appointment_reminders_query_busy','La consulta está tardando demasiado. Prueba con un intervalo de fechas más corto.');
      throw error;
    }
    const {count,rows,summary,history,linked}=result;
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
      let reason=REASONS[row.status];
      const suppression=object(row.import_metadata);
      if (row.source_kind==='appointment' && row.status==='skipped') reason=['appointment_inactive','El estado actual de la cita no requiere un recordatorio.'];
      if (row.status==='unplanned' && suppression?.notification_suppression?.reason==='manual_selection'
        && suppression.notification_suppression.day_before===true && suppression.notification_suppression.same_day===true)
        reason=['appointment_notification_suppressed','Los recordatorios de esta cita están desactivados manualmente.'];
      return {id:row.id,source_kind:row.source_kind,clinic_id:clinicId,patient_id:Number(row.patient_id),patient_public_id:row.patient_public_id||null,
        patient_name:row.patient_name,appointment_id:Number(row.appointment_id),appointment_title:row.appointment_title||'Cita',appointment_start:iso(row.appointment_start),appointment_status:row.appointment_status,
        superseded:Number(row.superseded)===1 || Number(row.historical_schedule)===1,original_appointment_start:iso(row.original_start),
        scheduled_at:iso(row.scheduled_at),created_at:iso(row.created_at),stage:['day_before','same_day','week_before'].includes(row.stage)?row.stage:null,
        channel:row.source_kind==='appointment'?null:'whatsapp',status:row.status,sent_at:iso(row.sent_at),template_name:templateInScope?row.template_name||null:null,template_version:templateInScope?number(row.template_version):null,
        source:{job_id:number(row.job_id),communication_id:row.communication_id||null,execution_id:number(row.execution_id),message_id:number(row.message_id),conversation_id:canChat?number(row.conversation_id):null},
        delivery:{message_status:row.message_status||null,job_status:row.job_status||null,execution_status:row.execution_status||null,communication_status:row.communication_status||null},
        reason_code:SKIPS[row.skip_reason]?row.skip_reason:reason?.[0]||null,
        reason:SKIPS[row.skip_reason]?SKIPS[row.skip_reason]:reason?.[1]||null,
        attention:{status:row.attention_status||null,message_id:canChat?number(row.response_message_id):null,
          conversation_id:canChat?number(row.response_conversation_id):null,received_at:iso(row.response_received_at)},
        history:history.filter(h=>Number(h.execution_id)===Number(row.execution_id)).slice(0,20).map(h=>({message_id:Number(h.id),kind:h.kind,status:h.status,sent_at:iso(h.sent_at)})),
        history_total:history.filter(h=>Number(h.execution_id)===Number(row.execution_id)).length,
        linked_appointments:linked.filter(a=>Number(a.anchor_id)===Number(row.appointment_id)).map(a=>({id:Number(a.id_cita),start:iso(a.inicio),status:a.estado})),
        links:{patient:`/pacientes/detalle/${encodeURIComponent(row.patient_public_id||row.patient_id)}/historia-clinica?clinica_id=${clinicId}`,
          appointment:`/agenda-de-citas?clinica_id=${clinicId}&appointment_id=${Number(row.appointment_id)}&action=view`,automation},read_only:true};
    });
    return {items,summary:Object.fromEntries(Object.entries(summary).map(([k,v])=>[k,Number(v)||0])),as_of:iso(now()),date_field:filter.dateField,date_from:filter.from,date_to:filter.to,total:Number(count.total),page:filter.page,page_size:filter.pageSize,timezone,available_sources:{automation:true,visit:native},read_only:true};
  }
  return {list};
}
let singleton;
module.exports={STATUSES,PENDING,SORTS,filters,createAppointmentRemindersReadService,
  list:options=>(singleton || (singleton=createAppointmentRemindersReadService({db:require('../../models')}))).list(options)};
