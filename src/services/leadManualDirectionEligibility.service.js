'use strict';

// Explicit portfolio assignment is separate from advertising attribution. A
// stored owner, an imported contact or a human call alone proves neither one.
// This read-only predicate is shared by paginated QuickChat and batch DTOs.
const { campaignResponsibilitySql, createLeadCampaignResponsibilityService } = require('./leadCampaignResponsibility.service');
const KEY = 'lead_direction_assignment_v1';
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function manualDirectionEligibilitySql(alias = 'LeadIntake') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw Error('manual_direction_alias_invalid');
  const lead = `\`${alias}\``;
  const field = name => `${lead}.\`${name}\``;
  const j = (row, root, path) => `JSON_EXTRACT(${row}.${root}, '$.${path}')`;
  const s = (row, root, path) => `JSON_UNQUOTE(${j(row, root, path)})`;
  const member = (row, path) => j(row, 'attribution_steps', `${KEY}.${path}`);
  const value = (row, path) => s(row, 'attribution_steps', `${KEY}.${path}`);
  const integer = (row, path) => `JSON_TYPE(${member(row, path)}) = 'INTEGER'`;
  const string = (row, path) => `JSON_TYPE(${member(row, path)}) = 'STRING'`;
  const hash = (row, path) => `(${string(row, path)} AND ${value(row, path)} REGEXP '^[a-f0-9]{64}$')`;
  const actor = row => `(JSON_TYPE(${j(row, 'attribution_steps', 'userId')}) = 'INTEGER'
    AND ${s(row, 'attribution_steps', 'userId')} IN ('1','44'))`;
  const currentDate = row => `(${row}.created_at >= ${field('created_at')} AND ${row}.created_at <= UTC_TIMESTAMP())`;
  const optionalClinic = (row, root, name) => `(${j(row, root, name)} IS NULL OR JSON_TYPE(${j(row, root, name)}) = 'NULL'
    OR ${s(row, root, name)} = CAST(${field('clinica_id')} AS CHAR))`;
  const native = row => `(${s(row, 'attribution_steps', 'action')} = 'status_update' AND ${actor(row)}
    AND JSON_TYPE(${j(row, 'raw_payload', 'asignado_a')}) = 'INTEGER' AND ${s(row, 'raw_payload', 'asignado_a')} = '44'
    AND ${j(row, 'attribution_steps', 'import_mode')} IS NULL
    AND ${optionalClinic(row, 'attribution_steps', 'clinic_id')}
    AND ${optionalClinic(row, 'raw_payload', 'clinic_id')} AND ${optionalClinic(row, 'raw_payload', 'clinica_id')})`;
  const attention = row => {
    const path = name => `lead_patient_attention_v1.${name}`;
    const entry = name => j(row, 'attribution_steps', path(name));
    const data = name => s(row, 'attribution_steps', path(name));
    return `(${s(row, 'attribution_steps', 'type')} = 'lead_patient_attention_v1'
      AND JSON_TYPE(${entry('version')}) = 'INTEGER' AND ${data('version')} = '1'
      AND JSON_TYPE(${entry('actor_user_id')}) = 'INTEGER' AND ${data('actor_user_id')} IN ('1','44')
      AND JSON_TYPE(${entry('director_user_id')}) = 'INTEGER' AND ${data('director_user_id')} = '44'
      AND JSON_TYPE(${entry('clinic_id')}) = 'INTEGER' AND ${data('clinic_id')} = CAST(${field('clinica_id')} AS CHAR)
      AND ${data('decision')} = 'director' AND ${data('request_kind')} IN ('commercial','patient_care')
      AND JSON_TYPE(${entry('decided_at')}) = 'STRING'
      AND ${data('decided_at')} REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{3})?Z$'
      AND LEFT(${data('decided_at')}, 19) = DATE_FORMAT(${row}.created_at, '%Y-%m-%dT%H:%i:%s'))`;
  };
  const typed = row => `(${s(row, 'attribution_steps', 'type')} = '${KEY}' AND ${actor(row)}
    AND ${integer(row, 'version')} AND ${value(row, 'version')} = '1'
    AND ${integer(row, 'clinic_id')} AND ${value(row, 'clinic_id')} = CAST(${field('clinica_id')} AS CHAR)
    AND ${integer(row, 'lead_id')} AND ${value(row, 'lead_id')} = CAST(${field('id')} AS CHAR)
    AND ${integer(row, 'director_user_id')} AND ${value(row, 'director_user_id')} = '44'
    AND ${integer(row, 'actor_user_id')} AND ${value(row, 'actor_user_id')} = ${s(row, 'attribution_steps', 'userId')}
    AND ${value(row, 'decision')} = 'director' AND ${value(row, 'source')} = 'manual_csv'
    AND ${hash(row, 'source_sha256')} AND ${hash(row, 'row_sha256')}
    AND ${string(row, 'batch_id')} AND ${value(row, 'batch_id')} REGEXP '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    AND JSON_TYPE(${member(row, 'row_numbers')}) = 'ARRAY' AND JSON_LENGTH(${member(row, 'row_numbers')}) BETWEEN 1 AND 100
    AND NOT EXISTS (SELECT 1 FROM JSON_TABLE(${member(row, 'row_numbers')}, '$[*]' COLUMNS (position FOR ORDINALITY)) md_rows
      WHERE JSON_TYPE(JSON_EXTRACT(${member(row, 'row_numbers')}, CONCAT('$[', md_rows.position - 1, ']'))) <> 'INTEGER'
        OR JSON_UNQUOTE(JSON_EXTRACT(${member(row, 'row_numbers')}, CONCAT('$[', md_rows.position - 1, ']'))) NOT REGEXP '^[1-9][0-9]*$')
    AND ${string(row, 'assigned_at')} AND ${value(row, 'assigned_at')} IN
      (DATE_FORMAT(${row}.created_at, '%Y-%m-%dT%H:%i:%sZ'), DATE_FORMAT(${row}.created_at, '%Y-%m-%dT%H:%i:%s.000Z'))
    AND ${s(row, 'attribution_steps', 'import_mode')} = 'manual_csv'
    AND ${s(row, 'attribution_steps', 'clinic_match_source')} = 'manual_import'
    AND ${s(row, 'attribution_steps', 'clinic_match_value')} = CAST(${field('clinica_id')} AS CHAR)
    AND JSON_TYPE(${j(row, 'raw_payload', 'import.raw_row')}) IN ('ARRAY','OBJECT'))`;
  // A later assignment receipt, including an invalid/foreign attempt, revokes
  // this proof. Never revive an older portfolio when a newer owner was chosen.
  const assignment = row => `(JSON_CONTAINS_PATH(${row}.attribution_steps, 'one', '$.${KEY}', '$.lead_patient_attention_v1') = 1
    OR (${s(row, 'attribution_steps', 'action')} = 'status_update'
      AND JSON_CONTAINS_PATH(${row}.raw_payload, 'one', '$.asignado_a') = 1))`;
  return `(${field('asignado_a')} = 44 AND ${field('archived_at')} IS NULL
    AND ${field('status_lead')} NOT IN ('descartado','acudio_cita','convertido')
    AND EXISTS (SELECT 1 FROM LeadAttributionAudits md_proof WHERE md_proof.lead_intake_id = ${field('id')}
      AND ${currentDate('md_proof')} AND (${native('md_proof')} OR ${typed('md_proof')} OR ${attention('md_proof')})
      AND NOT EXISTS (SELECT 1 FROM LeadAttributionAudits md_later WHERE md_later.lead_intake_id = ${field('id')}
        AND md_later.id > md_proof.id AND ${assignment('md_later')})))`;
}

function directionEligibilitySql(alias = 'LeadIntake') {
  return `(${campaignResponsibilitySql(alias)} OR ${manualDirectionEligibilitySql(alias)})`;
}

function createLeadManualDirectionEligibilityService(db) {
  async function forLeads(leads, { transaction = null } = {}) {
    const ids = [...new Set(leads.map(lead => Number(lead.id)).filter(positive))];
    if (!ids.length || !db.sequelize?.query) return new Map();
    const [rows] = await db.sequelize.query(`SELECT \`LeadIntake\`.\`id\`, \`LeadIntake\`.\`clinica_id\`, (${manualDirectionEligibilitySql()}) AS eligible
      FROM LeadIntakes AS \`LeadIntake\` WHERE \`LeadIntake\`.\`id\` IN (:ids)`, { replacements: { ids }, transaction });
    const clinics = new Map(leads.map(lead => [Number(lead.id), Number(lead.clinica_id)]));
    return new Map(rows.map(row => [Number(row.id), Boolean(Number(row.eligible))
      && positive(clinics.get(Number(row.id))) && Number(row.clinica_id) === clinics.get(Number(row.id))]));
  }
  return { forLeads };
}

function createLeadDirectionEligibilityService(db, { campaignResponsibility = null, manualDirectionEligibility = null } = {}) {
  const campaigns = campaignResponsibility || createLeadCampaignResponsibilityService(db);
  const manual = manualDirectionEligibility || createLeadManualDirectionEligibilityService(db);
  async function forLeads(leads, options = {}) {
    const [automatic, explicit] = await Promise.all([campaigns.forLeads(leads, options), manual.forLeads(leads, options)]);
    return new Map(leads.map(lead => [Number(lead.id), automatic.get(Number(lead.id)) === true || explicit.get(Number(lead.id)) === true]));
  }
  return { forLeads };
}

module.exports = { KEY, manualDirectionEligibilitySql, directionEligibilitySql,
  createLeadManualDirectionEligibilityService, createLeadDirectionEligibilityService };
