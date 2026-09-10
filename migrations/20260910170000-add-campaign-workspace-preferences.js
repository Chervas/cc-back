'use strict';

const TABLE = 'CampaignWorkspaceSettings';
module.exports = {
  async up(qi, Sequelize) {
    let columns = await qi.describeTable(TABLE);
    if (!columns.preferences) await qi.addColumn(TABLE, 'preferences', { type: Sequelize.JSON, allowNull: true });
    columns = await qi.describeTable(TABLE);
    if (String(columns.preferences?.type).toUpperCase() !== 'JSON' || columns.preferences.allowNull !== true) {
      throw new Error('CampaignWorkspaceSettings.preferences: incompatible column');
    }
  },
  async down(qi) {
    const columns = await qi.describeTable(TABLE);
    if (!columns.preferences) return;
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS count FROM CampaignWorkspaceSettings WHERE preferences IS NOT NULL');
    if (Number(rows[0]?.count)) throw new Error('Workspace preferences exist; explicit archival is required before rollback.');
    await qi.removeColumn(TABLE, 'preferences');
  },
};
