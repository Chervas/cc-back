'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('WhatsappTemplates', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      waba_id: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      language: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      category: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      components: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      meta_template_id: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      last_synced_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('WhatsappTemplates', ['waba_id', 'name', 'language'], {
      unique: true,
      name: 'uniq_waba_template_language',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('WhatsappTemplates', 'uniq_waba_template_language');
    await queryInterface.dropTable('WhatsappTemplates');
  },
};
