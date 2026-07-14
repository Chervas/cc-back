'use strict';

const { haveSameTemplateComponents } = require('./whatsapp-template-components');

const WHATSAPP_ASSET_TYPES = Object.freeze([
  'whatsapp_phone_number',
  'whatsapp_business_account',
]);

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseMaybeJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isEnabled(value) {
  if (value === true || value === 1) return true;
  return ['1', 'true', 'yes', 'si', 'sí'].includes(cleanString(value).toLowerCase());
}

function extractTechnicalTemplateVersion(baseName, candidateName) {
  const safeBaseName = cleanString(baseName).toLowerCase();
  const safeCandidate = cleanString(candidateName).toLowerCase();
  if (!safeBaseName || !safeCandidate) return null;
  if (safeCandidate === safeBaseName) return 1;
  const match = safeCandidate.match(/^(.*)_v(\d+)$/i);
  if (!match || cleanString(match[1]).toLowerCase() !== safeBaseName) return null;
  const parsed = Number(match[2]);
  return Number.isFinite(parsed) && parsed >= 2 ? parsed : null;
}

function normalizeCatalogComponents(catalog) {
  const components = parseMaybeJson(catalog?.components, []);
  if (Array.isArray(components) && components.length) return components;
  const bodyText = cleanString(catalog?.body_text);
  return bodyText ? [{ type: 'BODY', text: bodyText }] : [];
}

function hasCurrentCatalogContract(catalog, instance) {
  if (!catalog || !instance) return false;
  if (extractTechnicalTemplateVersion(catalog.name, instance.name) === null) return false;
  if (
    cleanString(catalog.category).toUpperCase()
    !== cleanString(instance.category).toUpperCase()
  ) {
    return false;
  }
  return haveSameTemplateComponents(
    normalizeCatalogComponents(catalog),
    instance.components
  );
}

function normalizeDisciplines(value) {
  const parsed = parseMaybeJson(value, []);
  return Array.isArray(parsed)
    ? parsed.map((entry) => cleanString(entry)).filter(Boolean)
    : [];
}

function getCatalogDisciplines(catalog) {
  const links = Array.isArray(catalog?.disciplinas) ? catalog.disciplinas : [];
  return links
    .map((entry) => cleanString(entry?.disciplina_code || entry))
    .filter(Boolean);
}

function getClinicDisciplines(clinic) {
  const config = parseMaybeJson(clinic?.configuracion, {}) || {};
  const disciplines = normalizeDisciplines(config.disciplinas);
  return disciplines.length ? disciplines : ['dental'];
}

function catalogAppliesToClinic(catalog, clinic) {
  if (isEnabled(catalog?.is_generic)) return true;
  const catalogDisciplines = new Set(getCatalogDisciplines(catalog));
  if (!catalogDisciplines.size) return false;
  return getClinicDisciplines(clinic).some((code) => catalogDisciplines.has(code));
}

function assetUpdatedAt(asset) {
  const timestamp = new Date(asset?.updatedAt || asset?.updated_at || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function pickLatestAsset(rows) {
  return [...rows].sort((left, right) => {
    const updatedDiff = assetUpdatedAt(right) - assetUpdatedAt(left);
    if (updatedDiff !== 0) return updatedDiff;
    return Number(right?.id || 0) - Number(left?.id || 0);
  })[0] || null;
}

function findScopedAsset({ clinic, assets, assetType }) {
  const clinicId = toPositiveInt(clinic?.id_clinica);
  const groupId = toPositiveInt(clinic?.grupoClinicaId);
  const activeTypeRows = (Array.isArray(assets) ? assets : []).filter((asset) => (
    isEnabled(asset?.isActive)
    && cleanString(asset?.assetType) === assetType
  ));

  const clinicAsset = pickLatestAsset(activeTypeRows.filter((asset) => (
    clinicId && toPositiveInt(asset?.clinicaId) === clinicId
  )));
  if (clinicAsset) return clinicAsset;
  if (!groupId) return null;

  return pickLatestAsset(activeTypeRows.filter((asset) => (
    cleanString(asset?.assignmentScope) === 'group'
    && toPositiveInt(asset?.grupoClinicaId) === groupId
  )));
}

function isUsableWhatsappAsset(asset) {
  const hasCredentials = isEnabled(asset?.hasCredentials)
    || !!cleanString(asset?.waAccessToken);
  return !!(
    cleanString(asset?.wabaId)
    && cleanString(asset?.phoneNumberId)
    && hasCredentials
  );
}

function resolveEffectiveWabaForClinic({ clinic, assets }) {
  for (const assetType of WHATSAPP_ASSET_TYPES) {
    const asset = findScopedAsset({ clinic, assets, assetType });
    if (isUsableWhatsappAsset(asset)) {
      return cleanString(asset.wabaId);
    }
  }
  return null;
}

function statusRank(status) {
  switch (cleanString(status).toUpperCase()) {
    case 'APPROVED': return 5;
    case 'PENDING':
    case 'IN_REVIEW': return 4;
    case 'PENDING_LOCAL': return 3;
    case 'REJECTED': return 2;
    default: return 1;
  }
}

function pickDiagnosticRow(rows) {
  return [...rows].sort((left, right) => {
    const rankDiff = statusRank(right?.status) - statusRank(left?.status);
    if (rankDiff !== 0) return rankDiff;
    const updatedDiff = assetUpdatedAt(right) - assetUpdatedAt(left);
    if (updatedDiff !== 0) return updatedDiff;
    return Number(right?.id || 0) - Number(left?.id || 0);
  })[0] || null;
}

function buildWhatsappTemplateCatalogCoverage({
  catalog,
  familyRows = [],
  clinics = [],
  assets = [],
} = {}) {
  const applicableClinics = (Array.isArray(clinics) ? clinics : [])
    .filter((clinic) => catalogAppliesToClinic(catalog, clinic))
    .map((clinic) => ({
      clinic,
      clinic_id: toPositiveInt(clinic?.id_clinica),
      clinic_name: cleanString(clinic?.nombre_clinica)
        || `Clínica ${toPositiveInt(clinic?.id_clinica) || '-'}`,
      waba_id: resolveEffectiveWabaForClinic({ clinic, assets }),
    }))
    .filter((entry) => entry.clinic_id && entry.waba_id);

  const applicableWabaIds = Array.from(
    new Set(applicableClinics.map((entry) => entry.waba_id))
  ).sort();
  const remoteFamilyRows = (Array.isArray(familyRows) ? familyRows : []).filter((row) => (
    !!cleanString(row?.waba_id)
    && extractTechnicalTemplateVersion(catalog?.name, row?.name) !== null
  ));

  const coverageByWaba = new Map();
  applicableWabaIds.forEach((wabaId) => {
    const wabaFamilyRows = remoteFamilyRows.filter((row) => cleanString(row?.waba_id) === wabaId);
    const contractRows = wabaFamilyRows.filter((row) => hasCurrentCatalogContract(catalog, row));
    const approvedRow = contractRows.find((row) => (
      cleanString(row?.status).toUpperCase() === 'APPROVED'
      && !!cleanString(row?.meta_template_id)
    )) || null;
    const diagnosticRow = pickDiagnosticRow(contractRows);
    coverageByWaba.set(wabaId, {
      approved: !!approvedRow,
      status: approvedRow
        ? 'APPROVED'
        : (cleanString(diagnosticRow?.status).toUpperCase()
          || (wabaFamilyRows.length ? 'DESACTUALIZADA' : 'SIN_ENVIAR')),
    });
  });

  const approvedCount = applicableWabaIds.filter((wabaId) => (
    coverageByWaba.get(wabaId)?.approved === true
  )).length;
  const approvalTotal = applicableWabaIds.length;
  const unapprovedClinics = applicableClinics
    .filter((entry) => coverageByWaba.get(entry.waba_id)?.approved !== true)
    .map((entry) => ({
      clinic_id: entry.clinic_id,
      clinic_name: entry.clinic_name,
      waba_id: entry.waba_id,
      status: coverageByWaba.get(entry.waba_id)?.status || 'SIN_ENVIAR',
    }));

  return {
    approved_by_coverage: approvalTotal > 0 && approvedCount === approvalTotal,
    approved_count: approvedCount,
    approved_total: approvalTotal,
    applicable_waba_ids: applicableWabaIds,
    unapproved_clinics: unapprovedClinics,
  };
}

module.exports = {
  buildWhatsappTemplateCatalogCoverage,
  catalogAppliesToClinic,
  extractTechnicalTemplateVersion,
  hasCurrentCatalogContract,
  resolveEffectiveWabaForClinic,
};
