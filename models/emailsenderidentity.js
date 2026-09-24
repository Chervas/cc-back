'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EmailSenderIdentity extends Model {
    static associate(models) {
      EmailSenderIdentity.belongsTo(models.EmailSendingDomain, { foreignKey: 'domain_id', as: 'domain' });
      EmailSenderIdentity.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      EmailSenderIdentity.belongsTo(models.GrupoClinica, { foreignKey: 'grupo_clinica_id', targetKey: 'id_grupo', as: 'grupoClinica' });
    }
  }
  EmailSenderIdentity.init({
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    scope_type: { type: DataTypes.STRING(16), allowNull: false },
    scope_key: { type: DataTypes.STRING(64), allowNull: false },
    clinica_id: DataTypes.INTEGER,
    grupo_clinica_id: DataTypes.INTEGER,
    domain_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    email: { type: DataTypes.STRING(320), allowNull: false },
    display_name: { type: DataTypes.STRING(160), allowNull: false },
    reply_to: DataTypes.STRING(320),
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'active' },
    verification_status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
    is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'EmailSenderIdentity',
    tableName: 'EmailSenderIdentities',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return EmailSenderIdentity;
};
