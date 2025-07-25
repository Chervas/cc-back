'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('social_stats_daily', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Clinicas',
          key: 'id_clinica'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      asset_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'ClinicMetaAssets',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      asset_type: {
        type: Sequelize.ENUM('facebook_page', 'instagram_business', 'ad_account'),
        allowNull: false
      },
      date: {
        type: Sequelize.DATEONLY,
        allowNull: false
      },
      impressions: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      reach: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      engagement: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      clicks: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      followers: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      profile_visits: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false
      }
    });

    // Crear índices para optimizar consultas
    await queryInterface.addIndex('social_stats_daily', ['clinica_id', 'asset_id', 'date'], {
      name: 'idx_social_stats_daily_clinica_asset_date'
    });

    await queryInterface.addIndex('social_stats_daily', ['asset_id', 'date'], {
      name: 'idx_social_stats_daily_asset_date'
    });

    await queryInterface.addIndex('social_stats_daily', ['date'], {
      name: 'idx_social_stats_daily_date'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('social_stats_daily');
  }
};

