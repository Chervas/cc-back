'use strict';

// Existing writers continue supplying a human actor. Technical imports are
// identified by validated source metadata and never claim a human approval.
module.exports = {
  async up(q, S) {
    await q.changeColumn('TreatmentProtocols', 'created_by', { type: S.INTEGER, allowNull: true });
    await q.changeColumn('TreatmentProtocols', 'updated_by', { type: S.INTEGER, allowNull: true });
    await q.changeColumn('TreatmentProtocolRevisions', 'actor_id', { type: S.INTEGER, allowNull: true });
  },
  async down(q, S) {
    const [rows] = await q.sequelize.query('SELECT (SELECT COUNT(*) FROM TreatmentProtocols WHERE created_by IS NULL OR updated_by IS NULL) + (SELECT COUNT(*) FROM TreatmentProtocolRevisions WHERE actor_id IS NULL) AS pending');
    if (Number(rows[0]?.pending)) throw new Error('System-import audit records exist; preserve them instead of inventing human actors.');
    await q.changeColumn('TreatmentProtocols', 'created_by', { type: S.INTEGER, allowNull: false });
    await q.changeColumn('TreatmentProtocols', 'updated_by', { type: S.INTEGER, allowNull: false });
    await q.changeColumn('TreatmentProtocolRevisions', 'actor_id', { type: S.INTEGER, allowNull: false });
  },
};
