'use strict';

async function ensureTable(queryInterface, name, columns) {
  // MySQL normalizes (and mutates) ENUM instances when creating a table.
  const expectedColumns = Object.fromEntries(Object.entries(columns).map(([key, column]) => {
    const type = typeof column.type === 'function' ? column.type() : column.type;
    return [key, { ...column, type: type.values ? `ENUM(${type.values.map(value => `'${value}'`).join(',')})` : String(type) }];
  }));
  const tables = await queryInterface.showAllTables();
  if (!tables.some(value => String(typeof value === 'string' ? value : value.tableName).toLowerCase() === name.toLowerCase())) {
    await queryInterface.createTable(name, columns);
  }
  const actual = await queryInterface.describeTable(name);
  const missing = Object.keys(columns).filter(key => !actual[key]);
  if (missing.length) throw new Error(`${name}: incomplete schema (${missing.join(', ')})`);
  const typeKey = type => String(type).toUpperCase().replace(/INTEGER/g, 'INT').replace(/INT\(\d+\)/g, 'INT').replace(/\s+/g, '');
  for (const [key, expected] of Object.entries(expectedColumns)) {
    if (typeKey(actual[key].type) !== typeKey(expected.type)
      || actual[key].allowNull !== expected.allowNull
      || expected.primaryKey && !actual[key].primaryKey) {
      throw new Error(`${name}.${key}: incompatible column`);
    }
  }
}

async function ensureIndex(queryInterface, table, fields, name) {
  const existing = (await queryInterface.showIndex(table)).find(index => index.name === name);
  if (!existing) return queryInterface.addIndex(table, fields, { name, unique: true });
  if (!existing.unique || existing.fields.map(field => field.attribute || field.name).join(',') !== fields.join(',')) {
    throw new Error(`${table}.${name}: incompatible index`);
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await ensureTable(queryInterface, 'CampaignWorkspaceSettings', {
      id: { type: Sequelize.STRING(36), primaryKey: true, allowNull: false },
      scope_type: { type: Sequelize.ENUM('clinic', 'group'), allowNull: false },
      scope_id: { type: Sequelize.INTEGER, allowNull: false },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      accounts: { type: Sequelize.JSON, allowNull: false },
      activation: { type: Sequelize.JSON, allowNull: true },
      updated_by_user_id: { type: Sequelize.INTEGER, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await ensureIndex(queryInterface, 'CampaignWorkspaceSettings', ['scope_type', 'scope_id'], 'uniq_campaign_workspace_scope');
    await ensureTable(queryInterface, 'CampaignWorkspaceEvents', {
      id: { type: Sequelize.STRING(36), primaryKey: true, allowNull: false },
      setting_id: { type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'CampaignWorkspaceSettings', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      event_type: { type: Sequelize.STRING(40), allowNull: false },
      actor_user_id: { type: Sequelize.INTEGER, allowNull: false },
      changes: { type: Sequelize.JSON, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await ensureIndex(queryInterface, 'CampaignWorkspaceEvents', ['setting_id', 'version'], 'uniq_campaign_workspace_event_version');
    const references = await queryInterface.getForeignKeyReferencesForTable('CampaignWorkspaceEvents');
    if (!references.some(reference => reference.columnName === 'setting_id'
      && reference.referencedTableName === 'CampaignWorkspaceSettings' && reference.referencedColumnName === 'id')) {
      throw new Error('CampaignWorkspaceEvents.setting_id: missing workspace foreign key');
    }
  },
  async down(queryInterface) {
    // Operational authorizations must not disappear as an incidental code rollback.
    const [rows] = await queryInterface.sequelize.query('SELECT COUNT(*) AS count FROM CampaignWorkspaceSettings');
    if (Number(rows[0].count)) throw new Error('Workspace settings exist; explicit archival is required before rollback.');
    await queryInterface.dropTable('CampaignWorkspaceEvents');
    await queryInterface.dropTable('CampaignWorkspaceSettings');
  },
};
