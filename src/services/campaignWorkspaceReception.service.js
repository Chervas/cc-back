'use strict';

const { Op } = require('sequelize');
const RECEIPT_WINDOW_MS = 7 * 24 * 3600000;

function destinationKey(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|gclid|dclid|gbraid|wbraid|fbclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch { return null; }
}

async function loadFormReceiptEvidence({ models, campaigns, now = new Date(), transaction = null }) {
  const eligible = campaigns.filter(campaign => campaign.assigned && campaign.destination === 'web');
  if (!eligible.length) return new Map();
  const clinicIds = [...new Set(eligible.map(campaign => campaign.clinicId))];
  // Read no form fields or patient identifiers. The required join confirms that the event reached the CRM in the same clinic.
  const rows = await models.FormSubmissionEvent.findAll({
    where: { clinic_id: { [Op.in]: clinicIds }, created_at: {
      [Op.gte]: new Date(now.getTime() - RECEIPT_WINDOW_MS), [Op.lte]: now,
    } },
    attributes: ['clinic_id', 'page_url', 'created_at'],
    include: [{ model: models.LeadIntake, as: 'leadIntake', required: true, attributes: ['clinica_id'],
      where: { clinica_id: { [Op.in]: clinicIds } } }], raw: true, transaction,
  });
  const receipts = new Map();
  for (const row of rows) {
    if (Number(row.clinic_id) !== Number(row['leadIntake.clinica_id'])) continue;
    const url = destinationKey(row.page_url);
    const receivedAt = new Date(row.created_at).getTime();
    if (!url || !Number.isFinite(receivedAt) || receivedAt > now.getTime() || receivedAt < now.getTime() - RECEIPT_WINDOW_MS) continue;
    const key = `${Number(row.clinic_id)}:${url}`;
    receipts.set(key, Math.max(receipts.get(key) || 0, receivedAt));
  }
  return new Map(eligible.map(campaign => {
    const destinations = [...new Set(campaign.urls.map(destinationKey))];
    const dates = destinations.map(url => url ? receipts.get(`${campaign.clinicId}:${url}`) : null);
    const complete = dates.length > 0 && dates.every(Boolean);
    return [campaign.id, { checked: complete, ready: complete,
      checkedAt: complete ? new Date(Math.min(...dates)).toISOString() : null,
      detail: complete ? 'Se han recibido formularios en Interesados desde todos los destinos anunciados durante los últimos siete días.'
        : 'Todavía no hay una recepción reciente confirmada para todos los destinos anunciados.',
    }];
  }));
}

module.exports = { destinationKey, loadFormReceiptEvidence };
