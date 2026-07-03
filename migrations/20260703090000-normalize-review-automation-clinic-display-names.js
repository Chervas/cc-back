'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `
      UPDATE AutomationFlowTemplatesV2 t
      LEFT JOIN Clinicas c
        ON c.id_clinica = t.clinic_id
         SET t.name = CASE
              WHEN t.is_system = TRUE THEN 'Reseñas automáticas'
              WHEN t.clinic_id IS NOT NULL THEN CONCAT('Reseñas automáticas · Clínica: ', COALESCE(c.nombre_clinica, CONCAT('Clínica ', t.clinic_id)))
              ELSE t.name
             END,
             t.updated_at = NOW()
       WHERE t.public_id = 'flw_review_request_system'
          OR t.public_id LIKE 'flw_review_req_clinic_%'
          OR t.template_key = 'review_request_after_completed'
          OR t.template_key LIKE 'review_request_after_completed__clinic_%'
          OR CAST(t.nodes AS CHAR) LIKE '%"action/request_review"%'
      `
    );
  },

  async down() {
    // No revertimos nombres visibles: la normalización elimina ambigüedad de UI
    // y no afecta a claves, nodos ni ejecución.
  },
};
