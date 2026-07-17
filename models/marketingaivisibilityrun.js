'use strict';

module.exports = (sequelize, DataTypes) => {
  const MarketingAiVisibilityRun = sequelize.define('MarketingAiVisibilityRun', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    requested_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
    query: { type: DataTypes.STRING(500), allowNull: false },
    query_hash: { type: DataTypes.STRING(64), allowNull: false },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'queued' },
    provider_status: { type: DataTypes.JSON, allowNull: true },
    provider_results: { type: DataTypes.JSON, allowNull: true },
    error_summary: { type: DataTypes.JSON, allowNull: true },
    job_request_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    started_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: false },
  }, {
    tableName: 'MarketingAiVisibilityRuns',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['clinica_id', 'created_at'] },
      { fields: ['clinica_id', 'query_hash', 'created_at'] },
      { fields: ['status'] },
      { fields: ['expires_at'] },
    ],
  });

  MarketingAiVisibilityRun.associate = function associate(models) {
    MarketingAiVisibilityRun.belongsTo(models.Clinica, {
      foreignKey: 'clinica_id',
      targetKey: 'id_clinica',
      as: 'clinica',
    });
    MarketingAiVisibilityRun.belongsTo(models.Usuario, {
      foreignKey: 'requested_by_user_id',
      targetKey: 'id_usuario',
      as: 'requestedBy',
    });
  };

  return MarketingAiVisibilityRun;
};
