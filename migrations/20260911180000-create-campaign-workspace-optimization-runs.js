'use strict';

const table = 'CampaignWorkspaceOptimizationRuns';
module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = {
      id: { type: Sequelize.STRING(36), primaryKey: true, allowNull: false },
      runtime_namespace: { type: Sequelize.STRING(80), allowNull: false },
      setting_id: { type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'CampaignWorkspaceSettings', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      mandate_id: { type: Sequelize.STRING(36), allowNull: false },
      plan_key: { type: Sequelize.STRING(64), allowNull: false },
      provider: { type: Sequelize.STRING(16), allowNull: false },
      account_id: { type: Sequelize.STRING(64), allowNull: false },
      campaign_id: { type: Sequelize.STRING(64), allowNull: false },
      resource_key: { type: Sequelize.STRING(64), allowNull: false },
      change: { type: Sequelize.JSON, allowNull: false },
      evidence: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.ENUM('queued', 'leased', 'submitted', 'verified', 'observed', 'skipped', 'uncertain'), allowNull: false, defaultValue: 'queued' },
      job_request_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true,
        references: { model: 'JobRequests', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      lease_token: { type: Sequelize.STRING(36), allowNull: true },
      lease_until: { type: Sequelize.DATE, allowNull: true },
      submitted_at: { type: Sequelize.DATE, allowNull: true },
      completed_at: { type: Sequelize.DATE, allowNull: true },
      outcome: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    };
    const expected = Object.fromEntries(Object.entries(columns).map(([name, column]) => {
      const type = typeof column.type === 'function' ? column.type() : column.type;
      return [name, { ...column, type: type.values ? `ENUM(${type.values.map(value => `'${value}'`).join(',')})` : String(type) }];
    }));
    const tables = await queryInterface.showAllTables();
    if (!tables.some(name => String(typeof name === 'string' ? name : name.tableName).toLowerCase() === table.toLowerCase())) await queryInterface.createTable(table, columns);
    const actual = await queryInterface.describeTable(table);
    const typeKey = type => String(type).toUpperCase().replace(/INTEGER/g, 'INT').replace(/INT\(\d+\)/g, 'INT').replace(/\s+/g, '');
    for (const [name, column] of Object.entries(expected)) {
      if (!actual[name] || typeKey(actual[name].type) !== typeKey(column.type) || actual[name].allowNull !== column.allowNull
        || column.primaryKey && !actual[name].primaryKey) throw new Error(`${table}.${name}: incompatible column`);
    }
    const definitions = [
      ['uniq_workspace_optimization_plan', ['setting_id', 'plan_key'], true],
      ['idx_workspace_optimization_account', ['provider', 'account_id', 'status'], false],
      ['idx_workspace_optimization_resource', ['resource_key', 'submitted_at'], false],
      ['idx_workspace_optimization_pending', ['runtime_namespace', 'status', 'updated_at'], false],
    ];
    for (const [name, fields, unique] of definitions) {
      const index = (await queryInterface.showIndex(table)).find(index => index.name === name);
      if (!index) await queryInterface.addIndex(table, fields, { name, unique });
      else if (index.unique !== unique || index.fields.map(field => field.attribute || field.name).join(',') !== fields.join(',')) throw new Error(`${table}.${name}: incompatible index`);
    }
    const references = await queryInterface.getForeignKeyReferencesForTable(table);
    for (const [name, column] of Object.entries(columns).filter(([, column]) => column.references)) {
      if (!references.some(ref => ref.columnName === name && ref.referencedTableName === column.references.model && ref.referencedColumnName === column.references.key)) throw new Error(`${table}.${name}: missing foreign key`);
    }
  },
  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query('SELECT COUNT(*) AS count FROM CampaignWorkspaceOptimizationRuns');
    if (Number(rows[0].count)) throw new Error('Optimization records exist; explicit archival is required before rollback.');
    await queryInterface.dropTable(table);
  },
};
