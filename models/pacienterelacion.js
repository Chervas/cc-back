'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class PacienteRelacion extends Model {
    static associate(models) {
      PacienteRelacion.belongsTo(models.Paciente, { foreignKey: 'id_paciente', targetKey: 'id_paciente', as: 'paciente' });
      PacienteRelacion.belongsTo(models.Paciente, { foreignKey: 'id_paciente_relacionado', targetKey: 'id_paciente', as: 'relacionado' });
    }
  }
  PacienteRelacion.init({
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    id_paciente: { type: DataTypes.INTEGER, allowNull: false },
    id_paciente_relacionado: { type: DataTypes.INTEGER, allowNull: false },
    tipo_relacion: {
      type: DataTypes.ENUM('padre', 'madre', 'tutor_legal', 'conyuge', 'hijo', 'otro'),
      allowNull: false
    },
    es_contacto_principal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    fecha_inicio: { type: DataTypes.DATEONLY, allowNull: false },
    fecha_fin: { type: DataTypes.DATEONLY, allowNull: true }
  }, {
    sequelize,
    modelName: 'PacienteRelacion',
    tableName: 'PacienteRelaciones',
    timestamps: true
  });
  return PacienteRelacion;
};
