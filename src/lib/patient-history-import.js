'use strict';

const { normalizeHistoryNumber } = require('../services/patientHistoryNumber.service');
const nameKey = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/\bMOD\b/g, '').replace(/[^A-Z0-9 ]/g, ' ').trim().split(/\s+/).sort().join(' ');
const phoneKey = value => String(value || '').replace(/\D/g, '').replace(/^(?:0034|34)(?=\d{9}$)/, '');
const dniKey = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const localDate = value => {
  const text = String(value || '');
  const m = text.match(/^(\d{2})[-/](\d{2})[-/](\d{4})(.*)$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}${m[4]}` : text;
};

function rankContacts(a, b) {
  return (b.treatment_count || 0) - (a.treatment_count || 0)
    || String(b.last_clinical_activity || '').localeCompare(String(a.last_clinical_activity || ''))
    || localDate(b.ALTA).localeCompare(localDate(a.ALTA))
    || String(b.IDCONTACTO).localeCompare(String(a.IDCONTACTO), 'en', { numeric: true });
}

function createHistoryImportPlan({ contacts, patients, links, clinicalCounts = {} }) {
  const patientsById = new Map(patients.map(p => [Number(p.id_paciente), p]));
  const contactMap = new Map(contacts.map(row => [String(row.IDCONTACTO), {
    ...row, number: normalizeHistoryNumber(row.NUM), treatment_count: clinicalCounts[row.IDCONTACTO]?.count || 0,
    last_clinical_activity: clinicalCounts[row.IDCONTACTO]?.last || '',
  }]));
  if (contactMap.size !== contacts.length) throw Error('source_contact_ids_repeated');
  const owners = new Map();
  for (const link of links) {
    const contactId = String(link.contact_id || '').trim();
    if (!contactMap.has(contactId) || !patientsById.has(Number(link.paciente_id))) continue;
    if (!owners.has(contactId)) owners.set(contactId, new Set());
    owners.get(contactId).add(Number(link.paciente_id));
  }
  const matched = [], unresolved = [];
  for (const contact of contactMap.values()) {
    if (owners.get(contact.IDCONTACTO)?.size > 1) { unresolved.push({ contact, reason: 'El contacto de origen está enlazado a varias fichas locales.' }); continue; }
    if (owners.has(contact.IDCONTACTO)) continue;
    const candidates = patients.filter(patient => {
      const sameName = nameKey(`${patient.nombre} ${patient.apellidos}`) === nameKey(`${contact.NOMBRE} ${contact.APELLIDOS}`);
      const document = dniKey(contact.DNI);
      const sameDni = /^[A-Z0-9]{8,12}$/.test(document) && dniKey(patient.dni) === document;
      const samePhone = phoneKey(contact['TELF. MOVIL']) && phoneKey(patient.telefono_movil) === phoneKey(contact['TELF. MOVIL']);
      const birth = localDate(contact['F. NACIMIENTO']).slice(0,10);
      const localBirth = patient.fecha_nacimiento ? new Date(patient.fecha_nacimiento).toISOString().slice(0,10) : '';
      const birthContradicts = birth && localBirth && birth !== localBirth;
      return !birthContradicts && ((sameName && (sameDni || samePhone))
        || (sameDni && (samePhone || (birth && birth === localBirth))));
    });
    if (candidates.length === 1) {
      const patientId = Number(candidates[0].id_paciente);
      owners.set(contact.IDCONTACTO, new Set([patientId]));
      matched.push({ contact_id: contact.IDCONTACTO, paciente_id: patientId,
        reason: dniKey(contact.DNI) && dniKey(candidates[0].dni) === dniKey(contact.DNI)
          ? 'Mismo nombre y DNI' : 'Mismo nombre y teléfono, sin contradicción en la fecha de nacimiento' });
    } else unresolved.push({ contact, reason: candidates.length ? 'Hay varias fichas coincidentes; no se fusionan automáticamente.' : 'No hay enlace ni coincidencia de identidad suficiente con una ficha local.' });
  }
  const byPatient = new Map();
  for (const contact of contactMap.values()) {
    if (owners.get(contact.IDCONTACTO)?.size !== 1) continue;
    const patientId = [...owners.get(contact.IDCONTACTO)][0];
    if (!byPatient.has(patientId)) byPatient.set(patientId, []);
    byPatient.get(patientId).push(contact);
  }
  const operations = [...byPatient].map(([patientId, candidates]) => {
    const ordered = candidates.sort(rankContacts);
    const chosen = ordered[0];
    const numbers = [...new Set(ordered.map(contact => contact.number))];
    const retentionReason = chosen.treatment_count
      ? (ordered.slice(1).some(contact => contact.treatment_count === chosen.treatment_count)
        ? 'por ser la ficha más reciente entre las que tenían más tratamientos asociados'
        : 'por tener más tratamientos asociados') : 'por corresponder a la ficha más reciente';
    return { paciente_id: patientId, numero_historia: chosen.number, chosen_contact_id: chosen.IDCONTACTO,
      chosen_treatment_count: chosen.treatment_count, source_contacts: ordered.map(contact => ({
        id: contact.IDCONTACTO, number: contact.number, treatment_count: contact.treatment_count,
    })), notes: numbers.length > 1 ? `Cuando se importó de ClinicCloud, este paciente tenía varios números de historia clínica: ${numbers.join(', ')}. Se conservó el ${chosen.number} ${retentionReason}. La elección del número no elimina ni fusiona su información clínica.` : '',
    };
  });
  const numberOwners = new Map();
  for (const op of operations) {
    if (!numberOwners.has(op.numero_historia)) numberOwners.set(op.numero_historia, []);
    numberOwners.get(op.numero_historia).push(op);
  }
  const duplicates = [];
  for (const [number, contenders] of numberOwners) {
    if (contenders.length < 2) continue;
    contenders.sort((a,b) => rankContacts(contactMap.get(a.chosen_contact_id), contactMap.get(b.chosen_contact_id)));
    const winner = contenders[0];
    for (const loser of contenders.slice(1)) {
      duplicates.push({ number, retained_patient_id: winner.paciente_id, patient_id: loser.paciente_id,
        retained_contact_id: winner.chosen_contact_id, contact_id: loser.chosen_contact_id,
        retained_treatment_count: winner.chosen_treatment_count, treatment_count: loser.chosen_treatment_count });
      loser.numero_historia = null;
      loser.notes = [loser.notes, `Cuando se importó de ClinicCloud, el número de historia clínica ${number} también correspondía a otra ficha. Se conservó en la ficha con más tratamientos asociados (y, en caso de empate, la más reciente). Esta ficha queda pendiente de asignar un número único; no se ha eliminado su información.`].filter(Boolean).join('\n\n');
    }
  }
  return { operations, duplicates, matched, unresolved, max_source_number: contacts.reduce((max,row) => {
    const n = BigInt(normalizeHistoryNumber(row.NUM)); return n > max ? n : max;
  }, 0n).toString(), stats: { contacts: contacts.length, patients: patients.length, mapped_patients: operations.length,
    assigned_numbers: operations.filter(op => op.numero_historia).length, multiple_numbers: operations.filter(op => new Set(op.source_contacts.map(c => c.number)).size > 1).length,
    repeated_number_patients: duplicates.length, newly_matched_contacts: matched.length, unresolved_contacts: unresolved.length } };
}

module.exports = { createHistoryImportPlan, rankContacts, nameKey, phoneKey };
