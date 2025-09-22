'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ClinicAnalyticsProperties', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      clinicaId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      googleConnectionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'GoogleConnections', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      propertyName: { type: Sequelize.STRING(128), allowNull: false },
      propertyDisplayName: { type: Sequelize.STRING(256), allowNull: true },
      propertyType: { type: Sequelize.STRING(32), allowNull: true },
      parent: { type: Sequelize.STRING(128), allowNull: true },
      measurementId: { type: Sequelize.STRING(128), allowNull: true },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('ClinicAnalyticsProperties', ['clinicaId']);
    await queryInterface.addIndex('ClinicAnalyticsProperties', ['googleConnectionId']);
    await queryInterface.addConstraint('ClinicAnalyticsProperties', {
      fields: ['clinicaId', 'propertyName'],
      type: 'unique',
      name: 'uq_clinicanalytics_clinic_property'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ClinicAnalyticsProperties');
  }
};
