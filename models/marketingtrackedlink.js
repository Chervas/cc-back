'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketingTrackedLink extends Model {
    static associate(models) {
      MarketingTrackedLink.belongsTo(models.MarketingPatientList, { foreignKey: 'list_id', as: 'list' });
      MarketingTrackedLink.belongsTo(models.MarketingPatientListItem, { foreignKey: 'item_id', as: 'item' });
      MarketingTrackedLink.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
    }
  }

  MarketingTrackedLink.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    token: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    list_id: { type: DataTypes.INTEGER, allowNull: false },
    item_id: { type: DataTypes.INTEGER, allowNull: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    grupo_clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    variable_key: { type: DataTypes.STRING(128), allowNull: true },
    original_url: { type: DataTypes.TEXT, allowNull: false },
    tracking_domain: { type: DataTypes.STRING(255), allowNull: true },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'active' },
    metadata: { type: DataTypes.JSON, allowNull: true },
    clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    unique_clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_clicked_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    sequelize,
    modelName: 'MarketingTrackedLink',
    tableName: 'MarketingTrackedLinks',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return MarketingTrackedLink;
};
