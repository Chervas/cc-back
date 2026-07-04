'use strict';

const BASE_TEMPLATE_NAME = 'clinicaclick_solicitar_resena';
const PHOTO_TEMPLATE_NAME = 'clinicaclick_solicitar_resena_foto';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplates wt
      LEFT JOIN WhatsappTemplateCatalog c ON c.id = wt.catalog_template_id
         SET wt.is_active = 0,
             wt.rejection_reason = CASE
               WHEN wt.rejection_reason IS NULL OR wt.rejection_reason = ''
                 THEN 'Retirada localmente: version antigua de solicitud de resenas sin remitente.'
               ELSE CONCAT(wt.rejection_reason, ' | Retirada localmente: version antigua de solicitud de resenas sin remitente.')
             END,
             wt.updatedAt = NOW()
       WHERE wt.is_active = 1
         AND (
           wt.name = :baseName
           OR wt.name LIKE :baseFamily
           OR wt.name = :photoName
           OR wt.name LIKE :photoFamily
           OR c.name = :baseName
           OR c.name = :photoName
         )
         AND COALESCE(CAST(wt.components AS CHAR), '') NOT LIKE '%Soy {{3}}%'
         AND COALESCE(CAST(wt.components AS CHAR), '') NOT LIKE '%firma_resenas%'
         AND COALESCE(CAST(wt.components AS CHAR), '') NOT LIKE '%review_sender_name%'
      `,
      {
        replacements: {
          baseName: BASE_TEMPLATE_NAME,
          baseFamily: `${BASE_TEMPLATE_NAME}_v%`,
          photoName: PHOTO_TEMPLATE_NAME,
          photoFamily: `${PHOTO_TEMPLATE_NAME}_v%`,
        },
      }
    );
  },

  async down() {
    // No reactivamos copias antiguas: pueden seguir aprobadas en Meta, pero no cumplen el contrato actual.
  },
};
