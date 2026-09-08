'use strict';
module.exports = {
  async up(q, S) {
    await q.createTable('TreatmentProtocols', {
      id: { type: S.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      clinic_id: { type: S.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
      title: { type: S.STRING(200), allowNull: false },
      kind: { type: S.STRING(20), allowNull: false },
      status: { type: S.STRING(20), allowNull: false },
      version: { type: S.INTEGER.UNSIGNED, allowNull: false },
      content: { type: S.TEXT('long'), allowNull: false },
      source: { type: S.STRING(500), allowNull: true },
      treatment_ids: { type: S.JSON, allowNull: false },
      created_by: { type: S.INTEGER, allowNull: false },
      updated_by: { type: S.INTEGER, allowNull: false },
      approved_by: { type: S.INTEGER, allowNull: true },
      approved_at: { type: S.DATE, allowNull: true },
      created_at: { type: S.DATE, allowNull: false },
      updated_at: { type: S.DATE, allowNull: false },
    });
    await q.addIndex('TreatmentProtocols', ['clinic_id', 'status', 'id'], { name: 'treatment_protocol_clinic_status' });
    await q.createTable('TreatmentProtocolRevisions', {
      id: { type: S.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      protocol_id: { type: S.INTEGER, allowNull: false, references: { model: 'TreatmentProtocols', key: 'id' }, onDelete: 'RESTRICT' },
      version: { type: S.INTEGER.UNSIGNED, allowNull: false },
      snapshot: { type: S.JSON, allowNull: false },
      actor_id: { type: S.INTEGER, allowNull: false },
      created_at: { type: S.DATE, allowNull: false },
    });
    await q.addIndex('TreatmentProtocolRevisions', ['protocol_id', 'version'], { name: 'treatment_protocol_revision_version', unique: true });
  },
  async down(q) {
    const [rows] = await q.sequelize.query('SELECT COUNT(*) AS count FROM TreatmentProtocols');
    if (Number(rows[0].count)) throw new Error('Hay protocolos clínicos: se necesita rollback de datos aprobado para retirar estas tablas.');
    await q.dropTable('TreatmentProtocolRevisions');
    await q.dropTable('TreatmentProtocols');
  },
};
