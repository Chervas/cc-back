'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class GrupoClinica extends Model {
    static associate(models) {
      // Un grupo puede tener muchas clínicas
      GrupoClinica.hasMany(models.Clinica, { foreignKey: 'grupoClinicaId', as: 'clinicas' });
    }
  }
  GrupoClinica.init({
    id_grupo: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    nombre_grupo: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    ads_assignment_mode: {
      type: DataTypes.ENUM('manual', 'automatic'),
      allowNull: false,
      defaultValue: 'automatic'
    },
    ads_assignment_delimiter: {
      type: DataTypes.STRING(8),
      allowNull: false,
      defaultValue: '**'
    },
    ads_assignment_last_run: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    web_assignment_mode: {
      type: DataTypes.ENUM('manual', 'automatic'),
      allowNull: false,
      defaultValue: 'automatic'
    },
    web_primary_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    web_assignment_updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    facebook_assignment_mode: {
      type: DataTypes.ENUM('group', 'clinic'),
      allowNull: false,
      defaultValue: 'clinic'
    },
    facebook_primary_asset_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'ClinicMetaAssets',
        key: 'id'
      }
    },
    facebook_assignment_updated_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    instagram_assignment_mode: {
      type: DataTypes.ENUM('group', 'clinic'),
      allowNull: false,
      defaultValue: 'clinic'
    },
    instagram_primary_asset_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'ClinicMetaAssets',
        key: 'id'
      }
    },
    instagram_assignment_updated_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    tiktok_assignment_mode: {
      type: DataTypes.ENUM('group', 'clinic'),
      allowNull: false,
      defaultValue: 'clinic'
    },
    tiktok_primary_asset_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    tiktok_assignment_updated_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    search_console_assignment_mode: {
      type: DataTypes.ENUM('group', 'clinic'),
      allowNull: false,
      defaultValue: 'clinic'
    },
    search_console_primary_asset_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'ClinicWebAssets',
        key: 'id'
      }
    },
    search_console_assignment_updated_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    analytics_assignment_mode: {
      type: DataTypes.ENUM('group', 'clinic'),
      allowNull: false,
      defaultValue: 'clinic'
    },
    analytics_primary_property_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'ClinicAnalyticsProperties',
        key: 'id'
      }
    },
    analytics_assignment_updated_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    business_profile_assignment_mode: {
      type: DataTypes.ENUM('group', 'clinic'),
      allowNull: false,
      defaultValue: 'clinic'
    },
    business_profile_primary_location_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'ClinicBusinessLocations',
        key: 'id'
      }
    },
    business_profile_assignment_updated_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'GrupoClinica',
    tableName: 'GruposClinicas',
    timestamps: false,
  });
  return GrupoClinica;
};
