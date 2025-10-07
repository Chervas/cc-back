'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // SocialAdsInsightsDaily
    await queryInterface.addColumn('SocialAdsInsightsDaily', 'clinica_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'Clinicas',
        key: 'id_clinica'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });

    await queryInterface.addColumn('SocialAdsInsightsDaily', 'grupo_clinica_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'GruposClinicas',
        key: 'id_grupo'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });

    await queryInterface.addColumn('SocialAdsInsightsDaily', 'clinic_match_source', {
      type: Sequelize.STRING(32),
      allowNull: true
    });

    await queryInterface.addColumn('SocialAdsInsightsDaily', 'clinic_match_value', {
      type: Sequelize.STRING(255),
      allowNull: true
    });

    await queryInterface.addIndex('SocialAdsInsightsDaily', {
      name: 'idx_social_ads_insights_clinic_date',
      fields: ['clinica_id', 'date']
    });

    await queryInterface.addIndex('SocialAdsInsightsDaily', {
      name: 'idx_social_ads_insights_group_date',
      fields: ['grupo_clinica_id', 'date']
    });

    // SocialAdsActionsDaily
    await queryInterface.addColumn('SocialAdsActionsDaily', 'clinica_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'Clinicas',
        key: 'id_clinica'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });

    await queryInterface.addColumn('SocialAdsActionsDaily', 'grupo_clinica_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'GruposClinicas',
        key: 'id_grupo'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });

    await queryInterface.addColumn('SocialAdsActionsDaily', 'clinic_match_source', {
      type: Sequelize.STRING(32),
      allowNull: true
    });

    await queryInterface.addColumn('SocialAdsActionsDaily', 'clinic_match_value', {
      type: Sequelize.STRING(255),
      allowNull: true
    });

    await queryInterface.addIndex('SocialAdsActionsDaily', {
      name: 'idx_social_ads_actions_clinic_date',
      fields: ['clinica_id', 'date']
    });

    await queryInterface.addIndex('SocialAdsActionsDaily', {
      name: 'idx_social_ads_actions_group_date',
      fields: ['grupo_clinica_id', 'date']
    });

    // SocialAdsAdsetDailyAgg
    await queryInterface.addColumn('SocialAdsAdsetDailyAgg', 'clinica_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'Clinicas',
        key: 'id_clinica'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });

    await queryInterface.addColumn('SocialAdsAdsetDailyAgg', 'grupo_clinica_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'GruposClinicas',
        key: 'id_grupo'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });

    await queryInterface.addIndex('SocialAdsAdsetDailyAgg', {
      name: 'idx_social_ads_adset_daily_clinic_date',
      fields: ['clinica_id', 'date']
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('SocialAdsAdsetDailyAgg', 'idx_social_ads_adset_daily_clinic_date');
    await queryInterface.removeColumn('SocialAdsAdsetDailyAgg', 'grupo_clinica_id');
    await queryInterface.removeColumn('SocialAdsAdsetDailyAgg', 'clinica_id');

    await queryInterface.removeIndex('SocialAdsActionsDaily', 'idx_social_ads_actions_group_date');
    await queryInterface.removeIndex('SocialAdsActionsDaily', 'idx_social_ads_actions_clinic_date');
    await queryInterface.removeColumn('SocialAdsActionsDaily', 'clinic_match_value');
    await queryInterface.removeColumn('SocialAdsActionsDaily', 'clinic_match_source');
    await queryInterface.removeColumn('SocialAdsActionsDaily', 'grupo_clinica_id');
    await queryInterface.removeColumn('SocialAdsActionsDaily', 'clinica_id');

    await queryInterface.removeIndex('SocialAdsInsightsDaily', 'idx_social_ads_insights_group_date');
    await queryInterface.removeIndex('SocialAdsInsightsDaily', 'idx_social_ads_insights_clinic_date');
    await queryInterface.removeColumn('SocialAdsInsightsDaily', 'clinic_match_value');
    await queryInterface.removeColumn('SocialAdsInsightsDaily', 'clinic_match_source');
    await queryInterface.removeColumn('SocialAdsInsightsDaily', 'grupo_clinica_id');
    await queryInterface.removeColumn('SocialAdsInsightsDaily', 'clinica_id');
  }
};
