'use strict';

const REMINDER_TEMPLATE_NAME = 'clinicaclick_recordatorio_resena_sin_respuesta';

const BODY = [
  'Perdona la insistencia {{1}}, pero saber tu opinión nos ayuda mucho a mejorar.',
  '',
  '¿Podrías responder con el número de tu valoración?',
  '',
  '5 ⭐⭐⭐⭐⭐',
  '4 ⭐⭐⭐⭐',
  '3 ⭐⭐⭐',
  '2 ⭐⭐',
  '1 ⭐',
].join('\n');

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
    const now = new Date();
    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplateCatalog
         SET is_active = 1,
             body_text = :body,
             components = :components,
             updated_at = :now
       WHERE name = :name
      `,
      {
        replacements: {
          name: REMINDER_TEMPLATE_NAME,
          body: BODY,
          components: JSON.stringify(COMPONENTS),
          now,
        },
      }
    );

    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplates wt
      LEFT JOIN WhatsappTemplateCatalog c ON c.id = wt.catalog_template_id
         SET wt.is_active = CASE
               WHEN JSON_UNQUOTE(JSON_EXTRACT(wt.components, '$[0].text')) = :body THEN 1
               ELSE 0
             END,
             wt.updatedAt = :now
       WHERE wt.name = :name
          OR wt.name LIKE :familyName
          OR c.name = :name
      `,
      {
        replacements: {
          name: REMINDER_TEMPLATE_NAME,
          familyName: `${REMINDER_TEMPLATE_NAME}_v%`,
          body: BODY,
          now,
        },
      }
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplateCatalog
         SET is_active = 0,
             updated_at = NOW()
       WHERE name = :name
      `,
      { replacements: { name: REMINDER_TEMPLATE_NAME } }
    );
  },
};
