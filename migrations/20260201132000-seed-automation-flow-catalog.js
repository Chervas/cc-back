'use strict';

/**
 * Seed inicial del catálogo de automatizaciones.
 * Incluye algunas genéricas y otras asociadas a disciplinas.
 */

const catalogItems = [
  {
    name: 'auto_bienvenida_lead',
    display_name: 'Bienvenida Lead',
    description: 'Mensaje inicial de bienvenida tras la llegada de un lead.',
    trigger_type: 'lead_nuevo',
    is_generic: true,
    steps: [
      { id: 1, orden: 1, nombre: 'Lead nuevo', tipo: 'trigger', config: { type: 'lead_nuevo' }, siguiente_paso_id: 2 },
      {
        id: 2,
        orden: 2,
        nombre: 'Enviar WhatsApp',
        tipo: 'action',
        config: { type: 'enviar_whatsapp', template_name: 'clinicaclick_confirmacion_cita_con_enlace' },
        siguiente_paso_id: 3,
      },
      { id: 3, orden: 3, nombre: 'Fin', tipo: 'end', config: {} },
    ],
  },
  {
    name: 'auto_recordatorio_cita',
    display_name: 'Recordatorio de cita',
    description: 'Recordatorio automático tras crear una cita.',
    trigger_type: 'cita_creada',
    is_generic: true,
    steps: [
      { id: 1, orden: 1, nombre: 'Cita creada', tipo: 'trigger', config: { type: 'cita_creada' }, siguiente_paso_id: 2 },
      {
        id: 2,
        orden: 2,
        nombre: 'Enviar WhatsApp',
        tipo: 'action',
        config: { type: 'enviar_whatsapp', template_name: 'clinicaclick_recordatorio_mismo_dia_recurrente' },
        siguiente_paso_id: 3,
      },
      { id: 3, orden: 3, nombre: 'Fin', tipo: 'end', config: {} },
    ],
  },
  {
    name: 'auto_reactivar_paciente',
    display_name: 'Reactivación de paciente',
    description: 'Mensaje de reactivación para pacientes inactivos.',
    trigger_type: 'paciente_inactivo',
    is_generic: true,
    steps: [
      { id: 1, orden: 1, nombre: 'Paciente inactivo', tipo: 'trigger', config: { type: 'paciente_inactivo' }, siguiente_paso_id: 2 },
      {
        id: 2,
        orden: 2,
        nombre: 'Enviar WhatsApp',
        tipo: 'action',
        config: { type: 'enviar_whatsapp', template_name: 'clinicaclick_reactivar_paciente' },
        siguiente_paso_id: 3,
      },
      { id: 3, orden: 3, nombre: 'Fin', tipo: 'end', config: {} },
    ],
  },
  {
    name: 'auto_solicitar_resena',
    display_name: 'Solicitar reseña',
    description: 'Pide una reseña tras una interacción positiva.',
    trigger_type: 'presupuesto_aceptado',
    is_generic: true,
    steps: [
      { id: 1, orden: 1, nombre: 'Presupuesto aceptado', tipo: 'trigger', config: { type: 'presupuesto_aceptado' }, siguiente_paso_id: 2 },
      {
        id: 2,
        orden: 2,
        nombre: 'Enviar WhatsApp',
        tipo: 'action',
        config: { type: 'enviar_whatsapp', template_name: 'clinicaclick_solicitar_resena' },
        siguiente_paso_id: 3,
      },
      { id: 3, orden: 3, nombre: 'Fin', tipo: 'end', config: {} },
    ],
  },
  {
    name: 'auto_recordatorio_ortodoncia',
    display_name: 'Recordatorio Ortodoncia',
    description: 'Recordatorio específico para tratamientos de ortodoncia.',
    trigger_type: 'cita_creada',
    is_generic: false,
    steps: [
      { id: 1, orden: 1, nombre: 'Cita creada', tipo: 'trigger', config: { type: 'cita_creada' }, siguiente_paso_id: 2 },
      {
        id: 2,
        orden: 2,
        nombre: 'Enviar WhatsApp',
        tipo: 'action',
        config: { type: 'enviar_whatsapp', template_name: 'clinicaclick_recordatorio_domingo_recurrente' },
        siguiente_paso_id: 3,
      },
      { id: 3, orden: 3, nombre: 'Fin', tipo: 'end', config: {} },
    ],
  },
];

const disciplineMap = {
  auto_recordatorio_ortodoncia: ['dental'],
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    const rows = catalogItems.map((item) => ({
      name: item.name,
      display_name: item.display_name,
      description: item.description,
      trigger_type: item.trigger_type,
      steps: JSON.stringify(item.steps),
      is_generic: item.is_generic,
      is_active: true,
      created_at: now,
      updated_at: now,
    }));

    await queryInterface.bulkInsert('AutomationFlowCatalog', rows);

    const [items] = await queryInterface.sequelize.query('SELECT id, name FROM AutomationFlowCatalog');
    const disciplineRows = [];
    items.forEach((item) => {
      const codes = disciplineMap[item.name] || [];
      codes.forEach((code) => {
        disciplineRows.push({
          flow_catalog_id: item.id,
          disciplina_code: code,
          created_at: now,
          updated_at: now,
        });
      });
    });

    if (disciplineRows.length) {
      await queryInterface.bulkInsert('AutomationFlowCatalogDisciplines', disciplineRows);
    }
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('AutomationFlowCatalogDisciplines', null, {});
    await queryInterface.bulkDelete('AutomationFlowCatalog', null, {});
  },
};
