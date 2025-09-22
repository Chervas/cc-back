'use strict';

module.exports = (sequelize, DataTypes) => {
  const BusinessProfilePost = sequelize.define('BusinessProfilePost', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    business_location_id: { type: DataTypes.INTEGER, allowNull: false },
    post_name: { type: DataTypes.STRING(256), allowNull: false, unique: true },
    summary: { type: DataTypes.STRING(1024), allowNull: true },
    topic_type: { type: DataTypes.STRING(64), allowNull: true },
    call_to_action_type: { type: DataTypes.STRING(64), allowNull: true },
    call_to_action_url: { type: DataTypes.STRING(1024), allowNull: true },
    media_url: { type: DataTypes.STRING(1024), allowNull: true },
    create_time: { type: DataTypes.DATE, allowNull: true },
    update_time: { type: DataTypes.DATE, allowNull: true },
    event_start_time: { type: DataTypes.DATE, allowNull: true },
    event_end_time: { type: DataTypes.DATE, allowNull: true },
    visibility_state: { type: DataTypes.STRING(64), allowNull: true },
    raw_payload: { type: DataTypes.JSON, allowNull: true }
  }, {
    tableName: 'BusinessProfilePosts',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  BusinessProfilePost.associate = function(models) {
    BusinessProfilePost.belongsTo(models.ClinicBusinessLocation, { foreignKey: 'business_location_id', as: 'location' });
    BusinessProfilePost.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
  };

  return BusinessProfilePost;
};
