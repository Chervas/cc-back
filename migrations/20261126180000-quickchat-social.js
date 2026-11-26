'use strict';

const E = require('../src/lib/mysqlEnumExtension');

module.exports = {
  async up(q, D) {
    const columns = await q.describeTable('Conversations');
    if (!columns.channel.type.includes('messenger')) {
      // Append to preserve the ordinal values of existing channels.
      const read = async () =>
        E.column(
          (
            await q.sequelize.query(E.metadataSql, {
              replacements: ['Conversations', 'channel'],
              type: D.QueryTypes.SELECT,
            })
          )[0],
        );
      const before = await read();
      const after = { ...before, values: [...before.values, 'messenger'] };
      E.validate(before, after);
      await q.sequelize.query(E.sql('Conversations', 'channel', after));
      E.validate(after, await read(), false);
    }
    for (const [name, size] of [
      ['social_account_id', 30],
      ['social_account_name', 255],
      ['social_alias', 255],
    ]) {
      if (!columns[name])
        await q.addColumn('Conversations', name, { type: D.STRING(size), allowNull: true });
    }
    if (!(await q.showIndex('Conversations')).some((i) => i.name === 'cc_social_thread')) {
      await q.addIndex('Conversations', ['clinic_id', 'channel', 'social_account_id', 'contact_id'], {
        unique: true,
        name: 'cc_social_thread',
      });
    }
    await q.createTable('SocialInboxReceipts', {
      key: { type: D.CHAR(64), primaryKey: true },
      state: { type: D.STRING(16), allowNull: false },
      event: { type: D.JSON, allowNull: false },
      route: D.JSON,
      message_id: D.INTEGER,
      reason: D.STRING(100),
      createdAt: { type: D.DATE, allowNull: false },
      updatedAt: { type: D.DATE, allowNull: false },
    });
    if (!(await q.showIndex('SocialInboxReceipts')).some((i) => i.name === 'cc_social_state')) {
      await q.addIndex('SocialInboxReceipts', ['state', 'updatedAt', 'key'], {
        name: 'cc_social_state',
      });
    }
  },
  async down() {
    throw new Error(
      'Conservar historial social. El rollback de código es compatible con el esquema aditivo.',
    );
  },
};
