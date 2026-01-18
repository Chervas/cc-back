'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class UsuarioEspecialidades extends Model {
    static associate(models) {
      if (models.Usuario) {
        UsuarioEspecialidades.belongsTo(models.Usuario, { foreignKey: 'id_usuario', targetKey: 'id_usuario', as: 'usuario' });
      }
      if (models.EspecialidadesMedicasSistema) {
        UsuarioEspecialidades.belongsTo(models.EspecialidadesMedicasSistema, { foreignKey: 'id_especialidad_sistema', as: 'especialidadSistema' });
      }
      if (models.EspecialidadesMedicasClinica) {
        UsuarioEspecialidades.belongsTo(models.EspecialidadesMedicasClinica, { foreignKey: 'id_especialidad_clinica', as: 'especialidadClinica' });
      }
    }
  }
  UsuarioEspecialidades.init({
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    id_usuario: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    id_especialidad_sistema: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    id_especialidad_clinica: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'UsuarioEspecialidades',
    tableName: 'UsuarioEspecialidades',
    timestamps: true
  });
  return UsuarioEspecialidades;
};
