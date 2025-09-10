'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('ClinicWebAssets', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      clinicaId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      googleConnectionId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'GoogleConnections', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      siteUrl: { type: Sequelize.STRING(512), allowNull: false },
      propertyType: { type: Sequelize.STRING(32), allowNull: true },
      permissionLevel: { type: Sequelize.STRING(64), allowNull: true },
      verified: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('ClinicWebAssets', ['clinicaId']);
    await queryInterface.addIndex('ClinicWebAssets', ['googleConnectionId']);
    await queryInterface.addConstraint('ClinicWebAssets', { fields: ['clinicaId','siteUrl'], type: 'unique', name: 'uniq_clinic_siteurl' });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('ClinicWebAssets');
  }
};

