// models/tokenvalidation.js
module.exports = (sequelize, DataTypes) => {
  const TokenValidation = sequelize.define('TokenValidation', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    assetId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'ClinicMetaAssets',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
      comment: 'ID del ClinicMetaAsset vinculado'
    },
    tokenType: {
      type: DataTypes.STRING(50),
      allowNull: false,
      comment: 'Tipo de token validado'
    },
    isValid: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Resultado de la validación'
    },
    validatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Fecha de validación'
    },
    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Mensaje de error si aplica'
    }
  }, {
    tableName: 'TokenValidations',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  TokenValidation.associate = function(models) {
    TokenValidation.belongsTo(models.ClinicMetaAsset, {
      foreignKey: 'assetId',
      targetKey: 'id',
      as: 'asset'
    });
  };

  return TokenValidation;
};

