'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EmailSendingDomain extends Model {
    static associate(models) {
      EmailSendingDomain.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      EmailSendingDomain.belongsTo(models.GrupoClinica, { foreignKey: 'grupo_clinica_id', targetKey: 'id_grupo', as: 'grupoClinica' });
      EmailSendingDomain.hasMany(models.EmailSenderIdentity, { foreignKey: 'domain_id', as: 'senders' });
    }
  }
  EmailSendingDomain.init({
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    scope_type: { type: DataTypes.STRING(16), allowNull: false },
    scope_key: { type: DataTypes.STRING(64), allowNull: false },
    clinica_id: DataTypes.INTEGER,
    grupo_clinica_id: DataTypes.INTEGER,
    domain: { type: DataTypes.STRING(255), allowNull: false },
    identity_name: { type: DataTypes.STRING(320), allowNull: false },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
    verification_status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
    dkim_status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
    spf_status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
    dmarc_status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'unknown' },
    mail_from_domain: DataTypes.STRING(255),
    mail_from_status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'not_configured' },
    dns_records: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    provider_snapshot: DataTypes.JSON,
    last_error_code: DataTypes.STRING(120),
    last_error_message: DataTypes.STRING(1000),
    checked_at: DataTypes.DATE,
    created_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'EmailSendingDomain',
    tableName: 'EmailSendingDomains',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return EmailSendingDomain;
};
