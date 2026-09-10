'use strict';

const TABLE = 'MetaSignalDeliveries';
module.exports = {
  async up(qi, Sequelize) {
    const tables = (await qi.showAllTables()).map(value => typeof value === 'string' ? value : value.tableName);
    const definition = {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      dedupe_key: { type: Sequelize.STRING(64), allowNull: false },
      clinic_id: { type: Sequelize.INTEGER, allowNull: false },
      account_id: { type: Sequelize.STRING(64), allowNull: false },
      campaign_id: { type: Sequelize.STRING(64), allowNull: true },
      dataset_id: { type: Sequelize.STRING(64), allowNull: false },
      destination_key: { type: Sequelize.STRING(64), allowNull: false },
      event_name: { type: Sequelize.STRING(32), allowNull: false },
      event_key: { type: Sequelize.STRING(64), allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      status: { type: Sequelize.ENUM('pending', 'accepted', 'warning', 'failed', 'unknown', 'skipped'), allowNull: false },
      attempt_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      lease_id: { type: Sequelize.STRING(36), allowNull: true },
      attempted_at: { type: Sequelize.DATE, allowNull: false },
      completed_at: { type: Sequelize.DATE, allowNull: true },
      policy_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      policy_refs: { type: Sequelize.JSON, allowNull: false },
      reason: { type: Sequelize.STRING(128), allowNull: true },
      events_received: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      warning_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      trace_id: { type: Sequelize.STRING(191), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    };
    const expected = Object.fromEntries(Object.entries(definition).map(([key, column]) => {
      const type = typeof column.type === 'function' ? column.type() : column.type;
      return [key, { ...column, type: type.values ? `ENUM(${type.values.map(value => `'${value}'`).join(',')})` : String(type) }];
    }));
    if (!tables.includes(TABLE)) await qi.createTable(TABLE, definition);
    const columns = await qi.describeTable(TABLE);
    const typeKey = type => String(type).toUpperCase().replace(/INTEGER/g, 'INT').replace(/INT\(\d+\)/g, 'INT').replace(/\s+/g, '');
    for (const [key, column] of Object.entries(expected)) {
      if (!columns[key]) throw new Error(`${TABLE}.${key}: missing column`);
      if (typeKey(columns[key].type) !== typeKey(column.type) || columns[key].allowNull !== column.allowNull
        || column.primaryKey && !columns[key].primaryKey) throw new Error(`${TABLE}.${key}: incompatible column`);
    }
    const indexes = await qi.showIndex(TABLE);
    for (const [name, fields, unique] of [['uniq_meta_signal_delivery', ['dedupe_key'], true],
      ['idx_meta_signal_campaign_time', ['clinic_id', 'account_id', 'campaign_id', 'attempted_at'], false]]) {
      const existing = indexes.find(index => index.name === name);
      if (!existing) await qi.addIndex(TABLE, fields, { name, unique });
      else if (!!existing.unique !== unique || JSON.stringify(existing.fields.map(field => field.attribute)) !== JSON.stringify(fields)) throw new Error(`Incompatible ${name}`);
    }
  },
  async down(qi) {
    const tables = (await qi.showAllTables()).map(value => typeof value === 'string' ? value : value.tableName);
    if (!tables.includes(TABLE)) return;
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS count FROM MetaSignalDeliveries');
    if (Number(rows[0]?.count)) throw new Error('Meta deliveries exist; explicit archival required before rollback.');
    await qi.dropTable(TABLE);
  },
};
