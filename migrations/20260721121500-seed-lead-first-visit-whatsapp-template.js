'use strict';

const TEMPLATE_NAME = 'clinicaclick_lead_primera_visita_programar';
const DISPLAY_NAME = 'Lead primera visita: agendar';

const BODY = 'Hola {{1}} 😊 te escribo desde {{2}}. Hemos recibido tu solicitud para realizar una primera visita ¿Quieres que la programe?';

const VARIABLES = [
  {
    position: 1,
    name: 'nombre_paciente',
    example: 'Jordi',
    description: 'Nombre del paciente o lead',
    template_usage: 'lead_primera_visita',
  },
  {
    position: 2,
    name: 'nombre_clinica',
    example: 'Propdental Sants',
    description: 'Nombre visible de la clínica',
    template_usage: 'lead_primera_visita',
  },
];

const COMPONENTS = [
  {
    type: 'BODY',
    text: BODY,
    example: {
      body_text: [['Jordi', 'Propdental Sants']],
    },
  },
];

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const rows = await queryInterface.sequelize.query(
      `SELECT id
       FROM WhatsappTemplateCatalog
       WHERE name = :name OR (family_key = :name AND locale = 'es')
       LIMIT 1`,
      {
        replacements: { name: TEMPLATE_NAME },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    const payload = {
      name: TEMPLATE_NAME,
      family_key: TEMPLATE_NAME,
      locale: 'es',
      display_name: DISPLAY_NAME,
      category: 'UTILITY',
      body_text: BODY,
      variables: JSON.stringify(VARIABLES),
      components: JSON.stringify(COMPONENTS),
      last_propagated_at: null,
      propagation_state: null,
      is_generic: true,
      is_active: true,
      updated_at: now,
    };

    if (rows[0]?.id) {
      await queryInterface.bulkUpdate('WhatsappTemplateCatalog', payload, { id: rows[0].id });
      return;
    }

    await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{
      ...payload,
      created_at: now,
    }]);
  },

  async down(queryInterface) {
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        is_active: false,
        propagation_state: null,
        updated_at: new Date(),
      },
      {
        name: TEMPLATE_NAME,
        family_key: TEMPLATE_NAME,
        locale: 'es',
      }
    );
  },
};
