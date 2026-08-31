'use strict';

const TARGET_CLINIC_NAMES = ['bs medical', 'bs medical · demo'];
const DEFAULT_PURPOSES = ['data_protection', 'marketing_image', 'commercial_communications'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    const clinics = await queryInterface.sequelize.query(
      `SELECT id_clinica
         FROM Clinicas
        WHERE LOWER(nombre_clinica) IN (:names)`,
      {
        replacements: { names: TARGET_CLINIC_NAMES },
        type: Sequelize.QueryTypes.SELECT,
      }
    );
    if (!clinics.length) return;

    for (const clinic of clinics) {
      const clinicId = Number(clinic.id_clinica);
      const templates = await queryInterface.sequelize.query(
        `SELECT id, blocking_policy
           FROM ClinicConsentTemplates
          WHERE clinic_id = :clinicId
            AND status = 'active'
            AND is_default = 1
            AND validity_mode = 'manual'
            AND purpose IN (:purposes)
          ORDER BY id ASC`,
        {
          replacements: { clinicId, purposes: DEFAULT_PURPOSES },
          type: Sequelize.QueryTypes.SELECT,
        }
      );
      if (!templates.length) continue;

      const treatments = await queryInterface.sequelize.query(
        `SELECT DISTINCT t.id_tratamiento
           FROM Tratamientos t
          WHERE t.clinica_id = :clinicId
            AND t.activo = 1
            AND EXISTS (
              SELECT 1
                FROM TreatmentConsentRequirements r
               WHERE r.tratamiento_id = t.id_tratamiento
                 AND (r.clinica_id = :clinicId OR r.clinica_id IS NULL)
            )
          ORDER BY t.id_tratamiento ASC`,
        {
          replacements: { clinicId },
          type: Sequelize.QueryTypes.SELECT,
        }
      );
      if (!treatments.length) continue;

      for (const treatment of treatments) {
        const treatmentId = Number(treatment.id_tratamiento);
        const existingRows = await queryInterface.sequelize.query(
          `SELECT clinic_template_id, COALESCE(MAX(sort_order), -1) AS max_sort_order
             FROM TreatmentConsentRequirements
            WHERE tratamiento_id = :treatmentId
              AND (clinica_id = :clinicId OR clinica_id IS NULL)
            GROUP BY clinic_template_id`,
          {
            replacements: { treatmentId, clinicId },
            type: Sequelize.QueryTypes.SELECT,
          }
        );
        const existingTemplateIds = new Set(
          existingRows
            .map((row) => Number(row.clinic_template_id))
            .filter((id) => Number.isFinite(id) && id > 0)
        );
        let sortOrder = Math.max(
          -1,
          ...existingRows
            .map((row) => Number(row.max_sort_order))
            .filter((value) => Number.isFinite(value))
        );

        const rows = templates
          .filter((template) => !existingTemplateIds.has(Number(template.id)))
          .map((template) => {
            sortOrder += 1;
            const blockingPolicy = template.blocking_policy || 'hard';
            return {
              tratamiento_id: treatmentId,
              clinica_id: clinicId,
              clinic_template_id: template.id,
              catalog_template_id: null,
              requirement_scope: 'treatment',
              condition_key: null,
              required: blockingPolicy !== 'optional',
              blocking_policy: blockingPolicy,
              sort_order: sortOrder,
              createdAt: now,
              updatedAt: now,
            };
          });

        if (rows.length) {
          await queryInterface.bulkInsert('TreatmentConsentRequirements', rows);
        }
      }
    }
  },

  async down() {
    // No se retiran vinculos automaticamente: pueden haber sido revisados por la clinica.
  },
};
