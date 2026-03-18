'use strict';

module.exports = (sequelize, DataTypes) => {
  const GoogleConnectionAssignment = sequelize.define('GoogleConnectionAssignment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    scopeKey: { type: DataTypes.STRING(64), allowNull: false, unique: true, field: 'scopeKey' },
    assignmentScope: { type: DataTypes.ENUM('clinic', 'group'), allowNull: false, defaultValue: 'clinic', field: 'assignmentScope' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinicaId' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupoClinicaId' },
    googleConnectionId: { type: DataTypes.INTEGER, allowNull: false, field: 'googleConnectionId' },
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
    tableName: 'GoogleConnectionAssignments',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['scopeKey'] },
      { fields: ['googleConnectionId'] },
      { fields: ['clinicaId'] },
      { fields: ['grupoClinicaId'] },
      { fields: ['status'] }
    ]
  });

  GoogleConnectionAssignment.associate = function(models) {
    GoogleConnectionAssignment.belongsTo(models.GoogleConnection, { foreignKey: 'googleConnectionId', targetKey: 'id', as: 'googleConnection' });
    GoogleConnectionAssignment.belongsTo(models.Clinica, { foreignKey: 'clinicaId', targetKey: 'id_clinica', as: 'clinica' });
    GoogleConnectionAssignment.belongsTo(models.GrupoClinica, { foreignKey: 'grupoClinicaId', targetKey: 'id_grupo', as: 'grupoClinica' });
    GoogleConnectionAssignment.belongsTo(models.Usuario, { foreignKey: 'authorizedByUserId', targetKey: 'id_usuario', as: 'authorizedBy' });
  };

  return GoogleConnectionAssignment;
};
