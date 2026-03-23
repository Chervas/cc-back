'use strict';

module.exports = (sequelize, DataTypes) => {
  const GoogleAdsAdInsightsDaily = sequelize.define('GoogleAdsAdInsightsDaily', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinicGoogleAdsAccountId: { type: DataTypes.INTEGER, allowNull: false, field: 'clinicGoogleAdsAccountId' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinicaId' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupoClinicaId' },
    customerId: { type: DataTypes.STRING(32), allowNull: false, field: 'customerId' },
    campaignId: { type: DataTypes.STRING(64), allowNull: false, field: 'campaignId' },
    campaignName: { type: DataTypes.STRING(256), allowNull: true, field: 'campaignName' },
    campaignStatus: { type: DataTypes.STRING(32), allowNull: true, field: 'campaignStatus' },
    adGroupId: { type: DataTypes.STRING(64), allowNull: true, field: 'adGroupId' },
    adGroupName: { type: DataTypes.STRING(256), allowNull: true, field: 'adGroupName' },
    adId: { type: DataTypes.STRING(64), allowNull: false, field: 'adId' },
    adName: { type: DataTypes.STRING(256), allowNull: true, field: 'adName' },
    adType: { type: DataTypes.STRING(64), allowNull: true, field: 'adType' },
    adStatus: { type: DataTypes.STRING(32), allowNull: true, field: 'adStatus' },
    date: { type: DataTypes.DATEONLY, allowNull: false, field: 'date' },
    network: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '', field: 'network' },
    device: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '', field: 'device' },
    impressions: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'impressions' },
    clicks: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'clicks' },
    costMicros: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'costMicros' },
    conversions: { type: DataTypes.DECIMAL(18, 6), allowNull: false, defaultValue: 0, field: 'conversions' },
    ctr: { type: DataTypes.DECIMAL(10, 6), allowNull: false, defaultValue: 0, field: 'ctr' },
    finalUrl: { type: DataTypes.STRING(1024), allowNull: true, field: 'finalUrl' },
    displayUrl: { type: DataTypes.STRING(512), allowNull: true, field: 'displayUrl' },
    headlines: { type: DataTypes.JSON, allowNull: true, field: 'headlines' },
    descriptions: { type: DataTypes.JSON, allowNull: true, field: 'descriptions' }
  }, {
    tableName: 'GoogleAdsAdInsightsDaily',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        name: 'uniq_google_ads_ad_date_account',
        unique: true,
        fields: ['clinicGoogleAdsAccountId', 'date', 'adId', 'network', 'device']
      },
      { name: 'idx_google_ads_ad_campaign_date', fields: ['campaignId', 'date'] },
      { name: 'idx_google_ads_ad_clinic_date', fields: ['clinicaId', 'date'] }
    ]
  });

  GoogleAdsAdInsightsDaily.associate = function(models) {
    GoogleAdsAdInsightsDaily.belongsTo(models.ClinicGoogleAdsAccount, {
      foreignKey: 'clinicGoogleAdsAccountId',
      as: 'account'
    });
    GoogleAdsAdInsightsDaily.belongsTo(models.Clinica, {
      foreignKey: 'clinicaId',
      targetKey: 'id_clinica',
      as: 'clinica'
    });
    GoogleAdsAdInsightsDaily.belongsTo(models.GrupoClinica, {
      foreignKey: 'grupoClinicaId',
      targetKey: 'id_grupo',
      as: 'grupoClinica'
    });
  };

  return GoogleAdsAdInsightsDaily;
};
