'use strict';

const TEMPLATE_NAME = 'clinicaclick_recordatorio_mismo_dia_primera_visita';

const VARIABLES = [
  {
    position: 1,
    name: 'nombre_paciente',
    example: 'Juan',
    description: 'Nombre del paciente o lead',
  },
  {
    position: 2,
    name: 'hora_cita',
    example: '10:30',
    description: 'Hora de la cita programada',
  },
  {
    position: 3,
    name: 'direccion_clinica',
    example: 'Calle Mayor 123, Madrid',
    description: 'Dirección completa de la clínica',
  },
  {
    position: 4,
    name: 'url_como_llegar_clinica',
    example: 'https://www.google.com/maps/dir/?api=1&destination=Clinica',
    description: 'Enlace de Google Maps con indicaciones para llegar a la clínica',
  },
];

const COMPONENTS = [
  {
    type: 'BODY',
    text: 'Hola {{1}}, tenemos todo preparado para recibirte hoy a las {{2}}.\n\nEstamos en {{3}}\n\nTe dejo un enlace con la ubicación: {{4}}\n\n¿Sabes llegar? ¿Necesitas alguna indicación?',
    example: {
      body_text: [[
        'Juan',
        '10:30',
        'Calle Mayor 123, Madrid',
        'https://www.google.com/maps/dir/?api=1&destination=Clinica',
      ]],
    },
  },
];

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        variables: JSON.stringify(VARIABLES),
        components: JSON.stringify(COMPONENTS),
        propagation_state: null,
        updated_at: now,
      },
      { name: TEMPLATE_NAME }
    );
  },

  async down(queryInterface) {
    const previousVariables = VARIABLES.map((variable) => (
      variable.position === 4
        ? {
          ...variable,
          name: 'url_perfil_google_clinica',
          example: 'https://g.page/r/abcd1234',
          description: 'Enlace a la ficha o perfil de Google Business Profile de la clínica',
        }
        : variable
    ));
    const previousComponents = [
      {
        ...COMPONENTS[0],
        example: {
          body_text: [[
            'Juan',
            '10:30',
            'Calle Mayor 123, Madrid',
            'https://g.page/r/abcd1234',
          ]],
        },
      },
    ];

    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        variables: JSON.stringify(previousVariables),
        components: JSON.stringify(previousComponents),
        propagation_state: null,
        updated_at: new Date(),
      },
      { name: TEMPLATE_NAME }
    );
  },
};
