'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('GoogleAdsInsightsDaily', 'clinicaId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      field: 'clinicaId'
    });

    await queryInterface.addColumn('GoogleAdsInsightsDaily', 'grupoClinicaId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'GruposClinicas',
        key: 'id_grupo'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
      field: 'grupoClinicaId'
    });

    await queryInterface.addColumn('GoogleAdsInsightsDaily', 'adGroupId', {
      type: Sequelize.STRING(64),
      allowNull: true,
      field: 'adGroupId'
    });

    await queryInterface.addColumn('GoogleAdsInsightsDaily', 'adGroupName', {
      type: Sequelize.STRING(256),
      allowNull: true,
      field: 'adGroupName'
    });

    await queryInterface.addColumn('GoogleAdsInsightsDaily', 'clinicMatchSource', {
      type: Sequelize.STRING(32),
      allowNull: true,
      field: 'clinicMatchSource'
    });

    await queryInterface.addColumn('GoogleAdsInsightsDaily', 'clinicMatchValue', {
      type: Sequelize.STRING(255),
      allowNull: true,
      field: 'clinicMatchValue'
    });

    await queryInterface.addIndex('GoogleAdsInsightsDaily', {
      name: 'idx_google_ads_insights_clinic_date',
      fields: ['clinicaId', 'date']
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('GoogleAdsInsightsDaily', 'idx_google_ads_insights_clinic_date');
    await queryInterface.removeColumn('GoogleAdsInsightsDaily', 'clinicMatchValue');
    await queryInterface.removeColumn('GoogleAdsInsightsDaily', 'clinicMatchSource');
    await queryInterface.removeColumn('GoogleAdsInsightsDaily', 'adGroupName');
    await queryInterface.removeColumn('GoogleAdsInsightsDaily', 'adGroupId');
    await queryInterface.removeColumn('GoogleAdsInsightsDaily', 'grupoClinicaId');

    await queryInterface.changeColumn('GoogleAdsInsightsDaily', 'clinicaId', {
      type: Sequelize.INTEGER,
      allowNull: false,
      field: 'clinicaId'
    });
  }
};
