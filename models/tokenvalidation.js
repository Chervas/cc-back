// models/TokenValidations.js
module.exports = (sequelize, DataTypes) => {
  const TokenValidations = sequelize.define('TokenValidations', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    connection_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'MetaConnections',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
      comment: 'ID de la conexión Meta validada'
    },
    validation_date: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Fecha y hora de la validación'
    },
    status: {
      type: DataTypes.ENUM('valid', 'invalid', 'expired'),
      allowNull: false,
      comment: 'Resultado de la validación del token'
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Mensaje de error (si aplica)'
    }
  }, {
    tableName: 'TokenValidations',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  TokenValidations.associate = function(models) {
    TokenValidations.belongsTo(models.MetaConnection, {
      foreignKey: 'connection_id',
      targetKey: 'id',
      as: 'metaConnection'
    });
  };

  return TokenValidations;
};

