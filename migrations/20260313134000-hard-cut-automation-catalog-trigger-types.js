'use strict';

const TRIGGER_MAP = {
  nuevo_lead: 'lead_nuevo',
  lead_nuevo: 'lead_nuevo',
  cita_creada: 'appointment_created',
  cita_confirmada: 'appointment_confirmed',
  cita_cancelada: 'appointment_cancelled',
  recordatorio_cita: 'appointment_reminder_window',
  paciente_inactivo: 'patient_inactive',
  seguimiento_lead: 'patient_inactive',
  presupuesto_aceptado: 'quote_accepted',
  post_tratamiento: 'treatment_completed',
  cumpleanos: 'birthday',
};

function normalizeTriggerType(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return TRIGGER_MAP[value] || value || null;
}

function normalizeSteps(raw) {
  if (!raw) return raw;
  let parsed = raw;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      return raw;
    }
  }
  if (!Array.isArray(parsed)) return raw;

  let changed = false;
  const next = parsed.map((step) => {
    if (!step || typeof step !== 'object') return step;
    if (step.tipo !== 'trigger' || !step.config || typeof step.config !== 'object') return step;
    const nextType = normalizeTriggerType(step.config.type);
    if (!nextType || nextType === step.config.type) return step;
    changed = true;
    return {
      ...step,
      config: {
        ...step.config,
        type: nextType,
      },
    };
  });

  return changed ? next : parsed;
}

async function migrateCatalogTable(queryInterface, Sequelize) {
  const [rows] = await queryInterface.sequelize.query(`
    SELECT id, trigger_type, steps
    FROM AutomationFlowCatalog
  `);

  for (const row of rows) {
    const nextTriggerType = normalizeTriggerType(row.trigger_type);
    const nextSteps = normalizeSteps(row.steps);
    const stepsChanged = JSON.stringify(nextSteps) !== JSON.stringify(
      typeof row.steps === 'string' ? (() => {
        try { return JSON.parse(row.steps); } catch (error) { return row.steps; }
      })() : row.steps
    );

    if (nextTriggerType !== row.trigger_type || stepsChanged) {
      await queryInterface.bulkUpdate(
        'AutomationFlowCatalog',
        {
          trigger_type: nextTriggerType,
          steps: nextSteps,
          updated_at: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        { id: row.id }
      );
    }
  }
}

async function migrateAutomationFlowsTable(queryInterface, Sequelize) {
  const [rows] = await queryInterface.sequelize.query(`
    SELECT id, disparador, pasos, acciones
    FROM AutomationFlows
  `);

  for (const row of rows) {
    const nextDisparador = normalizeTriggerType(row.disparador);
    const nextPasos = normalizeSteps(row.pasos);
    const nextAcciones = normalizeSteps(row.acciones);

    const pasosBefore = typeof row.pasos === 'string' ? (() => {
      try { return JSON.parse(row.pasos); } catch (error) { return row.pasos; }
    })() : row.pasos;
    const accionesBefore = typeof row.acciones === 'string' ? (() => {
      try { return JSON.parse(row.acciones); } catch (error) { return row.acciones; }
    })() : row.acciones;

    const pasosChanged = JSON.stringify(nextPasos) !== JSON.stringify(pasosBefore);
    const accionesChanged = JSON.stringify(nextAcciones) !== JSON.stringify(accionesBefore);

    if (nextDisparador !== row.disparador || pasosChanged || accionesChanged) {
      await queryInterface.bulkUpdate(
        'AutomationFlows',
        {
          disparador: nextDisparador,
          pasos: nextPasos,
          acciones: nextAcciones,
          updated_at: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        { id: row.id }
      );
    }
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await migrateCatalogTable(queryInterface, Sequelize);
    await migrateAutomationFlowsTable(queryInterface, Sequelize);
  },

  async down(queryInterface, Sequelize) {
    // Hard cut sin rollback semántico de nombres legacy.
    return Promise.resolve();
  },
};
