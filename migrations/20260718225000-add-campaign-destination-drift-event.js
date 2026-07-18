'use strict';

const BASE_EVENT_TYPES = Object.freeze([
  'landing_published',
  'destination_ready',
  'apply_requested',
  'apply_started',
  'readback_verified',
  'readback_failed',
  'rollback_requested',
  'rollback_started',
  'rollback_verified',
  'rollback_failed',
]);
const EVENT_TYPES = Object.freeze([...BASE_EVENT_TYPES, 'drift_detected']);

function tableName(value) {
  if (typeof value === 'string') return value;
  return value?.tableName || value?.name || '';
}

async function assertTable(queryInterface) {
  const tables = await queryInterface.showAllTables();
  if (!tables.some((table) => tableName(table).toLowerCase() === 'campaigndestinationbindingevents'.toLowerCase())) {
    const error = new Error('Falta CampaignDestinationBindingEvents; aplica primero la migración 20260717250000.');
    error.code = 'campaign_destination_drift_event_dependency_missing';
    throw error;
  }
  const definition = await queryInterface.describeTable('CampaignDestinationBindingEvents');
  if (!definition.event_type) {
    const error = new Error('CampaignDestinationBindingEvents no contiene event_type.');
    error.code = 'campaign_destination_drift_event_column_missing';
    throw error;
  }
  return definition;
}

function enumValues(metadata) {
  const raw = String(metadata?.type || metadata || '').trim();
  const match = raw.match(/^ENUM\((.*)\)$/i);
  if (!match) return [];
  return match[1].split(',').map((value) => value.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function assertCompatible(values, allowed, required) {
  if (!values.length) return;
  const unknown = values.filter((value) => !allowed.includes(value));
  const missing = required.filter((value) => !values.includes(value));
  if (unknown.length || missing.length) {
    const error = new Error('event_type tiene un ENUM incompatible; no se alterará automáticamente.');
    error.code = 'campaign_destination_drift_event_enum_incompatible';
    error.details = { unknown, missing };
    throw error;
  }
}

async function changeEventType(queryInterface, Sequelize, values) {
  await queryInterface.changeColumn('CampaignDestinationBindingEvents', 'event_type', {
    type: Sequelize.ENUM(...values),
    allowNull: false,
  });
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const definition = await assertTable(queryInterface);
    const current = enumValues(definition.event_type);
    assertCompatible(current, EVENT_TYPES, BASE_EVENT_TYPES);
    if (current.includes('drift_detected')) return;
    await changeEventType(queryInterface, Sequelize, EVENT_TYPES);
    const after = enumValues((await queryInterface.describeTable('CampaignDestinationBindingEvents')).event_type);
    if (after.length && !after.includes('drift_detected')) {
      const error = new Error('No se pudo verificar drift_detected tras alterar event_type.');
      error.code = 'campaign_destination_drift_event_enum_not_applied';
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const definition = await assertTable(queryInterface);
    const current = enumValues(definition.event_type);
    assertCompatible(current, EVENT_TYPES, BASE_EVENT_TYPES);
    if (!current.includes('drift_detected')) return;
    if (!queryInterface.sequelize?.query) {
      const error = new Error('No se puede verificar si existen eventos drift_detected antes del rollback.');
      error.code = 'campaign_destination_drift_event_rollback_preflight_unavailable';
      throw error;
    }
    const [rows] = await queryInterface.sequelize.query(
      "SELECT COUNT(*) AS row_count FROM `CampaignDestinationBindingEvents` WHERE `event_type` = 'drift_detected'"
    );
    if (Number(rows?.[0]?.row_count || 0) > 0) {
      const error = new Error('No se puede retirar drift_detected porque ya existen eventos auditables.');
      error.code = 'campaign_destination_drift_event_rollback_data_present';
      throw error;
    }
    await changeEventType(queryInterface, Sequelize, BASE_EVENT_TYPES);
  },
};
