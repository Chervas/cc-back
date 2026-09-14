'use strict';
// Additive repair: the service/model already emit signature activity, but the
// original database ENUM only accepted budget transitions. Keep its order.
const BASE = ['created', 'edited', 'presented', 'accepted', 'partially_accepted', 'rejected', 'expired', 'duplicated', 'superseded'];
const ADDED = ['signature_request_created', 'signature_request_sent', 'signature_request_failed', 'signature_request_expired', 'signature_request_viewed', 'signature_request_signed'];
const ALL = [...BASE, ...ADDED];
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function current(q) {
  const column = (await q.describeTable('EconomicBudgetEvents')).event_type;
  const match = String(column?.type || '').match(/^ENUM\((.*)\)$/i);
  if (!match || column.allowNull !== false) fail('budget_event_schema_incompatible');
  const values = match[1].split(',').map(v => v.trim().replace(/^'|'$/g, ''));
  if (BASE.some((v, i) => values[i] !== v) || values.some(v => !ALL.includes(v)) || new Set(values).size !== values.length) fail('budget_event_enum_incompatible');
  return values;
}
module.exports = {
  async up(q, Sequelize) {
    const before = await current(q);
    if (ALL.every((v, i) => before[i] === v) && before.length === ALL.length) return;
    // Refuse unexpected partial order instead of renumbering existing values.
    if (!before.every((v, i) => ALL[i] === v)) fail('budget_event_enum_order_incompatible');
    await q.changeColumn('EconomicBudgetEvents', 'event_type', { type: Sequelize.ENUM(...ALL), allowNull: false });
    const after = await current(q);
    if (ALL.some((v, i) => after[i] !== v) || after.length !== ALL.length) fail('budget_event_migration_verification_failed');
  },
  async down(q, Sequelize) {
    const before = await current(q);
    if (before.length === BASE.length) return;
    const [rows] = await q.sequelize.query('SELECT COUNT(*) AS total FROM `EconomicBudgetEvents` WHERE `event_type` IN (:added)', { replacements: { added: ADDED } });
    if (Number(rows?.[0]?.total) !== 0) fail('budget_event_rollback_has_audit_history');
    await q.changeColumn('EconomicBudgetEvents', 'event_type', { type: Sequelize.ENUM(...BASE), allowNull: false });
  },
};
