'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AdminCampaignPlaybook extends Model {
    static associate(models) {
      if (models.Tratamiento) {
        AdminCampaignPlaybook.belongsTo(models.Tratamiento, {
          foreignKey: 'treatment_id',
          targetKey: 'id_tratamiento',
          as: 'treatment',
        });
      }
    }
  }

  AdminCampaignPlaybook.init(
    {
      id: {
        type: DataTypes.STRING(36),
        primaryKey: true,
        allowNull: false,
      },
      catalog_key: {
        type: DataTypes.STRING(191),
        allowNull: false,
        unique: true,
      },
      display_name: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      objective_id: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      promotion_kind: {
        type: DataTypes.ENUM('treatment_specific', 'generic_campaign'),
        allowNull: false,
      },
      treatment_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      discipline: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      family_key: {
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('draft', 'active', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      channels_supported: {
        type: DataTypes.JSON,
        allowNull: false,
      },
      channels_default: {
        type: DataTypes.JSON,
        allowNull: false,
      },
      recommended_budget_min: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      recommended_budget_max: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      destination_policy: {
        type: DataTypes.JSON,
        allowNull: false,
      },
      measurement_profile: {
        type: DataTypes.JSON,
        allowNull: false,
      },
      automation_strategy: {
        type: DataTypes.JSON,
        allowNull: false,
      },
      template_bundle_refs: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      review_policy: {
        type: DataTypes.JSON,
        allowNull: false,
      },
      notes_internal: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'AdminCampaignPlaybook',
      tableName: 'AdminCampaignPlaybooks',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return AdminCampaignPlaybook;
};
