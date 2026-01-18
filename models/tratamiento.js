'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Tratamiento extends Model {
    static associate(models) {
      if (models.Clinica) {
        Tratamiento.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      }
       if (models.DependenciaTratamiento) {
        Tratamiento.hasMany(models.DependenciaTratamiento, { foreignKey: 'id_tratamiento_origen', as: 'dependenciasOrigen' });
        Tratamiento.hasMany(models.DependenciaTratamiento, { foreignKey: 'id_tratamiento_destino', as: 'dependenciasDestino' });
      }
    }
  }

  Tratamiento.init({
    id_tratamiento: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    nombre: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    codigo: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    descripcion: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    disciplina: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    especialidad: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    categoria: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    duracion_min: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    precio_base: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 0
    },
    color: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    origen: {
      type: DataTypes.ENUM('sistema', 'grupo', 'clinica'),
      allowNull: false,
      defaultValue: 'clinica'
    },
    id_tratamiento_base: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    eliminado_por_clinica: {
      type: DataTypes.JSON,
      allowNull: true
    },
    asignacion_especialidades: {
      type: DataTypes.JSON,
      allowNull: true
    },
    sesiones_defecto: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 1
    },
    requiere_pieza: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    requiere_zona: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    activo: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    clinica_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    grupo_clinica_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'Tratamiento',
    tableName: 'Tratamientos',
    timestamps: true
  });

  return Tratamiento;
};
