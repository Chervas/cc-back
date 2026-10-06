'use strict';

const normalizeHistoryNumber = value => {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^\d{1,32}$/.test(text) || !/[1-9]/.test(text)) throw Object.assign(Error('Número de historia inválido'), { status: 400 });
  return text.replace(/^0+/, '');
};
const historyScope = clinic => Number(clinic?.grupoClinicaId) > 0
  ? `group:${Number(clinic.grupoClinicaId)}` : `clinic:${Number(clinic.id_clinica)}`;

async function allocatePatientHistoryNumber(sequelize, clinicId, transaction = null) {
  const allocate = async tx => {
    const [clinics] = await sequelize.query('SELECT id_clinica, grupoClinicaId FROM Clinicas WHERE id_clinica = :clinicId',
      { replacements: { clinicId }, transaction: tx });
    if (clinics.length !== 1) throw Object.assign(Error('Clínica no encontrada'), { status: 404 });
    const scope = historyScope(clinics[0]);
    await sequelize.query('INSERT INTO PatientHistoryCounters (scope_key,next_number) VALUES (:scope,1) ON DUPLICATE KEY UPDATE scope_key=scope_key',
      { replacements: { scope }, transaction: tx });
    const [rows] = await sequelize.query('SELECT next_number FROM PatientHistoryCounters WHERE scope_key=:scope FOR UPDATE',
      { replacements: { scope }, transaction: tx });
    const number = normalizeHistoryNumber(rows[0]?.next_number);
    await sequelize.query('UPDATE PatientHistoryCounters SET next_number=next_number+1 WHERE scope_key=:scope',
      { replacements: { scope }, transaction: tx });
    return { numero_historia: number, historia_scope: scope };
  };
  return transaction ? allocate(transaction) : sequelize.transaction(allocate);
}

module.exports = { normalizeHistoryNumber, historyScope, allocatePatientHistoryNumber };
