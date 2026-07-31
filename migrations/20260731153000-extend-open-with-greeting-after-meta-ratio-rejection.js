'use strict';

const FAMILY_KEY = 'clinicaclick_abrir_con_saludo';
const SHORT_BODY_TEXT = '¡Hola {{1}}! Soy {{2}} de {{3}}.';
const BODY_TEXT = '¡Hola {{1}}! Soy {{2}} de {{3}} 😊 ¿Te puedo escribir por aquí para ayudarte con cualquier duda o consulta que tengas?';

const VARIABLES = [
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

function buildComponents(bodyText) {
  return JSON.stringify([{
    type: 'BODY',
    text: bodyText,
    example: { body_text: [VARIABLES.map((item) => item.example)] },
  }]);
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        body_text: BODY_TEXT,
        components: buildComponents(BODY_TEXT),
        last_propagated_at: null,
        propagation_state: null,
        updated_at: new Date(),
      },
      { family_key: FAMILY_KEY, locale: 'es' },
    );
  },

  async down(queryInterface) {
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        body_text: SHORT_BODY_TEXT,
        components: buildComponents(SHORT_BODY_TEXT),
        last_propagated_at: null,
        propagation_state: null,
        updated_at: new Date(),
      },
      { family_key: FAMILY_KEY, locale: 'es' },
    );
  },
};
