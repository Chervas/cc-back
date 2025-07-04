module.exports = (sequelize, DataTypes) => {
  const AdCache = sequelize.define('AdCache', {
    ad_id: {
      type: DataTypes.STRING,
      allowNull: false
    },
    adset_id: {
      type: DataTypes.STRING,
      allowNull: false
    },
    campaign_id: {
      type: DataTypes.STRING,
      allowNull: false
    },
    ultima_actualizacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    timestamps: true
  });

  return AdCache;
};
