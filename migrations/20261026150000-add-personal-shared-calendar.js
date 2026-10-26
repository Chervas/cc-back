'use strict';
module.exports = {
  async up(q, D) {
    await q.addColumn('DoctorClinicas', 'shared_schedule_source_id', { type: D.INTEGER, allowNull: true, defaultValue: null });
  },
  async down(q) {
    const [rows] = await q.sequelize.query('SELECT COUNT(*) AS n FROM DoctorClinicas WHERE shared_schedule_source_id IS NOT NULL');
    if (Number(rows[0]?.n)) throw Error('personal_shared_calendar_rollback_requires_unlinked_calendars');
    await q.removeColumn('DoctorClinicas', 'shared_schedule_source_id');
  },
};
