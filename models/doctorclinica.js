'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class DoctorClinica extends Model {
    static associate(models) {
      DoctorClinica.belongsTo(models.Usuario, { foreignKey: 'doctor_id', targetKey: 'id_usuario', as: 'doctor' });
      DoctorClinica.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      DoctorClinica.hasMany(models.DoctorHorario, { foreignKey: 'doctor_clinica_id', as: 'horarios' });
    }
  }
  DoctorClinica.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    doctor_id: { type: DataTypes.INTEGER, allowNull: false },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    rol_en_clinica: DataTypes.STRING(64),
    // Modo de disponibilidad del miembro en esta clínica.
    // Valores canónicos: 'sin_citas' | 'citas_automaticas' | 'citas_personalizadas'.
    // Legacy (compat temporal): 'solo_registro' | 'basico' | 'avanzado' — mapeados en controllers.
    modo_disponibilidad: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'citas_personalizadas' },
    activo: { type: DataTypes.BOOLEAN, defaultValue: true }
  }, {
    sequelize,
    modelName: 'DoctorClinica',
    tableName: 'DoctorClinicas',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });
  return DoctorClinica;
};
