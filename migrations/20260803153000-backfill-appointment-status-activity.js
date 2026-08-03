'use strict';

const EVENT_TYPE = 'appointment.status_changed';
const SOURCE = 'automation_v2';

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const tableNames = new Set(tables.map((table) => String(
      typeof table === 'string' ? table : (table?.tableName || table?.table_name || table?.name || '')
    ).toLowerCase()));
    if (!tableNames.has('patientoperationalevents') || !tableNames.has('flowexecutionlogsv2')) {
      return;
    }

    const [existingRows] = await queryInterface.sequelize.query(
      'SELECT metadata FROM PatientOperationalEvents WHERE event_type = ? AND source = ?',
      { replacements: [EVENT_TYPE, SOURCE] },
    );
    const existingFlowLogIds = new Set(existingRows
      .map((row) => positiveInt(parseJson(row.metadata).flow_log_id))
      .filter(Boolean));

    const [logs] = await queryInterface.sequelize.query(`
      SELECT
        log.id AS flow_log_id,
        log.flow_execution_id,
        log.node_id,
        log.finished_at,
        log.started_at,
        log.audit_snapshot,
        execution.template_version_id,
        execution.trigger_type,
        template.public_id AS flow_public_id,
        template.name AS flow_name,
        template.version AS flow_version
      FROM FlowExecutionLogsV2 log
      INNER JOIN FlowExecutionsV2 execution ON execution.id = log.flow_execution_id
      LEFT JOIN AutomationFlowTemplatesV2 template ON template.id = execution.template_version_id
      WHERE log.node_type = 'action/change_status'
        AND log.status = 'success'
      ORDER BY log.id ASC
    `);

    const candidates = [];
    const appointmentIds = new Set();
    for (const log of logs) {
      if (existingFlowLogIds.has(positiveInt(log.flow_log_id))) continue;
      const snapshot = parseJson(log.audit_snapshot);
      const output = snapshot?.node_output_after && typeof snapshot.node_output_after === 'object'
        ? snapshot.node_output_after
        : {};
      const targetType = String(output.target_type || output.target_entity || '').trim().toLowerCase();
      const appointmentId = positiveInt(output.target_id);
      const previousStatus = String(output.previous_status || '').trim().toLowerCase() || null;
      const newStatus = String(output.new_status || '').trim().toLowerCase() || null;
      if (targetType !== 'appointment' || !appointmentId || !newStatus || previousStatus === newStatus || output.skipped === true) {
        continue;
      }
      candidates.push({ log, appointmentId, previousStatus, newStatus });
      appointmentIds.add(appointmentId);
    }
    if (!candidates.length) return;

    const [appointments] = await queryInterface.sequelize.query(
      'SELECT id_cita, paciente_id, clinica_id FROM CitasPacientes WHERE id_cita IN (:appointmentIds)',
      { replacements: { appointmentIds: Array.from(appointmentIds) } },
    );
    const appointmentById = new Map(appointments.map((row) => [Number(row.id_cita), row]));
    const now = new Date();
    const inserts = candidates.flatMap(({ log, appointmentId, previousStatus, newStatus }) => {
      const appointment = appointmentById.get(appointmentId);
      if (!appointment) return [];
      return [{
        patient_id: positiveInt(appointment.paciente_id),
        clinic_id: positiveInt(appointment.clinica_id),
        actor_user_id: null,
        event_type: EVENT_TYPE,
        source: SOURCE,
        channel: null,
        metadata: JSON.stringify({
          appointment_id: appointmentId,
          previous_status: previousStatus,
          new_status: newStatus,
          flow_log_id: positiveInt(log.flow_log_id),
          flow_execution_id: positiveInt(log.flow_execution_id),
          flow_template_version_id: positiveInt(log.template_version_id),
          flow_public_id: log.flow_public_id || null,
          flow_name: log.flow_name || null,
          flow_version: positiveInt(log.flow_version),
          node_id: log.node_id || null,
          trigger_type: log.trigger_type || null,
          backfilled_from_flow_log: true,
        }),
        occurred_at: log.finished_at || log.started_at || now,
        created_at: now,
      }];
    });

    const chunkSize = 250;
    for (let index = 0; index < inserts.length; index += chunkSize) {
      await queryInterface.bulkInsert('PatientOperationalEvents', inserts.slice(index, index + chunkSize));
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM PatientOperationalEvents
      WHERE event_type = :eventType
        AND source = :source
        AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.backfilled_from_flow_log')) = 'true'
    `, {
      replacements: { eventType: EVENT_TYPE, source: SOURCE },
    });
  },
};
