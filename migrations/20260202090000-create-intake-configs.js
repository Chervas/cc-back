'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('IntakeConfigs', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      domains: { type: Sequelize.JSON, allowNull: true },
      config: { type: Sequelize.JSON, allowNull: true },
      hmac_key: { type: Sequelize.STRING(256), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('IntakeConfigs', { name: 'idx_intakeconfigs_clinic', fields: ['clinic_id'] });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('IntakeConfigs');
  }
};
