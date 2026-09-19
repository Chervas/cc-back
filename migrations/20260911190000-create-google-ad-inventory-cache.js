'use strict';

const daily = 'GoogleAdsAdInsightsDaily';
const oldIndex = 'uniq_google_ads_ad_date_account';
const newIndex = 'uniq_google_ads_ad_group_date_account';
const oldFields = ['clinicGoogleAdsAccountId', 'date', 'adId', 'network', 'device'];
const newFields = ['clinicGoogleAdsAccountId', 'date', 'campaignId', 'adGroupId', 'adId', 'network', 'device'];

async function ensureIndex(qi, table, name, fields, unique) {
  const found = (await qi.showIndex(table)).find(index => index.name === name);
  if (!found) return qi.addIndex(table, fields, { name, unique });
  if (found.unique !== unique || found.fields.map(field => field.attribute).join(',') !== fields.join(',')) {
    throw new Error(`${table}.${name}: incompatible index`);
  }
}

module.exports = {
  async up(qi, Sequelize) {
    const nullable = type => ({ type, allowNull: true });
    const common = () => ({
      id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, autoIncrement: true },
      clinicGoogleAdsAccountId: { type: Sequelize.INTEGER, allowNull: false },
      customerId: { type: Sequelize.STRING(32), allowNull: false },
      campaignId: { type: Sequelize.STRING(64), allowNull: false },
      observedAt: { type: Sequelize.DATE(3), allowNull: false },
    });
    const definitions = [
      ['GoogleAdsAdInventory', { ...common(),
        campaignName: nullable(Sequelize.STRING(256)), campaignStatus: nullable(Sequelize.STRING(32)),
        adGroupId: { type: Sequelize.STRING(64), allowNull: false }, adGroupName: nullable(Sequelize.STRING(256)),
        adGroupStatus: nullable(Sequelize.STRING(32)), adId: { type: Sequelize.STRING(64), allowNull: false },
        adName: nullable(Sequelize.STRING(256)), adType: nullable(Sequelize.STRING(64)), adStatus: nullable(Sequelize.STRING(32)),
        finalUrl: nullable(Sequelize.STRING(1024)), displayUrl: nullable(Sequelize.STRING(512)),
        headlines: nullable(Sequelize.JSON), descriptions: nullable(Sequelize.JSON), present: { type: Sequelize.BOOLEAN, allowNull: false },
      }, [
        { name: 'uniq_google_ad_inventory_identity', unique: true, fields: ['clinicGoogleAdsAccountId', 'campaignId', 'adGroupId', 'adId'] },
        { name: 'idx_google_ad_inventory_campaign', fields: ['customerId', 'campaignId'] },
      ]],
      ['GoogleAdsAdSyncDays', { ...common(), campaignId: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '' },
        date: { type: Sequelize.DATEONLY, allowNull: false },
      }, [
        { name: 'uniq_google_ad_sync_day', unique: true, fields: ['clinicGoogleAdsAccountId', 'campaignId', 'date'] },
        { name: 'idx_google_ad_sync_customer_date', fields: ['customerId', 'date'] },
      ]],
    ];
    for (const [table, columns, indexes] of definitions) {
      columns.clinicGoogleAdsAccountId.references = { model: 'ClinicGoogleAdsAccounts', key: 'id' };
      columns.clinicGoogleAdsAccountId.onDelete = 'CASCADE';
      columns.clinicGoogleAdsAccountId.onUpdate = 'CASCADE';
      columns.created_at = { type: Sequelize.DATE, allowNull: false };
      columns.updated_at = { type: Sequelize.DATE, allowNull: false };
      const tables = await qi.showAllTables();
      if (!tables.some(name => (typeof name === 'string' ? name : name.tableName) === table)) await qi.createTable(table, columns);
      const actual = await qi.describeTable(table);
      const typeKey = value => String(value).toUpperCase().replace(/INTEGER/g, 'INT').replace(/INT\(\d+\)/g, 'INT').replace(/TINYINT\(1\)/g, 'BOOLEAN');
      for (const [name, column] of Object.entries(columns)) {
        const type = typeof column.type === 'function' ? column.type() : column.type;
        const expectedType = type.key === 'DATE' && type.options?.length ? `DATETIME(${type.options.length})` : type;
        if (!actual[name] || typeKey(actual[name].type) !== typeKey(expectedType) || actual[name].allowNull !== (column.allowNull !== false && !column.primaryKey)) {
          throw new Error(`${table}.${name}: incompatible column`);
        }
      }
      for (const index of indexes) await ensureIndex(qi, table, index.name, index.fields, !!index.unique);
    }
    const columns = await qi.describeTable(daily);
    if (!columns.observedAt) await qi.addColumn(daily, 'observedAt', { type: Sequelize.DATE(3), allowNull: true });
    else if (columns.observedAt.type.toUpperCase() !== 'DATETIME(3)' || columns.observedAt.allowNull !== true) throw new Error('GoogleAdsAdInsightsDaily.observedAt: incompatible column');
    // Keep nullable groups for older writers sharing this DB; new ingestion requires the full identity.
    await ensureIndex(qi, daily, newIndex, newFields, true);
    if ((await qi.showIndex(daily)).some(index => index.name === oldIndex)) await qi.removeIndex(daily, oldIndex);
  },
  async down(qi) {
    // Adding first refuses an unsafe rollback without deleting ads that share an ID across groups.
    await ensureIndex(qi, daily, oldIndex, oldFields, true);
    if ((await qi.showIndex(daily)).some(index => index.name === newIndex)) await qi.removeIndex(daily, newIndex);
    await qi.removeColumn(daily, 'observedAt');
    await qi.dropTable('GoogleAdsAdSyncDays');
    await qi.dropTable('GoogleAdsAdInventory');
  },
};
