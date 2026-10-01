'use strict';

function belongsToAppointmentScope(template, clinicId, groupId) {
  if (template?.clinic_id != null) return Number(template.clinic_id) === Number(clinicId);
  if (template?.group_id != null) return !!groupId && Number(template.group_id) === Number(groupId);
  return template?.is_system === true || Number(template?.is_system) === 1;
}

function templateFamilyKey(template) {
  return String(template?.template_key || '').trim().replace(/(?:__?clinic_\d+)+$/gi, '');
}

function selectEffectiveAppointmentTemplates(rows, clinicId, groupId) {
  const latestByKey = new Map();
  for (const row of rows || []) {
    if (!row.published_at || !belongsToAppointmentScope(row, clinicId, groupId)) continue;
    const key = String(row.template_key || '').trim();
    if (!key) continue;
    const scopeKey = `${row.clinic_id != null ? `clinic:${row.clinic_id}` : row.group_id != null ? `group:${row.group_id}` : 'system'}:${key}`;
    const previous = latestByKey.get(scopeKey);
    if (!previous || Number(row.version) > Number(previous.version)
      || (Number(row.version) === Number(previous.version) && Number(row.id) > Number(previous.id))) {
      latestByKey.set(scopeKey, row);
    }
  }

  // An inactive clinic instance still overrides its shared system source.
  const families = new Map();
  for (const row of latestByKey.values()) {
    const family = templateFamilyKey(row);
    const rank = row.clinic_id != null ? 3 : row.group_id != null ? 2 : 1;
    families.set(family, Math.max(families.get(family) || 0, rank));
  }
  return [...latestByKey.values()].filter(row => {
    const rank = row.clinic_id != null ? 3 : row.group_id != null ? 2 : 1;
    return rank === families.get(templateFamilyKey(row))
      && (row.is_active === true || Number(row.is_active) === 1);
  });
}

module.exports = { belongsToAppointmentScope, templateFamilyKey, selectEffectiveAppointmentTemplates };
