'use strict';

const TABLE = 'CampaignWorkspaceSettings';
module.exports = {
  async up(qi, Sequelize) {
    let columns = await qi.describeTable(TABLE);
    if (!columns.signal_preparation) await qi.addColumn(TABLE, 'signal_preparation', { type: Sequelize.JSON, allowNull: true });
    columns = await qi.describeTable(TABLE);
    if (String(columns.signal_preparation?.type).toUpperCase() !== 'JSON' || columns.signal_preparation.allowNull !== true) {
      throw new Error('CampaignWorkspaceSettings.signal_preparation: incompatible column');
    }
  },
  async down(qi) {
    const columns = await qi.describeTable(TABLE);
    if (!columns.signal_preparation) return;
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS count FROM CampaignWorkspaceSettings WHERE signal_preparation IS NOT NULL');
    if (Number(rows[0]?.count)) throw new Error('Signal preparation exists; explicit archival is required before rollback.');
    await qi.removeColumn(TABLE, 'signal_preparation');
  },
};
