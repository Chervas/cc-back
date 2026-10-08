'use strict';
module.exports = {
  async up(q, D) {
    await q.addColumn('DoctorBloqueos', 'recurrente_hasta', { type: D.DATEONLY, allowNull: true, defaultValue: null });
  },
  async down(q) {
    const [rows] = await q.sequelize.query('SELECT COUNT(*) AS n FROM DoctorBloqueos WHERE recurrente_hasta IS NOT NULL');
    if (Number(rows[0]?.n)) throw Error('personal_block_until_rollback_requires_empty_limits');
    await q.removeColumn('DoctorBloqueos', 'recurrente_hasta');
  },
};
