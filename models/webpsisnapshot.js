'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebPsiSnapshot = sequelize.define('WebPsiSnapshot', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    url: { type: DataTypes.STRING(1024), allowNull: false },
    fetched_at: { type: DataTypes.DATE, allowNull: false },
    performance: { type: DataTypes.INTEGER, allowNull: true },
    accessibility: { type: DataTypes.INTEGER, allowNull: true },
    lcp_ms: { type: DataTypes.INTEGER, allowNull: true },
    cls: { type: DataTypes.DECIMAL(8,4), allowNull: true },
    inp_ms: { type: DataTypes.INTEGER, allowNull: true },
    // Técnicos persistidos
    https_ok: { type: DataTypes.BOOLEAN, allowNull: true },
    https_status: { type: DataTypes.INTEGER, allowNull: true },
    sitemap_found: { type: DataTypes.BOOLEAN, allowNull: true },
    sitemap_url: { type: DataTypes.STRING(1024), allowNull: true },
    sitemap_status: { type: DataTypes.INTEGER, allowNull: true },
    indexed_ok: { type: DataTypes.BOOLEAN, allowNull: true }
  }, {
    tableName: 'WebPsiSnapshots',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [ { fields: ['clinica_id','fetched_at'] } ]
  });
  return WebPsiSnapshot;
};
