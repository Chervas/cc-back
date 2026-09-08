'use strict';

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'lead_auto_reply_rate_limit_graph_20260908';
const BASE_TEMPLATE_KEY = 'lead_auto_reply_system';
const FEATURE_KEY = 'lead_auto_reply';

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || ''));
  } catch (_error) {
    return fallback;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function cleanString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function toIntOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeSources(value) {
  const allowed = new Set(['write', 'call']);
  const source = Array.isArray(value) ? value : [value];
  return Array.from(new Set(source.map(cleanString).filter((item) => allowed.has(item))));
}

function normalizeConfig(raw = {}) {
  const timing = ['immediate', 'next_day'].includes(cleanString(raw.timing))
    ? cleanString(raw.timing)
    : 'immediate';
  const scheduleScope = ['clinic_hours', 'all_days'].includes(cleanString(raw.schedule_scope))
    ? cleanString(raw.schedule_scope)
    : 'clinic_hours';
  return {
    ...raw,
    managed_feature: FEATURE_KEY,
    managed_graph_version: 2,
    configured: raw.configured === true,
    sources: normalizeSources(raw.sources || raw.contact_sources),
    timing,
    schedule_scope: scheduleScope,
    whatsapp_template_id: toIntOrNull(raw.whatsapp_template_id || raw.template_id),
    whatsapp_template_name: cleanString(raw.whatsapp_template_name || raw.template_name) || null,
    whatsapp_template_language: cleanString(raw.whatsapp_template_language || raw.language_code) || null,
    sender_display_name: cleanString(raw.sender_display_name || raw.contact_person_name) || null,
    communication_scope: 'marketing',
  };
}

function leadTemplateBindings(config = {}) {
  const senderName = cleanString(config.sender_display_name);
  return {
    nombre: '{{lead.nombre}}',
    nombre_paciente: '{{lead.nombre}}',
    patient_name: '{{lead.nombre}}',
    first_name: '{{lead.nombre}}',
    telefono: '{{lead.telefono}}',
    telefono_paciente: '{{lead.telefono}}',
    email: '{{lead.email}}',
    email_paciente: '{{lead.email}}',
    nombre_clinica: '{{clinica.nombre}}',
    clinic_name: '{{clinica.nombre}}',
    telefono_clinica: '{{clinica.telefono}}',
    direccion_clinica: '{{clinica.direccion}}',
    nombre_remitente: senderName,
    sender_name: senderName,
    nombre_persona_contacto: senderName,
  };
}

function buildManagedNodes(config) {
  const callDelay = config.timing === 'immediate'
    ? { duration: 1, unit: 'hours' }
    : { duration: 0, unit: 'minutes' };
  const scheduleConfig = {
    mode: 'clinic_schedule',
    timing: config.timing,
    schedule_scope: config.schedule_scope,
    datetime_expression: '{{trigger.data.event_at}}',
  };
  const nodes = [
    {
      id: 'N1', type: 'trigger/lead_nuevo', config: clone(config),
      outputs: { on_success: config.sources.length === 2 ? 'N2' : (config.sources[0] === 'call' ? 'N4' : 'N3') },
      position: { x: 320, y: 120 },
    },
    {
      id: 'N3', type: 'delay/wait_until', config: scheduleConfig,
      outputs: { on_complete: 'N6' }, position: { x: 320, y: 520 },
    },
    {
      id: 'N6', type: 'condition/field_check',
      config: {
        mode: 'lead_contact_state',
        left_ref: { source: 'context', path: 'lead.id', value_type: 'number', label: 'Lead actual' },
        operator: 'exists',
      },
      outputs: { on_true: 'N7', on_false: 'N10' }, position: { x: 320, y: 700 },
    },
    {
      id: 'N7', type: 'condition/field_check',
      config: {
        mode: 'simple',
        left_ref: {
          source: 'trigger_data',
          path: 'historical_pending',
          value_type: 'boolean',
          label: '¿Es un lead nuevo?',
        },
        operator: 'equals',
        right_value: false,
        true_label: 'Sí, acaba de llegar',
        false_label: 'No, ya estaba pendiente',
      },
      outputs: { on_true: 'N9', on_false: 'N8' }, position: { x: 320, y: 880 },
    },
    {
      id: 'N8', type: 'control/rate_limit',
      config: {
        target_node_id: 'N9',
        target_node_label: 'Enviar WhatsApp',
        interval_duration: 30,
        interval_unit: 'minutes',
        bucket_prefix: FEATURE_KEY,
        respect_clinic_schedule: config.schedule_scope === 'clinic_hours',
        schedule_scope: config.schedule_scope,
        sender_mode: 'clinic_default',
        template_usage: FEATURE_KEY,
        communication_scope: 'marketing',
      },
      outputs: { on_complete: 'N9' }, position: { x: 620, y: 1060 },
    },
    {
      id: 'N9', type: 'action/send_whatsapp',
      config: {
        message_mode: 'template',
        template_id: config.whatsapp_template_id,
        template_name: config.whatsapp_template_name,
        language_code: config.whatsapp_template_language || 'es',
        recipient_mode: 'context_lead',
        sender_mode: 'clinic_default',
        quiet_hours_enabled: false,
        communication_scope: 'marketing',
        variables_named: leadTemplateBindings(config),
        template_usage: FEATURE_KEY,
      },
      outputs: { on_success: 'N10', on_fail: 'N10' }, position: { x: 320, y: 1240 },
    },
    {
      id: 'N10', type: 'control/end', config: {},
      outputs: {}, position: { x: 320, y: 1420 },
    },
  ];
  if (config.sources.length === 2) {
    nodes.push({
      id: 'N2', type: 'condition/field_check',
      config: {
        mode: 'simple',
        left_ref: { source: 'trigger_data', path: 'event_kind', value_type: 'string', label: '¿Cómo ha contactado?' },
        operator: 'equals', right_value: 'write',
        true_label: 'Ha escrito', false_label: 'Ha solicitado una llamada',
      },
      outputs: { on_true: 'N3', on_false: 'N4' }, position: { x: 320, y: 280 },
    });
  }
  if (config.sources.includes('call')) {
    nodes.push({
      id: 'N4', type: 'delay/fixed', config: callDelay,
      outputs: { on_complete: 'N3' }, position: { x: 620, y: 420 },
    });
  }
  return nodes;
}

function pickExistingColumns(payload, definition) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => definition[key]));
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const existingSnapshots = await queryInterface.sequelize.query(
        `SELECT snapshot_key FROM ${SNAPSHOT_TABLE}
          WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (existingSnapshots.length) return;

      const clinicTemplatePrefix = `${BASE_TEMPLATE_KEY}__clinic_`;
      const rows = await queryInterface.sequelize.query(
        `SELECT id, public_id, template_key, version, engine_version, name, description,
                trigger_type, trigger_config, is_active, is_system, clinic_id, group_id,
                entry_node_id, nodes, published_at, published_by, created_by
           FROM AutomationFlowTemplatesV2
          WHERE template_key = :baseTemplateKey
             OR LEFT(template_key, CHAR_LENGTH(:clinicTemplatePrefix)) = :clinicTemplatePrefix
             OR JSON_UNQUOTE(JSON_EXTRACT(trigger_config, '$.managed_feature')) = :featureKey
          ORDER BY public_id ASC, version DESC, id DESC
          FOR UPDATE`,
        {
          replacements: {
            baseTemplateKey: BASE_TEMPLATE_KEY,
            clinicTemplatePrefix,
            featureKey: FEATURE_KEY,
          },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const latestPublishedByPublicId = new Map();
      for (const row of rows) {
        if (row.published_at && !latestPublishedByPublicId.has(row.public_id)) {
          latestPublishedByPublicId.set(row.public_id, row);
        }
      }

      const previousJobsAutoStart = process.env.JOBS_AUTO_START;
      process.env.JOBS_AUTO_START = 'false';
      let validateFlowPayloadForInternalUse;
      try {
        ({ validateFlowPayloadForInternalUse } = require('../src/controllers/automationsV2.controller'));
      } finally {
        if (previousJobsAutoStart === undefined) delete process.env.JOBS_AUTO_START;
        else process.env.JOBS_AUTO_START = previousJobsAutoStart;
      }

      const definition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
      const inserted = [];
      const now = new Date();
      for (const source of latestPublishedByPublicId.values()) {
        const currentNodes = parseJson(source.nodes, []);
        if (currentNodes.some((node) => node?.type === 'control/rate_limit')) continue;

        const config = normalizeConfig(parseJson(source.trigger_config, {}) || {});
        if (!config.configured || !config.sources.length || !config.whatsapp_template_id) continue;
        const nodes = buildManagedNodes(config);
        const validation = await validateFlowPayloadForInternalUse({
          entry_node_id: 'N1',
          trigger_type: source.trigger_type,
          trigger_config: config,
          nodes,
        });
        if (!validation.ok) {
          throw new Error(`lead_auto_reply_rate_limit_graph_invalid:${source.public_id}:${JSON.stringify(validation.errors)}`);
        }

        const maxVersion = Math.max(
          ...rows.filter((row) => row.public_id === source.public_id).map((row) => Number(row.version) || 0),
        );
        const nextVersion = maxVersion + 1;
        const wasActive = Number(source.is_active) === 1;
        if (wasActive) {
          await queryInterface.bulkUpdate(
            'AutomationFlowTemplatesV2',
            { is_active: false, updated_at: now },
            { public_id: source.public_id },
            { transaction },
          );
        }
        await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [pickExistingColumns({
          public_id: source.public_id,
          template_key: source.template_key,
          version: nextVersion,
          engine_version: source.engine_version || 'v2',
          name: source.name,
          description: 'Responde por WhatsApp a nuevos leads y dosifica los contactos históricos pendientes.',
          trigger_type: source.trigger_type,
          trigger_config: JSON.stringify(config),
          is_active: wasActive,
          is_system: Number(source.is_system) === 1,
          clinic_id: source.clinic_id,
          group_id: source.group_id,
          entry_node_id: 'N1',
          nodes: JSON.stringify(nodes),
          published_at: now,
          published_by: source.published_by || source.created_by,
          created_by: source.created_by || 1,
          created_at: now,
          updated_at: now,
        }, definition)], { transaction });
        const createdRows = await queryInterface.sequelize.query(
          `SELECT id FROM AutomationFlowTemplatesV2
            WHERE public_id = :publicId AND version = :version LIMIT 1`,
          {
            replacements: { publicId: source.public_id, version: nextVersion },
            type: queryInterface.sequelize.QueryTypes.SELECT,
            transaction,
          },
        );
        if (!createdRows[0]?.id) throw new Error('lead_auto_reply_rate_limit_graph_insert_failed');
        inserted.push({
          id: Number(createdRows[0].id),
          previous_id: Number(source.id),
          previous_was_active: wasActive,
        });
      }

      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({ inserted }),
        created_at: now,
      }], { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const rows = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE}
          WHERE snapshot_key = :snapshotKey LIMIT 1 FOR UPDATE`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const snapshot = parseJson(rows[0]?.payload, {});
      for (const item of Array.isArray(snapshot.inserted) ? snapshot.inserted : []) {
        await queryInterface.bulkDelete('AutomationFlowTemplatesV2', { id: item.id }, { transaction });
        if (item.previous_was_active) {
          await queryInterface.bulkUpdate(
            'AutomationFlowTemplatesV2',
            { is_active: true, updated_at: new Date() },
            { id: item.previous_id },
            { transaction },
          );
        }
      }
      await queryInterface.bulkDelete(SNAPSHOT_TABLE, { snapshot_key: SNAPSHOT_KEY }, { transaction });
    });
  },

  __testing: { buildManagedNodes, normalizeConfig },
};
