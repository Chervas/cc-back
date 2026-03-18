'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE Messages
      MODIFY COLUMN message_type ENUM('text', 'image', 'template', 'event', 'reaction')
      NOT NULL DEFAULT 'text'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE Messages
      SET message_type = 'text'
      WHERE message_type = 'reaction'
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE Messages
      MODIFY COLUMN message_type ENUM('text', 'image', 'template', 'event')
      NOT NULL DEFAULT 'text'
    `);
  },
};
