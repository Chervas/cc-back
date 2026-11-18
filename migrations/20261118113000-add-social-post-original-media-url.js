'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('SocialPosts');
    if (!columns.original_media_url) await queryInterface.addColumn('SocialPosts', 'original_media_url', {
      type: Sequelize.TEXT, allowNull: true,
      comment: 'Original media returned by normal synchronization; never a video thumbnail',
    });
  },
  async down() {
    // Revert application code without deleting already recovered originals.
    throw new Error('social_post_original_media_preserved_rollback_code_only');
  },
};
