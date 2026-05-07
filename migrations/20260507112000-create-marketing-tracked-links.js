'use strict';

async function createTableIfMissing(queryInterface, table, definition, options = {}) {
  const tables = await queryInterface.showAllTables();
  const exists = tables.some((item) => {
    const name = typeof item === 'string' ? item : item.tableName;
    return name === table;
  });
  if (!exists) {
    await queryInterface.createTable(table, definition, options);
  }
}

async function addIndexIfMissing(queryInterface, table, fields, options) {
  const indexes = await queryInterface.showIndex(table);
  const name = options?.name;
  if (name && indexes.some((index) => index.name === name)) {
    return;
  }
  await queryInterface.addIndex(table, fields, options);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfMissing(queryInterface, 'MarketingTrackedLinks', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      token: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      list_id: { type: Sequelize.INTEGER, allowNull: false },
      item_id: { type: Sequelize.INTEGER, allowNull: true },
      clinica_id: { type: Sequelize.INTEGER, allowNull: true },
      grupo_clinica_id: { type: Sequelize.INTEGER, allowNull: true },
      variable_key: { type: Sequelize.STRING(128), allowNull: true },
      original_url: { type: Sequelize.TEXT, allowNull: false },
      tracking_domain: { type: Sequelize.STRING(255), allowNull: true },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'active' },
      metadata: { type: Sequelize.JSON, allowNull: true },
      clicks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      unique_clicks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      last_clicked_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await createTableIfMissing(queryInterface, 'MarketingTrackedLinkClicks', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      tracked_link_id: { type: Sequelize.INTEGER, allowNull: false },
      list_id: { type: Sequelize.INTEGER, allowNull: false },
      item_id: { type: Sequelize.INTEGER, allowNull: true },
      clinica_id: { type: Sequelize.INTEGER, allowNull: true },
      grupo_clinica_id: { type: Sequelize.INTEGER, allowNull: true },
      ip_hash: { type: Sequelize.STRING(64), allowNull: true },
      user_agent_hash: { type: Sequelize.STRING(64), allowNull: true },
      country_code: { type: Sequelize.STRING(8), allowNull: true },
      country_name: { type: Sequelize.STRING(128), allowNull: true },
      referrer: { type: Sequelize.TEXT, allowNull: true },
      clicked_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      metadata: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await addIndexIfMissing(queryInterface, 'MarketingTrackedLinks', ['token'], { name: 'idx_marketing_tracked_links_token', unique: true });
    await addIndexIfMissing(queryInterface, 'MarketingTrackedLinks', ['list_id', 'item_id'], { name: 'idx_marketing_tracked_links_list_item' });
    await addIndexIfMissing(queryInterface, 'MarketingTrackedLinkClicks', ['tracked_link_id', 'clicked_at'], { name: 'idx_marketing_link_clicks_link_time' });
    await addIndexIfMissing(queryInterface, 'MarketingTrackedLinkClicks', ['list_id', 'clicked_at'], { name: 'idx_marketing_link_clicks_list_time' });
    await addIndexIfMissing(queryInterface, 'MarketingTrackedLinkClicks', ['item_id'], { name: 'idx_marketing_link_clicks_item' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('MarketingTrackedLinkClicks').catch(() => null);
    await queryInterface.dropTable('MarketingTrackedLinks').catch(() => null);
  },
};
