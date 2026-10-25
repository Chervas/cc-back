'use strict';
const E = require('../src/lib/mysqlEnumExtension');
const EXTENSIONS = [
  ['EconomicBudgetEvents', 'event_type', ['concept_cancelled', 'payment_recorded', 'financing_updated']],
  ['PatientWalletEntries', 'entry_type', ['concept_credit']],
  ['PatientVoucherMovements', 'movement_type', ['cancellation']],
  ['EconomicPayments', 'method', ['direct_debit']],
];
module.exports = {
  async up(q, S) {
    for (const [table, name, added] of EXTENSIONS) {
      const read = async () => {
        const rows = await q.sequelize.query(E.metadataSql, { replacements: [table, name], type: S.QueryTypes.SELECT });
        if (rows.length !== 1) throw Error('economic_enum_column_missing');
        return E.column(rows[0]);
      };
      const before = await read();
      const after = { ...before, values: [...before.values, ...added.filter(value => !before.values.includes(value))] };
      if (after.values.length === before.values.length) continue;
      E.validate(before, after);
      await q.sequelize.query(E.sql(table, name, after));
      E.validate(after, await read(), false);
    }
  },
  async down() { throw Error('Economic audit ENUM extensions are forward-only; preserve persisted events and money history.'); },
};
