'use strict';
module.exports = {
  async up(q, S) {
    const existing = await q.describeTable('PatientFollowUps');
    for (const [name, type] of Object.entries({
      reminder_advance_days: { type: S.INTEGER, allowNull: true },
      recipient_mode: { type: S.STRING(16), allowNull: false, defaultValue: 'creator' },
      recipient_role_ids: { type: S.JSON, allowNull: true },
      notice_cycle: { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      notice_enabled: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
    })) if (!existing[name]) await q.addColumn('PatientFollowUps', name, type);
    const tables = (await q.showAllTables()).map(x => typeof x === 'string' ? x : x.tableName);
    if (!tables.includes('PatientFollowUpNotices')) await q.createTable('PatientFollowUpNotices', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      follow_up_id: { type: S.BIGINT.UNSIGNED, allowNull: false, references: { model: 'PatientFollowUps', key: 'id' }, onDelete: 'RESTRICT' },
      user_id: { type: S.INTEGER, allowNull: false },
      enabled: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      snoozed_until: { type: S.DATE, allowNull: true },
      next_notice_at: { type: S.DATE, allowNull: true },
      notification_id: { type: S.INTEGER, allowNull: true },
      cycle: { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      last_issued_at: { type: S.DATE, allowNull: true },
      created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false },
    });
    const indexes = await q.showIndex('PatientFollowUpNotices');
    if (!indexes.some(x => x.name === 'pfun_recipient_unique')) await q.addIndex('PatientFollowUpNotices', ['follow_up_id','user_id'], { unique: true, name: 'pfun_recipient_unique' });
  },
  async down() { throw Error('Los avisos tienen preferencias e historial por persona; se requiere un rollback de datos revisado.'); },
};
