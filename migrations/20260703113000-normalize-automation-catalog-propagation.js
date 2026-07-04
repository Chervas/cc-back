'use strict';

function clean(value) {
  return String(value || '').trim();
}

async function disableInvalidQaCatalog(queryInterface) {
  const [rows] = await queryInterface.sequelize.query(`
    SELECT c.id
      FROM AutomationFlowCatalog c
 LEFT JOIN AutomationFlowTemplatesV2 by_public
        ON by_public.public_id = c.template_key
       AND by_public.published_at IS NOT NULL
       AND by_public.is_active = 1
 LEFT JOIN AutomationFlowTemplatesV2 by_key
        ON by_key.template_key = c.template_key
       AND by_key.published_at IS NOT NULL
       AND by_key.is_active = 1
     WHERE c.name = 'qa_reactivation_patient_followup'
       AND c.is_active = 1
       AND by_public.id IS NULL
       AND by_key.id IS NULL
  `);

  const ids = (rows || []).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return;

  await queryInterface.sequelize.query(`
    UPDATE AutomationFlowCatalog
       SET is_active = 0,
           is_default_for_trigger = 0,
           updated_at = NOW()
     WHERE id IN (:ids)
  `, { replacements: { ids } });
}

async function normalizeReviewClinicPublicIds(queryInterface) {
  const [rows] = await queryInterface.sequelize.query(`
    SELECT DISTINCT clinic_id, template_key
      FROM AutomationFlowTemplatesV2
     WHERE clinic_id IS NOT NULL
       AND template_key LIKE 'review_request_after_completed\\\\_\\\\_clinic\\\\_%'
  `);

  for (const row of rows || []) {
    const clinicId = Number(row.clinic_id);
    const templateKey = clean(row.template_key);
    if (!Number.isInteger(clinicId) || clinicId <= 0 || !templateKey) continue;

    const expectedPublicId = `flw_review_req_clinic_${clinicId}`;
    const [conflicts] = await queryInterface.sequelize.query(`
      SELECT id
        FROM AutomationFlowTemplatesV2
       WHERE public_id = :expectedPublicId
         AND template_key <> :templateKey
       LIMIT 1
    `, { replacements: { expectedPublicId, templateKey } });

    if ((conflicts || []).length) continue;

    await queryInterface.sequelize.query(`
      UPDATE AutomationFlowTemplatesV2
         SET public_id = :expectedPublicId,
             updated_at = NOW()
       WHERE template_key = :templateKey
         AND clinic_id = :clinicId
    `, { replacements: { expectedPublicId, templateKey, clinicId } });
  }
}

module.exports = {
  async up(queryInterface) {
    await disableInvalidQaCatalog(queryInterface);
    await normalizeReviewClinicPublicIds(queryInterface);
  },

  async down() {
    // Limpieza idempotente de datos legacy; no se restaura el catálogo QA inválido.
  },
};
