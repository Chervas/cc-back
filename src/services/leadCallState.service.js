'use strict';

// Operational last-call buckets. These reads never infer an answered call from
// a phone click, a booking, a WhatsApp message or the commercial lead phase.
const { literal, fn, Op } = require('sequelize');
const CALL_STATES = Object.freeze(['never_called', 'no_answer']);
const CLOSED_STATUSES = Object.freeze(['citado', 'acudio_cita', 'convertido', 'descartado']);
const NO_ANSWER_REASONS = Object.freeze(['no_contesta', 'no_contactado', 'sin_respuesta']);
const positiveId = value => ['number','string'].includes(typeof value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

function identity(row) {
  if (!positiveId(row.id)) return null;
  if (positiveId(row.clinica_id)) return `clinic:${Number(row.clinica_id)}:${Number(row.id)}`;
  return row.clinica_id == null && positiveId(row.grupo_clinica_id)
    ? `group:${Number(row.grupo_clinica_id)}:${Number(row.id)}` : null;
}

function normalizeCallState(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && CALL_STATES.includes(value.trim())) return value.trim();
  throw Object.assign(Error('Filtro de llamadas no válido'), { status: 400, statusCode: 400, code: 'lead_call_state_invalid' });
}

function quotedAlias(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw Error('lead_call_state_alias_invalid');
  return '`' + alias + '`';
}

function clockSql(now) {
  if (now == null) return 'UTC_TIMESTAMP(6)';
  if (!(now instanceof Date) || !Number.isFinite(+now)) throw Error('lead_call_state_clock_invalid');
  return "'" + now.toISOString().replace('T', ' ').replace('Z', '') + "'";
}

function eligibleLeadSql(alias = 'LeadIntake') {
  const lead = quotedAlias(alias);
  return `(${lead}.archived_at IS NULL AND COALESCE(${lead}.status_lead,'') NOT IN (${CLOSED_STATUSES.map(value => "'" + value + "'").join(',')}))`;
}

// Manual history was written as ISO UTC; tolerate older SQL timestamps and
// explicit ISO offsets while comparing every receipt as UTC. Keep fractions
// until mirror deduplication; SQL ledger timestamps may have second precision.
function historyInstantSql(raw) {
  const value = `UPPER(TRIM(${raw}))`;
  const pattern = '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])[T ]([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])?$';
  const base = `(CASE WHEN SUBSTRING(${value},20,1)='.'
    THEN STR_TO_DATE(REPLACE(${value},'T',' '),'%Y-%m-%d %H:%i:%s.%f')
    ELSE STR_TO_DATE(LEFT(REPLACE(${value},'T',' '),19),'%Y-%m-%d %H:%i:%s') END)`;
  const offset = `(CASE WHEN ${value} REGEXP '[+-][0-9]{2}:[0-9]{2}$'
    THEN (CASE WHEN LEFT(RIGHT(${value},6),1)='-' THEN -1 ELSE 1 END)
      * (CAST(SUBSTRING(RIGHT(${value},6),2,2) AS UNSIGNED)*60 + CAST(RIGHT(${value},2) AS UNSIGNED))
    ELSE 0 END)`;
  return `(CASE WHEN ${value} REGEXP '${pattern}'
    AND CAST(SUBSTRING(${value},9,2) AS UNSIGNED) <= DAY(LAST_DAY(CONCAT(LEFT(${value},7),'-01')))
    THEN DATE_SUB(${base}, INTERVAL ${offset} MINUTE) ELSE NULL END)`;
}

function leadCallStateSql(alias = 'LeadIntake', { now = null } = {}) {
  const lead = quotedAlias(alias), clock = clockSql(now);
  // JSON_TABLE uses the connection collation while older normalized tables
  // can use utf8mb4_unicode_ci. Compare normalized receipts consistently.
  const reason = column => `(LOWER(TRIM(CONVERT(COALESCE(${column},'') USING utf8mb4))) COLLATE utf8mb4_bin)`;
  const manual = column => `${reason(column)} NOT REGEXP 'auto(mation|_reply)|^system|^ai(_|$)'`;
  const outcome = column => `(CASE WHEN ${reason(column)} IN (${NO_ANSWER_REASONS.map(value => "'" + value + "'").join(',')}) THEN 'no_answer' ELSE 'called' END)`;
  const auditValue = path => `JSON_UNQUOTE(JSON_EXTRACT(cl_a.attribution_steps,'$.${path}'))`;
  const rawOutcome = "LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(cl_a.raw_payload,'$.outcome')),'')))";
  const auditOptional = path => `COALESCE(${auditValue(path)},'')`;
  const legacy = `SELECT cl_j.ordinal, cl_j.actor_id, cl_j.channel, cl_j.reason,
      ${historyInstantSql('cl_j.occurred_raw')} AS occurred_at
    FROM JSON_TABLE(CASE WHEN JSON_TYPE(${lead}.historial_contactos)='ARRAY' THEN ${lead}.historial_contactos ELSE JSON_ARRAY() END,
      '$[*]' COLUMNS (ordinal FOR ORDINALITY, actor_id VARCHAR(32) PATH '$.usuario_id' NULL ON EMPTY NULL ON ERROR,
        channel VARCHAR(32) PATH '$.canal' NULL ON EMPTY NULL ON ERROR,
        reason VARCHAR(128) PATH '$.motivo' NULL ON EMPTY NULL ON ERROR,
        occurred_raw VARCHAR(64) PATH '$.fecha' NULL ON EMPTY NULL ON ERROR)) AS cl_j`;
  return `(CASE WHEN ${eligibleLeadSql(alias)} THEN COALESCE((
    SELECT cl_calls.outcome FROM (
      SELECT cl_a.created_at AS occurred_at, 3 AS receipt_rank, cl_a.id AS source_id, ${outcome('cl_a.motivo')} AS outcome
      FROM LeadContactAttempts cl_a WHERE cl_a.lead_intake_id=${lead}.id AND cl_a.usuario_id>0
        AND LOWER(TRIM(cl_a.canal))='llamada' AND ${manual('cl_a.motivo')}
        AND cl_a.created_at>=${lead}.created_at AND cl_a.created_at<=${clock}
      UNION ALL
      SELECT cl_a.created_at, 2, cl_a.id,
        CASE WHEN ${rawOutcome}='no_contactado' THEN 'no_answer' ELSE 'called' END
      FROM LeadAttributionAudits cl_a WHERE cl_a.lead_intake_id=${lead}.id
        AND ${auditValue('action')}='call_outcome' AND ${auditValue('userId')} REGEXP '^[1-9][0-9]*$'
        AND JSON_TYPE(JSON_EXTRACT(cl_a.attribution_steps,'$.userId')) IN ('INTEGER','STRING')
        AND ${rawOutcome} IN ('no_contactado','informacion','citado')
        AND ${['source','origin','kind','source_event'].map(path => `${auditOptional(path)} NOT REGEXP 'auto(mation|_reply)|^system|^ai(_|$)'`).join(' AND ')}
        AND ${['is_automated','is_automation','generated_by_ai','ai_generated'].map(path => `${auditOptional(path)} NOT IN ('true','1')`).join(' AND ')}
        AND ${['execution_id','node_id','flow_execution_id','automation_flow_id'].map(path => `${auditOptional(path)} IN ('','null')`).join(' AND ')}
        AND ${auditOptional('clinic_id')} IN ('','null',CAST(${lead}.clinica_id AS CHAR))
        AND cl_a.created_at>=${lead}.created_at AND cl_a.created_at<=${clock}
      UNION ALL
      SELECT cl_legacy.occurred_at, 1, cl_legacy.ordinal, ${outcome('cl_legacy.reason')}
      FROM (${legacy}) AS cl_legacy
      WHERE cl_legacy.actor_id REGEXP '^[1-9][0-9]*$'
        AND (LOWER(TRIM(cl_legacy.channel))='llamada'
          OR ((cl_legacy.channel IS NULL OR TRIM(cl_legacy.channel)='') AND ${reason('cl_legacy.reason')} NOT LIKE 'whatsapp%'))
        AND ${manual('cl_legacy.reason')}
        AND cl_legacy.occurred_at>=${lead}.created_at AND cl_legacy.occurred_at<=${clock}
        AND NOT EXISTS (SELECT 1 FROM LeadContactAttempts cl_mirror WHERE cl_mirror.lead_intake_id=${lead}.id
          AND cl_mirror.usuario_id=CAST(cl_legacy.actor_id AS UNSIGNED) AND LOWER(TRIM(cl_mirror.canal))='llamada'
          AND ${reason('cl_mirror.motivo')}=${reason('cl_legacy.reason')}
          AND DATE_FORMAT(cl_mirror.created_at,'%Y-%m-%d %H:%i:%s')=DATE_FORMAT(cl_legacy.occurred_at,'%Y-%m-%d %H:%i:%s'))
    ) AS cl_calls ORDER BY cl_calls.occurred_at DESC,cl_calls.receipt_rank DESC,cl_calls.source_id DESC LIMIT 1
  ),'never_called') ELSE NULL END)`;
}

function leadCallStateWhere(value, options = {}) {
  const state = normalizeCallState(value);
  return state ? literal(`${leadCallStateSql(options.alias || 'LeadIntake', options)}='${state}'`) : null;
}

async function countLeadCallStates({ LeadIntake, where = {}, transaction = null, now = null }) {
  if (!LeadIntake) return { never_called: 0, no_answer: 0 };
  const alias = LeadIntake.name || 'LeadIntake';
  const rows = await LeadIntake.findAll({ where, transaction, raw: true,
    attributes: [[literal(leadCallStateSql(alias, { now })), 'call_state'], [fn('COUNT', literal('*')), 'count']],
    group: [literal('call_state')] });
  const result = { never_called: 0, no_answer: 0 };
  for (const row of rows) if (CALL_STATES.includes(row.call_state)) result[row.call_state] = Number(row.count) || 0;
  return result;
}

async function enrichLeadCallState({ models, leads, transaction = null, now = null, logger = console }) {
  const rows = leads.map(row => row?.get ? row.get({ plain: true }) : row);
  const eligible = rows.filter(row => !row.privacy_redacted && identity(row));
  if (!eligible.length) return rows.map(row => ({ ...row, call_state: null, call_state_status: 'available' }));
  try {
    const alias = models.LeadIntake.name || 'LeadIntake';
    const states = await models.LeadIntake.findAll({ where: { [Op.or]: eligible.map(row => positiveId(row.clinica_id)
      ? { id: Number(row.id), clinica_id: Number(row.clinica_id) }
      : { id: Number(row.id), clinica_id: null, grupo_clinica_id: Number(row.grupo_clinica_id) }) },
    attributes: ['id', 'clinica_id', 'grupo_clinica_id', [literal(leadCallStateSql(alias, { now })), 'call_state']], raw: true, transaction });
    const byIdentity = new Map(states.map(row => [identity(row), row.call_state]));
    return rows.map(row => {
      const value = !row.privacy_redacted && byIdentity.get(identity(row));
      return { ...row, call_state: CALL_STATES.includes(value) ? value : null, call_state_status: 'available' };
    });
  } catch (error) {
    // A read after a committed manual mutation cannot turn that success into a
    // retryable failed write. Omit the unknown projection; never claim "called"
    // or "never called" when its receipt store could not be read.
    const code = error?.original?.code || error?.code;
    const known = new Set(['ER_BAD_FIELD_ERROR','ER_NO_SUCH_TABLE','ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT','ECONNREFUSED','ETIMEDOUT']);
    logger?.warn?.('lead_call_state_unavailable', { code: known.has(code) ? code : 'summary_error' });
    return rows.map(row => ({ ...row, call_state: undefined, call_state_status: 'unavailable' }));
  }
}

module.exports = { CALL_STATES, CLOSED_STATUSES, NO_ANSWER_REASONS, normalizeCallState, eligibleLeadSql,
  historyInstantSql, leadCallStateSql, leadCallStateWhere, countLeadCallStates, enrichLeadCallState };
