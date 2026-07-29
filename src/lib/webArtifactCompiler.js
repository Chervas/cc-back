'use strict';

const crypto = require('node:crypto');
const {
  assertValidWebDocument,
  canonicalSerialize,
} = require('./webDocument');
const { assertWebContentSnapshot, isSafePublicAssetUrl } = require('./webContent');
const { trustedRuntime } = require('./webMeasurementRuntime');
const { publicHttpUrl } = require('./safeHttpTarget');
const {
  MAX_WEB_ARTIFACT_BUNDLE_BYTES,
  webArtifactBundleFootprintBytes,
} = require('./webArtifactBudget');

const RENDERER_VERSION = 'clinicaclick-web-renderer/1.15.0';
const SAFE_EXTERNAL_REL = /^(?:\/[A-Za-z0-9_][A-Za-z0-9/_-]*|https:\/\/[^\s]+)$/;
const SAFE_YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{6,64}$/;
const SAFE_VIMEO_VIDEO_ID = /^[0-9]{6,12}$/;
const PRODUCTION_INTAKE_ENDPOINT = '/_clinicaclick/intake';
const CLINIC_BINDING_FIELDS = new Set([
  'name',
  'address',
  'phone',
  'email',
  'website',
  'image',
  'hours',
  'booking_url',
]);
const SAFE_SCHEMA_TYPES = new Set(['Organization', 'Dentist', 'MedicalClinic']);
const POSTAL_ADDRESS_FIELDS = Object.freeze({
  street_address: ['street_address', 'streetAddress', 'street', 'direccion'],
  locality: ['locality', 'addressLocality', 'city', 'ciudad'],
  region: ['region', 'addressRegion', 'province', 'provincia'],
  postal_code: ['postal_code', 'postalCode', 'zip', 'codigo_postal'],
  country: ['country', 'addressCountry', 'country_code', 'pais'],
});
const GOOGLE_WEEKDAYS = Object.freeze([
  ['MONDAY', 'Monday'],
  ['TUESDAY', 'Tuesday'],
  ['WEDNESDAY', 'Wednesday'],
  ['THURSDAY', 'Thursday'],
  ['FRIDAY', 'Friday'],
  ['SATURDAY', 'Saturday'],
  ['SUNDAY', 'Sunday'],
]);
const GOOGLE_WEEKDAY_INDEX = new Map(GOOGLE_WEEKDAYS.map(([google, schema], index) => (
  [google, { index, schema }]
)));
const WEB_CONTENT_TYPE_LABELS = Object.freeze({
  value_proposition: 'Propuesta de valor',
  benefit: 'Beneficio',
  faq: 'Pregunta frecuente',
  treatment_copy: 'Tratamiento',
  professional_bio: 'Profesional',
  testimonial: 'Testimonio',
  legal_copy: 'Legal',
  article: 'Artículo',
  category: 'Categoría',
});

class WebArtifactCompilationError extends Error {
  constructor(code, message, details = undefined, status = 422) {
    super(message);
    this.name = 'WebArtifactCompilationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new WebArtifactCompilationError(code, message, details);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value) {
  return escapeHtml(value);
}

function faviconDataUrl(value) {
  const candidate = Array.from(String(value || '').normalize('NFC'))
    .find((character) => /[\p{L}\p{N}]/u.test(character)) || 'C';
  const label = escapeXml(candidate.toLocaleUpperCase().slice(0, 1));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#111827"/><text x="32" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#ffffff">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function stableJson(value) {
  return canonicalSerialize(value).replace(/</g, '\\u003c');
}

function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value).digest(encoding);
}

function safeAbsoluteBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('unsafe');
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    fail('web_artifact_base_url_invalid', 'La URL base debe ser https, estable y sin credenciales ni parámetros.');
  }
}

function safeLegalUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('/')) {
    if (
      raw.startsWith('//')
      || raw.length > 2048
      || /[\\\x00-\x20\x7f]/.test(raw)
      || /%(?:2e|2f|5c)/i.test(raw)
      || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw)
    ) {
      fail('web_artifact_privacy_url_invalid', 'La URL de privacidad no es publicable.');
    }
    return raw;
  }
  const safe = publicHttpUrl(raw, { requireHttps: true });
  if (!safe) fail('web_artifact_privacy_url_invalid', 'La URL de privacidad debe usar HTTPS y un host público.');
  return safe;
}

function safeIntakeEndpoint(value, environment = 'preview') {
  const normalized = String(value || '').trim();
  if (environment === 'production' && normalized !== PRODUCTION_INTAKE_ENDPOINT) {
    fail(
      'web_artifact_intake_endpoint_invalid',
      'La publicación solo puede usar el puente same-origin de formularios.'
    );
  }
  if (!SAFE_EXTERNAL_REL.test(normalized)) {
    fail('web_artifact_intake_endpoint_invalid', 'El endpoint del formulario no es publicable.');
  }
  if (normalized.startsWith('https://')) {
    const url = new URL(normalized);
    if (url.username || url.password || url.search || url.hash) {
      fail('web_artifact_intake_endpoint_invalid', 'El endpoint del formulario no puede contener credenciales ni parámetros.');
    }
  }
  return normalized;
}

function googleHoursObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function schemaTime(value) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    const match = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3] || 0);
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}${seconds ? `:${String(seconds).padStart(2, '0')}` : ''}`;
  }
  const source = googleHoursObject(value);
  if (!['hours', 'hour', 'minutes', 'minute', 'seconds', 'second', 'nanos']
    .some((field) => Object.prototype.hasOwnProperty.call(source, field))) return null;
  const hours = Number(source.hours ?? source.hour ?? 0);
  const minutes = Number(source.minutes ?? source.minute ?? 0);
  const seconds = Number(source.seconds ?? source.second ?? 0);
  const nanos = Number(source.nanos ?? 0);
  if (
    !Number.isInteger(hours) || hours < 0 || hours > 23
    || !Number.isInteger(minutes) || minutes < 0 || minutes > 59
    || !Number.isInteger(seconds) || seconds < 0 || seconds > 59
    || !Number.isInteger(nanos) || nanos !== 0
  ) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}${seconds ? `:${String(seconds).padStart(2, '0')}` : ''}`;
}

function normalizeGoogleOpeningHours(value) {
  if (Array.isArray(value)) {
    const schemaDayIndex = new Map(GOOGLE_WEEKDAYS.map(([_google, schema], index) => (
      [`https://schema.org/${schema}`, { index, schema }]
    )));
    const existing = value.flatMap((specification) => {
      if (!specification || typeof specification !== 'object' || Array.isArray(specification)) return [];
      const day = schemaDayIndex.get(String(specification.dayOfWeek || ''));
      const opens = schemaTime(specification.opens);
      const closes = schemaTime(specification.closes);
      if (!day || !opens || !closes) return [];
      return [{
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: `https://schema.org/${day.schema}`,
        opens,
        closes,
        _dayIndex: day.index,
      }];
    });
    existing.sort((left, right) => (
      left._dayIndex - right._dayIndex
      || left.opens.localeCompare(right.opens)
      || left.closes.localeCompare(right.closes)
    ));
    const seen = new Set();
    return existing.flatMap(({ _dayIndex, ...specification }) => {
      const key = `${specification.dayOfWeek}|${specification.opens}|${specification.closes}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [specification];
    });
  }
  const source = googleHoursObject(value);
  const periods = Array.isArray(source.periods) ? source.periods : [];
  const normalized = periods.flatMap((period) => {
    if (!period || typeof period !== 'object' || Array.isArray(period)) return [];
    const openDay = GOOGLE_WEEKDAY_INDEX.get(String(period.openDay || period.open_day || '').toUpperCase());
    const closeDay = GOOGLE_WEEKDAY_INDEX.get(String(period.closeDay || period.close_day || '').toUpperCase());
    const opens = schemaTime(period.openTime ?? period.open_time);
    const closes = schemaTime(period.closeTime ?? period.close_time);
    if (!openDay || !closeDay || !opens || !closes) return [];
    const sameDay = openDay.index === closeDay.index;
    const nextDay = closeDay.index === ((openDay.index + 1) % GOOGLE_WEEKDAYS.length);
    // Google expresses overnight ranges with closeDay on the following day.
    // Other multi-day shapes and inverted same-day ranges are ambiguous, so
    // they are omitted instead of manufacturing a schedule.
    if ((!sameDay && !nextDay) || (sameDay && closes <= opens)) return [];
    return [{
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: `https://schema.org/${openDay.schema}`,
      opens,
      closes,
      _dayIndex: openDay.index,
    }];
  });
  normalized.sort((left, right) => (
    left._dayIndex - right._dayIndex
    || left.opens.localeCompare(right.opens)
    || left.closes.localeCompare(right.closes)
  ));
  const seen = new Set();
  return normalized.flatMap(({ _dayIndex, ...specification }) => {
    const key = `${specification.dayOfWeek}|${specification.opens}|${specification.closes}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [specification];
  });
}

function normalizeClinicSnapshot(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clinicId = Number(source.clinic_id || source.id || 0);
  const result = {
    clinic_id: Number.isSafeInteger(clinicId) && clinicId > 0 ? String(clinicId) : null,
    schema_type: SAFE_SCHEMA_TYPES.has(source.schema_type) ? source.schema_type : 'Dentist',
  };
  for (const field of CLINIC_BINDING_FIELDS) {
    const raw = source[field];
    if (raw === undefined || raw === null) continue;
    if (field === 'address' && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const address = {};
      for (const [canonical, aliases] of Object.entries(POSTAL_ADDRESS_FIELDS)) {
        const selected = aliases.map((alias) => raw[alias]).find((candidate) => candidate !== undefined && candidate !== null);
        const text = String(selected ?? '').normalize('NFC').trim();
        if (text) address[canonical] = text.slice(0, 300);
      }
      if (Object.keys(address).length) result[field] = address;
      continue;
    }
    if (field === 'hours' && typeof raw === 'object') {
      result[field] = stableJson(raw);
      continue;
    }
    const text = String(raw).normalize('NFC').trim();
    if (!text) continue;
    if (field === 'website' || field === 'booking_url' || field === 'image') {
      const safeUrl = publicHttpUrl(text, { requireHttps: true });
      if (!safeUrl) {
        // The clinic avatar is only an optional Social/Schema fallback. Legacy
        // clinic records can contain relative admin paths or stale provider
        // URLs; omitting that optional fallback is safer than blocking an
        // otherwise publishable revision. Explicit website/booking bindings
        // remain fail-closed because they become actionable public links.
        if (field === 'image') continue;
        fail(
          'web_artifact_clinic_url_invalid',
          'Las URLs públicas de la clínica deben usar HTTPS y un host público.',
          { field }
        );
      }
      result[field] = safeUrl.slice(0, 2048);
      continue;
    }
    result[field] = text.slice(0, 2048);
  }
  const openingHours = normalizeGoogleOpeningHours(source.opening_hours ?? source.hours);
  if (openingHours.length) result.opening_hours = openingHours;
  return result;
}

function assertClinicBindingsFrozen(document, snapshot, clinic) {
  const frozen = new Set((snapshot.live_bindings || []).map((binding) => [
    binding.source,
    String(binding.source_id),
    binding.field,
    binding.resolver,
  ].join(':')));
  const unresolved = [];
  for (const [bindingId, binding] of Object.entries(document.bindings || {})) {
    if (binding.source !== 'clinic') continue;
    const expectedClinicId = String(binding.source_id || clinic.clinic_id || '');
    const key = ['clinic', expectedClinicId, binding.field, 'clinic_public_v1'].join(':');
    if (
      !clinic.clinic_id
      || expectedClinicId !== String(clinic.clinic_id)
      || !frozen.has(key)
    ) {
      unresolved.push({
        binding_id: bindingId,
        source_id: expectedClinicId || null,
        selected_clinic_id: clinic.clinic_id || null,
        field: binding.field,
      });
    }
  }
  const foreign = (snapshot.live_bindings || []).filter((binding) => (
    binding.source !== 'clinic'
    || String(binding.source_id) !== String(clinic.clinic_id || '')
    || binding.resolver !== 'clinic_public_v1'
  ));
  if (unresolved.length || foreign.length) {
    fail(
      'web_artifact_live_binding_scope_mismatch',
      'Los datos vivos de clínica no coinciden con la clínica elegida para publicar.',
      { unresolved, foreign_binding_count: foreign.length }
    );
  }
}

function contentBindingValue(snapshot, binding) {
  if (binding.source === 'content_entry') {
    const entry = snapshot.content_entries?.[binding.source_id];
    return entry?.fields?.[binding.field];
  }
  if (binding.source === 'treatment') {
    return snapshot.treatments?.[binding.source_id]?.fields?.[binding.field];
  }
  if (binding.source === 'professional') {
    return snapshot.professionals?.[binding.source_id]?.fields?.[binding.field];
  }
  return undefined;
}

function assertIntakeConfigFrozen(document, snapshot) {
  const selected = String(document?.integrations?.intake_config_id || '').trim();
  if (!selected) return;
  if (String(snapshot?.intake_config?.id || '') !== selected) {
    fail(
      'web_artifact_intake_config_unresolved',
      'La configuración de captación seleccionada no quedó validada en esta revisión.'
    );
  }
}

function documentSiteConfiguration(document, baseUrl) {
  return {
    consent: {
      provider: document.consent.provider,
      preview_mode: document.consent.preview_mode === true,
      privacy_policy_url: safeLegalUrl(document.consent.privacy_policy_url, baseUrl),
      privacy_policy_version: document.consent.privacy_policy_version || null,
      privacy_consent_text: document.consent.privacy_consent_text || null,
    },
    integrations: {
      intake_config_id: document.integrations.intake_config_id || null,
      chat_enabled: document.integrations.chat_enabled === true,
      whatsapp_enabled: document.integrations.whatsapp_enabled === true,
      phone_enabled: document.integrations.phone_enabled === true,
    },
  };
}

function assertDocumentRuntimeCoherence(document, snapshot, runtime, environment, baseUrl) {
  const configuration = documentSiteConfiguration(document, baseUrl);
  if (environment !== 'production') return configuration;
  const measurement = runtime.measurement || { enabled: false };
  const hasForm = Object.values(document.nodes || {}).some((node) => node?.type === 'intake_form');
  if (measurement.enabled !== true) {
    // compileRevision aplica el gate de disponibilidad para producción. El
    // compilador puro conserva preview/tests deterministas sin inventar un
    // runtime; si existe uno activo, sí exige coherencia exacta abajo.
    return configuration;
  }
  if (hasForm && (
    !configuration.integrations.intake_config_id
    || String(snapshot?.intake_config?.id || '') !== String(configuration.integrations.intake_config_id)
  )) {
    fail('web_artifact_intake_config_drift', 'La configuración de captación ya no coincide con la revisión aprobada.');
  }
  if (
    configuration.consent.preview_mode
    || !configuration.consent.privacy_policy_url
    || !configuration.consent.privacy_policy_version
    || !configuration.consent.privacy_consent_text
    || configuration.consent.provider === 'inherit'
    || configuration.consent.provider !== measurement.consent_provider
    || measurement.consent_mode_enabled !== true
  ) {
    fail('web_artifact_consent_runtime_drift', 'El consentimiento aprobado no coincide con la configuración activa.');
  }
  for (const field of ['chat_enabled', 'whatsapp_enabled', 'phone_enabled']) {
    if (configuration.integrations[field] !== (measurement[field] === true)) {
      fail(
        'web_artifact_integration_runtime_drift',
        'Las integraciones aprobadas no coinciden con la configuración activa.',
        { field }
      );
    }
  }
  return configuration;
}

function bindingValue(snapshot, clinic, binding) {
  if (binding.source === 'clinic') {
    if (!CLINIC_BINDING_FIELDS.has(binding.field)) return undefined;
    if (binding.field === 'address' && clinic.address && typeof clinic.address === 'object') {
      return [
        clinic.address.street_address,
        clinic.address.postal_code,
        clinic.address.locality,
        clinic.address.region,
        clinic.address.country,
      ].filter(Boolean).join(', ');
    }
    return clinic[binding.field];
  }
  return contentBindingValue(snapshot, binding);
}

function applyBindings(document, snapshot, clinic) {
  const nodes = Object.fromEntries(Object.entries(document.nodes).map(([id, node]) => [id, {
    ...node,
    props: { ...node.props },
    children: [...node.children],
  }]));
  const unresolved = [];
  for (const [bindingId, binding] of Object.entries(document.bindings || {})) {
    const value = bindingValue(snapshot, clinic, binding);
    if (value === undefined || value === null || value === '') {
      unresolved.push({
        binding_id: bindingId,
        source: binding.source,
        source_id: binding.source_id || null,
        field: binding.field,
      });
      continue;
    }
    const node = nodes[binding.target_node_id];
    if (!node) continue;
    node.props[binding.target_prop] = String(value);
  }
  if (unresolved.length) {
    fail(
      'web_artifact_binding_unresolved',
      'La revisión contiene datos dinámicos que todavía no se pueden resolver de forma segura.',
      { unresolved }
    );
  }
  return { ...document, nodes };
}

function safePublicButtonUrl(value, nodeId) {
  const safe = publicHttpUrl(String(value || ''), { requireHttps: true });
  if (!safe) {
    fail(
      'web_artifact_button_url_invalid',
      'El botón externo debe apuntar a una URL HTTPS con un host público.',
      { node_id: nodeId }
    );
  }
  return safe;
}

function safePhoneTarget(value, nodeId) {
  const raw = String(value || '').normalize('NFC').trim();
  const digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+') || digits.length < 8 || digits.length > 15 || digits[0] === '0') {
    fail(
      'web_artifact_button_phone_invalid',
      'El teléfono del botón debe estar en formato internacional.',
      { node_id: nodeId }
    );
  }
  return `+${digits}`;
}

function validateBoundDocument(document) {
  for (const node of Object.values(document.nodes || {})) {
    if (node?.type === 'button') {
      if (node.props.action === 'external_url') {
        node.props.target = safePublicButtonUrl(node.props.target, node.id);
      } else if (node.props.action === 'phone' || node.props.action === 'whatsapp') {
        node.props.target = safePhoneTarget(node.props.target, node.id);
      }
    } else if (node?.type === 'link_list') {
      node.props.items = node.props.items.map((item) => {
        if (item.action === 'external_url') return { ...item, target: safePublicButtonUrl(item.target, node.id) };
        if (item.action === 'phone' || item.action === 'whatsapp') return { ...item, target: safePhoneTarget(item.target, node.id) };
        return item;
      });
    }
  }
  try {
    assertValidWebDocument(document);
  } catch (error) {
    fail(
      'web_artifact_bound_document_invalid',
      'Los datos aplicados a la revisión no cumplen el contrato publicable.',
      { validation_errors: Array.isArray(error?.errors) ? error.errors : [] }
    );
  }
  return document;
}

function styleClassList(node) {
  const style = node.style_tokens || {};
  const responsive = node.responsive || {};
  const classes = [
    `cc-bg-${style.background || 'transparent'}`,
    `cc-fg-${style.foreground || 'default'}`,
    `cc-width-${style.content_width || 'standard'}`,
    `cc-pt-${style.spacing_top || 'none'}`,
    `cc-pb-${style.spacing_bottom || 'none'}`,
    `cc-gap-${style.gap || 'md'}`,
    `cc-radius-${style.radius || 'inherit'}`,
    `cc-shadow-${style.shadow || 'none'}`,
    `cc-align-${style.align || 'stretch'}`,
  ];
  if (node.animation && node.animation !== 'none') classes.push(`cc-animate-${node.animation}`);
  for (const breakpoint of ['desktop', 'tablet', 'mobile']) {
    const override = responsive[breakpoint];
    if (!override) continue;
    if (override.visible === false) classes.push(`cc-hide-${breakpoint}`);
    if (override.align) classes.push(`cc-${breakpoint}-align-${override.align}`);
    if (override.columns) classes.push(`cc-${breakpoint}-cols-${override.columns}`);
    if (override.spacing_top) classes.push(`cc-${breakpoint}-pt-${override.spacing_top}`);
    if (override.spacing_bottom) classes.push(`cc-${breakpoint}-pb-${override.spacing_bottom}`);
    if (override.gap) classes.push(`cc-${breakpoint}-gap-${override.gap}`);
  }
  return classes.join(' ');
}

function validColumnTracks(node, breakpoint) {
  const tracks = node?.props?.column_tracks?.[breakpoint];
  if (!Array.isArray(tracks)) return null;
  const expectedColumns = breakpoint === 'desktop'
    ? node.props.columns
    : (node.responsive?.[breakpoint]?.columns || node.props.columns);
  if (tracks.length !== expectedColumns) return null;
  if (tracks.some((track) => !Number.isInteger(track) || track < 1 || track > 12)) return null;
  return tracks.reduce((sum, track) => sum + track, 0) === 12 ? tracks : null;
}

function validColumnWidth(node, breakpoint) {
  const width = node?.props?.column_widths?.[breakpoint];
  return Number.isInteger(width) && width >= 1 && width <= 12 ? width : null;
}

function sectionRole(node) {
  return node?.props?.structure_role || 'section';
}

function rowUsesColumnWidths(document, node) {
  return sectionRole(node) === 'row' && (node.children || []).some((childId) => {
    const child = document.nodes?.[childId];
    return child?.type === 'section'
      && sectionRole(child) === 'column'
      && Boolean(child.props.column_widths && Object.keys(child.props.column_widths).length);
  });
}

function sectionTrackClassList(document, node) {
  if (rowUsesColumnWidths(document, node)) return 'cc-column-widths';
  return ['desktop', 'tablet', 'mobile'].map((breakpoint) => {
    const tracks = validColumnTracks(node, breakpoint);
    if (!tracks) return '';
    const prefix = breakpoint === 'desktop' ? 'cc-tracks' : `cc-${breakpoint}-tracks`;
    return `${prefix}-${tracks.join('-')}`;
  }).filter(Boolean).join(' ');
}

function sectionColumnWidthClassList(document, node, parentRow = null, parentChildIndex = null) {
  if (sectionRole(node) !== 'column') return '';
  return ['desktop', 'tablet', 'mobile'].map((breakpoint) => {
    const width = validColumnWidth(node, breakpoint)
      || fallbackColumnWidthFromParent(document, parentRow, parentChildIndex, breakpoint);
    if (!width) return '';
    const prefix = breakpoint === 'desktop' ? 'cc-col-span' : `cc-${breakpoint}-col-span`;
    return `${prefix}-${width}`;
  }).filter(Boolean).join(' ');
}

function fallbackColumnWidthFromParent(document, parentRow, parentChildIndex, breakpoint) {
  if (!parentRow || sectionRole(parentRow) !== 'row' || !rowUsesColumnWidths(document, parentRow)) return null;
  if (!Number.isInteger(parentChildIndex) || parentChildIndex < 0) return null;
  const tracks = validColumnTracks(parentRow, breakpoint);
  const width = tracks?.[parentChildIndex];
  return Number.isInteger(width) && width >= 1 && width <= 12 ? width : 12;
}

function imageClassList(node) {
  const fit = node.props.fit === 'contain' ? 'contain' : 'cover';
  const aspect = String(node.props.aspect_ratio || 'auto').replace(':', '-');
  const focalX = Number.isInteger(node.props.focal_x) ? node.props.focal_x : 50;
  const focalY = Number.isInteger(node.props.focal_y) ? node.props.focal_y : 50;
  return `cc-fit-${fit} cc-aspect-${aspect} cc-focal-${focalX}-${focalY}`;
}

function videoEmbedUrl(node) {
  const provider = String(node.props.provider || '').trim();
  const videoId = String(node.props.video_id || '').trim();
  if (provider === 'youtube') {
    if (!SAFE_YOUTUBE_VIDEO_ID.test(videoId)) {
      fail('web_artifact_video_id_invalid', 'El ID de YouTube no es válido.', {
        node_id: node.id,
        provider,
      });
    }
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`;
  }
  if (provider === 'vimeo') {
    if (!SAFE_VIMEO_VIDEO_ID.test(videoId)) {
      fail('web_artifact_video_id_invalid', 'El ID de Vimeo no es válido.', {
        node_id: node.id,
        provider,
      });
    }
    return `https://player.vimeo.com/video/${encodeURIComponent(videoId)}`;
  }
  fail('web_artifact_video_provider_invalid', 'El proveedor de vídeo no está soportado.', {
    node_id: node.id,
    provider,
  });
}

function webDocumentHasNodeType(document, nodeType) {
  return Object.values(document?.nodes || {}).some((node) => node?.type === nodeType);
}

function videoFrameCspDirective(document) {
  if (!webDocumentHasNodeType(document, 'video')) {
    return '';
  }
  const sources = 'https://www.youtube-nocookie.com https://player.vimeo.com';
  return ` frame-src ${sources}; child-src ${sources};`;
}

function resolvedMediaImage(snapshot, assetId, details = {}) {
  const media = snapshot.media_assets?.[assetId];
  if (!media) fail('web_artifact_media_unresolved', 'La revisión referencia una imagen no congelada.', {
    ...details,
    media_id: assetId,
  });
  const variants = Array.isArray(media.variants) ? media.variants : [];
  const original = variants.find((item) => item.key === 'original') || variants[0];
  const source = original?.url || media.public_media?.url;
  if (!isSafePublicAssetUrl(source)) {
    fail('web_artifact_media_url_invalid', 'La imagen no tiene una URL pública estable.', {
      ...details,
      media_id: assetId,
    });
  }
  const width = Number(original?.width || media.metadata?.width || 0);
  const height = Number(original?.height || media.metadata?.height || 0);
  return {
    source,
    dimensions: width > 0 && height > 0
    ? ` width="${width}" height="${height}"`
      : '',
  };
}

function renderImage(node, snapshot) {
  const { source, dimensions } = resolvedMediaImage(snapshot, node.props.asset_id, { node_id: node.id });
  const loading = node.props.loading === 'eager' ? 'eager' : 'lazy';
  const fetchPriority = loading === 'eager' ? ' fetchpriority="high"' : '';
  const alt = node.props.decorative ? '' : node.props.alt;
  const caption = node.props.caption
    ? `<figcaption>${escapeHtml(node.props.caption)}</figcaption>`
    : '';
  return `<figure id="cc-${escapeHtml(node.id)}" class="cc-node cc-image ${imageClassList(node)} ${styleClassList(node)}"><div class="cc-image-frame"><img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}" loading="${loading}" decoding="async"${fetchPriority}${dimensions}></div>${caption}</figure>`;
}

function renderGallery(node, snapshot) {
  const figures = node.props.items.map((item, index) => {
    const { source, dimensions } = resolvedMediaImage(snapshot, item.asset_id, {
      node_id: node.id,
      item_index: index,
    });
    const classes = imageClassList({
      props: {
        fit: node.props.fit,
        aspect_ratio: node.props.aspect_ratio,
        focal_x: item.focal_x,
        focal_y: item.focal_y,
      },
    });
    const alt = item.decorative ? '' : item.alt;
    const caption = item.caption
      ? `<figcaption>${escapeHtml(item.caption)}</figcaption>`
      : '';
    return `<figure class="cc-gallery-item ${classes}"><div class="cc-image-frame"><img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"${dimensions}></div>${caption}</figure>`;
  }).join('');
  return `<div id="cc-${escapeHtml(node.id)}" class="cc-node cc-gallery cc-gallery-cols-${Number(node.props.columns)} ${styleClassList(node)}">${figures}</div>`;
}

function renderSlider(node, snapshot) {
  const aspect = String(node.props.aspect_ratio || '16:9').replace(':', '-');
  const slides = node.props.items.map((item, index) => {
    const { source, dimensions } = resolvedMediaImage(snapshot, item.asset_id, {
      node_id: node.id,
      item_index: index,
    });
    const classes = imageClassList({
      props: {
        fit: node.props.fit,
        aspect_ratio: node.props.aspect_ratio,
        focal_x: item.focal_x,
        focal_y: item.focal_y,
      },
    });
    const alt = item.decorative ? '' : item.alt;
    const caption = item.caption
      ? `<figcaption>${escapeHtml(item.caption)}</figcaption>`
      : '';
    return `<figure id="cc-${escapeHtml(node.id)}-slide-${index + 1}" class="cc-slider-slide ${classes}"><div class="cc-image-frame"><img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"${dimensions}></div>${caption}</figure>`;
  }).join('');
  const dots = node.props.show_dots
    ? `<div class="cc-slider-dots" aria-hidden="true">${node.props.items.map((_, index) => `<a href="#cc-${escapeHtml(node.id)}-slide-${index + 1}">${index + 1}</a>`).join('')}</div>`
    : '';
  const arrows = node.props.show_arrows
    ? '<span class="cc-slider-arrow cc-slider-prev" aria-hidden="true">‹</span><span class="cc-slider-arrow cc-slider-next" aria-hidden="true">›</span>'
    : '';
  const autoplayClass = node.props.autoplay ? ' cc-slider-autoplay' : '';
  return `<div id="cc-${escapeHtml(node.id)}" class="cc-node cc-slider cc-slider-aspect-${escapeHtml(aspect)}${autoplayClass} ${styleClassList(node)}" style="--cc-slider-interval:${Number(node.props.interval_seconds) || 5}s">${arrows}<div class="cc-slider-track">${slides}</div>${dots}</div>`;
}

function renderVideo(node) {
  const source = videoEmbedUrl(node);
  const loading = node.props.loading === 'eager' ? 'eager' : 'lazy';
  const aspect = String(node.props.aspect_ratio || '16:9').replace(':', '-');
  const caption = node.props.caption
    ? `<figcaption>${escapeHtml(node.props.caption)}</figcaption>`
    : '';
  return `<figure id="cc-${escapeHtml(node.id)}" class="cc-node cc-video cc-video-aspect-${escapeHtml(aspect)} ${styleClassList(node)}"><div class="cc-video-frame"><iframe src="${escapeHtml(source)}" title="${escapeHtml(node.props.title)}" loading="${loading}" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>${caption}</figure>`;
}

function renderTestimonial(node) {
  const rating = Number.isInteger(node.props.rating)
    ? Math.min(5, Math.max(0, node.props.rating))
    : 0;
  const stars = rating > 0
    ? `<div class="cc-testimonial-stars" aria-label="${escapeHtml(`${rating} de 5 estrellas`)}">${escapeHtml('★'.repeat(rating))}${escapeHtml('☆'.repeat(5 - rating))}</div>`
    : '';
  const attribution = String(node.props.attribution || '').trim();
  const role = String(node.props.role || '').trim();
  const sourceLabel = String(node.props.source_label || '').trim();
  const metaParts = [
    attribution ? `<strong>${escapeHtml(attribution)}</strong>` : '',
    role ? `<span>${escapeHtml(role)}</span>` : '',
    sourceLabel ? `<span class="cc-testimonial-source">${escapeHtml(sourceLabel)}</span>` : '',
  ].filter(Boolean).join('');
  const meta = metaParts ? `<figcaption class="cc-testimonial-meta">${metaParts}</figcaption>` : '';
  return `<figure id="cc-${escapeHtml(node.id)}" class="cc-node cc-testimonial ${styleClassList(node)}">${stars}<blockquote class="cc-testimonial-quote">${escapeHtml(node.props.quote)}</blockquote>${meta}</figure>`;
}

function renderAccordion(node) {
  const title = String(node.props.title || '').trim();
  const heading = title
    ? `<h2 class="cc-accordion-title">${escapeHtml(title)}</h2>`
    : '';
  const sharedName = node.props.allow_multiple_open === false
    ? ` name="cc-accordion-${escapeHtml(node.id)}"`
    : '';
  const items = Array.isArray(node.props.items)
    ? node.props.items.slice(0, 12).map((item) => (
      `<details class="cc-accordion-item"${sharedName}${item.open ? ' open' : ''}><summary>${escapeHtml(item.title)}</summary><p>${escapeHtml(item.body)}</p></details>`
    )).join('')
    : '';
  return `<section id="cc-${escapeHtml(node.id)}" class="cc-node cc-accordion ${styleClassList(node)}" aria-label="${escapeHtml(node.props.aria_label)}">${heading}<div class="cc-accordion-items">${items}</div></section>`;
}

function renderLocationMap(node) {
  const href = safePublicButtonUrl(node.props.directions_url, node.id);
  const title = String(node.props.title || '').trim();
  const address = String(node.props.address || '').trim();
  const buttonLabel = String(node.props.button_label || 'Cómo llegar').trim();
  const mapPlaceholder = node.props.show_map_placeholder === false
    ? ''
    : '<div class="cc-location-map-visual" aria-hidden="true"><span></span><span></span><strong>Mapa</strong></div>';
  return `<aside id="cc-${escapeHtml(node.id)}" class="cc-node cc-location-map ${styleClassList(node)}">${mapPlaceholder}<div class="cc-location-map-body"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(address)}</p><a class="cc-button cc-button-outline" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(buttonLabel)}</a></div></aside>`;
}

function pageHref(page, baseUrl) {
  return page.slug === 'inicio' ? `${baseUrl}/` : `${baseUrl}/${page.slug}/`;
}

function renderBreadcrumbs(node, context) {
  const separator = ['/', '›', '·'].includes(node.props.separator) ? node.props.separator : '›';
  const currentTitle = String(context.page?.title || '').trim() || 'Página actual';
  const items = [];
  items.push(`<li><a href="${escapeHtml(`${context.baseUrl}/`)}">${escapeHtml(node.props.home_label)}</a></li>`);
  if (node.props.show_current !== false) {
    items.push(`<li><span aria-current="page">${escapeHtml(currentTitle)}</span></li>`);
  }
  return `<nav id="cc-${escapeHtml(node.id)}" class="cc-node cc-breadcrumbs ${styleClassList(node)}" aria-label="${escapeHtml(node.props.aria_label)}"><ol>${items.join(`<li class="cc-breadcrumbs-separator" aria-hidden="true">${escapeHtml(separator)}</li>`)}</ol></nav>`;
}

function renderPageMenu(node, context) {
  const currentPageId = context.page?.id || null;
  const includeHome = node.props.include_home !== false;
  const pages = Array.isArray(context.pages) ? context.pages : [];
  const navigationPages = pages
    .filter((page) => includeHome || page.slug !== 'inicio')
    .filter((page) => String(page?.title || '').trim());
  const items = navigationPages.map((page) => {
    const href = pageHref(page, context.baseUrl);
    const current = page.id === currentPageId ? ' aria-current="page"' : '';
    const className = page.id === currentPageId ? ' class="cc-page-menu-current"' : '';
    return `<li><a href="${escapeHtml(href)}"${className}${current}>${escapeHtml(page.title)}</a></li>`;
  }).join('');
  const label = String(node.props.label || '').trim();
  const title = label ? `<span class="cc-page-menu-label">${escapeHtml(label)}</span>` : '';
  const layout = node.props.layout === 'vertical' ? 'vertical' : 'horizontal';
  return `<nav id="cc-${escapeHtml(node.id)}" class="cc-node cc-page-menu cc-page-menu-${layout} ${styleClassList(node)}" aria-label="${escapeHtml(node.props.aria_label)}">${title}<ul>${items}</ul></nav>`;
}

function linkListItemHref(node, item, context) {
  if (item.action === 'external_url') return safePublicButtonUrl(item.target, node.id);
  if (item.action === 'phone') return `tel:${safePhoneTarget(item.target, node.id)}`;
  if (item.action === 'whatsapp') return `https://wa.me/${safePhoneTarget(item.target, node.id).slice(1)}`;
  const page = context.pageById.get(item.target);
  if (!page) fail('web_artifact_internal_page_missing', 'El enlace interno apunta a una página inexistente.', {
    node_id: node.id,
    target: item.target,
  });
  return pageHref(page, context.baseUrl);
}

function safeContentEntryHref(entry, context) {
  const fields = entry?.fields || {};
  const candidates = [
    entry?.public_url,
    entry?.url,
    entry?.content?.public_url,
    entry?.content?.url,
    fields.public_url,
    fields.url,
    fields.permalink,
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    if (raw.startsWith('/')) {
      try {
        const resolved = new URL(raw, context.baseUrl).toString();
        const safe = publicHttpUrl(resolved, { requireHttps: true });
        if (safe) return safe;
      } catch {
        continue;
      }
    }
    const safe = publicHttpUrl(raw, { requireHttps: true });
    if (safe) return safe;
  }
  return null;
}

function renderCmsLinkList(node, context, snapshot) {
  const cmsIndex = node.props.cms_index || {};
  const acceptedTypes = new Set(Array.isArray(cmsIndex.content_types) ? cmsIndex.content_types : []);
  const limit = Math.min(12, Math.max(1, Number(cmsIndex.limit) || 6));
  const entries = Object.values(snapshot.content_entries || {})
    .filter((entry) => acceptedTypes.has(entry?.type))
    .slice(0, limit);
  const layout = ['horizontal', 'cards'].includes(node.props.layout) ? node.props.layout : 'vertical';
  const title = String(node.props.title || '').trim()
    ? `<h2 class="cc-link-list-title">${escapeHtml(node.props.title)}</h2>`
    : '';
  const items = entries.length
    ? entries.map((entry) => {
      const typeLabel = WEB_CONTENT_TYPE_LABELS[entry.type] || 'Contenido';
      const badge = cmsIndex.show_type === false
        ? ''
        : `<span class="cc-link-list-type">${escapeHtml(typeLabel)}</span>`;
      const label = publicContentTitle(entry);
      const href = safeContentEntryHref(entry, context);
      if (href) {
        return `<li class="cc-link-list-item"><a href="${escapeHtml(href)}">${badge}<span>${escapeHtml(label)}</span></a></li>`;
      }
      return `<li class="cc-link-list-item"><span class="cc-link-list-static">${badge}<span>${escapeHtml(label)}</span></span></li>`;
    }).join('')
    : `<li class="cc-link-list-empty">${escapeHtml(cmsIndex.empty_message || 'Aún no hay contenido publicado para mostrar.')}</li>`;
  return `<nav id="cc-${escapeHtml(node.id)}" class="cc-node cc-link-list cc-link-list-${layout} cc-link-list-cms ${styleClassList(node)}" aria-label="${escapeHtml(node.props.aria_label)}">${title}<ul class="cc-link-list-items">${items}</ul></nav>`;
}

function renderLinkList(node, context, snapshot) {
  if (node.props.source === 'cms_index') return renderCmsLinkList(node, context, snapshot);
  const layout = ['horizontal', 'cards'].includes(node.props.layout) ? node.props.layout : 'vertical';
  const title = String(node.props.title || '').trim()
    ? `<h2 class="cc-link-list-title">${escapeHtml(node.props.title)}</h2>`
    : '';
  const items = node.props.items.slice(0, 8).map((item) => {
    const href = linkListItemHref(node, item, context);
    const external = item.action === 'external_url' && item.open_in_new_tab === true
      ? ' target="_blank" rel="noopener noreferrer"'
      : '';
    return `<li class="cc-link-list-item"><a href="${escapeHtml(href)}"${external}>${escapeHtml(item.label)}</a></li>`;
  }).join('');
  return `<nav id="cc-${escapeHtml(node.id)}" class="cc-node cc-link-list cc-link-list-${layout} ${styleClassList(node)}" aria-label="${escapeHtml(node.props.aria_label)}">${title}<ul class="cc-link-list-items">${items}</ul></nav>`;
}

function compactText(value, maximum = 240) {
  const normalized = String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

function publicContentTitle(entry) {
  const fields = entry?.fields || {};
  return compactText(
    fields.content_title
    || fields.headline
    || fields.question
    || fields.display_name
    || fields.name
    || entry?.title
    || 'Contenido',
    140
  );
}

function publicContentExcerpt(entry) {
  const fields = entry?.fields || {};
  return compactText(
    fields.excerpt
    || fields.summary
    || fields.short_description
    || fields.description
    || fields.answer
    || fields.biography
    || fields.quote
    || fields.text
    || '',
    240
  );
}

function publicContentImage(entry, snapshot) {
  const fields = entry?.fields || {};
  const content = entry?.content && typeof entry.content === 'object' && !Array.isArray(entry.content)
    ? entry.content
    : {};
  const blocks = Array.isArray(content.blocks) ? content.blocks : [];
  const imageBlock = blocks.find((block) => block?.type === 'image'
    && typeof block.image_asset_id === 'string'
    && typeof block.alt_text === 'string'
    && block.image_asset_id.trim()
    && block.alt_text.trim());
  const assetId = String(imageBlock?.image_asset_id || fields.image_asset_id || content.image_asset_id || '').trim();
  const alt = compactText(imageBlock?.alt_text || fields.alt_text || content.alt_text || '', 500);
  if (!assetId || !alt || !snapshot.media_assets?.[assetId]) return null;
  const { source, dimensions } = resolvedMediaImage(snapshot, assetId, {
    content_entry_id: entry?.id,
    field: 'content.blocks.image_asset_id',
  });
  return { source, alt, dimensions };
}

function publicContentString(entry, candidates, maximum = 120) {
  const fields = entry?.fields || {};
  for (const key of candidates) {
    const value = fields[key] ?? entry?.[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      const nested = value.display_name || value.name || value.title || value.label;
      if (typeof nested === 'string' && nested.trim()) return compactText(nested, maximum);
      continue;
    }
    const text = compactText(value, maximum);
    if (text) return text;
  }
  return '';
}

function publicContentAuthor(entry) {
  return publicContentString(entry, [
    'author',
    'author_name',
    'author_display_name',
    'display_author',
    'professional_name',
    'doctor_name',
  ], 120);
}

function publicContentCategory(entry) {
  const explicit = publicContentString(entry, [
    'category',
    'category_name',
    'primary_category',
    'content_category',
    'taxonomy',
  ], 120);
  if (explicit) return explicit;
  if (entry?.type === 'category') return publicContentTitle(entry);
  return '';
}

function publicContentDate(entry, format) {
  const raw = publicContentString(entry, [
    'published_at',
    'publish_date',
    'published_date',
    'date',
    'created_at',
    'updated_at',
  ], 80);
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  try {
    return format === 'short'
      ? new Intl.DateTimeFormat('es-ES', { dateStyle: 'short' }).format(date)
      : new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  } catch (_error) {
    return date.toISOString().slice(0, 10);
  }
}

function renderPostList(node, snapshot) {
  const acceptedTypes = new Set(Array.isArray(node.props.content_types) ? node.props.content_types : []);
  const limit = Math.min(12, Math.max(1, Number(node.props.limit) || 6));
  const entries = Object.values(snapshot.content_entries || {})
    .filter((entry) => acceptedTypes.has(entry?.type))
    .slice(0, limit);
  const title = String(node.props.title || '').trim();
  const layout = node.props.layout === 'list' ? 'list' : 'cards';
  const heading = title ? `<h2 class="cc-post-list-title">${escapeHtml(title)}</h2>` : '';
  const body = entries.length
    ? `<div class="cc-post-list-items">${entries.map((entry) => {
      const typeLabel = WEB_CONTENT_TYPE_LABELS[entry.type] || 'Contenido';
      const badge = node.props.show_type === false
        ? ''
        : `<span class="cc-post-list-type">${escapeHtml(typeLabel)}</span>`;
      const image = layout === 'cards' ? publicContentImage(entry, snapshot) : null;
      const imageHtml = image
        ? `<img class="cc-post-list-image" src="${escapeHtml(image.source)}" alt="${escapeHtml(image.alt)}" loading="lazy" decoding="async"${image.dimensions}>`
        : '';
      const excerpt = node.props.show_excerpt === false
        ? ''
        : publicContentExcerpt(entry);
      return `<article class="cc-post-list-card">${imageHtml}${badge}<h3>${escapeHtml(publicContentTitle(entry))}</h3>${excerpt ? `<p>${escapeHtml(excerpt)}</p>` : ''}</article>`;
    }).join('')}</div>`
    : `<p class="cc-post-list-empty">${escapeHtml(node.props.empty_message)}</p>`;
  return `<section id="cc-${escapeHtml(node.id)}" class="cc-node cc-post-list cc-post-list-${layout} ${styleClassList(node)}" aria-label="${escapeHtml(node.props.aria_label)}">${heading}${body}</section>`;
}

function renderCategoryList(node, snapshot) {
  const limit = Math.min(12, Math.max(1, Number(node.props.limit) || 8));
  const entries = Object.values(snapshot.content_entries || {})
    .filter((entry) => entry?.type === 'category')
    .slice(0, limit);
  const title = String(node.props.title || '').trim();
  const layout = node.props.layout === 'cards' ? 'cards' : 'chips';
  const heading = title ? `<h2 class="cc-category-list-title">${escapeHtml(title)}</h2>` : '';
  const body = entries.length
    ? `<div class="cc-category-list-items">${entries.map((entry) => {
      const excerpt = node.props.show_description === false
        ? ''
        : publicContentExcerpt(entry);
      const tag = layout === 'cards' ? 'article' : 'span';
      return `<${tag} class="cc-category-list-item"><strong>${escapeHtml(publicContentTitle(entry))}</strong>${excerpt ? `<p>${escapeHtml(excerpt)}</p>` : ''}</${tag}>`;
    }).join('')}</div>`
    : `<p class="cc-category-list-empty">${escapeHtml(node.props.empty_message)}</p>`;
  return `<section id="cc-${escapeHtml(node.id)}" class="cc-node cc-category-list cc-category-list-${layout} ${styleClassList(node)}" aria-label="${escapeHtml(node.props.aria_label)}">${heading}${body}</section>`;
}

function renderContentMeta(node, snapshot) {
  const acceptedTypes = new Set(Array.isArray(node.props.content_types) ? node.props.content_types : []);
  const entry = Object.values(snapshot.content_entries || {})
    .find((candidate) => acceptedTypes.has(candidate?.type));
  const title = String(node.props.title || '').trim();
  const layout = ['stacked', 'chips'].includes(node.props.layout) ? node.props.layout : 'inline';
  const heading = title ? `<h2 class="cc-content-meta-title">${escapeHtml(title)}</h2>` : '';
  const values = [];
  if (node.props.show_author !== false) {
    const value = entry ? publicContentAuthor(entry) : '';
    if (value) values.push({ label: 'Autor', value });
  }
  if (node.props.show_date !== false) {
    const value = entry ? publicContentDate(entry, node.props.date_format) : '';
    if (value) values.push({ label: 'Fecha', value });
  }
  if (node.props.show_category !== false) {
    const value = entry ? publicContentCategory(entry) : '';
    if (value) values.push({ label: 'Categoría', value });
  }
  const body = values.length
    ? `<div class="cc-content-meta-items">${values.map((item) => `<span class="cc-content-meta-item"><span class="cc-content-meta-label">${escapeHtml(item.label)}</span><span class="cc-content-meta-value">${escapeHtml(item.value)}</span></span>`).join('')}</div>`
    : `<p class="cc-content-meta-empty">${escapeHtml(node.props.empty_message)}</p>`;
  return `<aside id="cc-${escapeHtml(node.id)}" class="cc-node cc-content-meta cc-content-meta-${layout} ${styleClassList(node)}" aria-label="${escapeHtml(node.props.aria_label)}">${heading}${body}</aside>`;
}

function collectPageHeadingsForToc(document, page, sourceNode, minLevel, maxLevel) {
  const headings = [];
  const visited = new Set();
  const walk = (nodeId) => {
    if (!nodeId || visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = document.nodes[nodeId];
    if (!node || node.id === sourceNode.id) return;
    if (node.type === 'heading') {
      const level = Math.min(6, Math.max(1, Number(node.props.level) || 2));
      const text = compactText(node.props.text, 140);
      if (text && level >= minLevel && level <= maxLevel) {
        headings.push({ id: node.id, level, text });
      }
    }
    for (const childId of node.children || []) walk(childId);
  };
  for (const rootId of page.root_node_ids || []) walk(rootId);
  return headings;
}

function renderTableOfContents(node, document, context) {
  const rawMin = Math.min(6, Math.max(1, Number(node.props.min_level) || 2));
  const rawMax = Math.min(6, Math.max(1, Number(node.props.max_level) || 3));
  const minLevel = Math.min(rawMin, rawMax);
  const maxLevel = Math.max(rawMin, rawMax);
  const headings = collectPageHeadingsForToc(document, context.page, node, minLevel, maxLevel);
  const layout = node.props.layout === 'plain' ? 'plain' : 'boxed';
  const title = String(node.props.title || '').trim();
  const heading = title ? `<h2 class="cc-toc-title">${escapeHtml(title)}</h2>` : '';
  const body = headings.length
    ? `<ol class="cc-toc-list">${headings.map((entry, index) => {
      const marker = node.props.show_numbers === false
        ? ''
        : `<span class="cc-toc-marker" aria-hidden="true">${index + 1}</span>`;
      return `<li class="cc-toc-item cc-toc-level-${entry.level}">${marker}<a href="#cc-${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a></li>`;
    }).join('')}</ol>`
    : `<p class="cc-toc-empty">${escapeHtml(node.props.empty_message)}</p>`;
  return `<nav id="cc-${escapeHtml(node.id)}" class="cc-node cc-table-of-contents cc-toc-${layout} ${styleClassList(node)}" aria-label="${escapeHtml(node.props.aria_label)}">${heading}${body}</nav>`;
}

function buttonHref(node, context) {
  const { action, target } = node.props;
  if (action === 'external_url') return safePublicButtonUrl(target, node.id);
  if (action === 'phone') return `tel:${safePhoneTarget(target, node.id)}`;
  if (action === 'whatsapp') return `https://wa.me/${safePhoneTarget(target, node.id).slice(1)}`;
  if (action === 'intake_form_anchor') return `#cc-${target}`;
  const page = context.pageById.get(target);
  if (!page) fail('web_artifact_internal_page_missing', 'El enlace interno apunta a una página inexistente.', {
    node_id: node.id,
    target,
  });
  return pageHref(page, context.baseUrl);
}

function renderIntakeForm(node, context) {
  const availableContactFields = new Set(node.props.fields.map((field) => field.name));
  const fields = node.props.fields.map((field) => {
    const id = `cc-field-${field.id}`;
    if (field.type === 'checkbox') {
      const isPrivacy = field.name === 'privacy_consent';
      const text = isPrivacy && context.siteConfiguration.consent.privacy_consent_text
        ? context.siteConfiguration.consent.privacy_consent_text
        : field.label;
      const legal = isPrivacy && context.siteConfiguration.consent.privacy_policy_url
        ? ` <a href="${escapeHtml(context.siteConfiguration.consent.privacy_policy_url)}" target="_blank" rel="noopener noreferrer">Consultar política de privacidad</a>`
        : '';
      return `<label class="cc-field cc-checkbox" for="${id}"><input id="${id}" name="${escapeHtml(field.name)}" type="checkbox" value="1"${field.required ? ' required' : ''}> <span>${escapeHtml(text)}${legal}</span></label>`;
    }
    if (field.type === 'select') {
      const selectableOptions = field.name === 'preferred_contact'
        ? (field.options || []).filter((option) => option.value !== 'email' || availableContactFields.has('email'))
        : (field.options || []);
      const options = selectableOptions.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
      return `<label class="cc-field" for="${id}"><span>${escapeHtml(field.label)}</span><select id="${id}" name="${escapeHtml(field.name)}"${field.required ? ' required' : ''}><option value="">Selecciona una opción</option>${options}</select></label>`;
    }
    const tag = field.type === 'textarea' ? 'textarea' : 'input';
    const common = ` id="${id}" name="${escapeHtml(field.name)}"${field.required ? ' required' : ''}${field.autocomplete ? ` autocomplete="${escapeHtml(field.autocomplete)}"` : ''}${field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : ''}`;
    const control = tag === 'textarea'
      ? `<textarea${common}></textarea>`
      : `<input${common} type="${escapeHtml(field.type)}">`;
    return `<label class="cc-field" for="${id}"><span>${escapeHtml(field.label)}</span>${control}</label>`;
  }).join('');
  const successId = `cc-${node.id}-success`;
  const errorId = `cc-${node.id}-error`;
  return `<form id="cc-${escapeHtml(node.id)}" class="cc-node cc-form ${styleClassList(node)}" action="${escapeHtml(context.intakeEndpoint)}" method="post" enctype="application/x-www-form-urlencoded" accept-charset="UTF-8" data-cc-native-intake="true"><h2>${escapeHtml(node.props.title)}</h2>${node.props.description ? `<p>${escapeHtml(node.props.description)}</p>` : ''}<input type="hidden" name="web_project_id" value="${escapeHtml(context.projectId)}"><input type="hidden" name="web_revision_id" value="${escapeHtml(context.revisionId)}"><input type="hidden" name="web_page_id" value="${escapeHtml(context.page.id)}"><input type="hidden" name="web_form_id" value="${escapeHtml(node.id)}"><input type="hidden" name="web_artifact_input_hash" value="${escapeHtml(context.artifactMarker)}"><input class="cc-honeypot" type="text" name="_cc_company" value="" tabindex="-1" autocomplete="off" aria-hidden="true">${fields}<button type="submit" class="cc-button cc-button-primary">${escapeHtml(node.props.submit_label)}</button><p id="${escapeHtml(successId)}" class="cc-form-status cc-form-success" role="status">${escapeHtml(node.props.success_message)}</p><p id="${escapeHtml(errorId)}" class="cc-form-status cc-form-error" role="alert">No hemos podido enviar el formulario. Inténtalo de nuevo en unos minutos.</p></form>`;
}

function renderNode(nodeId, document, snapshot, context, ancestors = new Set(), rootSemanticTag = null, parentSection = null, parentChildIndex = null) {
  const node = document.nodes[nodeId];
  if (!node) fail('web_artifact_node_missing', 'La revisión contiene una referencia de bloque rota.', { node_id: nodeId });
  if (ancestors.has(nodeId)) fail('web_artifact_node_cycle', 'La revisión contiene un ciclo de bloques.', { node_id: nodeId });
  const nextAncestors = new Set(ancestors).add(nodeId);
  if (node.type === 'section') {
    const globalSlot = rootSemanticTag === 'header' || rootSemanticTag === 'footer'
      ? rootSemanticTag
      : null;
    const tag = globalSlot || node.props.semantic_tag || 'section';
    const children = node.children.map((childId, index) => renderNode(childId, document, snapshot, context, nextAncestors, null, node, index)).join('');
    const globalAttribute = globalSlot ? ` data-cc-global="${globalSlot}"` : '';
    const globalClass = globalSlot ? ` cc-site-${globalSlot}` : '';
    const roleClass = `cc-role-${escapeHtml(node.props.structure_role || 'section')}`;
    return `<${tag} id="cc-${escapeHtml(node.id)}"${globalAttribute} class="cc-node cc-section${globalClass} ${roleClass} cc-layout-${escapeHtml(node.props.layout)} cc-cols-${Number(node.props.columns)} ${sectionTrackClassList(document, node)} ${sectionColumnWidthClassList(document, node, parentSection, parentChildIndex)} ${styleClassList(node)}"><div class="cc-container">${children}</div></${tag}>`;
  }
  if (node.type === 'heading') {
    const level = Math.min(6, Math.max(1, Number(node.props.level) || 2));
    return `<h${level} id="cc-${escapeHtml(node.id)}" class="cc-node cc-heading cc-size-${escapeHtml(node.props.size || 'lg')} cc-text-${escapeHtml(node.props.align || 'left')} cc-tone-${escapeHtml(node.props.tone || 'default')} ${styleClassList(node)}">${escapeHtml(node.props.text)}</h${level}>`;
  }
  if (node.type === 'text') {
    return `<p id="cc-${escapeHtml(node.id)}" class="cc-node cc-text cc-size-${escapeHtml(node.props.size || 'md')} cc-text-${escapeHtml(node.props.align || 'left')} cc-tone-${escapeHtml(node.props.tone || 'default')} ${styleClassList(node)}">${escapeHtml(node.props.text)}</p>`;
  }
  if (node.type === 'divider') {
    return `<hr id="cc-${escapeHtml(node.id)}" class="cc-node cc-divider cc-divider-${escapeHtml(node.props.line_style)} cc-divider-tone-${escapeHtml(node.props.tone)} ${styleClassList(node)}">`;
  }
  if (node.type === 'spacer') {
    return `<div id="cc-${escapeHtml(node.id)}" class="cc-node cc-spacer cc-spacer-${escapeHtml(node.props.size)} ${styleClassList(node)}" aria-hidden="true" role="presentation"></div>`;
  }
  if (node.type === 'faq') {
    return `<details id="cc-${escapeHtml(node.id)}" class="cc-node cc-faq ${styleClassList(node)}"><summary>${escapeHtml(node.props.question)}</summary><p>${escapeHtml(node.props.answer)}</p></details>`;
  }
  if (node.type === 'accordion') return renderAccordion(node);
  if (node.type === 'testimonial') return renderTestimonial(node);
  if (node.type === 'image') return renderImage(node, snapshot);
  if (node.type === 'gallery') return renderGallery(node, snapshot);
  if (node.type === 'slider') return renderSlider(node, snapshot);
  if (node.type === 'video') return renderVideo(node);
  if (node.type === 'location_map') return renderLocationMap(node);
  if (node.type === 'breadcrumbs') return renderBreadcrumbs(node, context);
  if (node.type === 'page_menu') return renderPageMenu(node, context);
  if (node.type === 'link_list') return renderLinkList(node, context, snapshot);
  if (node.type === 'post_list') return renderPostList(node, snapshot);
  if (node.type === 'category_list') return renderCategoryList(node, snapshot);
  if (node.type === 'content_meta') return renderContentMeta(node, snapshot);
  if (node.type === 'table_of_contents') return renderTableOfContents(node, document, context);
  if (node.type === 'button') {
    const href = buttonHref(node, context);
    const external = node.props.action === 'external_url' && node.props.open_in_new_tab === true;
    return `<a id="cc-${escapeHtml(node.id)}" class="cc-node cc-button cc-button-${escapeHtml(node.props.variant)} ${styleClassList(node)}" href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(node.props.label)}</a>`;
  }
  if (node.type === 'intake_form') return renderIntakeForm(node, context);
  fail('web_artifact_node_type_unsupported', 'El renderer no reconoce un tipo de bloque.', {
    node_id: node.id,
    node_type: node.type,
  });
}

function fontStackCss(_token) {
  // No se publican binarios de fuentes en el artefacto. Los tokens antiguos se
  // aceptan para compatibilidad documental, pero se renderizan de forma
  // determinista con la pila disponible en el sistema.
  return 'ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
}

function stylesheet(tokens, document = { nodes: {} }) {
  const density = tokens.spacing_density === 'compact'
    ? { sm: '.45rem', md: '.8rem', lg: '1.35rem', xl: '2rem', xxl: '3rem' }
    : tokens.spacing_density === 'spacious'
      ? { sm: '.75rem', md: '1.25rem', lg: '2rem', xl: '3.5rem', xxl: '5rem' }
      : { sm: '.6rem', md: '1rem', lg: '1.6rem', xl: '2.6rem', xxl: '4rem' };
  const radius = { none: '0', sm: '.25rem', md: '.5rem', lg: '.9rem', xl: '1.35rem', full: '9999px' }[tokens.radius] || '.9rem';
  const spacing = {
    none: '0',
    xs: '.25rem',
    sm: 'var(--cc-sm)',
    md: 'var(--cc-md)',
    lg: 'var(--cc-lg)',
    xl: 'var(--cc-xl)',
    '2xl': 'var(--cc-2xl)',
  };
  const align = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
  const spacingRules = (prefix = '') => Object.entries(spacing).flatMap(([name, value]) => [
    `.cc-node.cc-${prefix}gap-${name}{gap:${value}}`,
    `.cc-node.cc-${prefix}pt-${name}{padding-top:${value}}`,
    `.cc-node.cc-${prefix}pb-${name}{padding-bottom:${value}}`,
  ]).join('');
  const alignRules = (prefix = '') => Object.entries(align).map(([name, value]) => (
    `.cc-node.cc-${prefix}align-${name}{align-self:${value}}.cc-section.cc-${prefix}align-${name}>.cc-container{align-items:${value}}`
  )).join('');
  const columnRules = (prefix = '') => [1, 2, 3, 4].map((count) => {
    const selector = prefix
      ? `.cc-section.cc-${prefix}cols-${count}`
      : `.cc-layout-grid.cc-cols-${count}`;
    return `${selector}>.cc-container{display:grid;grid-template-columns:repeat(${count},minmax(0,1fr))}`;
  }).join('');
  const columnWidthRules = (prefix = '') => (
    '.cc-role-row.cc-column-widths>.cc-container{display:grid;grid-template-columns:repeat(12,minmax(0,1fr))}'
    + '.cc-role-row.cc-column-widths>.cc-container>.cc-role-column{grid-column:span 12/span 12}'
    + Array.from({ length: 12 }, (_value, index) => index + 1)
      .map((span) => `.cc-role-row.cc-column-widths>.cc-container>.cc-role-column.cc-${prefix}col-span-${span}{grid-column:span ${span}/span ${span}}`)
      .join('')
  );
  const columnTrackRules = (breakpoint) => Object.values(document.nodes || {})
    .filter((node) => node.type === 'section')
    .map((node) => validColumnTracks(node, breakpoint))
    .filter(Boolean)
    .map((tracks) => {
      const prefix = breakpoint === 'desktop' ? 'cc-tracks' : `cc-${breakpoint}-tracks`;
      const className = `${prefix}-${tracks.join('-')}`;
      const template = tracks.map((track) => `minmax(0,${track}fr)`).join(' ');
      return `.cc-section.${className}>.cc-container{display:grid;grid-template-columns:${template}}`;
    })
    .filter((rule, index, rules) => rules.indexOf(rule) === index)
    .join('');
  const responsiveRules = (breakpoint) => (
    `.cc-node.cc-hide-${breakpoint}{display:none!important}`
    + spacingRules(`${breakpoint}-`)
    + alignRules(`${breakpoint}-`)
    + columnRules(`${breakpoint}-`)
    + columnWidthRules(`${breakpoint}-`)
    + columnTrackRules(breakpoint)
  );
  const focalRules = [...new Set(Object.values(document.nodes || {})
    .flatMap((node) => {
      if (node?.type === 'image') return [node.props];
      if (node?.type === 'gallery') return node.props?.items || [];
      if (node?.type === 'slider') return node.props?.items || [];
      return [];
    })
    .map((item) => `${Number.isInteger(item?.focal_x) ? item.focal_x : 50}-${Number.isInteger(item?.focal_y) ? item.focal_y : 50}`))]
    .sort((left, right) => left.localeCompare(right))
    .map((pair) => {
      const [x, y] = pair.split('-');
      return `.cc-focal-${pair} img{object-position:${x}% ${y}%}`;
    }).join('');
  return [
    `:root{--cc-primary:${tokens.color_primary};--cc-secondary:${tokens.color_secondary};--cc-accent:${tokens.color_accent};--cc-surface:${tokens.color_surface};--cc-text:${tokens.color_text};--cc-radius:${radius};--cc-font-heading:${fontStackCss(tokens.font_heading)};--cc-font-body:${fontStackCss(tokens.font_body)};--cc-sm:${density.sm};--cc-md:${density.md};--cc-lg:${density.lg};--cc-xl:${density.xl};--cc-2xl:${density.xxl};color-scheme:light}`,
    '*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--cc-surface);color:var(--cc-text);font-family:var(--cc-font-body);line-height:1.55}img{display:block;max-width:100%}',
    '.cc-node{min-width:0}.cc-container{margin-inline:auto;display:inherit;flex-direction:inherit;flex-wrap:inherit;gap:inherit}.cc-section{display:flex;width:100%}.cc-role-container>.cc-container,.cc-role-row>.cc-container{align-items:stretch}.cc-role-column{min-width:0}.cc-role-column>.cc-container{width:100%;min-width:0}.cc-layout-stack>.cc-container{display:flex;flex-direction:column}.cc-layout-row>.cc-container{display:flex;flex-direction:row;flex-wrap:wrap}.cc-layout-grid>.cc-container{display:grid}',
    columnRules(),
    columnWidthRules(),
    '.cc-section.cc-width-narrow>.cc-container{width:min(100% - 2rem,48rem)}.cc-section.cc-width-standard>.cc-container{width:min(100% - 2rem,72rem)}.cc-section.cc-width-wide>.cc-container{width:min(100% - 2rem,82.5rem)}.cc-section.cc-width-full>.cc-container{width:100%;padding-inline:1rem}.cc-node.cc-width-narrow:not(.cc-section){width:min(100%,48rem)}.cc-node.cc-width-standard:not(.cc-section){width:min(100%,72rem)}.cc-node.cc-width-wide:not(.cc-section){width:min(100%,82.5rem)}.cc-node.cc-width-full:not(.cc-section){width:100%}',
    spacingRules(),
    alignRules(),
    '.cc-node.cc-bg-transparent{background:transparent}.cc-node.cc-bg-surface{background:var(--cc-surface)}.cc-node.cc-bg-muted{background:#f5f6fa}.cc-node.cc-bg-brand{background:var(--cc-primary)}.cc-node.cc-bg-accent{background:var(--cc-accent)}.cc-node.cc-fg-default{color:var(--cc-text)}.cc-node.cc-fg-muted,.cc-node.cc-tone-muted{color:#5f6b7f}.cc-node.cc-fg-inverse,.cc-node.cc-tone-inverse{color:#fff}.cc-node.cc-fg-brand,.cc-node.cc-tone-brand{color:var(--cc-primary)}.cc-node.cc-fg-accent,.cc-node.cc-tone-accent{color:var(--cc-accent)}.cc-node.cc-tone-default{color:var(--cc-text)}',
    '.cc-node.cc-radius-inherit{border-radius:var(--cc-radius)}.cc-node.cc-radius-none{border-radius:0}.cc-node.cc-radius-sm{border-radius:.25rem}.cc-node.cc-radius-md{border-radius:.5rem}.cc-node.cc-radius-lg{border-radius:.9rem}.cc-node.cc-radius-xl{border-radius:1.35rem}.cc-node.cc-radius-full{border-radius:9999px}.cc-node.cc-shadow-none{box-shadow:none}.cc-node.cc-shadow-sm{box-shadow:0 2px 8px #181d3514}.cc-node.cc-shadow-md{box-shadow:0 8px 24px #181d3521}.cc-node.cc-shadow-lg{box-shadow:0 18px 50px #181d3529}',
    '@media(prefers-reduced-motion:no-preference){.cc-animate-fade_in{animation:ccFadeIn .42s cubic-bezier(.2,0,0,1) both}.cc-animate-slide_up{animation:ccSlideUp .46s cubic-bezier(.2,0,0,1) both}.cc-animate-scale_in{animation:ccScaleIn .38s cubic-bezier(.2,0,0,1) both}}@keyframes ccFadeIn{from{opacity:0}to{opacity:1}}@keyframes ccSlideUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}@keyframes ccScaleIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}',
    '.cc-heading{margin:0;font-family:var(--cc-font-heading);line-height:1.12;letter-spacing:-.025em}.cc-heading.cc-size-sm{font-size:1.25rem}.cc-heading.cc-size-md{font-size:1.5rem}.cc-heading.cc-size-lg{font-size:1.875rem}.cc-heading.cc-size-xl{font-size:clamp(1.55rem,3vw,2.35rem)}.cc-heading.cc-size-2xl{font-size:clamp(1.9rem,4vw,3.2rem)}.cc-heading.cc-size-3xl{font-size:clamp(2.25rem,6vw,4.5rem)}.cc-text{margin:0;max-width:68ch;white-space:pre-wrap}.cc-text.cc-size-sm{font-size:.875rem}.cc-text.cc-size-md{font-size:1rem}.cc-text.cc-size-lg{font-size:1.125rem}.cc-text-left{text-align:left}.cc-text-center{text-align:center}.cc-text-right{text-align:right}',
    '.cc-divider{width:100%;height:0;margin:0;border:0;border-top-width:1px;border-top-style:solid}.cc-divider-solid{border-top-style:solid}.cc-divider-dashed{border-top-style:dashed}.cc-divider-dotted{border-top-style:dotted}.cc-divider-tone-muted{border-top-color:#dfe3ec}.cc-divider-tone-brand{border-top-color:var(--cc-primary)}.cc-divider-tone-accent{border-top-color:var(--cc-accent)}.cc-spacer{display:block;width:100%;flex:none}.cc-spacer-xs{height:.25rem}.cc-spacer-sm{height:var(--cc-sm)}.cc-spacer-md{height:var(--cc-md)}.cc-spacer-lg{height:var(--cc-lg)}.cc-spacer-xl{height:var(--cc-xl)}.cc-spacer-2xl{height:var(--cc-2xl)}',
    '.cc-button{display:inline-flex;width:fit-content;align-items:center;justify-content:center;min-height:44px;padding:.75rem 1.15rem;border-radius:var(--cc-radius);font-weight:700;text-decoration:none;border:1px solid transparent;cursor:pointer}.cc-button-primary{background:var(--cc-primary);color:#fff}.cc-section.cc-bg-brand .cc-button-primary{background:var(--cc-surface);color:var(--cc-primary)}.cc-button-secondary{background:var(--cc-secondary);color:#fff}.cc-button-outline{border-color:currentColor;color:var(--cc-primary);background:transparent}.cc-button-link{padding-inline:0;color:var(--cc-primary)}',
    '.cc-form{display:grid;gap:var(--cc-md);padding:var(--cc-xl);border:1px solid #dfe3ec;border-radius:var(--cc-radius);background:#fff}.cc-field{display:grid;gap:.35rem}.cc-field input:not([type=checkbox]),.cc-field textarea,.cc-field select{width:100%;min-height:44px;border:1px solid #aab1c2;border-radius:.5rem;padding:.7rem;font:inherit}.cc-checkbox{grid-template-columns:auto 1fr;align-items:start}.cc-honeypot{position:absolute!important;left:-10000px!important;width:1px!important;height:1px!important;overflow:hidden!important}.cc-form-status{display:none;padding:.75rem;border-radius:.5rem}.cc-form-success{background:#e9f8f1;color:#145c3d}.cc-form-error{background:#fff1f1;color:#8b1f1f}.cc-form-status:target{display:block}',
    '.cc-image{margin:0}.cc-gallery{display:grid}.cc-gallery-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.cc-gallery-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.cc-gallery-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}.cc-gallery-item{min-width:0;margin:0;border-radius:inherit}.cc-image-frame{overflow:hidden;border-radius:inherit;background:#eef1f6}.cc-image img,.cc-gallery-item img,.cc-slider-slide img{width:100%;height:100%;object-fit:cover}.cc-fit-contain img{object-fit:contain}.cc-aspect-auto .cc-image-frame img{height:auto}.cc-aspect-1-1 .cc-image-frame img{aspect-ratio:1/1}.cc-aspect-1-1 .cc-image-frame{aspect-ratio:1/1}.cc-aspect-4-3 .cc-image-frame{aspect-ratio:4/3}.cc-aspect-3-2 .cc-image-frame{aspect-ratio:3/2}.cc-aspect-16-9 .cc-image-frame{aspect-ratio:16/9}.cc-aspect-21-9 .cc-image-frame{aspect-ratio:21/9}.cc-image figcaption,.cc-gallery-item figcaption,.cc-slider-slide figcaption,.cc-video figcaption{padding-top:.5rem;color:#5f6b7f;font-size:.8125rem}.cc-slider{position:relative;overflow:hidden}.cc-slider-track{display:flex;gap:var(--cc-md);overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;border-radius:inherit}.cc-slider-slide{min-width:100%;margin:0;scroll-snap-align:start;border-radius:inherit}.cc-slider-dots{display:flex;justify-content:center;gap:.5rem;margin-top:.75rem}.cc-slider-dots a{width:.625rem;height:.625rem;overflow:hidden;border-radius:999px;background:#cbd5e1;text-indent:999px}.cc-slider-arrow{position:absolute;top:50%;z-index:1;display:grid;width:2.25rem;height:2.25rem;place-items:center;border-radius:999px;background:rgba(15,23,42,.72);color:#fff;transform:translateY(-50%)}.cc-slider-prev{left:.75rem}.cc-slider-next{right:.75rem}.cc-slider-autoplay .cc-slider-track{animation:cc-slider-pulse var(--cc-slider-interval,5s) ease-in-out infinite}@keyframes cc-slider-pulse{0%,100%{filter:none}50%{filter:brightness(.96)}}.cc-video{margin:0}.cc-video-frame{position:relative;overflow:hidden;border-radius:inherit;background:#eef1f6}.cc-video-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0}.cc-video-aspect-16-9 .cc-video-frame{aspect-ratio:16/9}.cc-video-aspect-4-3 .cc-video-frame{aspect-ratio:4/3}.cc-video-aspect-1-1 .cc-video-frame{aspect-ratio:1/1}',
    '.cc-location-map{display:grid;grid-template-columns:minmax(0,1fr) minmax(16rem,1fr);gap:var(--cc-lg);align-items:stretch;border:1px solid #dfe3ec;background:#fff;padding:var(--cc-lg);border-radius:var(--cc-radius)}.cc-location-map-visual{position:relative;min-height:12rem;overflow:hidden;border-radius:calc(var(--cc-radius) - .25rem);background:linear-gradient(135deg,#eef2ff,#e0f2fe);display:grid;place-items:center;color:var(--cc-primary);font-family:var(--cc-font-heading);font-weight:800}.cc-location-map-visual span{position:absolute;inset:auto 12% 32%;height:2px;background:rgba(79,70,229,.22);transform:rotate(-14deg)}.cc-location-map-visual span+span{inset:34% 18% auto;height:2px;transform:rotate(18deg)}.cc-location-map-body{display:grid;align-content:center;gap:.75rem}.cc-location-map h2,.cc-location-map p{margin:0}.cc-location-map p{color:#5f6b7f;white-space:pre-wrap}',
    '.cc-breadcrumbs{font-size:.875rem;color:#5f6b7f}.cc-breadcrumbs ol{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem;margin:0;padding:0;list-style:none}.cc-breadcrumbs a{color:var(--cc-primary);text-decoration:none;font-weight:700}.cc-breadcrumbs a:hover{text-decoration:underline}.cc-breadcrumbs [aria-current=page]{color:var(--cc-text);font-weight:700}.cc-breadcrumbs-separator{color:#9aa3b6}',
    '.cc-page-menu{display:flex;align-items:center;gap:var(--cc-md);font-size:.95rem}.cc-page-menu-label{font-family:var(--cc-font-heading);font-weight:800;color:var(--cc-text)}.cc-page-menu ul{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem .9rem;margin:0;padding:0;list-style:none}.cc-page-menu a{display:inline-flex;align-items:center;min-height:36px;color:#5f6b7f;text-decoration:none;font-weight:700}.cc-page-menu a:hover{color:var(--cc-primary);text-decoration:underline}.cc-page-menu a[aria-current=page],.cc-page-menu-current{color:var(--cc-primary)}.cc-page-menu-vertical{align-items:flex-start;flex-direction:column}.cc-page-menu-vertical ul{align-items:flex-start;flex-direction:column;gap:.25rem}',
    '.cc-link-list{display:grid;gap:var(--cc-sm)}.cc-link-list-title{margin:0;font-family:var(--cc-font-heading);font-size:1.05rem;line-height:1.2;letter-spacing:-.01em}.cc-link-list-items{display:flex;flex-wrap:wrap;gap:.5rem .75rem;margin:0;padding:0;list-style:none}.cc-link-list-vertical .cc-link-list-items{flex-direction:column;align-items:flex-start;gap:.35rem}.cc-link-list-cards .cc-link-list-items{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--cc-sm)}.cc-link-list-item{min-width:0}.cc-link-list a,.cc-link-list-static{display:inline-flex;align-items:center;min-height:36px;color:var(--cc-primary);text-decoration:none;font-weight:800}.cc-link-list a::after{content:"›";margin-left:.35rem;opacity:.65}.cc-link-list a:hover{text-decoration:underline}.cc-link-list-cards a,.cc-link-list-cards .cc-link-list-static{width:100%;min-height:44px;border:1px solid #dfe3ec;border-radius:var(--cc-radius);background:#fff;padding:.65rem .8rem;box-shadow:0 2px 8px #181d3508}.cc-link-list-cms a,.cc-link-list-cms .cc-link-list-static{gap:.45rem;align-items:flex-start}.cc-link-list-type{width:fit-content;flex:0 0 auto;border-radius:9999px;background:#eef2ff;color:var(--cc-primary);padding:.16rem .45rem;font-size:.68rem;font-weight:800}.cc-link-list-empty{color:#5f6b7f;font-size:.92rem}',
    '.cc-post-list{display:grid;gap:var(--cc-md)}.cc-post-list-title{margin:0;font-family:var(--cc-font-heading);font-size:clamp(1.35rem,2.5vw,2rem);line-height:1.15;letter-spacing:-.02em}.cc-post-list-items{display:grid;gap:var(--cc-md)}.cc-post-list-cards .cc-post-list-items{grid-template-columns:repeat(3,minmax(0,1fr))}.cc-post-list-card{display:grid;gap:.55rem;min-width:0;padding:var(--cc-md);border:1px solid #dfe3ec;border-radius:var(--cc-radius);background:#fff;box-shadow:0 2px 8px #181d350a}.cc-post-list-image{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:calc(var(--cc-radius) - .25rem);background:#eef1f6}.cc-post-list-card h3{margin:0;font-family:var(--cc-font-heading);font-size:1.05rem;line-height:1.25}.cc-post-list-card p{margin:0;color:#5f6b7f;white-space:pre-wrap}.cc-post-list-type{width:fit-content;border-radius:9999px;background:#eef2ff;color:var(--cc-primary);padding:.18rem .5rem;font-size:.72rem;font-weight:800}.cc-post-list-empty{margin:0;color:#5f6b7f}',
    '.cc-category-list{display:grid;gap:var(--cc-md)}.cc-category-list-title{margin:0;font-family:var(--cc-font-heading);font-size:clamp(1.25rem,2.2vw,1.8rem);line-height:1.15;letter-spacing:-.02em}.cc-category-list-items{display:flex;flex-wrap:wrap;gap:.65rem}.cc-category-list-item{display:grid;gap:.35rem;min-width:0;margin:0}.cc-category-list-chips .cc-category-list-item{border:1px solid #dfe3ec;border-radius:9999px;background:#fff;padding:.45rem .85rem;box-shadow:0 2px 8px #181d3508}.cc-category-list-cards .cc-category-list-items{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--cc-md)}.cc-category-list-cards .cc-category-list-item{border:1px solid #dfe3ec;border-radius:var(--cc-radius);background:#fff;padding:var(--cc-md);box-shadow:0 2px 8px #181d350a}.cc-category-list-item strong{font-family:var(--cc-font-heading);font-size:.95rem;color:var(--cc-text)}.cc-category-list-item p{margin:0;color:#5f6b7f;white-space:pre-wrap}.cc-category-list-empty{margin:0;color:#5f6b7f}',
    '.cc-content-meta{display:grid;gap:.65rem;color:#5f6b7f;font-size:.92rem}.cc-content-meta-title{margin:0;font-family:var(--cc-font-heading);color:var(--cc-text);font-size:1.05rem;line-height:1.25}.cc-content-meta-items{display:flex;flex-wrap:wrap;align-items:center;gap:.45rem .9rem}.cc-content-meta-stacked .cc-content-meta-items{align-items:flex-start;flex-direction:column;gap:.35rem}.cc-content-meta-chips .cc-content-meta-items{gap:.5rem}.cc-content-meta-item{display:inline-flex;min-width:0;align-items:center;gap:.35rem}.cc-content-meta-chips .cc-content-meta-item{border:1px solid #dfe3ec;border-radius:9999px;background:#fff;padding:.34rem .7rem;box-shadow:0 2px 8px #181d3508}.cc-content-meta-label{color:#9aa3b6;font-size:.76rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase}.cc-content-meta-value{color:var(--cc-text);font-weight:700}.cc-content-meta-empty{margin:0;color:#5f6b7f}',
    '.cc-table-of-contents{display:grid;gap:var(--cc-md)}.cc-toc-boxed{padding:var(--cc-md);border:1px solid #dfe3ec;border-radius:var(--cc-radius);background:#fff;box-shadow:0 2px 8px #181d350a}.cc-toc-title{margin:0;font-family:var(--cc-font-heading);font-size:1.1rem;line-height:1.25}.cc-toc-list{display:grid;gap:.45rem;margin:0;padding:0;list-style:none}.cc-toc-item{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start;gap:.55rem}.cc-toc-item a{color:var(--cc-text);font-weight:700;text-decoration:none}.cc-toc-item a:hover{color:var(--cc-primary);text-decoration:underline}.cc-toc-marker{display:inline-grid;place-items:center;min-width:1.5rem;height:1.5rem;border-radius:9999px;background:#eef2ff;color:var(--cc-primary);font-size:.75rem;font-weight:800}.cc-toc-level-3{padding-left:1rem}.cc-toc-level-4,.cc-toc-level-5,.cc-toc-level-6{padding-left:2rem}.cc-toc-empty{margin:0;color:#5f6b7f}',
    focalRules,
    '.cc-faq{border:1px solid #dfe3ec;background:#fff;padding:var(--cc-md);border-radius:var(--cc-radius)}.cc-faq summary{cursor:pointer;font-family:var(--cc-font-heading);font-weight:700}.cc-faq p{margin:var(--cc-sm) 0 0;white-space:pre-wrap}',
    '.cc-accordion{display:grid;gap:var(--cc-sm);border:1px solid #dfe3ec;background:#fff;padding:var(--cc-md);border-radius:var(--cc-radius)}.cc-accordion-title{margin:0;font-family:var(--cc-font-heading);font-size:clamp(1.25rem,2.2vw,1.85rem);line-height:1.15;letter-spacing:-.02em}.cc-accordion-items{display:grid;gap:.6rem}.cc-accordion-item{overflow:hidden;border:1px solid #dfe3ec;border-radius:calc(var(--cc-radius) - .25rem);background:#fff}.cc-accordion-item summary{display:flex;align-items:center;justify-content:space-between;gap:1rem;cursor:pointer;padding:.85rem 1rem;font-family:var(--cc-font-heading);font-weight:800;list-style:none}.cc-accordion-item summary::-webkit-details-marker{display:none}.cc-accordion-item summary::after{content:"+";display:inline-grid;width:1.65rem;height:1.65rem;flex:0 0 auto;place-items:center;border-radius:9999px;background:#eef2ff;color:var(--cc-primary);font-family:var(--cc-font-body);font-weight:900}.cc-accordion-item[open] summary::after{content:"−"}.cc-accordion-item p{margin:0;padding:0 1rem 1rem;color:#475569;white-space:pre-wrap}',
    '.cc-testimonial{margin:0;display:grid;gap:.65rem;border:1px solid #dfe3ec;background:#fff;padding:var(--cc-lg);border-radius:var(--cc-radius)}.cc-testimonial-stars{color:#f59e0b;letter-spacing:.08em;font-size:1rem;line-height:1}.cc-testimonial-quote{margin:0;font-family:var(--cc-font-heading);font-size:1.125rem;line-height:1.5;white-space:pre-wrap}.cc-testimonial-meta{display:flex;flex-wrap:wrap;gap:.35rem .65rem;align-items:center;color:#5f6b7f;font-size:.875rem}.cc-testimonial-meta strong{color:var(--cc-text);font-weight:800}.cc-testimonial-source{padding:.16rem .45rem;border-radius:9999px;background:#eef2ff;color:var(--cc-primary);font-size:.75rem;font-weight:700}',
    `@media(max-width:767px){.cc-layout-row>.cc-container{flex-direction:column}.cc-layout-grid>.cc-container,.cc-gallery,.cc-location-map{grid-template-columns:1fr}.cc-post-list-cards .cc-post-list-items,.cc-category-list-cards .cc-category-list-items,.cc-link-list-cards .cc-link-list-items{grid-template-columns:1fr}.cc-form{padding:var(--cc-lg)}.cc-button{width:100%}${responsiveRules('mobile')}}`,
    `@media(min-width:768px) and (max-width:1023px){.cc-gallery{grid-template-columns:repeat(2,minmax(0,1fr))}${responsiveRules('tablet')}}`,
    `@media(min-width:1024px){${responsiveRules('desktop')}}`,
  ].join('');
}

function clinicAddress(clinic) {
  const value = clinic.address;
  if (!value) return null;
  if (typeof value === 'string') return { '@type': 'PostalAddress', streetAddress: value };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const address = {
      '@type': 'PostalAddress',
      ...(value.street_address ? { streetAddress: value.street_address } : {}),
      ...(value.locality ? { addressLocality: value.locality } : {}),
      ...(value.region ? { addressRegion: value.region } : {}),
      ...(value.postal_code ? { postalCode: value.postal_code } : {}),
      ...(value.country ? { addressCountry: value.country } : {}),
    };
    return Object.keys(address).length > 1 ? address : null;
  }
  return null;
}

function effectiveRootNodeIds(page, document) {
  return [
    document.globals?.header_node_id || null,
    ...(page.root_node_ids || []),
    document.globals?.footer_node_id || null,
  ].filter((nodeId, index, values) => nodeId && values.indexOf(nodeId) === index);
}

function reachableNodeIds(page, document) {
  const reachable = new Set();
  // SEO and Schema must describe the effective DOM. Header and footer are
  // visible on every route, so their headings/FAQ cannot be ignored here.
  const pending = [...effectiveRootNodeIds(page, document)];
  while (pending.length) {
    const nodeId = pending.pop();
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    pending.push(...(document.nodes[nodeId]?.children || []));
  }
  return reachable;
}

function buildStructuredData({ project, page, pageUrl, baseUrl, clinic, document, socialImageUrl = null }) {
  const root = `${baseUrl}/#website`;
  const organizationId = `${baseUrl}/#organization`;
  const schemaConfig = page.seo?.schema && typeof page.seo.schema === 'object'
    ? page.seo.schema
    : {};
  const pageType = schemaConfig.page_type === 'medical_web_page' ? 'MedicalWebPage' : 'WebPage';
  const includeFaq = schemaConfig.include_faq !== false;
  const graph = [{
    '@type': 'WebSite',
    '@id': root,
    url: `${baseUrl}/`,
    name: project.name,
    inLanguage: project.locale,
    publisher: { '@id': organizationId },
  }, {
    '@type': clinic.schema_type || 'Organization',
    '@id': organizationId,
    name: clinic.name || project.name,
    url: clinic.website || `${baseUrl}/`,
    ...(clinic.phone ? { telephone: clinic.phone } : {}),
    ...(clinic.email ? { email: clinic.email } : {}),
    ...(clinicAddress(clinic) ? { address: clinicAddress(clinic) } : {}),
    ...(Array.isArray(clinic.opening_hours) && clinic.opening_hours.length
      ? { openingHoursSpecification: clinic.opening_hours }
      : {}),
    ...(socialImageUrl && isSafePublicAssetUrl(socialImageUrl) ? { image: socialImageUrl } : {}),
    ...(clinic.schema_type === 'Dentist' ? { medicalSpecialty: 'Dentistry' } : {}),
  }, {
    '@type': pageType,
    '@id': `${pageUrl}#webpage`,
    url: pageUrl,
    name: page.seo?.title || page.title,
    ...(page.seo?.description ? { description: page.seo.description } : {}),
    isPartOf: { '@id': root },
    about: { '@id': organizationId },
    inLanguage: project.locale,
  }];
  const reachable = reachableNodeIds(page, document);
  const faqEntries = [...reachable]
    .map((nodeId) => document.nodes[nodeId])
    .filter((node) => node?.type === 'faq' && node.props?.question && node.props?.answer)
    .map((node) => ({
      '@type': 'Question',
      name: node.props.question,
      acceptedAnswer: { '@type': 'Answer', text: node.props.answer },
    }));
  if (includeFaq && faqEntries.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${pageUrl}#faq`,
      url: pageUrl,
      isPartOf: { '@id': `${pageUrl}#webpage` },
      mainEntity: faqEntries,
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

function pageSeoAudit(page, document) {
  const reachable = reachableNodeIds(page, document);
  const headings = [...reachable].map((id) => document.nodes[id]).filter((node) => node?.type === 'heading');
  const h1Count = headings.filter((node) => Number(node.props.level) === 1).length;
  const warnings = [];
  if (h1Count !== 1) warnings.push({ code: 'seo_h1_count', value: h1Count, expected: 1 });
  if (!page.seo?.title) warnings.push({ code: 'seo_title_missing' });
  if (!page.seo?.description) warnings.push({ code: 'seo_description_missing' });
  if ((page.seo?.title || '').length > 60) warnings.push({ code: 'seo_title_long' });
  if ((page.seo?.description || '').length > 160) warnings.push({ code: 'seo_description_long' });
  return { h1_count: h1Count, heading_count: headings.length, warnings };
}

function intakeFormsForPage(page, document) {
  // A global intake form is a real form on every rendered route. Include it in
  // each page contract; the manifest groups those contracts by page below.
  const pending = [...effectiveRootNodeIds(page, document)];
  const visited = new Set();
  const forms = [];
  while (pending.length) {
    const nodeId = pending.pop();
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = document.nodes[nodeId];
    if (!node) continue;
    if (node.type === 'intake_form') forms.push(node);
    pending.push(...node.children);
  }
  return forms.sort((left, right) => left.id.localeCompare(right.id));
}

function measurementLoaderTag(measurement, identity = {}) {
  if (!measurement.enabled) return '';
  const scopeAttribute = measurement.scope_type === 'group'
    ? `data-group-id="${measurement.scope_id}"`
    : `data-clinic-id="${measurement.scope_id}"`;
  // hmac_key is server-only IntakeConfig material. The browser receives only
  // public routing/configuration attributes; native landing forms are signed
  // by the same-origin bridge after canonical server-side validation.
  return `<script src="${escapeHtml(measurement.loader_url)}" ${scopeAttribute} data-api-url="${escapeHtml(measurement.api_url)}" data-event-bridge-url="/_clinicaclick/events" data-web-project-id="${escapeHtml(identity.projectId)}" data-web-revision-id="${escapeHtml(identity.revisionId)}" data-web-page-id="${escapeHtml(identity.pageId)}" data-web-artifact-input-hash="${escapeHtml(identity.artifactMarker)}" data-consent-mode-enabled="${measurement.consent_mode_enabled ? 'true' : 'false'}" data-consent-provider="${escapeHtml(measurement.consent_provider)}" async></script>`;
}

function renderPage({ page, document, snapshot, context, project, baseUrl, clinic, cssFile, artifactMarker }) {
  const pageContext = { ...context, page, artifactMarker };
  const headerId = document.globals?.header_node_id || null;
  const footerId = document.globals?.footer_node_id || null;
  const header = headerId
    ? renderNode(headerId, document, snapshot, pageContext, new Set(), 'header')
    : '';
  const body = page.root_node_ids.map((nodeId) => renderNode(nodeId, document, snapshot, pageContext)).join('');
  const footer = footerId
    ? renderNode(footerId, document, snapshot, pageContext, new Set(), 'footer')
    : '';
  const titleSuffix = document.seo.title_suffix ? ` ${document.seo.title_suffix}` : '';
  const title = `${page.seo?.title || page.title}${titleSuffix}`.slice(0, 150);
  const description = page.seo?.description || '';
  const pageUrl = page.slug === 'inicio' ? `${baseUrl}/` : `${baseUrl}/${page.slug}/`;
  const productionIndex = context.environment === 'production'
    && document.seo.indexing !== 'noindex'
    && page.seo?.index === true;
  const robots = `${productionIndex ? 'index' : 'noindex'},${page.seo?.follow === false ? 'nofollow' : 'follow'}`;
  const canonical = context.environment === 'production'
    ? (page.seo?.canonical_url || pageUrl)
    : pageUrl;
  const socialId = page.seo?.social_asset_id || document.seo.default_social_asset_id;
  const social = socialId ? snapshot.media_assets?.[socialId] : null;
  const socialUrl = social?.variants?.[0]?.url || social?.public_media?.url || null;
  const safeSocialUrl = socialUrl && isSafePublicAssetUrl(socialUrl)
    ? socialUrl
    : (clinic.image && isSafePublicAssetUrl(clinic.image) ? clinic.image : null);
  const socialImageAlt = social?.alt_text
    ? String(social.alt_text).normalize('NFC').trim().slice(0, 300)
    : (clinic.name || project.name);
  const jsonLd = buildStructuredData({
    project,
    page,
    pageUrl: canonical,
    baseUrl,
    clinic,
    document,
    socialImageUrl: safeSocialUrl,
  });
  const jsonLdText = stableJson(jsonLd);
  const jsonLdCspHash = sha256(jsonLdText, 'base64');
  const measurementOrigin = context.measurement.enabled ? context.measurement.api_url : null;
  // The public measurement runtime builds the consent/chat UI at runtime. It
  // injects scoped CSS and may use a public brand image served by the trusted
  // measurement origin. Keep the stricter static-site policy when measurement
  // is disabled, and open only those two directives when the trusted runtime
  // is embedded.
  const runtimeImageSources = `${measurementOrigin ? ` ${measurementOrigin}` : ''} data:`;
  const runtimeStyleSources = measurementOrigin ? " 'unsafe-inline'" : '';
  const runtimeFrameSources = videoFrameCspDirective(document);
  // `frame-ancestors` is ignored in a meta CSP and causes a browser warning.
  // It remains enforced in the response-header contract below together with
  // X-Frame-Options, while the meta policy preserves the useful early guards.
  const pageCsp = `default-src 'none'; base-uri 'none'; form-action 'self'; img-src 'self' https://media.clinicaclick.com${runtimeImageSources}; style-src 'self'${runtimeStyleSources}; script-src 'sha256-${jsonLdCspHash}'${measurementOrigin ? ` ${measurementOrigin}` : ''}; connect-src 'self'${measurementOrigin ? ` ${measurementOrigin}` : ''}; font-src 'self'; manifest-src 'self';${runtimeFrameSources} upgrade-insecure-requests`;
  const publicationBasePath = new URL(`${baseUrl}/`).pathname;
  const favicon = faviconDataUrl(clinic.name || project.name);
  const socialImageTags = safeSocialUrl
    ? `<meta property="og:image" content="${escapeHtml(safeSocialUrl)}"><meta property="og:image:alt" content="${escapeHtml(socialImageAlt)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${escapeHtml(safeSocialUrl)}"><meta name="twitter:image:alt" content="${escapeHtml(socialImageAlt)}">`
    : '<meta name="twitter:card" content="summary">';
  const html = `<!doctype html><html lang="${escapeHtml(project.locale)}"><head><meta charset="utf-8"><meta name="clinicaclick-artifact-input" content="${escapeHtml(artifactMarker)}"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(pageCsp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/svg+xml" href="${escapeHtml(favicon)}"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="${robots}"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="website"><meta property="og:site_name" content="${escapeHtml(project.name)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}">${socialImageTags}<meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><link rel="stylesheet" href="${escapeHtml(`${baseUrl}/${cssFile}`)}"><script type="application/ld+json">${jsonLdText}</script>${measurementLoaderTag(context.measurement, { projectId: project.id, revisionId: context.revisionId, pageId: page.id, artifactMarker })}</head><body data-cc-web-project-id="${escapeHtml(project.id)}" data-cc-web-revision-id="${escapeHtml(context.revisionId)}" data-cc-web-artifact-input-hash="${escapeHtml(artifactMarker)}" data-cc-web-base-path="${escapeHtml(publicationBasePath)}">${header}${body}${footer}</body></html>`;
  return {
    path: page.slug === 'inicio' ? '/' : `/${page.slug}/`,
    html,
    html_hash: sha256(html),
    canonical,
    robots,
    json_ld: jsonLd,
    json_ld_csp_hash: jsonLdCspHash,
    seo_audit: pageSeoAudit(page, document),
  };
}

function sitemapXml(baseUrl, pages) {
  const publicationOrigin = new URL(`${baseUrl}/`).origin;
  const urls = pages
    .filter((page) => page.robots.startsWith('index') && new URL(page.canonical).origin === publicationOrigin)
    .map((page) => `<url><loc>${escapeXml(page.canonical)}</loc></url>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

function compileWebArtifact(input = {}) {
  const documentValidation = assertValidWebDocument(input.document);
  const snapshot = assertWebContentSnapshot(input.contentSnapshot || {
    schema_version: 1,
    content_entries: {},
    media_assets: {},
    live_bindings: [],
  });
  const project = {
    id: String(input.project?.id || '').trim(),
    name: String(input.project?.name || '').normalize('NFC').trim().slice(0, 191),
    locale: String(input.project?.locale || 'es-ES').trim(),
  };
  const revisionId = String(input.revisionId || '').trim();
  if (!project.id || !project.name || !revisionId) {
    fail('web_artifact_identity_required', 'Proyecto y revisión son obligatorios para compilar.');
  }
  const environment = input.environment === 'production' ? 'production' : 'preview';
  const baseUrl = safeAbsoluteBaseUrl(input.baseUrl);
  const runtime = trustedRuntime(input.trustedRuntime, { environment });
  const clinic = normalizeClinicSnapshot(input.clinicSnapshot);
  const clinicSnapshotHash = sha256(canonicalSerialize(clinic));
  assertClinicBindingsFrozen(input.document, snapshot, clinic);
  assertIntakeConfigFrozen(input.document, snapshot);
  const document = validateBoundDocument(applyBindings(input.document, snapshot, clinic));
  const siteConfiguration = assertDocumentRuntimeCoherence(document, snapshot, runtime, environment, baseUrl);
  const intakeEndpoint = safeIntakeEndpoint(
    input.intakeEndpoint || (environment === 'production' ? PRODUCTION_INTAKE_ENDPOINT : '/api/intake/web'),
    environment
  );
  const css = stylesheet(document.design_system.tokens, document);
  const cssHash = sha256(css);
  const cssFile = `assets/styles.${cssHash.slice(0, 16)}.css`;
  const pageById = new Map(document.pages.map((page) => [page.id, page]));
  const context = {
    environment,
    intakeEndpoint,
    pageById,
    pages: document.pages,
    projectId: project.id,
    revisionId,
    baseUrl,
    measurement: runtime.measurement,
    siteConfiguration,
  };
  const artifactMarker = sha256(canonicalSerialize({
    renderer_version: input.rendererVersion || RENDERER_VERSION,
    project_id: project.id,
    revision_id: revisionId,
    environment,
    base_url: baseUrl,
    intake_endpoint: intakeEndpoint,
    runtime_config_hash: runtime.runtime_config_hash,
    document_hash: documentValidation.hash,
    content_snapshot_hash: sha256(canonicalSerialize(snapshot)),
    clinic_snapshot_hash: clinicSnapshotHash,
  }));
  const pages = document.pages.map((page) => renderPage({
    page,
    document,
    snapshot,
    context,
    project,
    baseUrl,
    clinic,
    cssFile,
    artifactMarker,
  }));
  const scriptHashes = [...new Set(pages.map((page) => `'sha256-${page.json_ld_csp_hash}'`))].sort();
  const measurementOrigin = runtime.measurement.enabled ? runtime.measurement.api_url : null;
  const runtimeImageSources = `${measurementOrigin ? ` ${measurementOrigin}` : ''} data:`;
  const runtimeStyleSources = measurementOrigin ? " 'unsafe-inline'" : '';
  const runtimeFrameSources = videoFrameCspDirective(document);
  const headers = {
    'content-security-policy': `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' https://media.clinicaclick.com${runtimeImageSources}; style-src 'self'${runtimeStyleSources}; script-src ${scriptHashes.join(' ')}${measurementOrigin ? ` ${measurementOrigin}` : ''}; connect-src 'self'${measurementOrigin ? ` ${measurementOrigin}` : ''}; font-src 'self'; manifest-src 'self';${runtimeFrameSources} upgrade-insecure-requests`,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-site',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
  const robots = environment === 'production'
    ? `User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  const sitemap = sitemapXml(baseUrl, pages);
  const intakeFormOccurrences = new Map();
  for (const page of document.pages) {
    const pagePath = page.slug === 'inicio' ? '/' : `/${page.slug}/`;
    for (const form of intakeFormsForPage(page, document)) {
      const contract = {
        page_path: pagePath,
        page_id: page.id,
        success_anchor: `cc-${form.id}-success`,
        error_anchor: `cc-${form.id}-error`,
        fields: form.props.fields.map((field) => ({
          name: field.name,
          type: field.type,
          required: field.required === true,
        })),
      };
      intakeFormOccurrences.set(form.id, [
        ...(intakeFormOccurrences.get(form.id) || []),
        contract,
      ]);
    }
  }
  const intakeForms = Object.fromEntries([...intakeFormOccurrences.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([formId, contracts]) => (
      contracts.length === 1
        ? [formId, contracts[0]]
        : [formId, {
            scope: 'global',
            page_contracts: Object.fromEntries(contracts
              .sort((left, right) => left.page_id.localeCompare(right.page_id))
              .map((contract) => [contract.page_id, contract])),
          }]
    )));
  const manifestCore = {
    schema_version: 1,
    renderer_version: input.rendererVersion || RENDERER_VERSION,
    project_id: project.id,
    revision_id: revisionId,
    environment,
    base_url: baseUrl,
    runtime_config_hash: runtime.runtime_config_hash,
    document_hash: documentValidation.hash,
    content_snapshot_hash: sha256(canonicalSerialize(snapshot)),
    clinic_snapshot_hash: clinicSnapshotHash,
    artifact_input_hash: artifactMarker,
    page_routes: Object.fromEntries(document.pages.map((page) => [page.id, {
      page_path: page.slug === 'inicio' ? '/' : `/${page.slug}/`,
    }])),
    intake_forms: intakeForms,
    site_configuration: siteConfiguration,
    files: {
      [cssFile]: { sha256: cssHash, content_type: 'text/css; charset=utf-8', size_bytes: Buffer.byteLength(css) },
      'robots.txt': { sha256: sha256(robots), content_type: 'text/plain; charset=utf-8', size_bytes: Buffer.byteLength(robots) },
      'sitemap.xml': { sha256: sha256(sitemap), content_type: 'application/xml; charset=utf-8', size_bytes: Buffer.byteLength(sitemap) },
      ...Object.fromEntries(pages.map((page) => {
        const file = page.path === '/' ? 'index.html' : `${page.path.slice(1)}index.html`;
        return [file, {
          sha256: page.html_hash,
          content_type: 'text/html; charset=utf-8',
          size_bytes: Buffer.byteLength(page.html),
        }];
      })),
    },
    headers,
  };
  const artifactHash = sha256(canonicalSerialize(manifestCore));
  const manifest = { ...manifestCore, artifact_hash: artifactHash };
  const bundleSizeBytes = webArtifactBundleFootprintBytes(manifest);
  if (bundleSizeBytes === null || bundleSizeBytes > MAX_WEB_ARTIFACT_BUNDLE_BYTES) {
    fail(
      'web_artifact_bundle_too_large',
      'La web generada supera el tamaño máximo publicable.',
      {
        size_bytes: bundleSizeBytes,
        max_size_bytes: MAX_WEB_ARTIFACT_BUNDLE_BYTES,
      }
    );
  }
  return {
    artifact_hash: artifactHash,
    manifest,
    files: {
      [cssFile]: css,
      'robots.txt': robots,
      'sitemap.xml': sitemap,
      ...Object.fromEntries(pages.map((page) => [
        page.path === '/' ? 'index.html' : `${page.path.slice(1)}index.html`,
        page.html,
      ])),
    },
    pages: pages.map(({ html, json_ld_csp_hash, ...page }) => page),
    qa: {
      deterministic: true,
      executable_user_code: false,
      inline_event_handlers: false,
      page_count: pages.length,
      warnings: pages.flatMap((page) => page.seo_audit.warnings.map((warning) => ({
        page_path: page.path,
        ...warning,
      }))),
    },
  };
}

module.exports = {
  CLINIC_BINDING_FIELDS,
  RENDERER_VERSION,
  WebArtifactCompilationError,
  assertClinicBindingsFrozen,
  assertIntakeConfigFrozen,
  assertDocumentRuntimeCoherence,
  applyBindings,
  compileWebArtifact,
  escapeHtml,
  faviconDataUrl,
  normalizeClinicSnapshot,
  normalizeGoogleOpeningHours,
  pageSeoAudit,
  safeAbsoluteBaseUrl,
  safePublicButtonUrl,
  sha256,
  stableJson,
};
