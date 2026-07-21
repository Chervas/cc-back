'use strict';

const LEAD_WITH_CALL_FAMILY = 'clinicaclick_lead_primera_visita_con_llamada';
const RESCHEDULE_FAMILY = 'clinicaclick_cita_reprogramada_peticion_paciente';
const FLOW_KEY = 'appointment_rescheduled_patient_request_system';

const CATALOG_ROWS = [
  {
    name: LEAD_WITH_CALL_FAMILY,
    family_key: LEAD_WITH_CALL_FAMILY,
    locale: 'es',
    display_name: 'Primera cita con llamada previa',
    body_text: 'Hola {{1}} 😊 te escribo desde {{2}}. Hemos intentado llamarte por tu solicitud para realizar una primera visita. ¿Quieres que la programemos por aquí?',
    variables: [
      { position: 1, name: 'nombre_paciente', example: 'Jordi', description: 'Nombre del paciente o lead', template_usage: 'lead_primera_visita' },
      { position: 2, name: 'nombre_clinica', example: 'Propdental Sants', description: 'Nombre visible de la clínica', template_usage: 'lead_primera_visita' },
    ],
  },
  {
    name: RESCHEDULE_FAMILY,
    family_key: RESCHEDULE_FAMILY,
    locale: 'es',
    display_name: 'Cita reprogramada a petición del paciente',
    body_text: 'Hola {{1}}, tal como acabamos de hablar, hemos reprogramado tu cita para el día {{2}} a las {{3}}. ¿Nos confirmas el cambio?',
  },
  {
    name: `${RESCHEDULE_FAMILY}_ca`,
    family_key: RESCHEDULE_FAMILY,
    locale: 'ca',
    display_name: 'Cita reprogramada a petició del pacient',
    body_text: 'Hola {{1}}, tal com acabem de parlar, hem reprogramat la teva cita per al dia {{2}} a les {{3}}. Ens confirmes el canvi?',
  },
  {
    name: `${RESCHEDULE_FAMILY}_en`,
    family_key: RESCHEDULE_FAMILY,
    locale: 'en',
    display_name: 'Appointment rescheduled at patient request',
    body_text: 'Hi {{1}}, as we have just discussed, we have rescheduled your appointment for {{2}} at {{3}}. Could you confirm the change?',
  },
];

function appointmentVariables() {
  return [
    { position: 1, name: 'nombre_paciente', example: 'Jordi', description: 'Nombre del paciente' },
    { position: 2, name: 'fecha_cita', example: '24/07/2026', description: 'Nueva fecha de la cita' },
    { position: 3, name: 'hora_cita', example: '16:30', description: 'Nueva hora de la cita' },
  ];
}

function components(row) {
  const variables = row.variables || appointmentVariables();
  return [{
    type: 'BODY',
    text: row.body_text,
    example: { body_text: [variables.map((item) => item.example)] },
  }];
}

async function upsertCatalogRow(queryInterface, row, now) {
  const [existing] = await queryInterface.sequelize.query(
    `SELECT id FROM WhatsappTemplateCatalog
     WHERE family_key = :familyKey AND locale = :locale
     LIMIT 1`,
    {
      replacements: { familyKey: row.family_key, locale: row.locale },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );
  const payload = {
    name: row.name,
    family_key: row.family_key,
    locale: row.locale,
    display_name: row.display_name,
    category: 'UTILITY',
    body_text: row.body_text,
    variables: JSON.stringify(row.variables || appointmentVariables()),
    components: JSON.stringify(components(row)),
    last_propagated_at: null,
    propagation_state: null,
    is_generic: true,
    is_active: true,
    updated_at: now,
  };
  if (existing?.id) {
    await queryInterface.bulkUpdate('WhatsappTemplateCatalog', payload, { id: existing.id });
    return existing.id;
  }
  await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{ ...payload, created_at: now }]);
  const [created] = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE family_key = :familyKey AND locale = :locale LIMIT 1',
    {
      replacements: { familyKey: row.family_key, locale: row.locale },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );
  return created?.id || null;
}

function cloneJson(value, fallback) {
  if (value && typeof value === 'object') return JSON.parse(JSON.stringify(value));
  try { return JSON.parse(String(value || '')); } catch (_error) { return fallback; }
}

function reachableNodes(nodes, entryNodeId) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pending = [entryNodeId];
  const reachable = new Set();
  while (pending.length) {
    const nodeId = pending.shift();
    if (!nodeId || reachable.has(nodeId)) continue;
    const node = byId.get(nodeId);
    if (!node) continue;
    reachable.add(nodeId);
    Object.values(node.outputs || {}).forEach((targetId) => {
      if (typeof targetId === 'string' && targetId) pending.push(targetId);
    });
  }
  return nodes.filter((node) => reachable.has(node.id));
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    const table = await queryInterface.describeTable('CitasPacientes');
    if (!table.reschedule_reason) {
      await queryInterface.addColumn('CitasPacientes', 'reschedule_reason', {
        type: Sequelize.STRING(32),
        allowNull: true,
        after: 'motivo',
      });
    }

    await queryInterface.sequelize.query(
      `UPDATE WhatsappTemplateCatalog
       SET display_name = 'Primera cita sin llamada previa', updated_at = :now
       WHERE family_key = 'clinicaclick_lead_primera_visita_programar'`,
      { replacements: { now } }
    );

    const catalogIds = {};
    for (const row of CATALOG_ROWS) {
      catalogIds[row.locale === 'es' && row.family_key === LEAD_WITH_CALL_FAMILY ? 'lead' : row.locale] = await upsertCatalogRow(queryInterface, row, now);
    }

    const [source] = await queryInterface.sequelize.query(
      `SELECT nodes
       FROM AutomationFlowTemplatesV2
       WHERE trigger_type = 'appointment_rescheduled'
         AND published_at IS NOT NULL
         AND clinic_id IS NULL
       ORDER BY version DESC, id DESC
       LIMIT 1`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    const nodes = cloneJson(source?.nodes, []);
    const triggerNode = nodes.find((node) => node.id === 'N1');
    const sendNode = nodes.find((node) => node.id === 'N5');
    if (!triggerNode || !sendNode) {
      throw new Error('appointment_rescheduled_source_flow_missing');
    }

    triggerNode.outputs = { on_success: 'N5' };
    sendNode.config = {
      ...sendNode.config,
      variables: { 1: '{{paciente.nombre}}', 2: '{{cita.fecha}}', 3: '{{cita.hora}}' },
      variables_named: {
        nombre_paciente: '{{paciente.nombre}}',
        fecha_cita: '{{cita.fecha}}',
        hora_cita: '{{cita.hora}}',
      },
      template_id: '',
      template_name: RESCHEDULE_FAMILY,
      language_code: 'es',
      catalog_template_id: catalogIds.es,
      require_current_catalog_body: true,
      language_routing: {
        source: 'patient_preferred_language',
        enabled: true,
        variants: {
          ca: {
            template_id: '',
            template_name: `${RESCHEDULE_FAMILY}_ca`,
            language_code: 'ca',
            catalog_family_key: RESCHEDULE_FAMILY,
            catalog_template_id: catalogIds.ca,
            variables: { 1: '{{paciente.nombre}}', 2: '{{cita.fecha}}', 3: '{{cita.hora}}' },
            variables_named: {
              nombre_paciente: '{{paciente.nombre}}',
              fecha_cita: '{{cita.fecha}}',
              hora_cita: '{{cita.hora}}',
            },
          },
          en: {
            template_id: '',
            template_name: `${RESCHEDULE_FAMILY}_en`,
            language_code: 'en_US',
            catalog_family_key: RESCHEDULE_FAMILY,
            catalog_template_id: catalogIds.en,
            variables: { 1: '{{paciente.nombre}}', 2: '{{cita.fecha}}', 3: '{{cita.hora}}' },
            variables_named: {
              nombre_paciente: '{{paciente.nombre}}',
              fecha_cita: '{{cita.fecha}}',
              hora_cita: '{{cita.hora}}',
            },
          },
        },
      },
    };
    const flowNodes = reachableNodes(nodes, 'N1');

    const [existingFlow] = await queryInterface.sequelize.query(
      'SELECT id FROM AutomationFlowTemplatesV2 WHERE template_key = :key AND version = 1 LIMIT 1',
      { replacements: { key: FLOW_KEY }, type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    const flowPayload = {
      public_id: 'flw_appointment_rescheduled_patient_request_system',
      engine_version: 'v2',
      name: 'Confirmar cambio solicitado por el paciente',
      description: 'Confirma por WhatsApp una reprogramación pedida por el paciente sin enviar el aviso de cambio por necesidades de agenda.',
      trigger_type: 'appointment_rescheduled',
      trigger_config: JSON.stringify({ reschedule_reasons: ['patient_request'] }),
      is_active: true,
      is_system: true,
      clinic_id: null,
      group_id: null,
      entry_node_id: 'N1',
      nodes: JSON.stringify(flowNodes),
      published_at: now,
      published_by: 1,
      created_by: 1,
      updated_at: now,
    };
    if (existingFlow?.id) {
      await queryInterface.bulkUpdate('AutomationFlowTemplatesV2', flowPayload, { id: existingFlow.id });
    } else {
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [{
        template_key: FLOW_KEY,
        version: 1,
        ...flowPayload,
        created_at: now,
      }]);
    }
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('AutomationFlowTemplatesV2', { template_key: FLOW_KEY });
    await queryInterface.sequelize.query(
      `UPDATE WhatsappTemplateCatalog
       SET is_active = 0, propagation_state = NULL, updated_at = :now
       WHERE family_key IN (:families)`,
      { replacements: { now: new Date(), families: [LEAD_WITH_CALL_FAMILY, RESCHEDULE_FAMILY] } }
    );
    const table = await queryInterface.describeTable('CitasPacientes');
    if (table.reschedule_reason) {
      await queryInterface.removeColumn('CitasPacientes', 'reschedule_reason');
    }
  },
};
