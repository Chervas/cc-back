module.exports = (sequelize, DataTypes) => {
  const Campana = sequelize.define('Campana', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      field: 'id_campana'
    },
    nombre: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'nombre_campana'
    },
    cliente: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'cliente'
    },
    projectManager: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'projectManager'
    },
    campaign_id: {
      type: DataTypes.STRING,
      allowNull: true
    },
    estado: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'estado'
    },
    gastoTotal: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
      field: 'gastoTotal'
    },
    fechaInicio: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'fechaInicio'
    },
    fechaFin: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'fechaFin'
    },
    leads: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'leads'
    },
    preset: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'preset'
    },
    frecuenciaMaxima: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      field: 'frecuenciaMaxima'
    },
    reproducciones75: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'reproducciones75'
    },
    reproduccionesTotales: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'reproduccionesTotales'
    },
    curvaVisionado: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'curvaVisionado'
    },
    orden: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'orden'
    },
    precioPorLead: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
      field: 'precioPorLead'
    },
    mostrar: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'mostrar'
    },
    clinica_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'clinica_id'
    }
  }, {
    tableName: 'Campanas',
    timestamps: true,
    createdAt: 'fecha_creacion',
    updatedAt: 'fecha_actualizacion'
  });

  Campana.associate = function(models) {
    // Asociación con Clinica
    Campana.belongsTo(models.Clinica, {
      foreignKey: 'clinica_id',
      as: 'clinica'
    });
  };

  return Campana;
};
