'use strict';

function googleLogo(locations) {
  for (const location of locations || []) {
    let raw = location.raw_payload || {};
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = {}; } }
    const items = raw.clinicaclick_media_items || raw.mediaItems || [];
    for (const category of ['LOGO', 'PROFILE']) {
      const item = (Array.isArray(items) ? items : []).find(media =>
        String(media.locationAssociation?.category || media.category || '').toUpperCase() === category
        && String(media.mediaFormat || media.media_format || 'PHOTO').toUpperCase() !== 'VIDEO'
        && /^https:\/\//i.test(media.googleUrl || media.sourceUrl || media.thumbnailUrl || ''));
      if (item) return item.googleUrl || item.sourceUrl || item.thumbnailUrl;
    }
  }
  return null;
}

// Only local, effectively assigned Google content; never a remote fetch on a
// clinic/agenda request. Reading this fallback does not persist a custom logo.
async function resolveClinicAvatar(clinic, dependencies = {}) {
  if (String(clinic?.url_avatar || '').trim()) return { url: clinic.url_avatar, source: 'clinic' };
  try {
    const resolve = dependencies.resolveEffectiveLocations || require('./businessProfileLocal.service').resolveEffectiveLocations;
    const resolved = await resolve(clinic.id_clinica);
    const url = googleLogo(resolved.locations);
    return { url, source: url ? 'google_business_profile' : null };
  } catch (_) { return { url: null, source: null }; }
}

async function enrichClinicAvatars(rows) {
  return Promise.all(rows.map(async row => {
    const data = row?.toJSON ? row.toJSON() : { ...row };
    const avatar = await resolveClinicAvatar(data);
    return { ...data, configured_avatar_url: data.url_avatar || null, url_avatar: avatar.url, avatar_source: avatar.source };
  }));
}

module.exports = { googleLogo, resolveClinicAvatar, enrichClinicAvatars };
