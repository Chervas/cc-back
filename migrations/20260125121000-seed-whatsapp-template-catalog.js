'use strict';

/**
 * Seed inicial del catálogo de plantillas WhatsApp con components + examples.
 * Categorías: 8 UTILITY, 11 MARKETING.
 * Todas marcadas como is_generic=true para aplicarlas a cualquier disciplina
 * (puede refinarse después en la tabla de disciplinas si se requiere).
 */

const templates = [
  // UTILITY
  {
    name: 'clinicaclick_confirmacion_cita',
    display_name: 'Confirmación de cita',
    category: 'UTILITY',
    body_text: '¡Hola {{1}}! Soy {{2}}, hemos hablado hace unos minutos. Hemos agendado tu cita para el {{3}}. Recuerda que estamos en {{4}}. ¿Me confirmas que recibes este mensaje? Gracias 😊',
    vars: ['paciente', 'usuario', 'fecha_cita', 'ubicacion'],
    example: ['Juan', 'María', '15 de enero a las 10:00', 'Calle Mayor 10'],
  },
  {
    name: 'clinicaclick_confirmacion_cita_con_enlace',
    display_name: 'Confirmación de cita con enlace',
    category: 'UTILITY',
    body_text: '¡Hola {{1}}! Soy {{2}}, hemos hablado hace unos minutos. Hemos agendado tu cita para el {{3}}, pero para confirmarla necesitamos que rellenes estos datos en las próximas horas: {{4}}',
    vars: ['paciente', 'usuario', 'fecha_cita', 'enlace_form'],
    example: ['Juan', 'María', '15 de enero a las 10:00', 'https://tucita.com/form'],
  },
  {
    name: 'clinicaclick_recordatorio_domingo_primera_visita',
    display_name: 'Recordatorio domingo (primera visita)',
    category: 'UTILITY',
    body_text: 'Hola {{1}}, perdona por molestarte un domingo 🙏 Es solo para recordarte tu cita de mañana a las {{2}} en {{3}}. Recuerda que estamos en {{4}}. ¿Me la confirmas?',
    vars: ['paciente', 'hora', 'clinica', 'ubicacion'],
    example: ['Juan', '10:00', 'Clínica Arriaga', 'Calle Mayor 10'],
  },
  {
    name: 'clinicaclick_recordatorio_mismo_dia_primera_visita',
    display_name: 'Recordatorio mismo día 8:00 (primera visita)',
    category: 'UTILITY',
    body_text: 'Hola {{1}}, tenemos todo preparado para recibirte hoy a las {{2}}. ¿Sabes llegar? Te dejo un enlace con la ubicación: {{3}}',
    vars: ['paciente', 'hora', 'enlace_ubicacion'],
    example: ['Juan', '10:00', 'https://maps.example.com/clinica'],
  },
  {
    name: 'clinicaclick_recordatorio_domingo_recurrente',
    display_name: 'Recordatorio domingo (recurrente)',
    category: 'UTILITY',
    body_text: 'Hola {{1}}, perdona por molestarte un domingo 🙏 Es solo para recordarte tu cita de mañana a las {{2}} en {{3}}. ¿Me la confirmas?',
    vars: ['paciente', 'hora', 'clinica'],
    example: ['Juan', '10:00', 'Clínica Arriaga'],
  },
  {
    name: 'clinicaclick_recordatorio_mismo_dia_recurrente',
    display_name: 'Recordatorio mismo día (recurrente)',
    category: 'UTILITY',
    body_text: 'Hola {{1}}, tenemos todo preparado para recibirte hoy a las {{2}}. Te esperamos 😊',
    vars: ['paciente', 'hora'],
    example: ['Juan', '10:00'],
  },
  {
    name: 'clinicaclick_cita_cancelada',
    display_name: 'Cita cancelada',
    category: 'UTILITY',
    body_text: 'Hola {{1}}, tu cita prevista para el {{2}} ha sido cancelada. Si deseas reprogramarla, dímelo y lo vemos enseguida.',
    vars: ['paciente', 'fecha_cita'],
    example: ['Juan', '15 de enero'],
  },
  {
    name: 'clinicaclick_no_show',
    display_name: 'Paciente no acudió',
    category: 'UTILITY',
    body_text: 'Hola {{1}}, te estuvimos esperando y finalmente no pudiste venir 😕 Si quieres, puedo agendarte otra cita cuando te venga mejor.',
    vars: ['paciente'],
    example: ['Juan'],
  },
  // MARKETING
  {
    name: 'clinicaclick_solicitar_resena',
    display_name: 'Solicitar reseña',
    category: 'MARKETING',
    body_text: 'Hola {{1}}, ¿me ayudaría mucho una valoración sobre tu experiencia en {{2}}? Es solo un minuto. Pincha en el siguiente enlace: {{3}}. Gracias 😊',
    vars: ['paciente', 'clinica', 'enlace_resena'],
    example: ['Juan', 'Clínica Arriaga', 'https://reviews.example.com'],
  },
  {
    name: 'clinicaclick_reactivar_paciente',
    display_name: 'Reactivar paciente',
    category: 'MARKETING',
    body_text: 'Hola {{1}}, ¿qué tal estás? Hace tiempo que no te vemos por {{2}}. Solo recordarte que aquí estamos para cualquier cosa 😊',
    vars: ['paciente', 'clinica'],
    example: ['Juan', 'Clínica Arriaga'],
  },
  {
    name: 'clinicaclick_cumpleanos_nino',
    display_name: 'Cumpleaños niño',
    category: 'MARKETING',
    body_text: 'Hola {{1}}, hoy cumple años {{2}} 🎉 Desde {{3}} le mandamos una felicitación muy especial. ¡Esperamos veros pronto!',
    vars: ['tutor', 'nino', 'clinica'],
    example: ['Laura', 'Pepe', 'Clínica Arriaga'],
  },
  {
    name: 'clinicaclick_cumpleanos_adulto',
    display_name: 'Cumpleaños adulto',
    category: 'MARKETING',
    body_text: 'Hola {{1}} 🎉 Desde {{2}} queremos desearte un feliz cumpleaños. Que tengas un día estupendo 😊',
    vars: ['paciente', 'clinica'],
    example: ['Juan', 'Clínica Arriaga'],
  },
  {
    name: 'clinicaclick_cumpleanos_mayor',
    display_name: 'Cumpleaños mayor',
    category: 'MARKETING',
    body_text: 'Hola {{1}}, desde {{2}} queremos desearte un feliz cumpleaños 🎉 Te mandamos un fuerte abrazo y nuestros mejores deseos.',
    vars: ['paciente', 'clinica'],
    example: ['Juan', 'Clínica Arriaga'],
  },
  {
    name: 'clinicaclick_cumpleanos_promo_nino',
    display_name: 'Cumpleaños promo niño',
    category: 'MARKETING',
    body_text: 'Hola {{1}}, hoy cumple años {{2}} 🎉 Desde {{3}} queremos hacerle un regalo especial: {{4}}. Tenéis {{5}} días para solicitarlo 😊',
    vars: ['tutor', 'nino', 'clinica', 'regalo', 'dias'],
    example: ['Laura', 'Pepe', 'Clínica Arriaga', 'limpieza gratuita', '7'],
  },
  {
    name: 'clinicaclick_cumpleanos_promo_adulto',
    display_name: 'Cumpleaños promo adulto',
    category: 'MARKETING',
    body_text: 'Hola {{1}} 🎉 Desde {{2}} queremos celebrarlo contigo regalándote {{3}}. Tienes {{4}} días para solicitarlo. ¡Disfrútalo!',
    vars: ['paciente', 'clinica', 'regalo', 'dias'],
    example: ['Juan', 'Clínica Arriaga', 'un blanqueamiento', '7'],
  },
  {
    name: 'clinicaclick_cumpleanos_promo_mayor',
    display_name: 'Cumpleaños promo mayor',
    category: 'MARKETING',
    body_text: 'Hola {{1}} 🎉 Desde {{2}} queremos felicitarte y regalarte {{3}}. Puedes solicitarlo durante los próximos {{4}} días.',
    vars: ['paciente', 'clinica', 'regalo', 'dias'],
    example: ['Juan', 'Clínica Arriaga', 'una revisión gratuita', '7'],
  },
  {
    name: 'clinicaclick_navidad_nino',
    display_name: 'Navidad niño',
    category: 'MARKETING',
    body_text: 'Hola {{1}} 🎄 Desde {{2}} queremos desearos una Feliz Navidad y un Próspero Año Nuevo para {{3}} y toda la familia ✨',
    vars: ['tutor', 'clinica', 'nino'],
    example: ['Laura', 'Clínica Arriaga', 'Pepe'],
  },
  {
    name: 'clinicaclick_navidad_adulto',
    display_name: 'Navidad adulto',
    category: 'MARKETING',
    body_text: 'Hola {{1}} 🎄 Desde {{2}} te deseamos una Feliz Navidad y un Próspero Año Nuevo ✨ Gracias por confiar en nosotros.',
    vars: ['paciente', 'clinica'],
    example: ['Juan', 'Clínica Arriaga'],
  },
  {
    name: 'clinicaclick_navidad_mayor',
    display_name: 'Navidad mayor',
    category: 'MARKETING',
    body_text: 'Hola {{1}} 🎄 Desde {{2}} queremos desearte una Feliz Navidad y un Próspero Año Nuevo ✨ Con todo nuestro cariño.',
    vars: ['paciente', 'clinica'],
    example: ['Juan', 'Clínica Arriaga'],
  },
];

function buildComponents(bodyText, exampleValues) {
  return [
    {
      type: 'BODY',
      text: bodyText,
      example: {
        body_text: [exampleValues],
      },
    },
  ];
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    const rows = templates.map((t) => ({
      name: t.name,
      display_name: t.display_name,
      category: t.category,
      body_text: t.body_text,
      variables: JSON.stringify((t.vars || []).map((v, idx) => ({ position: idx + 1, name: v }))),
      components: JSON.stringify(buildComponents(t.body_text, t.example || [])),
      is_generic: true,
      is_active: true,
      created_at: now,
      updated_at: now,
    }));
    await queryInterface.bulkInsert('WhatsappTemplateCatalog', rows);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete('WhatsappTemplateCatalog', null, {});
  },
};
