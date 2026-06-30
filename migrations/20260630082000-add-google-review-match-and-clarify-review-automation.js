'use strict';

const TABLE = 'BusinessProfileReviews';

async function addColumnIfMissing(queryInterface, table, column, definition) {
  const schema = await queryInterface.describeTable(table);
  if (!schema[column]) {
    await queryInterface.addColumn(table, column, definition);
  }
}

async function addIndexSafe(queryInterface, table, fields, name) {
  try {
    await queryInterface.addIndex(table, fields, { name });
  } catch (error) {
    if (!String(error?.message || '').toLowerCase().includes('duplicate')) {
      throw error;
    }
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, TABLE, 'matched_paciente_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, TABLE, 'matched_contact_event_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, TABLE, 'match_confidence', {
      type: Sequelize.FLOAT,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, TABLE, 'match_reason', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, TABLE, 'matched_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await addIndexSafe(queryInterface, TABLE, ['matched_paciente_id'], 'idx_business_profile_reviews_matched_paciente');
    await addIndexSafe(queryInterface, TABLE, ['matched_contact_event_id'], 'idx_business_profile_reviews_matched_event');

    await queryInterface.sequelize.query(`
      UPDATE AutomationFlowTemplatesV2
      SET name = 'Solicitar reseña tras cita completada · Base de sistema',
          updated_at = NOW()
      WHERE template_key = 'system_review_request_after_appointment_completed'
        AND is_system = 1
    `);

    await queryInterface.sequelize.query(`
      UPDATE AutomationFlowTemplatesV2 t
      LEFT JOIN Clinicas c ON c.id_clinica = t.clinic_id
      SET t.name = CONCAT('Solicitar reseña tras cita completada · ', COALESCE(c.nombre_clinica, 'Clínica')),
          t.updated_at = NOW()
      WHERE t.trigger_type = 'appointment_completed'
        AND t.is_system = 0
        AND (
          t.template_key LIKE 'review_request_after_completed__clinic_%'
          OR t.template_key LIKE 'system_review_request_after_appointment_completed__clinic_%'
        )
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE AutomationFlowTemplatesV2
      SET name = 'Solicitar reseña tras cita completada',
          updated_at = NOW()
      WHERE trigger_type = 'appointment_completed'
        AND name LIKE 'Solicitar reseña tras cita completada · %'
    `);

    const schema = await queryInterface.describeTable(TABLE);
    for (const column of ['matched_at', 'match_reason', 'match_confidence', 'matched_contact_event_id', 'matched_paciente_id']) {
      if (schema[column]) {
        await queryInterface.removeColumn(TABLE, column);
      }
    }
  },
};
