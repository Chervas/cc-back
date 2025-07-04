module.exports = (sequelize, DataTypes) => {
  const Campana = sequelize.define('Campana', {
    nombre: {
      type: DataTypes.STRING,
      allowNull: false
    },
    campaign_id: {
      type: DataTypes.STRING,
      allowNull: true
    },
    estado: {
      type: DataTypes.ENUM('ACTIVE', 'PAUSED', 'DELETED'),
      defaultValue: 'ACTIVE'
    },
    gastoTotal: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0
    },
    fechaInicio: {
      type: DataTypes.DATE,
      allowNull: true
    },
    fechaFin: {
      type: DataTypes.DATE,
      allowNull: true
    },
    leads: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    preset: {
      type: DataTypes.STRING,
      allowNull: true
    },
    frecuenciaMaxima: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true
    },
    reproducciones75: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    reproduccionesTotales: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    curvaVisionado: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    orden: {
      type: DataTypes.STRING,
      allowNull: true
    },
    precioPorLead: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0
    },
    mostrar: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    }
  }, {
    timestamps: true
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
