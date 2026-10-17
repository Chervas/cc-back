'use strict';
// Additive only. Legacy como_nos_conocio/procedencia and attribution evidence
// remain byte-for-byte unchanged; NULL never invents an acquisition origin.
module.exports = {
  async up(q, S) {
    const fields = await q.describeTable('Pacientes');
    if (fields.como_nos_conocio_codigo) {
      if (String(fields.como_nos_conocio_codigo.type).toUpperCase() !== 'VARCHAR(64)' || fields.como_nos_conocio_codigo.allowNull !== true) throw Error('patient_declared_origin_schema_conflict');
      return;
    }
    await q.addColumn('Pacientes', 'como_nos_conocio_codigo', { type: S.STRING(64), allowNull: true, defaultValue: null });
  },
  async down() { throw Error('Refusing to remove a patient declared-origin field; preserve recorded answers.'); },
};
