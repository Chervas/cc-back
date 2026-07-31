'use strict';

const TEMPLATE_NAME = 'clinicaclick_abrir_con_saludo';
const FAMILY_KEY = 'clinicaclick_abrir_con_saludo';
const BODY_TEXT = '¡Hola {{1}}! Soy {{2}} de {{3}}.';

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    const variables = [
      {
        position: 1,
        name: 'nombre_paciente',
        example: 'Inmaculada',
        description: 'Nombre del paciente',
        template_usage: 'manual_patient_contact',
      },
      {
        position: 2,
        name: 'usuario_nombre',
        example: 'Vero',
        description: 'Nombre de la persona que escribe',
        template_usage: 'manual_patient_contact',
      },
      {
        position: 3,
        name: 'nombre_clinica',
        example: 'Clínica Centro',
        description: 'Nombre visible de la clínica',
        template_usage: 'manual_patient_contact',
      },
    ];
    const components = [{
      type: 'BODY',
      text: BODY_TEXT,
      example: { body_text: [variables.map((item) => item.example)] },
    }];
    const [existing] = await queryInterface.sequelize.query(
      `SELECT id
       FROM WhatsappTemplateCatalog
       WHERE family_key = :familyKey AND locale = 'es'
       LIMIT 1`,
      {
        replacements: { familyKey: FAMILY_KEY },
        type: Sequelize.QueryTypes.SELECT,
      },
    );
    const payload = {
      name: TEMPLATE_NAME,
      family_key: FAMILY_KEY,
      locale: 'es',
      display_name: 'Abrir con saludo',
      category: 'MARKETING',
      body_text: BODY_TEXT,
      variables: JSON.stringify(variables),
      components: JSON.stringify(components),
      last_propagated_at: null,
      propagation_state: null,
      is_generic: true,
      is_active: true,
      updated_at: now,
    };
    if (existing?.id) {
      await queryInterface.bulkUpdate('WhatsappTemplateCatalog', payload, { id: existing.id });
      return;
    }
    await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{
      ...payload,
      created_at: now,
    }]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('WhatsappTemplateCatalog', {
      family_key: FAMILY_KEY,
      locale: 'es',
    });
  },
};
