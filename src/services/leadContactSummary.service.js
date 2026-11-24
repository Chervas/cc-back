'use strict';
const { Op } = require('sequelize');
const { formatDateLocal, localDateTimeToUtc } = require('../lib/availability-calendar');
const zone = 'Europe/Madrid';
const instant = value => {
  if (value instanceof Date) return value;
  if (typeof value !== 'string' || !value) return new Date(NaN);
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : value.replace(' ', 'T') + 'Z');
};

function mergeLeadContactAttempts(attempts, history) {
  // SQL DATETIME stores seconds, while legacy JSON retains milliseconds.
  // Match mirrored records one-to-one by second, author, channel and reason;
  // retain multiplicity and never count a lifetime aggregate as "today".
  const key = (row, date) => JSON.stringify([Math.floor(+date / 1000),
    row.usuario_id ?? null, row.canal || 'llamada', String(row.motivo || '').replace(/^lead_auto_reply:.+$/, 'lead_auto_reply')]);
  const unmatched = new Map();
  const merged = [...attempts];
  for (const [index, row] of attempts.entries()) {
    const k = key(row, instant(row.created_at));
    if (!unmatched.has(k)) unmatched.set(k, []);
    unmatched.get(k).push(index);
  }
  for (const row of Array.isArray(history) ? history : []) {
    if (!row) continue;
    const k = key(row, instant(row.fecha));
    const index = unmatched.get(k)?.shift();
    if (index === undefined) merged.push({ ...row, created_at: row.fecha });
    else if (!merged[index].notas && row.notas) merged[index] = { ...merged[index], notas: row.notas };
  }
  return merged;
}

function todayCount(lead, attempts, now, start) {
  const inRange = value => {
    const date = instant(value);
    return date >= start && date <= now;
  };
  const history = Array.isArray(lead.historial_contactos) ? lead.historial_contactos : [];
  return mergeLeadContactAttempts(attempts.filter(row => inRange(row.created_at)),
    history.filter(row => inRange(row?.fecha))).length;
}

async function enrichContactSummary({ models, leads, now = new Date() }) {
  if (!leads.length) return leads;
  const today = formatDateLocal(now, zone), start = new Date(localDateTimeToUtc(today, '00:00:00', zone));
  const ids = leads.map(lead => Number(lead.id)).filter(id => Number.isSafeInteger(id) && id > 0);
  const rows = ids.length && models.LeadContactAttempt ? await models.LeadContactAttempt.findAll({
    where: { lead_intake_id: { [Op.in]: ids }, created_at: { [Op.gte]: start, [Op.lte]: now } },
    attributes: ['lead_intake_id', 'created_at', 'usuario_id', 'canal', 'motivo'], raw: true,
  }) : [];
  const grouped = new Map();
  for (const row of rows) {
    const id = Number(row.lead_intake_id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  return leads.map(lead => ({ ...lead, num_contactos_hoy: todayCount(lead, grouped.get(Number(lead.id)) || [], now, start), contactos_hoy_fecha: today }));
}

module.exports = { enrichContactSummary, mergeLeadContactAttempts, todayCount };
