'use strict';

module.exports = (sequelize, DataTypes) => {
  const GoogleAdsInsightsDaily = sequelize.define('GoogleAdsInsightsDaily', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinicGoogleAdsAccountId: { type: DataTypes.INTEGER, allowNull: false, field: 'clinicGoogleAdsAccountId' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinicaId' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupoClinicaId' },
    grupo_clinica_id: {
      type: DataTypes.VIRTUAL,
      get() {
        return this.getDataValue('grupoClinicaId') ?? null;
      }
    },
    customerId: { type: DataTypes.STRING(32), allowNull: false, field: 'customerId' },
    campaignId: { type: DataTypes.STRING(64), allowNull: false, field: 'campaignId' },
    campaignName: { type: DataTypes.STRING(256), allowNull: true, field: 'campaignName' },
    campaignStatus: { type: DataTypes.STRING(32), allowNull: true, field: 'campaignStatus' },
    adGroupId: { type: DataTypes.STRING(64), allowNull: true, field: 'adGroupId' },
    adGroupName: { type: DataTypes.STRING(256), allowNull: true, field: 'adGroupName' },
    date: { type: DataTypes.DATEONLY, allowNull: false, field: 'date' },
    network: { type: DataTypes.STRING(64), allowNull: true, field: 'network' },
    device: { type: DataTypes.STRING(64), allowNull: true, field: 'device' },
    impressions: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'impressions' },
    clicks: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'clicks' },
    costMicros: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'costMicros' },
    conversions: { type: DataTypes.DECIMAL(18,6), allowNull: false, defaultValue: 0, field: 'conversions' },
    conversionsValue: { type: DataTypes.DECIMAL(18,6), allowNull: false, defaultValue: 0, field: 'conversionsValue' },
    ctr: { type: DataTypes.DECIMAL(10,6), allowNull: false, defaultValue: 0, field: 'ctr' },
    averageCpcMicros: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'averageCpcMicros' },
    averageCpmMicros: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'averageCpmMicros' },
    averageCostMicros: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'averageCostMicros' },
    conversionsFromInteractionsRate: { type: DataTypes.DECIMAL(10,6), allowNull: false, defaultValue: 0, field: 'conversionsFromInteractionsRate' },
    clinicMatchSource: { type: DataTypes.STRING(32), allowNull: true, field: 'clinicMatchSource' },
    clinicMatchValue: { type: DataTypes.STRING(255), allowNull: true, field: 'clinicMatchValue' }
  }, {
    tableName: 'GoogleAdsInsightsDaily',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['clinicaId', 'date'], name: 'idx_google_ads_insights_clinic_date' }
    ]
  });

  GoogleAdsInsightsDaily.associate = function(models) {
    GoogleAdsInsightsDaily.belongsTo(models.ClinicGoogleAdsAccount, {
      foreignKey: 'clinicGoogleAdsAccountId',
      as: 'account'
    });
    GoogleAdsInsightsDaily.belongsTo(models.Clinica, {
      foreignKey: 'clinicaId',
      targetKey: 'id_clinica',
      as: 'clinica'
    });
    GoogleAdsInsightsDaily.belongsTo(models.GrupoClinica, {
      foreignKey: 'grupoClinicaId',
      targetKey: 'id_grupo',
      as: 'grupoClinica'
    });
  };

  return GoogleAdsInsightsDaily;
};
