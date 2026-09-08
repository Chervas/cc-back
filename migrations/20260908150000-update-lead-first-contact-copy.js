'use strict';

const FAMILIES = [
  'clinicaclick_lead_primera_visita_programar',
  'clinicaclick_lead_primera_visita_con_llamada',
];

const BODY = 'Hola {{1}} ¿Qué tal estás? 😊\n\nSoy {{2}}. Te escribo desde {{3}}. Mis compañeras me han pasado una solicitud de contacto tuya. ¿Quieres que programemos una primera visita? Si ya no te interesa o ha sido un error, no te preocupes, indícanoslo y no te molestaremos más.';
const VARIABLES = [
  { position: 1, name: 'nombre_paciente', example: 'Jordi', description: 'Nombre del paciente o lead', template_usage: 'lead_primera_visita' },
  { position: 2, name: 'nombre_remitente', example: 'Marta', description: 'Nombre real de la persona que contacta', template_usage: 'lead_primera_visita' },
  { position: 3, name: 'nombre_clinica', example: 'Clínica Ejemplo', description: 'Nombre visible de la clínica', template_usage: 'lead_primera_visita' },
];
const COMPONENTS = [
  {
    type: 'BODY',
    text: BODY,
    example: { body_text: [['Jordi', 'Marta', 'Clínica Ejemplo']] },
  },
  {
    type: 'BUTTONS',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Sí, dame más información' },
      { type: 'QUICK_REPLY', text: 'Ya no estoy interesado' },
    ],
  },
];

const PREVIOUS = {
  clinicaclick_lead_primera_visita_programar: 'Hola {{1}} 😊 te escribo desde {{2}}. Hemos recibido tu solicitud para realizar una primera visita ¿Quieres que la programe?',
  clinicaclick_lead_primera_visita_con_llamada: 'Hola {{1}} 😊 te escribo desde {{2}}. Hemos intentado llamarte por tu solicitud para realizar una primera visita. ¿Quieres que la programemos por aquí?',
};

function previousVariables() {
  return [
    { position: 1, name: 'nombre_paciente', example: 'Jordi', description: 'Nombre del paciente o lead', template_usage: 'lead_primera_visita' },
    { position: 2, name: 'nombre_clinica', example: 'Propdental Sants', description: 'Nombre visible de la clínica', template_usage: 'lead_primera_visita' },
  ];
}

function components(body, variables) {
  return [
    { type: 'BODY', text: body, example: { body_text: [variables.map((variable) => variable.example)] } },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Quiero una cita' },
        { type: 'QUICK_REPLY', text: 'Ya no estoy interesado' },
      ],
    },
  ];
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkUpdate('WhatsappTemplateCatalog', {
      category: 'MARKETING',
      body_text: BODY,
      variables: JSON.stringify(VARIABLES),
      components: JSON.stringify(COMPONENTS),
      propagation_state: null,
      last_propagated_at: null,
      updated_at: new Date(),
    }, {
      family_key: FAMILIES,
      locale: 'es',
      is_active: true,
    });
  },

  async down(queryInterface) {
    const variables = previousVariables();
    for (const family of FAMILIES) {
      const body = PREVIOUS[family];
      await queryInterface.bulkUpdate('WhatsappTemplateCatalog', {
        category: 'MARKETING',
        body_text: body,
        variables: JSON.stringify(variables),
        components: JSON.stringify(components(body, variables)),
        propagation_state: null,
        last_propagated_at: null,
        updated_at: new Date(),
      }, { family_key: family, locale: 'es' });
    }
  },

  __testing: { BODY, COMPONENTS, VARIABLES },
};
