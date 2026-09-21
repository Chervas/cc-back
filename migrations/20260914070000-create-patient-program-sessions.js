'use strict';
// Additive preparation only. No runtime gates, catalogue or messages changed.
module.exports = {
  async up(q, S) {
    await q.addColumn('TreatmentPrograms', 'cadence', { type: S.JSON, allowNull: true });
    await q.createTable('PatientProgramSessions', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      voucher_id: { type: S.BIGINT.UNSIGNED, allowNull: false, references: { model: 'PatientVouchers', key: 'id' }, onDelete: 'RESTRICT' },
      session_key: { type: S.STRING(64), allowNull: false },
      position: { type: S.INTEGER.UNSIGNED, allowNull: false },
      snapshot_sha256: { type: S.STRING(64), allowNull: false },
      snapshot: { type: S.JSON, allowNull: false },
      appointment_id: { type: S.INTEGER, allowNull: true, references: { model: 'CitasPacientes', key: 'id_cita' }, onDelete: 'RESTRICT' },
      consumption_movement_id: { type: S.BIGINT.UNSIGNED, allowNull: true, references: { model: 'PatientVoucherMovements', key: 'id' }, onDelete: 'RESTRICT' },
      created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false },
    });
    await q.addIndex('PatientProgramSessions', ['voucher_id', 'session_key'], { unique: true, name: 'pps_voucher_session' });
    await q.addIndex('PatientProgramSessions', ['appointment_id'], { unique: true, name: 'pps_current_appointment' });
    await q.createTable('PatientProgramBookingRequests', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      voucher_id: { type: S.BIGINT.UNSIGNED, allowNull: false, references: { model: 'PatientVouchers', key: 'id' }, onDelete: 'RESTRICT' },
      request_key: { type: S.STRING(80), allowNull: false },
      request_sha256: { type: S.STRING(64), allowNull: false }, result: { type: S.JSON, allowNull: false },
      created_by: { type: S.INTEGER, allowNull: false }, created_at: { type: S.DATE, allowNull: false },
    });
    await q.addIndex('PatientProgramBookingRequests', ['voucher_id', 'request_key'], { unique: true, name: 'ppbr_voucher_request' });
  },
  async down(q) {
    for (const table of ['PatientProgramSessions', 'PatientProgramBookingRequests']) {
      const [rows] = await q.sequelize.query(`SELECT COUNT(*) n FROM \`${table}\``);
      if (Number(rows[0].n)) throw Error('PROGRAM_HISTORY_MUST_BE_PRESERVED');
    }
    const [programs] = await q.sequelize.query('SELECT COUNT(*) n FROM TreatmentPrograms WHERE cadence IS NOT NULL');
    if (Number(programs[0].n)) throw Error('PROGRAM_CADENCE_MUST_BE_PRESERVED');
    await q.dropTable('PatientProgramBookingRequests');
    await q.dropTable('PatientProgramSessions');
    await q.removeColumn('TreatmentPrograms', 'cadence');
  },
};
