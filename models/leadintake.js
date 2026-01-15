'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class LeadIntake extends Model {
    static associate(models) {
      LeadIntake.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      LeadIntake.belongsTo(models.GrupoClinica, { foreignKey: 'grupo_clinica_id', targetKey: 'id_grupo', as: 'grupoClinica' });
      if (models.Campana) {
        LeadIntake.belongsTo(models.Campana, { foreignKey: 'campana_id', as: 'campana' });
      }
      if (models.LeadAttributionAudit) {
        LeadIntake.hasMany(models.LeadAttributionAudit, { foreignKey: 'lead_intake_id', as: 'attributionAudits' });
      }
    }
  }

  LeadIntake.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    grupo_clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    campana_id: { type: DataTypes.INTEGER, allowNull: true },
    channel: {
      type: DataTypes.ENUM('paid', 'organic', 'unknown'),
      allowNull: false,
      defaultValue: 'unknown'
    },
    source: {
      type: DataTypes.ENUM('meta_ads', 'google_ads', 'web', 'whatsapp', 'call_click', 'tiktok_ads', 'seo', 'direct', 'local_services'),
      allowNull: true
    },
    source_detail: { type: DataTypes.STRING(512), allowNull: true },
    clinic_match_source: { type: DataTypes.STRING(64), allowNull: true },
    clinic_match_value: { type: DataTypes.STRING(256), allowNull: true },
    utm_source: { type: DataTypes.STRING(128), allowNull: true },
    utm_medium: { type: DataTypes.STRING(128), allowNull: true },
    utm_campaign: { type: DataTypes.STRING(128), allowNull: true },
    utm_content: { type: DataTypes.STRING(128), allowNull: true },
    utm_term: { type: DataTypes.STRING(128), allowNull: true },
    gclid: { type: DataTypes.STRING(128), allowNull: true },
    fbclid: { type: DataTypes.STRING(128), allowNull: true },
    ttclid: { type: DataTypes.STRING(128), allowNull: true },
    referrer: { type: DataTypes.STRING(512), allowNull: true },
    page_url: { type: DataTypes.STRING(1024), allowNull: true },
    landing_url: { type: DataTypes.STRING(1024), allowNull: true },
    user_agent: { type: DataTypes.STRING(512), allowNull: true },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    event_id: { type: DataTypes.STRING(128), allowNull: true },
    nombre: { type: DataTypes.STRING(255), allowNull: true },
    email: { type: DataTypes.STRING(255), allowNull: true },
    email_hash: { type: DataTypes.STRING(128), allowNull: true },
    telefono: { type: DataTypes.STRING(64), allowNull: true },
    phone_hash: { type: DataTypes.STRING(128), allowNull: true },
    notas: { type: DataTypes.TEXT, allowNull: true },
    status_lead: {
      type: DataTypes.ENUM('nuevo', 'contactado', 'convertido', 'descartado'),
      allowNull: false,
      defaultValue: 'nuevo'
    },
    consentimiento_canal: { type: DataTypes.JSON, allowNull: true }
  }, {
    sequelize,
    modelName: 'LeadIntake',
    tableName: 'LeadIntakes',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return LeadIntake;
};
