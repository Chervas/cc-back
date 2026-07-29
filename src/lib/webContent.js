'use strict';

const crypto = require('node:crypto');
const { canonicalSerialize } = require('./webDocument');

const WEB_CONTENT_TYPES = Object.freeze([
  'value_proposition',
  'benefit',
  'faq',
  'treatment_copy',
  'professional_bio',
  'testimonial',
  'legal_copy',
  'article',
  'category',
]);
const WEB_CONTENT_STATUSES = Object.freeze(['draft', 'review', 'published', 'archived']);
const WEB_MEDIA_STATUSES = Object.freeze(['processing', 'ready', 'failed', 'archived']);
const WEB_MEDIA_KINDS = Object.freeze(['image']);
const WEB_RIGHTS_ORIGINS = Object.freeze(['owned', 'licensed', 'stock', 'generated']);
const WEB_CONTENT_SCHEMA_PROFILES = Object.freeze([
  'auto',
  'WebPage',
  'CreativeWork',
  'FAQPage',
  'Article',
  'Person',
  'Review',
  'MedicalWebPage',
  'CollectionPage',
]);

const WEB_CONTENT_SCHEMA_PROFILE_BY_TYPE = Object.freeze({
  value_proposition: Object.freeze(['auto', 'WebPage', 'CreativeWork']),
  benefit: Object.freeze(['auto', 'CreativeWork', 'WebPage']),
  faq: Object.freeze(['auto', 'FAQPage', 'WebPage']),
  treatment_copy: Object.freeze(['auto', 'MedicalWebPage', 'WebPage']),
  professional_bio: Object.freeze(['auto', 'Person', 'WebPage']),
  testimonial: Object.freeze(['auto', 'Review', 'CreativeWork']),
  legal_copy: Object.freeze(['auto', 'WebPage', 'CreativeWork']),
  article: Object.freeze(['auto', 'Article', 'WebPage']),
  category: Object.freeze(['auto', 'CollectionPage', 'WebPage']),
});
const WEB_CONTENT_TYPES_WITH_IMAGE = Object.freeze([
  'value_proposition',
  'benefit',
  'treatment_copy',
  'professional_bio',
  'article',
  'category',
]);

class WebContentValidationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'WebContentValidationError';
    this.code = code;
    this.status = 422;
    this.details = details;
  }
}

function fail(code, message, path, details = {}) {
  throw new WebContentValidationError(code, message, {
    path,
    ...details,
  });
}

function assertPlainObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('invalid_content_shape', `${path} debe ser un objeto JSON.`, path);
  }
}

function assertKeys(value, allowed, required, path) {
  assertPlainObject(value, path);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    fail('invalid_content_field', `${path} contiene campos no admitidos.`, path, { fields: unknown });
  }
  const missing = required.filter((key) => value[key] === undefined);
  if (missing.length) {
    fail('required_content_field', `${path} no contiene todos los campos obligatorios.`, path, { fields: missing });
  }
}

function assertText(value, path, { min = 0, max = 5000, nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string') fail('invalid_content_text', `${path} debe ser texto.`, path);
  const normalized = value.normalize('NFC').trim();
  if (normalized.length < min || normalized.length > max) {
    fail('invalid_content_text_length', `${path} debe tener entre ${min} y ${max} caracteres.`, path);
  }
  // El CMS persiste texto y estructura editorial, nunca markup ejecutable ni
  // fragmentos HTML que el renderer tuviera que confiar o sanear después.
  if (/<\/?[a-z][^>]*>/i.test(normalized) || /&(?:lt|gt|#0*60|#x0*3c);/i.test(normalized)) {
    fail('content_markup_forbidden', `${path} no admite HTML.`, path);
  }
  return normalized;
}

function assertTextArray(value, path, { minItems = 0, maxItems = 30, itemMax = 500 } = {}) {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    fail('invalid_content_list', `${path} debe contener entre ${minItems} y ${maxItems} elementos.`, path);
  }
  return value.map((item, index) => assertText(item, `${path}/${index}`, { min: 1, max: itemMax }));
}

function assertHttpsUrl(value, path, { nullable = false, stablePublic = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const normalized = assertText(value, path, { min: 1, max: 2048 });
  try {
    const url = new URL(normalized);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || (stablePublic && (url.search || url.hash))
    ) throw new Error('unsafe');
  } catch {
    fail(
      'invalid_https_url',
      `${path} debe ser una URL https pública, estable y sin credenciales, query ni fragmento.`,
      path
    );
  }
  return normalized;
}

function isSafePublicAssetUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function safePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function projectSafeMediaVariants(value) {
  if (!Array.isArray(value)) return [];
  const allowedMime = /^image\/(?:jpeg|png|webp)$/i;
  return value.slice(0, 30).flatMap((variant, index) => {
    if (!variant || typeof variant !== 'object' || !isSafePublicAssetUrl(variant.url)) return [];
    const contentType = String(variant.content_type || '').trim().toLowerCase();
    if (!allowedMime.test(contentType)) return [];
    const requestedKey = String(variant.key || '').trim().toLowerCase();
    return [{
      key: /^[a-z0-9][a-z0-9_-]{0,63}$/.test(requestedKey) ? requestedKey : `variant-${index + 1}`,
      url: String(variant.url).trim(),
      content_type: contentType,
      width: safePositiveInteger(variant.width),
      height: safePositiveInteger(variant.height),
    }];
  });
}

function projectSafeMediaMetadata(value) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    content_type: typeof metadata.content_type === 'string' ? metadata.content_type.slice(0, 128) : null,
    size_bytes: safePositiveInteger(metadata.size_bytes) || 0,
    width: safePositiveInteger(metadata.width),
    height: safePositiveInteger(metadata.height),
  };
}

function projectSafeMediaRights(value) {
  const rights = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    origin: WEB_RIGHTS_ORIGINS.includes(rights.origin) ? rights.origin : null,
    license_reference: typeof rights.license_reference === 'string' ? rights.license_reference.slice(0, 500) : null,
    license_url: typeof rights.license_url === 'string' && isSafePublicAssetUrl(rights.license_url)
      ? rights.license_url.slice(0, 2048)
      : null,
    credit: typeof rights.credit === 'string' ? rights.credit.slice(0, 300) : null,
    consent_reference: typeof rights.consent_reference === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(rights.consent_reference)
      ? rights.consent_reference
      : null,
    expires_at: typeof rights.expires_at === 'string' && Number.isFinite(Date.parse(rights.expires_at))
      ? new Date(Date.parse(rights.expires_at)).toISOString()
      : null,
  };
}

function publicMediaMatchesWebScope(webMedia, publicMedia) {
  const web = webMedia?.get ? webMedia.get({ plain: true }) : webMedia;
  const source = publicMedia?.get ? publicMedia.get({ plain: true }) : publicMedia;
  if (!web || !source || web.scopeType !== source.scope_type) return false;
  if (web.scopeType === 'clinic') return Number(web.clinicaId) === Number(source.clinica_id);
  if (web.scopeType === 'group') return Number(web.grupoClinicaId) === Number(source.grupo_clinica_id);
  return false;
}

function publicMediaIsAuthorizedForWeb(webMedia, publicMedia) {
  const source = publicMedia?.get ? publicMedia.get({ plain: true }) : publicMedia;
  const metadata = source?.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
    ? source.metadata
    : {};
  return publicMediaMatchesWebScope(webMedia, source)
    && source.status === 'active'
    && source.sensitivity === 'public'
    && metadata.non_clinical_asserted === true
    && metadata.patient_data_in_public_media !== true
    && metadata.patient_name_present !== true
    && isSafePublicAssetUrl(source.public_url);
}

function assertIsoDate(value, path, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const normalized = assertText(value, path, { min: 10, max: 40 });
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) fail('invalid_iso_date', `${path} debe ser una fecha ISO válida.`, path);
  return new Date(parsed).toISOString();
}

function assertOpaqueReference(value, path) {
  const normalized = assertText(value, path, { min: 1, max: 191 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(normalized)) {
    fail(
      'invalid_opaque_reference',
      `${path} debe ser un identificador opaco y no un nombre o dato personal.`,
      path
    );
  }
  return normalized;
}

function contentKeysForType(type, baseKeys) {
  if (!WEB_CONTENT_TYPES_WITH_IMAGE.includes(type)) return baseKeys;
  return [...baseKeys, 'image_asset_id', 'alt_text'];
}

function validateContentImageFields(type, value, path = '/content') {
  if (!WEB_CONTENT_TYPES_WITH_IMAGE.includes(type)) return {};
  const rawImageAssetId = value?.image_asset_id;
  const rawAltText = value?.alt_text;
  const hasImage = rawImageAssetId !== undefined && rawImageAssetId !== null && String(rawImageAssetId).trim() !== '';
  const hasAlt = rawAltText !== undefined && rawAltText !== null && String(rawAltText).trim() !== '';
  if (!hasImage && !hasAlt) return {};
  if (!hasImage) {
    fail(
      'content_image_asset_required',
      `${path}/image_asset_id es obligatorio cuando se define una descripción alternativa.`,
      `${path}/image_asset_id`
    );
  }
  const imageAssetId = assertText(rawImageAssetId, `${path}/image_asset_id`, { min: 1, max: 36 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,35}$/.test(imageAssetId)) {
    fail(
      'invalid_content_image_asset_id',
      `${path}/image_asset_id debe ser un identificador opaco de Medios.`,
      `${path}/image_asset_id`
    );
  }
  if (!hasAlt) {
    fail(
      'content_image_alt_required',
      `${path}/alt_text es obligatorio cuando el contenido usa una imagen.`,
      `${path}/alt_text`
    );
  }
  return {
    image_asset_id: imageAssetId,
    alt_text: assertText(rawAltText, `${path}/alt_text`, { min: 1, max: 500 }),
  };
}

function validateSources(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    fail('invalid_content_sources', 'sources debe ser una lista de hasta 20 fuentes.', '/sources');
  }
  return value.map((source, index) => {
    const path = `/sources/${index}`;
    assertKeys(source, ['label', 'url', 'publisher', 'accessed_at'], ['label', 'url'], path);
    return {
      label: assertText(source.label, `${path}/label`, { min: 1, max: 191 }),
      url: assertHttpsUrl(source.url, `${path}/url`, { stablePublic: true }),
      publisher: source.publisher == null
        ? null
        : assertText(source.publisher, `${path}/publisher`, { min: 1, max: 191 }),
      accessed_at: source.accessed_at == null
        ? null
        : assertIsoDate(source.accessed_at, `${path}/accessed_at`),
    };
  });
}

function validateArticleSections(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) {
    fail('invalid_article_sections', 'content.sections debe tener entre 1 y 40 secciones.', '/content/sections');
  }
  return value.map((section, index) => {
    const path = `/content/sections/${index}`;
    assertKeys(section, ['heading', 'paragraphs'], ['heading', 'paragraphs'], path);
    return {
      heading: assertText(section.heading, `${path}/heading`, { min: 1, max: 180 }),
      paragraphs: assertTextArray(section.paragraphs, `${path}/paragraphs`, {
        minItems: 1,
        maxItems: 20,
        itemMax: 5000,
      }),
    };
  });
}

function validateTypedContent(type, value) {
  const path = '/content';
  switch (type) {
    case 'value_proposition':
      assertKeys(value, contentKeysForType(type, ['headline', 'summary']), ['headline', 'summary'], path);
      return {
        headline: assertText(value.headline, `${path}/headline`, { min: 1, max: 180 }),
        summary: assertText(value.summary, `${path}/summary`, { min: 1, max: 1200 }),
        ...validateContentImageFields(type, value, path),
      };
    case 'benefit':
      assertKeys(value, contentKeysForType(type, ['title', 'description']), ['title', 'description'], path);
      return {
        title: assertText(value.title, `${path}/title`, { min: 1, max: 180 }),
        description: assertText(value.description, `${path}/description`, { min: 1, max: 2000 }),
        ...validateContentImageFields(type, value, path),
      };
    case 'faq':
      assertKeys(value, ['question', 'answer'], ['question', 'answer'], path);
      return {
        question: assertText(value.question, `${path}/question`, { min: 1, max: 300 }),
        answer: assertText(value.answer, `${path}/answer`, { min: 1, max: 5000 }),
      };
    case 'treatment_copy':
      assertKeys(
        value,
        contentKeysForType(type, ['title', 'short_description', 'description']),
        ['title', 'short_description', 'description'],
        path
      );
      return {
        title: assertText(value.title, `${path}/title`, { min: 1, max: 180 }),
        short_description: assertText(value.short_description, `${path}/short_description`, { min: 1, max: 500 }),
        description: assertText(value.description, `${path}/description`, { min: 1, max: 8000 }),
        ...validateContentImageFields(type, value, path),
      };
    case 'professional_bio':
      assertKeys(
        value,
        contentKeysForType(type, ['display_name', 'role', 'biography', 'credentials']),
        ['display_name', 'biography', 'credentials'],
        path
      );
      return {
        display_name: assertText(value.display_name, `${path}/display_name`, { min: 1, max: 180 }),
        role: value.role == null ? null : assertText(value.role, `${path}/role`, { min: 1, max: 180 }),
        biography: assertText(value.biography, `${path}/biography`, { min: 1, max: 8000 }),
        credentials: assertTextArray(value.credentials, `${path}/credentials`, { maxItems: 30, itemMax: 300 }),
        ...validateContentImageFields(type, value, path),
      };
    case 'testimonial':
      assertKeys(value, ['quote', 'attribution', 'consent_reference'], ['quote', 'consent_reference'], path);
      return {
        quote: assertText(value.quote, `${path}/quote`, { min: 1, max: 3000 }),
        attribution: value.attribution == null
          ? null
          : assertText(value.attribution, `${path}/attribution`, { min: 1, max: 180 }),
        consent_reference: assertOpaqueReference(value.consent_reference, `${path}/consent_reference`),
      };
    case 'legal_copy':
      assertKeys(value, ['title', 'text', 'version_label'], ['title', 'text', 'version_label'], path);
      return {
        title: assertText(value.title, `${path}/title`, { min: 1, max: 180 }),
        text: assertText(value.text, `${path}/text`, { min: 1, max: 15000 }),
        version_label: assertText(value.version_label, `${path}/version_label`, { min: 1, max: 80 }),
      };
    case 'article':
      assertKeys(value, contentKeysForType(type, ['title', 'excerpt', 'sections']), ['title', 'excerpt', 'sections'], path);
      return {
        title: assertText(value.title, `${path}/title`, { min: 1, max: 180 }),
        excerpt: assertText(value.excerpt, `${path}/excerpt`, { min: 1, max: 500 }),
        sections: validateArticleSections(value.sections),
        ...validateContentImageFields(type, value, path),
      };
    case 'category':
      assertKeys(value, contentKeysForType(type, ['name', 'description']), ['name'], path);
      return {
        name: assertText(value.name, `${path}/name`, { min: 1, max: 180 }),
        description: value.description == null
          ? null
          : assertText(value.description, `${path}/description`, { min: 1, max: 1000 }),
        ...validateContentImageFields(type, value, path),
      };
    default:
      fail('invalid_content_type', 'El tipo de contenido no está permitido.', '/type', { allowed: WEB_CONTENT_TYPES });
  }
}

function validateWebContentSchemaConfig(type, value = undefined) {
  const path = '/schema_config';
  if (value === undefined || value === null) {
    return { enabled: true, profile: 'auto', include_sources: false };
  }
  assertKeys(value, ['enabled', 'profile', 'include_sources'], [], path);
  const enabled = value.enabled !== false;
  const profile = String(value.profile || 'auto').trim();
  const allowedProfiles = WEB_CONTENT_SCHEMA_PROFILE_BY_TYPE[type] || ['auto'];
  if (!WEB_CONTENT_SCHEMA_PROFILES.includes(profile) || !allowedProfiles.includes(profile)) {
    fail('invalid_content_schema_profile', `${path}.profile no es válido para este tipo de contenido.`, `${path}/profile`, {
      allowed: allowedProfiles,
    });
  }
  return {
    enabled,
    profile: enabled ? profile : 'auto',
    include_sources: enabled ? value.include_sources === true : false,
  };
}

function validateWebContentEntry(input = {}) {
  const type = String(input.type || '').trim().toLowerCase();
  if (!WEB_CONTENT_TYPES.includes(type)) {
    fail('invalid_content_type', 'El tipo de contenido no está permitido.', '/type', { allowed: WEB_CONTENT_TYPES });
  }
  const locale = String(input.locale || 'es-ES').trim();
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)) {
    fail('invalid_content_locale', 'locale debe usar un formato como es-ES.', '/locale');
  }
  const normalized = {
    type,
    locale,
    title: assertText(input.title, '/title', { min: 1, max: 191 }),
    content: validateTypedContent(type, input.content),
    sources: validateSources(input.sources),
    schema_config: validateWebContentSchemaConfig(type, input.schema_config),
  };
  // Reutiliza la inspección JSON defensiva del WebDocument para prototipos,
  // getters, claves de código, strings ejecutables, profundidad y tamaño.
  const serialized = canonicalSerialize(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > 128 * 1024) {
    fail('content_too_large', 'La entrada supera 128 KiB.', '/content');
  }
  return {
    ...normalized,
    hash: crypto.createHash('sha256').update(serialized, 'utf8').digest('hex'),
  };
}

function validateFocalPoints(value) {
  if (value === undefined || value === null) return {};
  assertKeys(value, ['desktop', 'tablet', 'mobile'], [], '/focal_points');
  const result = {};
  for (const breakpoint of ['desktop', 'tablet', 'mobile']) {
    if (value[breakpoint] == null) continue;
    const path = `/focal_points/${breakpoint}`;
    assertKeys(value[breakpoint], ['x', 'y'], ['x', 'y'], path);
    const x = Number(value[breakpoint].x);
    const y = Number(value[breakpoint].y);
    if (!Number.isInteger(x) || x < 0 || x > 100 || !Number.isInteger(y) || y < 0 || y > 100) {
      fail('invalid_focal_point', `${path} necesita x/y enteros entre 0 y 100.`, path);
    }
    result[breakpoint] = { x, y };
  }
  return result;
}

function validateMediaRights(value) {
  assertKeys(
    value,
    ['origin', 'license_reference', 'license_url', 'credit', 'consent_reference', 'expires_at'],
    ['origin'],
    '/rights'
  );
  const origin = String(value.origin || '').trim().toLowerCase();
  if (!WEB_RIGHTS_ORIGINS.includes(origin)) {
    fail('invalid_media_rights_origin', 'El origen de derechos no está permitido.', '/rights/origin', {
      allowed: WEB_RIGHTS_ORIGINS,
    });
  }
  const licenseReference = value.license_reference == null
    ? null
    : assertText(value.license_reference, '/rights/license_reference', { min: 1, max: 500 });
  const licenseUrl = value.license_url == null
    ? null
    : assertHttpsUrl(value.license_url, '/rights/license_url');
  if (licenseUrl && !isSafePublicAssetUrl(licenseUrl)) {
    fail(
      'invalid_media_license_url',
      'La URL de licencia debe ser pública y estable, sin query ni credenciales.',
      '/rights/license_url'
    );
  }
  if (['licensed', 'stock'].includes(origin) && !licenseReference && !licenseUrl) {
    fail(
      'media_license_required',
      'Los medios licenciados o de stock necesitan una referencia o URL de licencia.',
      '/rights'
    );
  }
  return {
    origin,
    license_reference: licenseReference,
    license_url: licenseUrl,
    credit: value.credit == null ? null : assertText(value.credit, '/rights/credit', { min: 1, max: 300 }),
    consent_reference: value.consent_reference == null
      ? null
      : assertOpaqueReference(value.consent_reference, '/rights/consent_reference'),
    expires_at: value.expires_at == null ? null : assertIsoDate(value.expires_at, '/rights/expires_at'),
  };
}

function validateWebMediaPresentation(input = {}) {
  const decorative = input.decorative === true;
  const altText = input.alt_text == null
    ? ''
    : assertText(input.alt_text, '/alt_text', { min: 0, max: 500 });
  if (decorative && altText !== '') {
    fail('decorative_media_alt_forbidden', 'Un medio decorativo debe tener alt_text vacío.', '/alt_text');
  }
  if (!decorative && altText === '') {
    fail('informative_media_alt_required', 'Un medio informativo necesita alt_text.', '/alt_text');
  }
  const normalized = {
    title: assertText(input.title, '/title', { min: 1, max: 191 }),
    alt_text: altText,
    decorative,
    focal_points: validateFocalPoints(input.focal_points),
    rights: validateMediaRights(input.rights),
  };
  canonicalSerialize(normalized);
  return normalized;
}

function contentFieldValues(entry) {
  const row = entry?.get ? entry.get({ plain: true }) : entry;
  const content = row?.content || {};
  const description = content.description
    || content.summary
    || content.answer
    || content.biography
    || content.quote
    || content.text
    || content.excerpt
    || null;
  return {
    // Aliases retained for documents created before typed CMS fields were
    // bindable. `title` deliberately remains the editorial/internal title;
    // new documents use the exact typed field below instead.
    title: row?.title || null,
    name: content.name || content.display_name || row?.title || null,
    description,
    short_description: content.short_description || content.excerpt || content.summary || description,
    // Exact public fields. Keeping these separate prevents an internal CMS
    // label from replacing the headline/question that an editor selected.
    content_title: content.title || null,
    headline: content.headline || null,
    summary: content.summary || null,
    question: content.question || null,
    answer: content.answer || null,
    display_name: content.display_name || null,
    role: content.role || null,
    biography: content.biography || null,
    quote: content.quote || null,
    attribution: content.attribution || null,
    text: content.text || null,
    version_label: content.version_label || null,
    excerpt: content.excerpt || null,
    image_asset_id: content.image_asset_id || null,
    alt_text: content.alt_text || null,
  };
}

function assertWebContentSnapshot(value) {
  assertKeys(value, [
    'schema_version',
    'content_entries',
    'media_assets',
    'live_bindings',
    'treatments',
    'professionals',
    'intake_config',
  ], [
    'schema_version',
    'content_entries',
    'media_assets',
    'live_bindings',
  ], '/content_snapshot');
  if (value.schema_version !== 1) {
    fail('invalid_content_snapshot_version', 'content_snapshot.schema_version debe ser 1.', '/content_snapshot/schema_version');
  }
  assertPlainObject(value.content_entries, '/content_snapshot/content_entries');
  assertPlainObject(value.media_assets, '/content_snapshot/media_assets');
  if (value.treatments !== undefined) assertPlainObject(value.treatments, '/content_snapshot/treatments');
  if (value.professionals !== undefined) assertPlainObject(value.professionals, '/content_snapshot/professionals');
  if (value.intake_config !== undefined && value.intake_config !== null) {
    assertPlainObject(value.intake_config, '/content_snapshot/intake_config');
  }
  if (!Array.isArray(value.live_bindings) || value.live_bindings.length > 200) {
    fail(
      'invalid_content_snapshot_live_bindings',
      'content_snapshot.live_bindings debe ser una lista de hasta 200 bindings.',
      '/content_snapshot/live_bindings'
    );
  }
  const liveClinicFields = new Set(['name', 'address', 'phone', 'email', 'website', 'hours', 'booking_url']);
  value.live_bindings.forEach((binding, index) => {
    const path = `/content_snapshot/live_bindings/${index}`;
    assertKeys(
      binding,
      ['source', 'source_id', 'field', 'resolver', 'implicit_scope'],
      ['source', 'source_id', 'field', 'resolver', 'implicit_scope'],
      path
    );
    if (
      binding.source !== 'clinic'
      || binding.resolver !== 'clinic_public_v1'
      || !/^[1-9][0-9]*$/.test(String(binding.source_id || ''))
      || !liveClinicFields.has(binding.field)
      || typeof binding.implicit_scope !== 'boolean'
    ) {
      fail('invalid_content_snapshot_live_binding', 'El binding vivo no es válido.', path);
    }
  });
  const sensitiveKeys = /^(?:secret|token|access_token|refresh_token|hmac_key|bucket|region|object_key|etag|provider|license_reference|consent_reference)$/i;
  const inspect = (current, path, depth) => {
    if (depth > 20) fail('content_snapshot_too_deep', 'content_snapshot supera 20 niveles.', path);
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      if (sensitiveKeys.test(key)) {
        fail('content_snapshot_sensitive_field', 'content_snapshot contiene un campo interno no publicable.', `${path}/${key}`);
      }
      inspect(child, `${path}/${key}`, depth + 1);
    }
  };
  inspect(value, '/content_snapshot', 0);
  const serialized = canonicalSerialize(value);
  if (Buffer.byteLength(serialized, 'utf8') > 2 * 1024 * 1024) {
    fail('content_snapshot_too_large', 'content_snapshot supera 2 MiB.', '/content_snapshot');
  }
  return value;
}

module.exports = {
  WEB_CONTENT_STATUSES,
  WEB_CONTENT_TYPES,
  WEB_CONTENT_SCHEMA_PROFILE_BY_TYPE,
  WEB_CONTENT_SCHEMA_PROFILES,
  WEB_CONTENT_TYPES_WITH_IMAGE,
  WEB_MEDIA_KINDS,
  WEB_MEDIA_STATUSES,
  WEB_RIGHTS_ORIGINS,
  WebContentValidationError,
  assertWebContentSnapshot,
  contentFieldValues,
  isSafePublicAssetUrl,
  projectSafeMediaMetadata,
  projectSafeMediaRights,
  projectSafeMediaVariants,
  publicMediaMatchesWebScope,
  publicMediaIsAuthorizedForWeb,
  validateFocalPoints,
  validateMediaRights,
  validateSources,
  validateWebContentSchemaConfig,
  validateWebContentEntry,
  validateWebMediaPresentation,
};
