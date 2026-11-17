'use strict';

const normalizeHistoryNumber = value => {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^\d{1,32}$/.test(text) || !/[1-9]/.test(text)) throw Object.assign(Error('Número de historia inválido'), { status: 400 });
  return text.replace(/^0+/, '');
};
const historyScope = clinic => Number(clinic?.grupoClinicaId) > 0
  ? `group:${Number(clinic.grupoClinicaId)}` : `clinic:${Number(clinic.id_clinica)}`;

// Reuse the allocator's existing scope row as the contact-resolution mutex.
// The lock never consumes a number. Both ordinary registration and appointment
// birth take it before INSERT Pacientes acquires its foreign-key clinic lock;
// taking Clinicas FOR UPDATE first would invert that order and deadlock.
async function lockPatientHistoryCounter(sequelize, clinicId, transaction) {
  if (!transaction) throw new Error('patient_history_counter_transaction_required');
  const [clinics] = await sequelize.query('SELECT id_clinica, grupoClinicaId FROM Clinicas WHERE id_clinica = :clinicId',
    { replacements: { clinicId }, transaction });
  if (clinics.length !== 1) throw Object.assign(Error('Clínica no encontrada'), { status: 404 });
  const scope = historyScope(clinics[0]);
  await sequelize.query('INSERT INTO PatientHistoryCounters (scope_key,next_number) VALUES (:scope,1) ON DUPLICATE KEY UPDATE scope_key=scope_key',
    { replacements: { scope }, transaction });
  const [rows] = await sequelize.query('SELECT next_number FROM PatientHistoryCounters WHERE scope_key=:scope FOR UPDATE',
    { replacements: { scope }, transaction });
  return { scope, nextNumber: normalizeHistoryNumber(rows[0]?.next_number) };
}

async function allocatePatientHistoryNumber(sequelize, clinicId, transaction = null) {
  const allocate = async tx => {
    const { scope, nextNumber: number } = await lockPatientHistoryCounter(sequelize, clinicId, tx);
    await sequelize.query('UPDATE PatientHistoryCounters SET next_number=next_number+1 WHERE scope_key=:scope',
      { replacements: { scope }, transaction: tx });
    return { numero_historia: number, historia_scope: scope };
  };
  return transaction ? allocate(transaction) : sequelize.transaction(allocate);
}

module.exports = { normalizeHistoryNumber, historyScope, lockPatientHistoryCounter, allocatePatientHistoryNumber };
