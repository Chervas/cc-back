module.exports = (sequelize, DataTypes) => {
  const Lead = sequelize.define('Lead', {
    nombre: {
      type: DataTypes.STRING,
      allowNull: true
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true
    },
    telefono: {
      type: DataTypes.STRING,
      allowNull: true
    },
    facebook_lead_id: {
      type: DataTypes.STRING,
      allowNull: true
    },
    form_id: {
      type: DataTypes.STRING,
      allowNull: true
    },
    fecha_creacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    datos_adicionales: {
      type: DataTypes.JSON,
      allowNull: true
    },
    estado: {
      type: DataTypes.ENUM('NUEVO', 'CONTACTADO', 'CONVERTIDO', 'DESCARTADO'),
      defaultValue: 'NUEVO'
    },
    notas: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    timestamps: true
  });

  Lead.associate = function(models) {
    // Asociación con Campana
    Lead.belongsTo(models.Campana, {
      foreignKey: 'campana_id',
      as: 'campana'
    });
    
    // Asociación con Clinica
    Lead.belongsTo(models.Clinica, {
      foreignKey: 'clinica_id',
      as: 'clinica'
    });
  };

  return Lead;
};
