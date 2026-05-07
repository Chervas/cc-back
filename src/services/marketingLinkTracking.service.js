'use strict';

const crypto = require('crypto');
const db = require('../../models');

const {
  MarketingTrackedLink,
  MarketingTrackedLinkClick,
  MarketingPatientContactEvent,
} = db;

function normalizeText(value) {
  return String(value ?? '').trim();
}

function hashValue(value) {
  const clean = normalizeText(value);
  if (!clean) return null;
  const salt = process.env.MARKETING_LINK_TRACKING_HASH_SALT || process.env.JWT_SECRET || 'clinicaclick';
  return crypto.createHash('sha256').update(`${salt}:${clean}`).digest('hex');
}

function getClientIp(req) {
  const forwarded = normalizeText(req.headers['x-forwarded-for']).split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || '';
}

function getCountry(req) {
  const code = normalizeText(
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-country-code']
  ).toUpperCase();
  return {
    country_code: code || null,
    country_name: code || null,
  };
}

async function recordTrackedLinkClick(token, req) {
  if (!MarketingTrackedLink || !MarketingTrackedLinkClick) {
    return null;
  }
  const link = await MarketingTrackedLink.findOne({
    where: {
      token: normalizeText(token),
      status: 'active',
    },
  });
  if (!link) {
    return null;
  }

  const country = getCountry(req);
  const click = await MarketingTrackedLinkClick.create({
    tracked_link_id: link.id,
    list_id: link.list_id,
    item_id: link.item_id || null,
    clinica_id: link.clinica_id || null,
    grupo_clinica_id: link.grupo_clinica_id || null,
    ip_hash: hashValue(getClientIp(req)),
    user_agent_hash: hashValue(req.headers['user-agent']),
    country_code: country.country_code,
    country_name: country.country_name,
    referrer: normalizeText(req.headers.referer || req.headers.referrer) || null,
    clicked_at: new Date(),
    metadata: {
      source: 'marketing_link_tracking',
      variable_key: link.variable_key || null,
    },
  });

  const [{ totalClicks = 0 } = {}] = await db.sequelize.query(
    'SELECT COUNT(*) AS totalClicks FROM MarketingTrackedLinkClicks WHERE tracked_link_id = :linkId',
    { replacements: { linkId: link.id }, type: db.Sequelize.QueryTypes.SELECT }
  );
  const [{ uniqueClicks = 0 } = {}] = await db.sequelize.query(
    `
    SELECT COUNT(DISTINCT CONCAT(COALESCE(item_id, 0), ':', COALESCE(ip_hash, ''), ':', COALESCE(user_agent_hash, ''))) AS uniqueClicks
    FROM MarketingTrackedLinkClicks
    WHERE tracked_link_id = :linkId
    `,
    { replacements: { linkId: link.id }, type: db.Sequelize.QueryTypes.SELECT }
  );

  await link.update({
    clicks: Number(totalClicks || 0),
    unique_clicks: Number(uniqueClicks || 0),
    last_clicked_at: click.clicked_at,
  });

  if (MarketingPatientContactEvent) {
    await MarketingPatientContactEvent.create({
      list_id: link.list_id,
      item_id: link.item_id || null,
      event_type: 'mass_campaign_link_clicked',
      channel: 'whatsapp',
      payload: {
        tracked_link_id: link.id,
        variable_key: link.variable_key || null,
        original_url: link.original_url,
        country_code: country.country_code,
      },
      occurred_at: click.clicked_at,
    }).catch(() => null);
  }

  return link.original_url;
}

module.exports = {
  recordTrackedLinkClick,
};
