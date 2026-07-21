'use strict';

const INDEX_NAME = 'notifications_event_is_read';

module.exports = {
  async up(queryInterface) {
    const indexes = await queryInterface.showIndex('Notifications');
    if (!indexes.some((index) => index.name === INDEX_NAME)) {
      await queryInterface.addIndex('Notifications', ['event', 'is_read'], { name: INDEX_NAME });
    }
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('Notifications');
    if (indexes.some((index) => index.name === INDEX_NAME)) {
      await queryInterface.removeIndex('Notifications', INDEX_NAME);
    }
  },
};
