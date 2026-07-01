'use strict';

const CATALOG_NAME = 'auto_solicitar_resena';
const TRIGGER_TYPE = 'appointment_completed';
const SOURCE_PUBLIC_ID = 'flw_review_request_system';
const LEGACY_SOURCE_KEY = 'system_review_request_after_appointment_completed';
const SOURCE_KEY = 'review_request_after_completed';

function pickExistingColumns(payload, tableDefinition) {
  return Object.entries(payload).reduce((acc, [key, value]) => {
    if (tableDefinition[key]) acc[key] = value;
    return acc;
  }, {});
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const templateDefinition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
    const [legacyClinicRows] = await queryInterface.sequelize.query(
      `
      SELECT id, clinic_id
        FROM AutomationFlowTemplatesV2
       WHERE trigger_type = :triggerType
         AND clinic_id IS NOT NULL
         AND template_key LIKE 'system_review_request_after_appointment_completed%clinic_%'
      `,
      { replacements: { triggerType: TRIGGER_TYPE } }
    );

    for (const row of legacyClinicRows || []) {
      const clinicId = Number(row.clinic_id || 0);
      if (!clinicId) continue;

      const targetKey = `${SOURCE_KEY}__clinic_${clinicId}`;
      const targetPublicId = `flw_review_req_clinic_${clinicId}`;
      const [collisions] = await queryInterface.sequelize.query(
        `
        SELECT id
          FROM AutomationFlowTemplatesV2
         WHERE id <> :id
           AND (template_key = :targetKey OR public_id = :targetPublicId)
         LIMIT 1
        `,
        {
          replacements: {
            id: row.id,
            targetKey,
            targetPublicId,
          },
        }
      );

      if (Array.isArray(collisions) && collisions.length) {
        continue;
      }

      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        pickExistingColumns({
          template_key: targetKey,
          public_id: targetPublicId,
          updated_at: now,
        }, templateDefinition),
        { id: row.id }
      );
    }

    await queryInterface.bulkUpdate(
      'AutomationFlowTemplatesV2',
      pickExistingColumns({
        template_key: SOURCE_KEY,
        updated_at: now,
      }, templateDefinition),
      {
        trigger_type: TRIGGER_TYPE,
        public_id: SOURCE_PUBLIC_ID,
        template_key: LEGACY_SOURCE_KEY,
      }
    );

    const tableDefinition = await queryInterface.describeTable('AutomationFlowCatalog');
    const [catalogRows] = await queryInterface.sequelize.query(
      `
      SELECT id, template_key, template_version
        FROM AutomationFlowCatalog
       WHERE name = :catalogName
       LIMIT 1
      `,
      { replacements: { catalogName: CATALOG_NAME } }
    );

    const catalog = Array.isArray(catalogRows) ? catalogRows[0] : null;
    if (!catalog?.id || !catalog?.template_key) {
      return;
    }

    const [copyRows] = await queryInterface.sequelize.query(
      `
      SELECT COUNT(*) AS total
        FROM AutomationFlowTemplatesV2
       WHERE trigger_type = :triggerType
         AND clinic_id IS NOT NULL
         AND published_at IS NOT NULL
         AND (
           template_key LIKE 'review_request_after_completed%clinic_%'
           OR public_id LIKE 'flw_review_req_clinic_%'
           OR CAST(nodes AS CHAR) LIKE '%action/request_review%'
         )
      `,
      { replacements: { triggerType: TRIGGER_TYPE } }
    );

    const propagatedCopies = Number(copyRows?.[0]?.total || 0);
    if (!propagatedCopies) {
      return;
    }

    await queryInterface.bulkUpdate(
      'AutomationFlowCatalog',
      pickExistingColumns({
        last_propagated_at: new Date(now.getTime() + 1000),
        last_propagated_template_key: catalog.template_key,
        last_propagated_template_version: Number(catalog.template_version || 1) || 1,
      }, tableDefinition),
      { id: catalog.id }
    );
  },

  async down() {
    // No se revierte para no ocultar propagaciones reales posteriores.
  },
};
