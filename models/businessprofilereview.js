'use strict';

module.exports = (sequelize, DataTypes) => {
  const BusinessProfileReview = sequelize.define('BusinessProfileReview', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    business_location_id: { type: DataTypes.INTEGER, allowNull: false },
    review_name: { type: DataTypes.STRING(256), allowNull: false, unique: true },
    reviewer_name: { type: DataTypes.STRING(256), allowNull: true },
    reviewer_profile_photo_url: { type: DataTypes.STRING(1024), allowNull: true },
    star_rating: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    comment: { type: DataTypes.TEXT, allowNull: true },
    create_time: { type: DataTypes.DATE, allowNull: true },
    update_time: { type: DataTypes.DATE, allowNull: true },
    review_state: { type: DataTypes.STRING(64), allowNull: true },
    is_new: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    is_negative: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    reply_comment: { type: DataTypes.TEXT, allowNull: true },
    reply_update_time: { type: DataTypes.DATE, allowNull: true },
    has_reply: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    raw_payload: { type: DataTypes.JSON, allowNull: true }
  }, {
    tableName: 'BusinessProfileReviews',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  BusinessProfileReview.associate = function(models) {
    BusinessProfileReview.belongsTo(models.ClinicBusinessLocation, { foreignKey: 'business_location_id', as: 'location' });
    BusinessProfileReview.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
  };

  return BusinessProfileReview;
};
