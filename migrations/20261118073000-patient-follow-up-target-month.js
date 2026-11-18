'use strict';

module.exports = {
  async up(q, S) {
    const columns = await q.describeTable('PatientFollowUps');
    if (!columns.clinical_target_month) await q.addColumn('PatientFollowUps', 'clinical_target_month', {
      type: S.STRING(7), allowNull: true,
    });
  },
  async down(q) {
    const [rows] = await q.sequelize.query('SELECT COUNT(*) AS total FROM PatientFollowUps WHERE clinical_target_month IS NOT NULL');
    if (Number(rows[0].total)) throw Error('Los meses previstos contienen historia: se requiere una reversión de datos revisada.');
    await q.removeColumn('PatientFollowUps', 'clinical_target_month');
  },
};
