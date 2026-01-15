'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class CampaignRequest extends Model {
    static associate(models) {
      CampaignRequest.belongsTo(models.Campaign, { foreignKey: 'campaign_id', as: 'campaign' });
      CampaignRequest.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
    }
  }

  CampaignRequest.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    campaign_id: { type: DataTypes.INTEGER, allowNull: true },
    estado: {
      type: DataTypes.ENUM('pendiente_aceptacion', 'en_creacion', 'solicitar_cambio', 'aprobada', 'activa', 'pausada', 'finalizada'),
      allowNull: false,
      defaultValue: 'pendiente_aceptacion'
    },
    solicitud: { type: DataTypes.JSON, allowNull: true }
  }, {
    sequelize,
    modelName: 'CampaignRequest',
    tableName: 'CampaignRequests',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return CampaignRequest;
};
