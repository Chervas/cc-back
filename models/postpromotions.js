// models/PostPromotions.js
module.exports = (sequelize, DataTypes) => {
  const PostPromotions = sequelize.define('PostPromotions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    asset_type: { type: DataTypes.ENUM('facebook_page', 'instagram_business'), allowNull: false },
    post_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'SocialPosts', key: 'id' } },
    ad_account_id: { type: DataTypes.STRING(64) },
    campaign_id: { type: DataTypes.STRING(64) },
    adset_id: { type: DataTypes.STRING(64) },
    ad_id: { type: DataTypes.STRING(64) },
    ad_creative_id: { type: DataTypes.STRING(64) },
    effective_instagram_media_id: { type: DataTypes.STRING(64) },
    effective_object_story_id: { type: DataTypes.STRING(64) },
    instagram_permalink_url: { type: DataTypes.STRING(512) },
    promo_start: { type: DataTypes.DATE },
    promo_end: { type: DataTypes.DATE },
    status: { type: DataTypes.STRING(64) }
  }, {
    tableName: 'PostPromotions',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  PostPromotions.associate = function(models) {
    PostPromotions.belongsTo(models.SocialPosts, { foreignKey: 'post_id', targetKey: 'id', as: 'post' });
  };

  return PostPromotions;
};

