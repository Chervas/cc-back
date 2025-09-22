'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebScQueryDaily = sequelize.define('WebScQueryDaily', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    site_url: { type: DataTypes.STRING(512), allowNull: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    query: { type: DataTypes.STRING(1024), allowNull: false },
    query_hash: { type: DataTypes.CHAR(64), allowNull: false },
    page_url: { type: DataTypes.STRING(2048), allowNull: true },
    page_url_hash: { type: DataTypes.CHAR(64), allowNull: false },
    clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    impressions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ctr: { type: DataTypes.DECIMAL(8, 6), allowNull: false, defaultValue: 0 },
    position: { type: DataTypes.DECIMAL(8, 3), allowNull: true }
  }, {
    tableName: 'WebScQueryDaily',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  WebScQueryDaily.associate = function(models) {
    WebScQueryDaily.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
  };

  return WebScQueryDaily;
};
