'use strict';

const TEMPLATE_NAME = 'clinicaclick_solicitar_resena';

const BODY = [
  '¡Hola {{1}}! ¿Cómo valorarías tu experiencia en {{2}}?',
  '',
  'Responde con un número:',
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
];

const COMPONENTS = [
  {
    type: 'BODY',
    text: BODY,
    example: {
      body_text: [['María', 'Clínica Dental Centro']],
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
    // No-op: las copias aprobadas por Meta no se deben revertir automáticamente.
  },
};
