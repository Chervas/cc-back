'use strict';

const { Op } = require('sequelize');

// Temporary presentation filter, NOT an access policy or a PatientDirection role.
// Retire when the Director de pacientes workflow replaces this account workaround.
const TEMPORARY_FOCUSED_ACCOUNT = Object.freeze({
  userId: 44,
  email: 'maria.gonzalez@modmarketing.net',
});

function isTemporaryQuickChatFocusUser(actor) {
  return Number(actor?.userId) === TEMPORARY_FOCUSED_ACCOUNT.userId
    && String(actor?.email || '').trim().toLowerCase() === TEMPORARY_FOCUSED_ACCOUNT.email;
}

function temporaryQuickChatFocusSql(actor) {
  if (!isTemporaryQuickChatFocusUser(actor)) return null;
  // Values are pinned server-side; never interpolate request/search parameters.
  // Pair clinic + patient: an appointment in another clinic is not a match.
  // Preserve leads/external contacts and the existing team category.
  return `(
    \`Conversation\`.\`patient_id\` IS NULL
    OR \`Conversation\`.\`channel\` = 'internal'
    OR EXISTS (
      SELECT 1 FROM \`CitasPacientes\` AS \`qc_own_appointment\`
      WHERE \`qc_own_appointment\`.\`created_by\` = ${TEMPORARY_FOCUSED_ACCOUNT.userId}
        AND \`qc_own_appointment\`.\`clinica_id\` = \`Conversation\`.\`clinic_id\`
        AND \`qc_own_appointment\`.\`paciente_id\` = \`Conversation\`.\`patient_id\`
    )
  )`;
}

function temporaryQuickChatListSql(actor, { patientId, leadId } = {}) {
  // Explicit contact reads remain subject to the normal category/clinic guards,
  // but bypass the habitual-list filter so appointment cards can open any allowed chat.
  if (patientId || leadId) return null;
  return temporaryQuickChatFocusSql(actor);
}

async function attachTemporaryQuickChatEligibility(conversations, actor, CitaPaciente) {
  if (!isTemporaryQuickChatFocusUser(actor)) return conversations;
  const pairs = new Map();
  for (const c of conversations) {
    if (c.patient_id && c.channel !== 'internal') {
      pairs.set(`${Number(c.clinic_id)}:${Number(c.patient_id)}`, {
        clinica_id: Number(c.clinic_id), paciente_id: Number(c.patient_id),
      });
    }
  }
  const appointments = pairs.size ? await CitaPaciente.findAll({
    where: { created_by: TEMPORARY_FOCUSED_ACCOUNT.userId, [Op.or]: [...pairs.values()] },
    attributes: ['clinica_id', 'paciente_id'],
    group: ['clinica_id', 'paciente_id'],
    raw: true,
  }) : [];
  const ownPairs = new Set(appointments.map(a => `${Number(a.clinica_id)}:${Number(a.paciente_id)}`));
  return conversations.map(c => ({
    ...c,
    quickchat_list_eligible: !c.patient_id || c.channel === 'internal'
      || ownPairs.has(`${Number(c.clinic_id)}:${Number(c.patient_id)}`),
  }));
}

module.exports = {
  isTemporaryQuickChatFocusUser,
  temporaryQuickChatFocusSql,
  temporaryQuickChatListSql,
  attachTemporaryQuickChatEligibility,
};
