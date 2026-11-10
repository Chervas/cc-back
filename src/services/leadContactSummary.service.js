'use strict';
const { Op } = require('sequelize');
const { formatDateLocal, localDateTimeToUtc } = require('../lib/availability-calendar');
const zone = 'Europe/Madrid';
const instant = value => {
  if (value instanceof Date) return value;
  if (typeof value !== 'string' || !value) return new Date(NaN);
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : value.replace(' ', 'T') + 'Z');
};

function todayCount(lead, attempts, now, start) {
  // SQL DATETIME stores seconds, while legacy JSON retains milliseconds.
  // Match mirrored records one-to-one by second, author, channel and reason;
  // retain multiplicity and never count a lifetime aggregate as "today".
  const key = (row, date) => JSON.stringify([Math.floor(+date / 1000),
    row.usuario_id ?? null, row.canal || 'llamada', String(row.motivo || '').replace(/^lead_auto_reply:.+$/, 'lead_auto_reply')]);
  const counts = new Map(); let total = 0;
  for (const row of attempts) {
    const date = instant(row.created_at);
    if (!(date >= start && date <= now)) continue;
    const k = key(row, date); counts.set(k, (counts.get(k) || 0) + 1); total++;
  }
  for (const row of Array.isArray(lead.historial_contactos) ? lead.historial_contactos : []) {
    if (!row) continue;
    const date = instant(row.fecha);
    if (!(date >= start && date <= now)) continue;
    const k = key(row, date), available = counts.get(k) || 0;
    if (available) counts.set(k, available - 1); else total++;
  }
  return total;
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

module.exports = { enrichContactSummary, todayCount };
