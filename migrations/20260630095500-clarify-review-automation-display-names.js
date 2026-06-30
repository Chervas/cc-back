'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE AutomationFlowTemplatesV2
      SET
        name = 'Plantilla base de sistema · Reseñas automáticas',
        description = 'Plantilla de sistema usada como base. No envía sola a pacientes: cada clínica ejecuta su propia automatización activa.'
      WHERE template_key = 'system_review_request_after_appointment_completed'
         OR public_id = 'flw_review_request_system'
    `);

    await queryInterface.sequelize.query(`
      UPDATE AutomationFlowTemplatesV2 t
      LEFT JOIN Clinicas c ON c.id_clinica = t.clinic_id
      SET
        t.name = CONCAT('Reseñas automáticas · Clínica: ', COALESCE(c.nombre_clinica, CONCAT('Clínica ', t.clinic_id))),
        t.description = 'Automatización activa de esta clínica: espera 24h tras completar una cita, pide valoración privada 1-5 y deriva a Google solo si responde 5/5. No envía recordatorio si no responde.'
      WHERE t.clinic_id IS NOT NULL
        AND t.trigger_type = 'appointment_completed'
        AND (
          t.template_key LIKE 'review_request_after_completed__clinic_%'
          OR t.template_key LIKE 'system_review_request_after_appointment_completed__clinic_%'
          OR t.public_id LIKE 'flw_review_req_clinic_%'
        )
    `);

    await queryInterface.sequelize.query(`
      UPDATE WhatsappTemplates wt
      LEFT JOIN WhatsappTemplateCatalog wc ON wc.id = wt.catalog_template_id
      SET wt.is_active = 0
      WHERE wt.name LIKE 'clinicaclick_recordatorio_resena_sin_respuesta%'
         OR wc.name = 'clinicaclick_recordatorio_resena_sin_respuesta'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE AutomationFlowTemplatesV2
      SET name = 'Solicitar reseña tras cita completada · Base de sistema'
      WHERE template_key = 'system_review_request_after_appointment_completed'
         OR public_id = 'flw_review_request_system'
    `);

    await queryInterface.sequelize.query(`
      UPDATE AutomationFlowTemplatesV2 t
      LEFT JOIN Clinicas c ON c.id_clinica = t.clinic_id
      SET t.name = CONCAT('Solicitar reseña tras cita completada · ', COALESCE(c.nombre_clinica, 'Clínica'))
      WHERE t.clinic_id IS NOT NULL
        AND t.trigger_type = 'appointment_completed'
        AND (
          t.template_key LIKE 'review_request_after_completed__clinic_%'
          OR t.template_key LIKE 'system_review_request_after_appointment_completed__clinic_%'
          OR t.public_id LIKE 'flw_review_req_clinic_%'
        )
    `);
  },
};
