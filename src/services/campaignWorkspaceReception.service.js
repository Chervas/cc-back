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
  const eligible = campaigns.filter(campaign => campaign.assigned && ['web', 'mixed'].includes(campaign.destination));
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

function combineReceptionEvidence(parts) {
  const ready = parts.every(part => part?.checked && part.ready);
  const configured = parts.every(part => part?.configured || part?.ready);
  const failure = parts.find(part => part?.checked && !part.ready && !['pending_confirmation', 'unverified'].includes(part.state));
  return { checked: !!failure || parts.every(part => part?.checked), ready, configured,
    state: ready ? 'verified' : failure ? 'action_required' : configured ? 'pending_confirmation' : 'unverified',
    checkedAt: ready ? parts.map(part => part.checkedAt).filter(Boolean).sort()[0] || null : null,
    detail: ready ? 'Recepción comprobada en la web y en los formularios de la plataforma.'
      : failure?.detail || (configured ? 'Configuración preparada. Falta confirmar la recepción en todos los destinos.' : 'Falta comprobar la recepción en todos los destinos de la campaña.'),
  };
}

module.exports = { destinationKey, loadFormReceiptEvidence, combineReceptionEvidence };
