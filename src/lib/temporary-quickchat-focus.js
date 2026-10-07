'use strict';

// Temporary presentation filter, NOT an access policy or a PatientDirection role.
// Retire when the Director de pacientes workflow replaces this account workaround.
const TEMPORARY_FOCUSED_ACCOUNT = Object.freeze({
  userId: 44,
  email: 'maria.gonzalez@modmarketing.net',
});
const TEMPORARY_DIRECTOR_CLINICS = Object.freeze([66, 72, 77]);

function temporaryQuickChatEligibilitySql() {
  const clinicIds = TEMPORARY_DIRECTOR_CLINICS.join(',');
  const event = kind => `EXISTS (
    SELECT 1 FROM \`Messages\` AS \`qc_attention\`
    WHERE \`qc_attention\`.\`conversation_id\` = \`Conversation\`.\`id\`
      AND \`qc_attention\`.\`message_type\` = 'event'
      AND \`qc_attention\`.\`automation_delivery_key\` LIKE 'temporary-patient-direction:%'
      AND JSON_UNQUOTE(JSON_EXTRACT(\`qc_attention\`.\`metadata\`, '$.kind')) = '${kind}'
  )`;
  return `(\`Conversation\`.\`clinic_id\` NOT IN (${clinicIds})
    OR \`Conversation\`.\`channel\` = 'internal'
    OR (NOT ${event('temporary_patient_direction_handoff')} AND (
      \`Conversation\`.\`patient_id\` IS NULL
      OR ${event('temporary_patient_direction_started')}
      OR EXISTS (SELECT 1 FROM \`CitasPacientes\` AS \`qc_own_appointment\`
        WHERE \`qc_own_appointment\`.\`created_by\` = ${TEMPORARY_FOCUSED_ACCOUNT.userId}
          AND \`qc_own_appointment\`.\`clinica_id\` = \`Conversation\`.\`clinic_id\`
          AND \`qc_own_appointment\`.\`paciente_id\` = \`Conversation\`.\`patient_id\`)
      OR EXISTS (SELECT 1 FROM \`PatientOperationalEvents\` AS \`qc_creation\`
        WHERE \`qc_creation\`.\`actor_user_id\` = ${TEMPORARY_FOCUSED_ACCOUNT.userId}
          AND \`qc_creation\`.\`event_type\` = 'patient.created'
          AND \`qc_creation\`.\`clinic_id\` = \`Conversation\`.\`clinic_id\`
          AND \`qc_creation\`.\`patient_id\` = \`Conversation\`.\`patient_id\`)
      OR EXISTS (SELECT 1 FROM \`Messages\` AS \`qc_human\`
        WHERE \`qc_human\`.\`conversation_id\` = \`Conversation\`.\`id\`
          AND \`qc_human\`.\`sender_id\` = ${TEMPORARY_FOCUSED_ACCOUNT.userId}
          AND \`qc_human\`.\`direction\` = 'outbound'
          AND \`qc_human\`.\`message_type\` <> 'event'
          AND \`qc_human\`.\`automation_delivery_key\` IS NULL)
    )))`;
}

function isTemporaryQuickChatFocusUser(actor) {
  return Number(actor?.userId) === TEMPORARY_FOCUSED_ACCOUNT.userId
    && String(actor?.email || '').trim().toLowerCase() === TEMPORARY_FOCUSED_ACCOUNT.email;
}

function temporaryQuickChatFocusSql(actor) {
  if (!isTemporaryQuickChatFocusUser(actor)) return null;
  // Server-pinned values only. Reads remain guarded by normal clinic/category ACLs.
  return temporaryQuickChatEligibilitySql();
}

function temporaryQuickChatListSql(actor, { patientId, leadId } = {}) {
  // Explicit contact reads remain subject to the normal category/clinic guards,
  // but bypass the habitual-list filter so appointment cards can open any allowed chat.
  if (patientId || leadId) return null;
  return temporaryQuickChatFocusSql(actor);
}

async function attachTemporaryQuickChatEligibility(conversations, actor, CitaPaciente) {
  if (!isTemporaryQuickChatFocusUser(actor)) return conversations;
  const ids = conversations.filter(c => TEMPORARY_DIRECTOR_CLINICS.includes(Number(c.clinic_id))
    && c.channel !== 'internal').map(c => Number(c.id)).filter(id => Number.isSafeInteger(id) && id > 0);
  const [eligible] = ids.length ? await CitaPaciente.sequelize.query(
    `SELECT \`Conversation\`.\`id\`, ${temporaryQuickChatEligibilitySql()} AS eligible
      FROM \`Conversations\` AS \`Conversation\` WHERE \`Conversation\`.\`id\` IN (:ids)`,
    { replacements: { ids } }
  ) : [[]];
  const byId = new Map(eligible.map(row => [Number(row.id), Boolean(Number(row.eligible))]));
  return conversations.map(c => ({
    ...c,
    quickchat_list_eligible: !TEMPORARY_DIRECTOR_CLINICS.includes(Number(c.clinic_id)) || c.channel === 'internal'
      || byId.get(Number(c.id)) === true,
  }));
}

module.exports = {
  isTemporaryQuickChatFocusUser,
  TEMPORARY_FOCUSED_ACCOUNT,
  TEMPORARY_DIRECTOR_CLINICS,
  temporaryQuickChatEligibilitySql,
  temporaryQuickChatFocusSql,
  temporaryQuickChatListSql,
  attachTemporaryQuickChatEligibility,
};
