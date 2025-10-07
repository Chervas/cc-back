'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('ClinicGoogleAdsAccounts', 'clinicaId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'Clinicas',
        key: 'id_clinica'
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    });

    await queryInterface.addColumn('ClinicGoogleAdsAccounts', 'grupoClinicaId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'GruposClinicas',
        key: 'id_grupo'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });

    await queryInterface.addColumn('ClinicGoogleAdsAccounts', 'assignmentScope', {
      type: Sequelize.ENUM('clinic', 'group'),
      allowNull: false,
      defaultValue: 'clinic'
    });

    try {
      await queryInterface.removeConstraint('ClinicGoogleAdsAccounts', 'uniq_clinic_google_ads_customer');
    } catch (error) {
      // ignore if missing
    }

    await queryInterface.addConstraint('ClinicGoogleAdsAccounts', {
      fields: ['googleConnectionId', 'customerId'],
      type: 'unique',
      name: 'uniq_google_connection_customer'
    });

    await queryInterface.addIndex('ClinicGoogleAdsAccounts', {
      name: 'idx_google_ads_group_active',
      fields: ['grupoClinicaId', 'isActive']
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('ClinicGoogleAdsAccounts', 'idx_google_ads_group_active');

    try {
      await queryInterface.removeConstraint('ClinicGoogleAdsAccounts', 'uniq_google_connection_customer');
    } catch (error) {
      // ignore
    }

    await queryInterface.addConstraint('ClinicGoogleAdsAccounts', {
      fields: ['clinicaId', 'customerId'],
      type: 'unique',
      name: 'uniq_clinic_google_ads_customer'
    });

    await queryInterface.removeColumn('ClinicGoogleAdsAccounts', 'assignmentScope');
    await queryInterface.removeColumn('ClinicGoogleAdsAccounts', 'grupoClinicaId');

    await queryInterface.changeColumn('ClinicGoogleAdsAccounts', 'clinicaId', {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: {
        model: 'Clinicas',
        key: 'id_clinica'
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    });
  }
};
