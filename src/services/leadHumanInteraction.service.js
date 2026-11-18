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

// A recorded attempt is evidence of human work, never evidence that the patient
// answered. Assignments, appointment authors and inbound messages are not work
// carried out by that actor on this request.
function selectLatestInteraction(lead, candidates, now = new Date()) {
  const start = date(lead.created_at);
  return candidates.filter(row => Number(row.lead_id) === Number(lead.id) && positive(row.user_id)
    && Number.isFinite(+date(row.occurred_at)) && date(row.occurred_at) <= now
    && (!Number.isFinite(+start) || date(row.occurred_at) >= start)
    && !/auto(?:mation|_reply)|^system|^ai(?:_|$)/i.test(String(row.reason || '')))
    .sort((a, b) => +date(b.occurred_at) - +date(a.occurred_at)
      || Number(b.source_id || 0) - Number(a.source_id || 0))[0] || null;
}

async function loadHumanInteraction({ models, leads, now = new Date() }) {
  const rows = leads.filter(lead => !lead.privacy_redacted && positive(lead.id) && positive(lead.clinica_id));
  if (!rows.length) return leads.map(lead => ({ ...lead, last_human_interaction: null }));
  const replacements = { leadIds: rows.map(lead => Number(lead.id)), clinicIds: [...new Set(rows.map(lead => Number(lead.clinica_id)))], now };
  // Both queries rank the complete history in SQL and return at most one item
  // per lead. The join binds conversation ownership and clinic, never a phone.
  const attemptsSql = `SELECT * FROM (
    SELECT a.lead_intake_id AS lead_id, a.usuario_id AS user_id, a.created_at AS occurred_at,
      a.canal AS channel, a.motivo AS reason, a.id AS source_id, 'contact_attempt' AS kind,
      ROW_NUMBER() OVER (PARTITION BY a.lead_intake_id ORDER BY a.created_at DESC, a.id DESC) AS position
    FROM LeadContactAttempts a JOIN LeadIntakes l ON l.id = a.lead_intake_id
    WHERE l.id IN (:leadIds) AND l.clinica_id IN (:clinicIds) AND a.usuario_id > 0
      AND a.created_at >= l.created_at AND a.created_at <= :now
      AND COALESCE(a.motivo, '') NOT REGEXP 'auto(mation|_reply)|^system|^ai(_|$)'
  ) ranked WHERE position = 1`;
  const metadata = path => `COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.${path}')), '')`;
  const messageSql = `SELECT * FROM (
    SELECT l.id AS lead_id, m.sender_id AS user_id, COALESCE(m.sent_at,m.createdAt) AS occurred_at,
      c.channel AS channel, m.id AS source_id, 'message' AS kind, '' AS reason,
      ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY COALESCE(m.sent_at,m.createdAt) DESC, m.id DESC) AS position
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
      AND ${['ai_generated','generated_by_ai','is_automated','is_automation'].map(key => `${metadata(key)} NOT IN ('true','1')`).join(' AND ')}
      AND ${['execution_id','node_id','flow_execution_id','automation_flow_id','automation_delivery_key',
        'bulk_send_job_id','marketing_bulk_job_id','campaign_id'].map(key => `${metadata(key)} IN ('','null')`).join(' AND ')}
      AND ${metadata('qa_cleanup')} <> 'true' AND ${metadata('hide_from_quickchat')} <> 'true'
  ) ranked WHERE position = 1`;
  const [attempts, messages] = await Promise.all([
    models.sequelize.query(attemptsSql, { replacements, type: QueryTypes.SELECT }),
    models.sequelize.query(messageSql, { replacements, type: QueryTypes.SELECT }),
  ]);
  const candidates = [...attempts, ...messages];
  for (const lead of rows) {
    for (const item of Array.isArray(lead.historial_contactos) ? lead.historial_contactos : []) {
      if (item) candidates.push({ lead_id: lead.id, user_id: item.usuario_id, occurred_at: item.fecha,
        channel: item.canal || 'llamada', reason: item.motivo, kind: 'contact_attempt', source_id: 0 });
    }
  }
  const latest = new Map(rows.map(lead => [Number(lead.id), selectLatestInteraction(lead, candidates, now)]));
  const userIds = [...new Set([...latest.values()].filter(Boolean).map(row => Number(row.user_id)))];
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
  return leads.map(lead => {
    const item = !lead.privacy_redacted && latest.get(Number(lead.id)), user = item && byUser.get(Number(item.user_id));
    const name = user && [user.nombre, user.apellidos].filter(Boolean).join(' ').trim();
    return { ...lead, last_human_interaction: item && name ? {
      user_id: Number(item.user_id), user_name: name, occurred_at: date(item.occurred_at).toISOString(),
      time_zone: zones.get(Number(lead.clinica_id)) || 'Europe/Madrid',
      channel: item.channel, kind: item.kind,
      outcome: item.kind === 'message' ? 'sent' : ['no_contesta','no_contactado','sin_respuesta'].includes(String(item.reason || '').trim().toLowerCase()) ? 'no_answer' : 'registered',
      is_patient_director: directors.get(Number(lead.clinica_id)) === Number(item.user_id),
    } : null };
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
    // This accessory projection must not hide the lead or invent "no activity".
    // Principal list/detail authorization and read failures remain unaffected.
    return options.leads.map(lead => ({ ...lead, last_human_interaction: null, human_interaction_status: 'unavailable' }));
  }
}

module.exports = { enrichHumanInteraction, selectLatestInteraction };
