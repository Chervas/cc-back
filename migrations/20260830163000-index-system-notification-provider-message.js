'use strict';

const INDEX_NAME = 'idx_system_notifications_provider_message';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex(
      'SystemNotificationDeliveries',
      ['channel', 'provider', 'provider_message_id'],
      { name: INDEX_NAME }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('SystemNotificationDeliveries', INDEX_NAME);
  },
};
