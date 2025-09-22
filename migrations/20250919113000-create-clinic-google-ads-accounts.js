'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('ClinicGoogleAdsAccounts', {
      id: { type: Sequelize.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
      clinicaId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      googleConnectionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'GoogleConnections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      customerId: { type: Sequelize.STRING(32), allowNull: false },
      descriptiveName: { type: Sequelize.STRING(256), allowNull: true },
      currencyCode: { type: Sequelize.STRING(16), allowNull: true },
      timeZone: { type: Sequelize.STRING(64), allowNull: true },
      accountStatus: { type: Sequelize.STRING(32), allowNull: true },
      managerCustomerId: { type: Sequelize.STRING(32), allowNull: true },
      managerLinkId: { type: Sequelize.STRING(32), allowNull: true },
      managerLinkStatus: { type: Sequelize.STRING(32), allowNull: true },
      invitationStatus: { type: Sequelize.STRING(32), allowNull: true },
      linkedAt: { type: Sequelize.DATE, allowNull: true },
      lastSyncedAt: { type: Sequelize.DATE, allowNull: true },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('ClinicGoogleAdsAccounts', ['clinicaId']);
    await queryInterface.addIndex('ClinicGoogleAdsAccounts', ['googleConnectionId']);
    await queryInterface.addIndex('ClinicGoogleAdsAccounts', ['customerId']);
    await queryInterface.addConstraint('ClinicGoogleAdsAccounts', {
      fields: ['clinicaId', 'customerId'],
      type: 'unique',
      name: 'uniq_clinic_google_ads_customer'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('ClinicGoogleAdsAccounts');
  }
};

