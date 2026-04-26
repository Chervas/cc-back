'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { normalizePhoneDigits } = require('../lib/phone');

const { CitaPaciente, Paciente, Tratamiento } = db;

const CANCELLED_STATES = new Set(['cancelada', 'no_asistio']);

function toDateMonthsAgo(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function getThresholdMonths(treatmentName) {
  const normalized = normalizeText(treatmentName).toLowerCase();
  if (normalized.includes('ortodon')) return 6;
  if (normalized.includes('higiene') || normalized.includes('periodon')) return 9;
  if (normalized.includes('capilar')) return 12;
  if (normalized.includes('implante')) return 6;
  return 6;
}

function getPriority({ eligible, thresholdMonths }) {
  if (eligible >= 8 || thresholdMonths <= 6) return 'alta';
  if (eligible >= 3) return 'media';
  return 'baja';
}

function getRecommendedMode(treatmentName) {
  const normalized = normalizeText(treatmentName).toLowerCase();
  if (normalized.includes('implante') || normalized.includes('presupuesto')) return 'managed_calls';
  if (normalized.includes('higiene') || normalized.includes('periodon')) return 'lead_call_list';
  return 'whatsapp_template';
}

function getRevenueLabel(treatmentName) {
  const normalized = normalizeText(treatmentName).toLowerCase();
  if (normalized.includes('implante')) return 'Tratamiento de alto valor';
  if (normalized.includes('ortodon')) return 'Alta probabilidad de revisión';
  if (normalized.includes('capilar')) return 'Seguimiento preventivo';
  return 'Seguimiento recurrente';
}

async function getSuggestions(scope, options = {}) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length) {
    return { success: true, suggestions: [], candidates_preview: [] };
  }

  const now = new Date();
  const maxRows = Math.min(Math.max(Number(options.limit_rows || 2500), 100), 5000);

  const pastAppointments = await CitaPaciente.findAll({
    where: {
      clinica_id: clinicIds.length === 1 ? clinicIds[0] : { [Op.in]: clinicIds },
      inicio: { [Op.lt]: now },
      estado: { [Op.notIn]: Array.from(CANCELLED_STATES) },
    },
    attributes: ['id_cita', 'clinica_id', 'paciente_id', 'tratamiento_id', 'estado', 'inicio'],
    include: [
      { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'nombre', 'apellidos', 'telefono_movil', 'email'] },
      { model: Tratamiento, as: 'tratamiento', attributes: ['id_tratamiento', 'nombre', 'disciplina', 'categoria'] },
    ],
    order: [['inicio', 'DESC']],
    limit: maxRows,
  });

  const patientIds = Array.from(new Set(
    pastAppointments
      .map((row) => Number(row.paciente_id || row.paciente?.id_paciente || 0))
      .filter((id) => Number.isInteger(id) && id > 0)
  ));

  const futureRows = patientIds.length
    ? await CitaPaciente.findAll({
      where: {
        paciente_id: { [Op.in]: patientIds },
        inicio: { [Op.gte]: now },
        estado: { [Op.notIn]: Array.from(CANCELLED_STATES) },
      },
      attributes: ['paciente_id'],
      raw: true,
    })
    : [];
  const futurePatientIds = new Set(futureRows.map((row) => Number(row.paciente_id)).filter(Boolean));

  const latestByPatientTreatment = new Map();
  for (const appointment of pastAppointments) {
    const treatmentName = normalizeText(appointment.tratamiento?.nombre) || 'Sin tratamiento asignado';
    const patientId = Number(appointment.paciente_id || appointment.paciente?.id_paciente || 0);
    if (!patientId) continue;
    const key = `${patientId}:${treatmentName.toLowerCase()}`;
    if (latestByPatientTreatment.has(key)) continue;
    latestByPatientTreatment.set(key, { appointment, treatmentName, patientId });
  }

  const groups = new Map();
  for (const item of latestByPatientTreatment.values()) {
    const { appointment, treatmentName, patientId } = item;
    const thresholdMonths = getThresholdMonths(treatmentName);
    const cutoff = toDateMonthsAgo(thresholdMonths);
    const lastDate = new Date(appointment.inicio);
    if (!(lastDate < cutoff)) continue;

    const phone = normalizePhoneDigits(appointment.paciente?.telefono_movil || '');
    const hasFutureAppointment = futurePatientIds.has(patientId);
    const validPhone = phone && phone.length >= 8;
    const status = hasFutureAppointment
      ? 'excluded_future_appointment'
      : (!validPhone ? 'excluded_invalid_phone' : 'ready');

    if (!groups.has(treatmentName)) {
      groups.set(treatmentName, {
        treatmentName,
        thresholdMonths,
        candidates: [],
      });
    }

    groups.get(treatmentName).candidates.push({
      patient_id: patientId,
      name: [appointment.paciente?.nombre, appointment.paciente?.apellidos].filter(Boolean).join(' ').trim() || 'Paciente sin nombre',
      treatment: treatmentName,
      last_visit_at: lastDate.toISOString(),
      status,
      reason: status === 'ready'
        ? 'Sin cita futura y teléfono válido'
        : (status === 'excluded_future_appointment' ? 'Tiene cita futura' : 'Teléfono no válido'),
    });
  }

  const suggestions = Array.from(groups.values())
    .map((group) => {
      const eligible = group.candidates.filter((candidate) => candidate.status === 'ready').length;
      const excluded = group.candidates.length - eligible;
      const id = `auto_${group.treatmentName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'sin_tratamiento'}_${group.thresholdMonths}m`;
      return {
        id,
        title: `${group.treatmentName} sin visita reciente`,
        subtitle: `Pacientes de ${group.treatmentName} sin cita futura detectada.`,
        treatment: group.treatmentName,
        condition: `Última cita hace más de ${group.thresholdMonths} meses, sin cita programada y con teléfono válido.`,
        candidates: group.candidates.length,
        eligible,
        excluded,
        exclusionSummary: excluded ? `${excluded} excluidos por cita futura o teléfono no válido.` : 'Sin exclusiones detectadas.',
        recommendedMode: getRecommendedMode(group.treatmentName),
        priority: getPriority({ eligible, thresholdMonths: group.thresholdMonths }),
        estimatedRevenueLabel: getRevenueLabel(group.treatmentName),
        source: 'catalog',
        candidates_preview: group.candidates.slice(0, 5),
      };
    })
    .filter((item) => item.candidates > 0)
    .sort((a, b) => (b.eligible - a.eligible) || (b.candidates - a.candidates))
    .slice(0, Math.min(Math.max(Number(options.limit || 8), 1), 20));

  return {
    success: true,
    suggestions,
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  getSuggestions,
};
