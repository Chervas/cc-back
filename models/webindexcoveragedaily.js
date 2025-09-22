'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebIndexCoverageDaily = sequelize.define('WebIndexCoverageDaily', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    indexed_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    nonindexed_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: 'WebIndexCoverageDaily',
    timestamps: false,
    indexes: [ { unique: true, fields: ['clinica_id','date'] } ]
  });
  return WebIndexCoverageDaily;
};

