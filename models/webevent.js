'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class WebEvent extends Model {
    static associate(models) {
      if (models.Clinica) {
        WebEvent.belongsTo(models.Clinica, {
          foreignKey: 'clinic_id',
          targetKey: 'id_clinica',
          as: 'clinica',
        });
      }
      if (models.GrupoClinica) {
        WebEvent.belongsTo(models.GrupoClinica, {
          foreignKey: 'group_id',
          targetKey: 'id_grupo',
          as: 'grupoClinica',
        });
      }
    }
  }

  WebEvent.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    group_id: { type: DataTypes.INTEGER, allowNull: true },
    event_name: { type: DataTypes.STRING(80), allowNull: false },
    event_type: { type: DataTypes.STRING(80), allowNull: true },
    event_id: { type: DataTypes.STRING(128), allowNull: true },
    session_id: { type: DataTypes.STRING(128), allowNull: true },
    visitor_id: { type: DataTypes.STRING(128), allowNull: true },
    domain: { type: DataTypes.STRING(255), allowNull: true },
    page_url: { type: DataTypes.STRING(1024), allowNull: true },
    page_path: { type: DataTypes.STRING(512), allowNull: true },
    page_title: { type: DataTypes.STRING(512), allowNull: true },
    referrer: { type: DataTypes.STRING(1024), allowNull: true },
    utm_source: { type: DataTypes.STRING(128), allowNull: true },
    utm_medium: { type: DataTypes.STRING(128), allowNull: true },
    utm_campaign: { type: DataTypes.STRING(255), allowNull: true },
    utm_content: { type: DataTypes.STRING(255), allowNull: true },
    utm_term: { type: DataTypes.STRING(255), allowNull: true },
    gclid: { type: DataTypes.STRING(255), allowNull: true },
    fbclid: { type: DataTypes.STRING(255), allowNull: true },
    ttclid: { type: DataTypes.STRING(255), allowNull: true },
    msclkid: { type: DataTypes.STRING(255), allowNull: true },
    consent_analytics: { type: DataTypes.BOOLEAN, allowNull: true },
    consent_marketing: { type: DataTypes.BOOLEAN, allowNull: true },
    consent_ad_user_data: { type: DataTypes.BOOLEAN, allowNull: true },
    consent_ad_personalization: { type: DataTypes.BOOLEAN, allowNull: true },
    consent_json: { type: DataTypes.JSON, allowNull: true },
    user_agent_hash: { type: DataTypes.STRING(64), allowNull: true },
    ip_hash: { type: DataTypes.STRING(64), allowNull: true },
    screen_width: { type: DataTypes.INTEGER, allowNull: true },
    screen_height: { type: DataTypes.INTEGER, allowNull: true },
    viewport_width: { type: DataTypes.INTEGER, allowNull: true },
    viewport_height: { type: DataTypes.INTEGER, allowNull: true },
    language: { type: DataTypes.STRING(32), allowNull: true },
    metadata: { type: DataTypes.JSON, allowNull: true },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
  }, {
    sequelize,
    modelName: 'WebEvent',
    tableName: 'WebEvents',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return WebEvent;
};
