'use strict';

const { validateClinicScope } = require('../src/lib/webDocumentModel');

module.exports = (sequelize, DataTypes) => {
  const WebDomain = sequelize.define('WebDomain', {
    id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true, validate: { isUUID: 4 } },
    scopeType: { type: DataTypes.ENUM('clinic', 'group'), allowNull: false, field: 'scope_type' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinica_id' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupo_clinica_id' },
    host: { type: DataTypes.STRING(253), allowNull: false },
    kind: { type: DataTypes.ENUM('clinicaclick_hosted', 'custom_domain'), allowNull: false },
    status: {
      type: DataTypes.ENUM('pending_dns', 'pending_tls', 'ready', 'failed', 'retired'),
      allowNull: false,
      defaultValue: 'pending_dns',
    },
    ownershipTokenHash: { type: DataTypes.STRING(64), allowNull: false, field: 'ownership_token_hash' },
    providerReferenceHash: { type: DataTypes.STRING(64), allowNull: true, field: 'provider_reference_hash' },
    expectedDns: { type: DataTypes.JSON, allowNull: false, defaultValue: {}, field: 'expected_dns' },
    verification: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    tls: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    commercialMode: {
      type: DataTypes.ENUM('included', 'paid_domain'), allowNull: false, defaultValue: 'included', field: 'commercial_mode',
    },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by_user_id' },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by_user_id' },
    retiredAt: { type: DataTypes.DATE, allowNull: true, field: 'retired_at' },
  }, {
    tableName: 'WebDomains',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    validate: { coherentScope() { validateClinicScope(this); } },
    indexes: [
      { unique: true, fields: ['host'] },
      { fields: ['clinica_id', 'status'] },
      { fields: ['grupo_clinica_id', 'status'] },
    ],
  });
  WebDomain.associate = function associate(models) {
    WebDomain.belongsTo(models.Clinica, { foreignKey: 'clinicaId', targetKey: 'id_clinica', as: 'clinica' });
    WebDomain.belongsTo(models.GrupoClinica, { foreignKey: 'grupoClinicaId', targetKey: 'id_grupo', as: 'grupoClinica' });
    WebDomain.hasMany(models.WebPublication, { foreignKey: 'domainId', as: 'publications' });
  };
  return WebDomain;
};
