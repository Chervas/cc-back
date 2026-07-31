'use strict';

async function hasIndex(queryInterface, tableName, indexName) {
  const indexes = await queryInterface.showIndex(tableName);
  return indexes.some((index) => index.name === indexName);
}

async function addIndexIfMissing(queryInterface, tableName, fields, options) {
  if (!await hasIndex(queryInterface, tableName, options.name)) {
    await queryInterface.addIndex(tableName, fields, options);
  }
}

function tableExists(tables, expectedName) {
  return tables.some((table) => {
    const name = typeof table === 'string'
      ? table
      : (table?.tableName || table?.table_name || table?.name || '');
    return String(name).toLowerCase() === String(expectedName).toLowerCase();
  });
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tableExists(tables, 'PatientOperationalEvents')) {
      await queryInterface.createTable('PatientOperationalEvents', {
        id: {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
        },
        patient_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Pacientes', key: 'id_paciente' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        clinic_id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'Clinicas', key: 'id_clinica' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        actor_user_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Usuarios', key: 'id_usuario' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        event_type: { type: Sequelize.STRING(96), allowNull: false },
        source: { type: Sequelize.STRING(48), allowNull: false },
        channel: { type: Sequelize.STRING(24), allowNull: true },
        metadata: { type: Sequelize.JSON, allowNull: false },
        occurred_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
    }

    await addIndexIfMissing(
      queryInterface,
      'PatientOperationalEvents',
      ['patient_id', 'clinic_id', 'event_type', 'occurred_at'],
      { name: 'idx_patient_operational_events_patient_type_at' },
    );
    await addIndexIfMissing(
      queryInterface,
      'PatientOperationalEvents',
      ['clinic_id', 'event_type', 'occurred_at'],
      { name: 'idx_patient_operational_events_clinic_type_at' },
    );
    await addIndexIfMissing(
      queryInterface,
      'PatientOperationalEvents',
      ['actor_user_id', 'occurred_at'],
      { name: 'idx_patient_operational_events_actor_at' },
    );
    await addIndexIfMissing(
      queryInterface,
      'Pacientes',
      ['telefono_movil'],
      { name: 'idx_pacientes_phone' },
    );
    await addIndexIfMissing(
      queryInterface,
      'Pacientes',
      ['nombre', 'apellidos'],
      { name: 'idx_pacientes_name_surname' },
    );
    await addIndexIfMissing(
      queryInterface,
      'Pacientes',
      ['apellidos', 'nombre'],
      { name: 'idx_pacientes_surname_name' },
    );
  },

  async down(queryInterface) {
    for (const indexName of [
      'idx_pacientes_surname_name',
      'idx_pacientes_name_surname',
      'idx_pacientes_phone',
    ]) {
      if (await hasIndex(queryInterface, 'Pacientes', indexName)) {
        await queryInterface.removeIndex('Pacientes', indexName);
      }
    }
    const tables = await queryInterface.showAllTables();
    if (tableExists(tables, 'PatientOperationalEvents')) {
      await queryInterface.dropTable('PatientOperationalEvents');
    }
  },
};
