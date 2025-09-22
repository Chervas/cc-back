'use strict';

module.exports = (sequelize, DataTypes) => {
  const ClinicGoogleAdsAccount = sequelize.define('ClinicGoogleAdsAccount', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinicaId: { type: DataTypes.INTEGER, allowNull: false, field: 'clinicaId' },
    googleConnectionId: { type: DataTypes.INTEGER, allowNull: false, field: 'googleConnectionId' },
    customerId: { type: DataTypes.STRING(32), allowNull: false, field: 'customerId' },
    descriptiveName: { type: DataTypes.STRING(256), allowNull: true, field: 'descriptiveName' },
    currencyCode: { type: DataTypes.STRING(16), allowNull: true, field: 'currencyCode' },
    timeZone: { type: DataTypes.STRING(64), allowNull: true, field: 'timeZone' },
    accountStatus: { type: DataTypes.STRING(32), allowNull: true, field: 'accountStatus' },
    managerCustomerId: { type: DataTypes.STRING(32), allowNull: true, field: 'managerCustomerId' },
    loginCustomerId: { type: DataTypes.STRING(32), allowNull: true, field: 'loginCustomerId' },
    managerLinkId: { type: DataTypes.STRING(32), allowNull: true, field: 'managerLinkId' },
    managerLinkStatus: { type: DataTypes.STRING(32), allowNull: true, field: 'managerLinkStatus' },
    invitationStatus: { type: DataTypes.STRING(32), allowNull: true, field: 'invitationStatus' },
    linkedAt: { type: DataTypes.DATE, allowNull: true, field: 'linkedAt' },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true, field: 'lastSyncedAt' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'isActive' }
  }, {
    tableName: 'ClinicGoogleAdsAccounts',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  ClinicGoogleAdsAccount.associate = function(models) {
    ClinicGoogleAdsAccount.belongsTo(models.Clinica, { foreignKey: 'clinicaId', targetKey: 'id_clinica', as: 'clinica' });
    ClinicGoogleAdsAccount.belongsTo(models.GoogleConnection, { foreignKey: 'googleConnectionId', as: 'googleConnection' });
    ClinicGoogleAdsAccount.hasMany(models.GoogleAdsInsightsDaily, { foreignKey: 'clinicGoogleAdsAccountId', as: 'insights' });
  };

  return ClinicGoogleAdsAccount;
};
