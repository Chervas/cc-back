'use strict';

const TEMPLATE_NAME = 'clinicaclick_recordatorio_mismo_dia';

const OLD_BODY = '¡Hola {{1}}! Solo recordarte tu cita de hoy a las {{2}} en {{3}}';
const NEW_BODY = '¡Hola {{1}}! Solo recordarte tu cita de hoy a las {{2}} en {{3}}. Te esperamos.';

const EXAMPLE = ['Juan', '10:30', 'Clínica Dental Sonrisa'];

function buildComponents(bodyText) {
  return JSON.stringify([
    {
      type: 'BODY',
      text: bodyText,
      example: {
        body_text: [EXAMPLE],
      },
    },
  ]);
}

async function updateTemplate(queryInterface, fromBody, toBody) {
  const now = new Date();
  await queryInterface.bulkUpdate(
    'WhatsappTemplateCatalog',
    {
      body_text: toBody,
      components: buildComponents(toBody),
      updated_at: now,
    },
    {
      name: TEMPLATE_NAME,
      body_text: fromBody,
    },
  );

  await queryInterface.bulkUpdate(
    'WhatsappTemplates',
    {
      components: buildComponents(toBody),
      updatedAt: now,
    },
    {
      name: TEMPLATE_NAME,
      meta_template_id: null,
    },
  );
}

module.exports = {
  async up(queryInterface) {
    await updateTemplate(queryInterface, OLD_BODY, NEW_BODY);
  },

  async down(queryInterface) {
    await updateTemplate(queryInterface, NEW_BODY, OLD_BODY);
  },
};
