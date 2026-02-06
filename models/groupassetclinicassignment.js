'use strict';

module.exports = (sequelize, DataTypes) => {
  const GroupAssetClinicAssignment = sequelize.define('GroupAssetClinicAssignment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: false, field: 'grupoClinicaId' },
    grupo_clinica_id: {
      type: DataTypes.VIRTUAL,
      get() {
        return this.getDataValue('grupoClinicaId') ?? null;
      }
    },
    assetType: { type: DataTypes.STRING(64), allowNull: false, field: 'assetType' },
    assetId: { type: DataTypes.INTEGER, allowNull: false, field: 'assetId' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: false, field: 'clinicaId' }
  }, {
    tableName: 'GroupAssetClinicAssignments',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  GroupAssetClinicAssignment.associate = function(models) {
    GroupAssetClinicAssignment.belongsTo(models.GrupoClinica, { foreignKey: 'grupoClinicaId', targetKey: 'id_grupo', as: 'grupo' });
    GroupAssetClinicAssignment.belongsTo(models.Clinica, { foreignKey: 'clinicaId', targetKey: 'id_clinica', as: 'clinica' });
  };

  return GroupAssetClinicAssignment;
};
