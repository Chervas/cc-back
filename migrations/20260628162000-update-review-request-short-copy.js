'use strict';

const TEMPLATE_NAME = 'clinicaclick_solicitar_resena';

const BODY = [
  '¡Hola {{1}}! ¿Qué tal te atendimos en {{2}} {{3}}?',
  '',
  'Responde con el número de tu valoración:',
  '',
  '1 ⭐',
  '2 ⭐⭐',
  '3 ⭐⭐⭐',
  '4 ⭐⭐⭐⭐',
  '5 ⭐⭐⭐⭐⭐',
  '',
  'Tu opinión nos ayuda mucho.',
].join('\n');

const VARIABLES = [
  {
    position: 1,
    name: 'nombre_paciente',
    example: 'María',
    description: 'Nombre del paciente',
  },
  {
    position: 2,
    name: 'nombre_clinica',
    example: 'Clínica Dental Centro',
    description: 'Nombre visible de la clínica',
  },
  {
    position: 3,
    name: 'referencia_visita',
    example: 'el pasado 21/05/2026',
    description: 'Referencia breve a la cita o visita atendida',
  },
];

const COMPONENTS = [
  {
    type: 'BODY',
    text: BODY,
    example: {
      body_text: [['María', 'Clínica Dental Centro', 'el pasado 21/05/2026']],
    },
  },
];

module.exports = {
  async up(queryInterface) {
    const rows = await queryInterface.sequelize.query(
      'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
      {
        replacements: { name: TEMPLATE_NAME },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );
    const template = rows[0];
    if (!template) return;

    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        display_name: 'Solicitud de valoración 1-5',
        body_text: BODY,
        variables: JSON.stringify(VARIABLES),
        components: JSON.stringify(COMPONENTS),
        propagation_state: null,
        updated_at: new Date(),
      },
      { id: template.id }
    );

    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplates
      SET components = :components,
          variables = :variables,
          updatedAt = NOW()
      WHERE (
          catalog_template_id = :catalogId
          OR name = :name
          OR name LIKE :familyName
        )
        AND (
          status <> 'APPROVED'
          OR meta_template_id IS NULL
          OR meta_template_id = ''
        )
      `,
      {
        replacements: {
          catalogId: template.id,
          name: TEMPLATE_NAME,
          familyName: `${TEMPLATE_NAME}_v%`,
          components: JSON.stringify(COMPONENTS),
          variables: JSON.stringify(VARIABLES),
        },
      }
    );
  },

  async down() {
    // No-op: mantener versiones aprobadas anteriores no debe reactivar copias largas.
  },
};
