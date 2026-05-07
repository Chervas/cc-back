'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketingTrackedLinkClick extends Model {
    static associate(models) {
      MarketingTrackedLinkClick.belongsTo(models.MarketingTrackedLink, { foreignKey: 'tracked_link_id', as: 'link' });
      MarketingTrackedLinkClick.belongsTo(models.MarketingPatientList, { foreignKey: 'list_id', as: 'list' });
      MarketingTrackedLinkClick.belongsTo(models.MarketingPatientListItem, { foreignKey: 'item_id', as: 'item' });
      MarketingTrackedLinkClick.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
    }
  }

  MarketingTrackedLinkClick.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tracked_link_id: { type: DataTypes.INTEGER, allowNull: false },
    list_id: { type: DataTypes.INTEGER, allowNull: false },
    item_id: { type: DataTypes.INTEGER, allowNull: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    grupo_clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    ip_hash: { type: DataTypes.STRING(64), allowNull: true },
    user_agent_hash: { type: DataTypes.STRING(64), allowNull: true },
    country_code: { type: DataTypes.STRING(8), allowNull: true },
    country_name: { type: DataTypes.STRING(128), allowNull: true },
    referrer: { type: DataTypes.TEXT, allowNull: true },
    clicked_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    metadata: { type: DataTypes.JSON, allowNull: true },
  }, {
    sequelize,
    modelName: 'MarketingTrackedLinkClick',
    tableName: 'MarketingTrackedLinkClicks',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false,
  });

  return MarketingTrackedLinkClick;
};
