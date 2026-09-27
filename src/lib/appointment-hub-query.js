'use strict';

// A contact's appointment list is always bounded and scoped to ONE clinic.
function parseAppointmentHubQuery(query = {}) {
    const positive = value => /^\d+$/.test(String(value || '')) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
    const clinicId = positive(query.clinica_id) ? Number(query.clinica_id) : null;
    const patient = String(query.paciente_id || '').trim();
    const leadId = positive(query.lead_id) ? Number(query.lead_id) : null;
    if (!clinicId || (!patient && !leadId) || (patient && !positive(patient) && !/^(pac|pat)_[a-zA-Z0-9]+$/.test(patient))) {
        const error = new Error('Indica una clínica y un paciente o lead válido.');
        error.status = 400;
        throw error;
    }
    const page = positive(query.page) ? Math.min(Number(query.page), 10000) : 1;
    const limit = positive(query.limit) ? Math.min(Number(query.limit), 30) : 15;
    return { clinicId, patient, leadId, page, limit, past: query.period === 'past' };
}

module.exports = { parseAppointmentHubQuery };
