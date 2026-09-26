'use strict';

module.exports = (sequelize, D) => {
  const model = sequelize.define('ClinicMedicalAreaContract', {
    id: { type: D.INTEGER, autoIncrement: true, primaryKey: true },
    clinic_id: { type: D.INTEGER, allowNull: false },
    code: { type: D.STRING(80), allowNull: false },
    revision_id: { type: D.INTEGER, allowNull: false },
    previous_revision_id: { type: D.INTEGER, allowNull: true },
    updated_by: { type: D.INTEGER, allowNull: true },
  }, {
    tableName: 'ClinicMedicalAreaContracts', underscored: true, timestamps: true,
    indexes: [{ unique: true, fields: ['clinic_id', 'code'] }],
  });
  model.associate = (models) => {
    model.belongsTo(models.MedicalAreaContractRevision, { as: 'revision', foreignKey: 'revision_id' });
  };
  return model;
};
