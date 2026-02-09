'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Permitir configuraciones a nivel de grupo (clinic_id = NULL)
    await queryInterface.changeColumn('IntakeConfigs', 'clinic_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'Clinicas', key: 'id_clinica' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    });

    // Asegurar 1 config por grupo (group_id). Los clinic rows llevan group_id NULL.
    try {
      await queryInterface.removeIndex('IntakeConfigs', 'idx_intakeconfigs_group');
    } catch (_) {}

    await queryInterface.addIndex('IntakeConfigs', {
      name: 'uidx_intakeconfigs_group',
      unique: true,
      fields: ['group_id']
    });
  },

  async down(queryInterface, Sequelize) {
    try {
      await queryInterface.removeIndex('IntakeConfigs', 'uidx_intakeconfigs_group');
    } catch (_) {}

    // Restaurar el índice no-único previo (si se desea volver atrás)
    await queryInterface.addIndex('IntakeConfigs', {
      name: 'idx_intakeconfigs_group',
      fields: ['group_id']
    });

    await queryInterface.changeColumn('IntakeConfigs', 'clinic_id', {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: 'Clinicas', key: 'id_clinica' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    });
  }
};

