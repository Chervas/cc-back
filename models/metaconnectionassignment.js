'use strict';

module.exports = (sequelize, DataTypes) => {
  const MetaConnectionAssignment = sequelize.define('MetaConnectionAssignment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    scopeKey: { type: DataTypes.STRING(64), allowNull: false, unique: true, field: 'scopeKey' },
    assignmentScope: { type: DataTypes.ENUM('clinic', 'group'), allowNull: false, defaultValue: 'clinic', field: 'assignmentScope' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinicaId' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupoClinicaId' },
    metaConnectionId: { type: DataTypes.INTEGER, allowNull: false, field: 'metaConnectionId' },
    status: {
      type: DataTypes.ENUM('active', 'reauthorization_required', 'revoked', 'disconnected'),
      allowNull: false,
      defaultValue: 'active',
      field: 'status'
    },
    authorizedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'authorizedByUserId' },
    authorizedByName: { type: DataTypes.STRING(255), allowNull: true, field: 'authorizedByName' },
    authorizedByEmail: { type: DataTypes.STRING(255), allowNull: true, field: 'authorizedByEmail' },
    connectedAt: { type: DataTypes.DATE, allowNull: true, field: 'connectedAt' },
    lastValidatedAt: { type: DataTypes.DATE, allowNull: true, field: 'lastValidatedAt' },
    lastErrorCode: { type: DataTypes.STRING(128), allowNull: true, field: 'lastErrorCode' },
    lastErrorMessage: { type: DataTypes.TEXT, allowNull: true, field: 'lastErrorMessage' }
  }, {
    tableName: 'MetaConnectionAssignments',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['scopeKey'] },
      { fields: ['metaConnectionId'] },
      { fields: ['clinicaId'] },
      { fields: ['grupoClinicaId'] },
      { fields: ['status'] }
    ]
  });

  MetaConnectionAssignment.associate = function(models) {
    MetaConnectionAssignment.belongsTo(models.MetaConnection, { foreignKey: 'metaConnectionId', targetKey: 'id', as: 'metaConnection' });
    MetaConnectionAssignment.belongsTo(models.Clinica, { foreignKey: 'clinicaId', targetKey: 'id_clinica', as: 'clinica' });
    MetaConnectionAssignment.belongsTo(models.GrupoClinica, { foreignKey: 'grupoClinicaId', targetKey: 'id_grupo', as: 'grupoClinica' });
    MetaConnectionAssignment.belongsTo(models.Usuario, { foreignKey: 'authorizedByUserId', targetKey: 'id_usuario', as: 'authorizedBy' });
  };

  return MetaConnectionAssignment;
};
