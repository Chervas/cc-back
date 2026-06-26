'use strict';

const TEMPLATE_NAME = 'clinicaclick_recordatorio_resena_sin_respuesta';

const BODY = [
  'Perdona la insistencia {{1}}, pero saber tu opinión nos ayuda mucho a mejorar.',
  '',
  '¿Podrías responder con el número de tu valoración?',
  '',
  '1 ⭐',
  '2 ⭐⭐',
  '3 ⭐⭐⭐',
  '4 ⭐⭐⭐⭐',
  '5 ⭐⭐⭐⭐⭐',
].join('\n');

const VARIABLES = [
  {
    position: 1,
    name: 'nombre_paciente',
    example: 'María',
    description: 'Nombre del paciente',
  },
];

const COMPONENTS = [
  {
    type: 'BODY',
    text: BODY,
    example: {
      body_text: [['María']],
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
        display_name: 'Recordatorio de valoración sin respuesta',
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
      SET is_active = 0,
          updatedAt = NOW()
      WHERE is_active = 1
        AND (
          catalog_template_id = :catalogId
          OR name = :name
          OR name LIKE :familyName
        )
        AND CAST(components AS CHAR) LIKE '%BUTTONS%'
      `,
      {
        replacements: {
          catalogId: template.id,
          name: TEMPLATE_NAME,
          familyName: `${TEMPLATE_NAME}_v%`,
        },
      }
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
    // No-op: button-based review reminders should not be automatically reactivated.
  },
};
