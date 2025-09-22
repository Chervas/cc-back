'use strict';

module.exports = (sequelize, DataTypes) => {
  const GoogleAdsInsightsDaily = sequelize.define('GoogleAdsInsightsDaily', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinicGoogleAdsAccountId: { type: DataTypes.INTEGER, allowNull: false, field: 'clinicGoogleAdsAccountId' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: false, field: 'clinicaId' },
    customerId: { type: DataTypes.STRING(32), allowNull: false, field: 'customerId' },
    campaignId: { type: DataTypes.STRING(64), allowNull: false, field: 'campaignId' },
    campaignName: { type: DataTypes.STRING(256), allowNull: true, field: 'campaignName' },
    campaignStatus: { type: DataTypes.STRING(32), allowNull: true, field: 'campaignStatus' },
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
    conversionsFromInteractionsRate: { type: DataTypes.DECIMAL(10,6), allowNull: false, defaultValue: 0, field: 'conversionsFromInteractionsRate' }
  }, {
    tableName: 'GoogleAdsInsightsDaily',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
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
  };

  return GoogleAdsInsightsDaily;
};
