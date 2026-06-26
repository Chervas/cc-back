'use strict';

const TEMPLATE_NAME = 'clinicaclick_solicitar_resena';

const BODY = [
  '¡Hola {{1}}! ¿Te puedo hacer una pregunta si no es mucha molestia?',
  '',
  'Nos encantaría conocer tu opinión sobre cómo te atendimos en {{2}}.',
  '',
  'Responde con el número de tu valoración:',
  '',
  '1 ⭐',
  '2 ⭐⭐',
  '3 ⭐⭐⭐',
  '4 ⭐⭐⭐⭐',
  '5 ⭐⭐⭐⭐⭐',
  '',
  'Te llevará solo unos segundos.',
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
    description: 'Nombre de la clínica',
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
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        body_text: BODY,
        variables: JSON.stringify(VARIABLES),
        components: JSON.stringify(COMPONENTS),
        propagation_state: null,
        updated_at: new Date(),
      },
      { name: TEMPLATE_NAME }
    );
  },

  async down(queryInterface) {
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        propagation_state: null,
        updated_at: new Date(),
      },
      { name: TEMPLATE_NAME }
    );
  },
};
