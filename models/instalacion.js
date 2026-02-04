'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Instalacion extends Model {
    static associate(models) {
      Instalacion.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      Instalacion.hasMany(models.InstalacionHorario, { foreignKey: 'instalacion_id', as: 'horarios' });
      Instalacion.hasMany(models.InstalacionBloqueo, { foreignKey: 'instalacion_id', as: 'bloqueos' });
    }
  }
  Instalacion.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    nombre: { type: DataTypes.STRING(255), allowNull: false },
    tipo: { type: DataTypes.ENUM('box','quirofano','sala_pruebas','sala_polivalente','otro'), defaultValue: 'box' },
    descripcion: DataTypes.TEXT,
    piso: DataTypes.STRING(64),
    color: DataTypes.STRING(16),
    capacidad: { type: DataTypes.INTEGER, defaultValue: 1 },
    activo: { type: DataTypes.BOOLEAN, defaultValue: true },
    requiere_preparacion: { type: DataTypes.BOOLEAN, defaultValue: false },
    tiempo_preparacion_minutos: { type: DataTypes.INTEGER, defaultValue: 0 },
    es_exclusiva: { type: DataTypes.BOOLEAN, defaultValue: false },
    especialidades_permitidas: DataTypes.JSON,
    tratamientos_exclusivos: DataTypes.JSON,
    equipamiento: DataTypes.JSON,
    orden_visualizacion: DataTypes.INTEGER
  }, {
    sequelize,
    modelName: 'Instalacion',
    tableName: 'Instalaciones',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });
  return Instalacion;
};
