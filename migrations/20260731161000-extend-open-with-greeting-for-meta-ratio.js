'use strict';

const FAMILY_KEY = 'clinicaclick_abrir_con_saludo';
const PREVIOUS_BODY_TEXT = '¡Hola {{1}}! Soy {{2}} de {{3}} 😊 ¿Te importa que te escriba por aquí para consultarte o prefieres que te llame?';
const BODY_TEXT = '¡Hola {{1}}! Soy {{2}} de {{3}} 😊 ¿Te importa que te escriba por aquí para consultarte o prefieres que te llame? Queremos atenderte por el canal que te resulte más cómodo. Si prefieres una llamada, dínoslo y nos pondremos en contacto contigo.';

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

async function updateCatalog(queryInterface, bodyText) {
  await queryInterface.bulkUpdate(
    'WhatsappTemplateCatalog',
    {
      body_text: bodyText,
      components: buildComponents(bodyText),
      last_propagated_at: null,
      propagation_state: null,
      updated_at: new Date(),
    },
    { family_key: FAMILY_KEY, locale: 'es' },
  );
}

module.exports = {
  async up(queryInterface) {
    await updateCatalog(queryInterface, BODY_TEXT);
  },

  async down(queryInterface) {
    await updateCatalog(queryInterface, PREVIOUS_BODY_TEXT);
  },
};
