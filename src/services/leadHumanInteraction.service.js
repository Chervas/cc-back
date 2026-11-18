'use strict';

const { Op, QueryTypes } = require('sequelize');
const { resolveClinicTimezone } = require('../lib/availability-calendar');
const { TEMPORARY_FOCUSED_ACCOUNT, TEMPORARY_DIRECTOR_CLINICS } = require('../lib/temporary-quickchat-focus');
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const date = value => {
  if (value instanceof Date) return value;
  return new Date(typeof value === 'string' && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value.replace(' ', 'T') + 'Z' : value);
};

// Management starts with the first evidenced human action, even an unanswered
// attempt. Responsibility/assignment and automatic confirmations are separate.
function orderedInteractions(lead, candidates, now) {
  if (lead.privacy_redacted) return [];
  const start = date(lead.created_at);
  return candidates.filter(row => Number(row.lead_id) === Number(lead.id) && positive(row.user_id)
    && Number.isFinite(+date(row.occurred_at)) && date(row.occurred_at) <= now
    && (!Number.isFinite(+start) || date(row.occurred_at) >= start)
    && !/auto(?:mation|_reply)|^system|^ai(?:_|$)/i.test(String(row.reason || '')))
    .sort((a, b) => +date(a.occurred_at) - +date(b.occurred_at)
      || Number(a.source_id || 0) - Number(b.source_id || 0));
}
function selectFirstInteraction(lead, candidates, now = new Date()) {
  return orderedInteractions(lead, candidates, now)[0] || null;
}
function selectLatestInteraction(lead, candidates, now = new Date()) {
  return orderedInteractions(lead, candidates, now).at(-1) || null;
}

const jsonValue = (alias, path) => `COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${alias}, '$.${path}')), '')`;
// Each source returns both ends of its complete, scoped history. Picking only
// its latest row would irretrievably lose the person who began management.
function endpointsSql(select) {
  return `SELECT * FROM (
    SELECT candidates.*,
      ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY occurred_at ASC, source_id ASC) AS first_position,
      ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY occurred_at DESC, source_id DESC) AS last_position
    FROM (${select}) candidates
  ) ranked WHERE first_position = 1 OR last_position = 1`;
}

async function loadHumanInteraction({ models, leads, now = new Date() }) {
  const rows = leads.filter(lead => !lead.privacy_redacted && positive(lead.id) && positive(lead.clinica_id));
  if (!rows.length) return leads.map(lead => ({ ...lead, first_human_interaction: null, last_human_interaction: null }));
  const replacements = { leadIds: rows.map(lead => Number(lead.id)), clinicIds: [...new Set(rows.map(lead => Number(lead.clinica_id)))], now };
  const attemptsSql = endpointsSql(`SELECT a.lead_intake_id AS lead_id, a.usuario_id AS user_id, a.created_at AS occurred_at,
      a.canal AS channel, a.motivo AS reason, a.id AS source_id, 'contact_attempt' AS kind, NULL AS outcome
    FROM LeadContactAttempts a JOIN LeadIntakes l ON l.id = a.lead_intake_id
    WHERE l.id IN (:leadIds) AND l.clinica_id IN (:clinicIds) AND a.usuario_id > 0
      AND a.created_at >= l.created_at AND a.created_at <= :now
      AND COALESCE(a.motivo, '') NOT REGEXP 'auto(mation|_reply)|^system|^ai(_|$)'`);
  const metadata = path => jsonValue('m.metadata', path);
  const messageSql = endpointsSql(`SELECT l.id AS lead_id, m.sender_id AS user_id, COALESCE(m.sent_at,m.createdAt) AS occurred_at,
      c.channel AS channel, m.id AS source_id, 'message' AS kind, '' AS reason, 'sent' AS outcome
    FROM LeadIntakes l JOIN Conversations c ON c.lead_id = l.id AND c.clinic_id = l.clinica_id
      JOIN Messages m ON m.conversation_id = c.id
    WHERE l.id IN (:leadIds) AND l.clinica_id IN (:clinicIds) AND m.sender_id > 0
      AND c.channel <> 'internal' AND m.direction = 'outbound' AND m.message_type <> 'event'
      AND m.status IN ('sent','delivered','read') AND COALESCE(m.automation_delivery_key,'') = ''
      AND COALESCE(m.sent_at,m.createdAt) >= l.created_at AND COALESCE(m.sent_at,m.createdAt) <= :now
      AND ${metadata('source')} NOT REGEXP 'automation|auto_reply|^ai(_|$)'
      AND ${metadata('origin')} NOT REGEXP 'automation|auto_reply|^ai(_|$)'
      AND ${metadata('source_event')} NOT REGEXP 'automation|auto_reply|away|greeting'
      AND ${metadata('coexistence.source_event')} NOT REGEXP 'automation|auto_reply|away|greeting'
      AND ${metadata('kind')} NOT REGEXP 'automation|auto_reply'
      AND ${metadata('coexistence.kind')} NOT REGEXP 'automation|auto_reply'
      AND ${metadata('raw_type')} NOT REGEXP 'auto_reply|away|greeting'
      AND ${metadata('lead_intake_id')} IN ('','null',CAST(l.id AS CHAR))
      AND ${metadata('lead_id')} IN ('','null',CAST(l.id AS CHAR))
      AND ${metadata('ad_sharing.lead_id')} IN ('','null',CAST(l.id AS CHAR))
      AND ${['ai_generated','generated_by_ai','is_automated','is_automation'].map(key => `${metadata(key)} NOT IN ('true','1')`).join(' AND ')}
      AND ${['execution_id','node_id','flow_execution_id','automation_flow_id','automation_delivery_key',
        'bulk_send_job_id','marketing_bulk_job_id','campaign_id'].map(key => `${metadata(key)} IN ('','null')`).join(' AND ')}
      AND ${metadata('qa_cleanup')} <> 'true' AND ${metadata('hide_from_quickchat')} <> 'true'`);
  const appointmentMetadata = path => jsonValue('a.import_metadata', path);
  // Native booking creation records the authenticated actor and creation time.
  // Never use updated_by/updated_at: confirmations retain the original actor.
  // Imported/generated bookings are not evidence of a human booking action.
  const appointmentsSql = endpointsSql(`SELECT l.id AS lead_id, a.created_by AS user_id, a.created_at AS occurred_at,
      'agenda' AS channel, a.id_cita AS source_id, 'appointment' AS kind, '' AS reason, 'scheduled' AS outcome
    FROM CitasPacientes a JOIN LeadIntakes l ON l.id = a.lead_intake_id AND l.clinica_id = a.clinica_id
    WHERE l.id IN (:leadIds) AND l.clinica_id IN (:clinicIds) AND a.created_by > 0
      AND a.created_at >= l.created_at AND a.created_at <= :now
      AND LOWER(COALESCE(a.source_system,'')) IN ('','clinicaclick','agenda','manual','lead_resolution_historical')
      AND ${['source','origin','source_system','source_kind'].map(key => `${appointmentMetadata(key)} NOT REGEXP 'automation|auto_reply|^ai(_|$)|^system|import|cliniccloud|gesden'`).join(' AND ')}
      AND ${['is_automated','is_automation','ai_generated','generated_by_ai','imported'].map(key => `${appointmentMetadata(key)} NOT IN ('true','1')`).join(' AND ')}
      AND ${['execution_id','flow_execution_id','automation_flow_id','node_id','automation_delivery_key'].map(key => `${appointmentMetadata(key)} IN ('','null')`).join(' AND ')}`);
  const action = jsonValue('a.attribution_steps', 'action');
  const attention = path => jsonValue('a.attribution_steps', `lead_patient_attention_v1.${path}`);
  const status = jsonValue('a.raw_payload', 'status_lead');
  const manualStatus = `${action} = 'status_update' AND ${jsonValue('a.attribution_steps', 'userId')} REGEXP '^[1-9][0-9]*$'
      AND ${status} IN ('nuevo','contactado','esperando_info','info_recibida','cualificado','citado','acudio_cita','convertido','descartado')
      AND ${status} <> ${jsonValue('a.attribution_steps', 'previous_status')}`;
  const manualDecision = `${jsonValue('a.attribution_steps', 'type')} = 'lead_patient_attention_v1'
      AND ${attention('version')} = '1' AND ${attention('decision')} IN ('director','clinic')
      AND ${attention('request_kind')} IN ('commercial','patient_care')
      AND ${attention('actor_user_id')} REGEXP '^[1-9][0-9]*$' AND ${attention('clinic_id')} = CAST(l.clinica_id AS CHAR)`;
  const callOutcome = jsonValue('a.raw_payload', 'outcome');
  const manualCall = `${action} = 'call_outcome' AND ${jsonValue('a.attribution_steps', 'userId')} REGEXP '^[1-9][0-9]*$'
      AND ${callOutcome} IN ('citado','informacion','no_contactado')
      AND ${jsonValue('a.attribution_steps', 'clinic_id')} IN ('','null',CAST(l.clinica_id AS CHAR))`;
  // These audit shapes are written by the authenticated manual endpoints.
  // Assignment-only changes and automatic lifecycle updates do not qualify.
  const actionsSql = endpointsSql(`SELECT l.id AS lead_id,
      CAST(CASE WHEN ${action} IN ('status_update','call_outcome') THEN ${jsonValue('a.attribution_steps', 'userId')}
        ELSE ${attention('actor_user_id')} END AS UNSIGNED) AS user_id,
      a.created_at AS occurred_at, CASE WHEN ${action} = 'call_outcome' THEN 'llamada' ELSE 'gestion' END AS channel,
      a.id AS source_id, CASE WHEN ${action} = 'call_outcome' THEN 'contact_attempt' ELSE 'lead_action' END AS kind, '' AS reason,
      CASE WHEN ${action} = 'call_outcome' AND ${callOutcome} = 'no_contactado' THEN 'no_answer'
        WHEN ${action} = 'call_outcome' THEN 'registered'
        WHEN ${action} = 'status_update' AND ${status} = 'descartado' THEN 'discarded'
        WHEN ${jsonValue('a.attribution_steps', 'type')} = 'lead_patient_attention_v1' AND ${attention('decision')} = 'director' THEN 'claimed'
        ELSE 'updated' END AS outcome
    FROM LeadAttributionAudits a JOIN LeadIntakes l ON l.id = a.lead_intake_id
    WHERE l.id IN (:leadIds) AND l.clinica_id IN (:clinicIds)
      AND a.created_at >= l.created_at AND a.created_at <= :now
      AND ((${manualStatus}) OR (${manualDecision}) OR (${manualCall}))
      AND ${['source','origin','kind','source_event'].map(key => `${jsonValue('a.attribution_steps', key)} NOT REGEXP 'automation|auto_reply|^system|^ai(_|$)'`).join(' AND ')}
      AND ${['is_automated','is_automation','ai_generated','generated_by_ai'].map(key => `${jsonValue('a.attribution_steps', key)} NOT IN ('true','1')`).join(' AND ')}
      AND ${['execution_id','flow_execution_id','automation_flow_id','node_id'].map(key => `${jsonValue('a.attribution_steps', key)} IN ('','null')`).join(' AND ')}`);
  const sources = await Promise.all([attemptsSql, messageSql, appointmentsSql, actionsSql]
    .map(sql => models.sequelize.query(sql, { replacements, type: QueryTypes.SELECT })));
  const candidates = sources.flat();
  for (const lead of rows) {
    for (const item of Array.isArray(lead.historial_contactos) ? lead.historial_contactos : []) {
      if (item) candidates.push({ lead_id: lead.id, user_id: item.usuario_id, occurred_at: item.fecha,
        channel: item.canal || 'llamada', reason: item.motivo, kind: 'contact_attempt', source_id: 0 });
    }
  }
  const endpoints = new Map(rows.map(lead => [Number(lead.id), {
    first: selectFirstInteraction(lead, candidates, now), last: selectLatestInteraction(lead, candidates, now),
  }]));
  const userIds = [...new Set([...endpoints.values()].flatMap(value => [value.first, value.last])
    .filter(Boolean).map(row => Number(row.user_id)))];
  const [users, settings, clinics] = await Promise.all([
    userIds.length ? models.Usuario.findAll({ where: { id_usuario: { [Op.in]: userIds } },
      attributes: ['id_usuario', 'nombre', 'apellidos'], raw: true }) : [],
    models.PatientDirectionSetting ? models.PatientDirectionSetting.findAll({ where: {
      clinic_id: { [Op.in]: replacements.clinicIds }, is_enabled: true,
    }, attributes: ['clinic_id', 'director_user_id'], raw: true }) : [],
    models.Clinica ? models.Clinica.findAll({ where: { id_clinica: { [Op.in]: replacements.clinicIds } },
      attributes: ['id_clinica', 'configuracion'], raw: true }) : [],
  ]);
  const byUser = new Map(users.map(user => [Number(user.id_usuario), user]));
  const directors = new Map(settings.map(setting => [Number(setting.clinic_id), Number(setting.director_user_id)]));
  const zones = new Map(clinics.map(clinic => [Number(clinic.id_clinica), resolveClinicTimezone(clinic)]));
  for (const clinicId of TEMPORARY_DIRECTOR_CLINICS) if (!directors.has(clinicId)) directors.set(clinicId, TEMPORARY_FOCUSED_ACCOUNT.userId);
  function dto(item, lead) {
    const user = item && byUser.get(Number(item.user_id));
    const name = user && [user.nombre, user.apellidos].filter(Boolean).join(' ').trim();
    if (!item || !name) return null;
    return { user_id: Number(item.user_id), user_name: name, occurred_at: date(item.occurred_at).toISOString(),
      time_zone: zones.get(Number(lead.clinica_id)) || 'Europe/Madrid', channel: item.channel, kind: item.kind,
      outcome: item.outcome || (item.kind === 'message' ? 'sent'
        : ['no_contesta','no_contactado','sin_respuesta'].includes(String(item.reason || '').trim().toLowerCase()) ? 'no_answer' : 'registered'),
      is_patient_director: directors.get(Number(lead.clinica_id)) === Number(item.user_id) };
  }
  return leads.map(lead => {
    const value = !lead.privacy_redacted && endpoints.get(Number(lead.id));
    return { ...lead, first_human_interaction: dto(value?.first, lead), last_human_interaction: dto(value?.last, lead) };
  });
}

async function enrichHumanInteraction(options) {
  try {
    const rows = await loadHumanInteraction(options);
    return rows.map(lead => ({ ...lead, human_interaction_status: 'available' }));
  } catch (error) {
    const code = error?.original?.code || error?.code;
    const known = new Set(['ER_BAD_FIELD_ERROR','ER_NO_SUCH_TABLE','ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT','ECONNREFUSED','ETIMEDOUT']);
    (options.logger || console).warn('lead_human_interaction_summary_unavailable', { code: known.has(code) ? code : 'summary_error' });
    return options.leads.map(lead => ({ ...lead, first_human_interaction: null, last_human_interaction: null, human_interaction_status: 'unavailable' }));
  }
}

module.exports = { enrichHumanInteraction, selectFirstInteraction, selectLatestInteraction };
