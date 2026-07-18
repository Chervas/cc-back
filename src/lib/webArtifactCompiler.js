'use strict';

const crypto = require('node:crypto');
const {
  assertValidWebDocument,
  canonicalSerialize,
} = require('./webDocument');
const { assertWebContentSnapshot, isSafePublicAssetUrl } = require('./webContent');
const { trustedRuntime } = require('./webMeasurementRuntime');
const { publicHttpUrl } = require('./safeHttpTarget');

const RENDERER_VERSION = 'clinicaclick-web-renderer/1.2.1';
const SAFE_EXTERNAL_REL = /^(?:\/[A-Za-z0-9_][A-Za-z0-9/_-]*|https:\/\/[^\s]+)$/;
const PRODUCTION_INTAKE_ENDPOINT = '/_clinicaclick/intake';
const CLINIC_BINDING_FIELDS = new Set([
  'name',
  'address',
  'phone',
  'email',
  'website',
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
    if (field === 'website' || field === 'booking_url') {
      const safeUrl = publicHttpUrl(text, { requireHttps: true });
      if (!safeUrl) {
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
    if (node?.type !== 'button') continue;
    if (node.props.action === 'external_url') {
      node.props.target = safePublicButtonUrl(node.props.target, node.id);
    } else if (node.props.action === 'phone' || node.props.action === 'whatsapp') {
      node.props.target = safePhoneTarget(node.props.target, node.id);
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

function imageClassList(node) {
  const fit = node.props.fit === 'contain' ? 'contain' : 'cover';
  const aspect = String(node.props.aspect_ratio || 'auto').replace(':', '-');
  const focalX = Number.isInteger(node.props.focal_x) ? node.props.focal_x : 50;
  const focalY = Number.isInteger(node.props.focal_y) ? node.props.focal_y : 50;
  return `cc-fit-${fit} cc-aspect-${aspect} cc-focal-${focalX}-${focalY}`;
}

function renderImage(node, snapshot) {
  const media = snapshot.media_assets?.[node.props.asset_id];
  if (!media) fail('web_artifact_media_unresolved', 'La revisión referencia una imagen no congelada.', {
    node_id: node.id,
    media_id: node.props.asset_id,
  });
  const variants = Array.isArray(media.variants) ? media.variants : [];
  const original = variants.find((item) => item.key === 'original') || variants[0];
  const source = original?.url || media.public_media?.url;
  if (!isSafePublicAssetUrl(source)) {
    fail('web_artifact_media_url_invalid', 'La imagen no tiene una URL pública estable.', { node_id: node.id });
  }
  const width = Number(original?.width || media.metadata?.width || 0);
  const height = Number(original?.height || media.metadata?.height || 0);
  const dimensions = width > 0 && height > 0
    ? ` width="${width}" height="${height}"`
    : '';
  const loading = node.props.loading === 'eager' ? 'eager' : 'lazy';
  const fetchPriority = loading === 'eager' ? ' fetchpriority="high"' : '';
  const alt = node.props.decorative ? '' : node.props.alt;
  const caption = node.props.caption
    ? `<figcaption>${escapeHtml(node.props.caption)}</figcaption>`
    : '';
  return `<figure id="cc-${escapeHtml(node.id)}" class="cc-node cc-image ${imageClassList(node)} ${styleClassList(node)}"><div class="cc-image-frame"><img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}" loading="${loading}" decoding="async"${fetchPriority}${dimensions}></div>${caption}</figure>`;
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
  return page.slug === 'inicio' ? `${context.baseUrl}/` : `${context.baseUrl}/${page.slug}/`;
}

function renderIntakeForm(node, context) {
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
      const options = (field.options || []).map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
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
  return `<form id="cc-${escapeHtml(node.id)}" class="cc-node cc-form ${styleClassList(node)}" action="${escapeHtml(context.intakeEndpoint)}" method="post" enctype="application/x-www-form-urlencoded" accept-charset="UTF-8" data-cc-native-intake="true"><h2>${escapeHtml(node.props.title)}</h2>${node.props.description ? `<p>${escapeHtml(node.props.description)}</p>` : ''}<input type="hidden" name="web_project_id" value="${escapeHtml(context.projectId)}"><input type="hidden" name="web_revision_id" value="${escapeHtml(context.revisionId)}"><input type="hidden" name="web_page_id" value="${escapeHtml(context.page.id)}"><input type="hidden" name="web_form_id" value="${escapeHtml(node.id)}"><input class="cc-honeypot" type="text" name="_cc_company" value="" tabindex="-1" autocomplete="off" aria-hidden="true">${fields}<button type="submit" class="cc-button cc-button-primary">${escapeHtml(node.props.submit_label)}</button><p id="${escapeHtml(successId)}" class="cc-form-status cc-form-success" role="status">${escapeHtml(node.props.success_message)}</p><p id="${escapeHtml(errorId)}" class="cc-form-status cc-form-error" role="alert">No hemos podido enviar el formulario. Inténtalo de nuevo en unos minutos.</p></form>`;
}

function renderNode(nodeId, document, snapshot, context, ancestors = new Set()) {
  const node = document.nodes[nodeId];
  if (!node) fail('web_artifact_node_missing', 'La revisión contiene una referencia de bloque rota.', { node_id: nodeId });
  if (ancestors.has(nodeId)) fail('web_artifact_node_cycle', 'La revisión contiene un ciclo de bloques.', { node_id: nodeId });
  const nextAncestors = new Set(ancestors).add(nodeId);
  if (node.type === 'section') {
    const tag = node.props.semantic_tag || 'section';
    const children = node.children.map((childId) => renderNode(childId, document, snapshot, context, nextAncestors)).join('');
    return `<${tag} id="cc-${escapeHtml(node.id)}" class="cc-node cc-section cc-layout-${escapeHtml(node.props.layout)} cc-cols-${Number(node.props.columns)} ${styleClassList(node)}"><div class="cc-container">${children}</div></${tag}>`;
  }
  if (node.type === 'heading') {
    const level = Math.min(6, Math.max(1, Number(node.props.level) || 2));
    return `<h${level} id="cc-${escapeHtml(node.id)}" class="cc-node cc-heading cc-size-${escapeHtml(node.props.size || 'lg')} cc-text-${escapeHtml(node.props.align || 'left')} cc-tone-${escapeHtml(node.props.tone || 'default')} ${styleClassList(node)}">${escapeHtml(node.props.text)}</h${level}>`;
  }
  if (node.type === 'text') {
    return `<p id="cc-${escapeHtml(node.id)}" class="cc-node cc-text cc-size-${escapeHtml(node.props.size || 'md')} cc-text-${escapeHtml(node.props.align || 'left')} cc-tone-${escapeHtml(node.props.tone || 'default')} ${styleClassList(node)}">${escapeHtml(node.props.text)}</p>`;
  }
  if (node.type === 'faq') {
    return `<details id="cc-${escapeHtml(node.id)}" class="cc-node cc-faq ${styleClassList(node)}"><summary>${escapeHtml(node.props.question)}</summary><p>${escapeHtml(node.props.answer)}</p></details>`;
  }
  if (node.type === 'image') return renderImage(node, snapshot);
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

function fontStackCss(token) {
  return {
    system: 'ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    inter: 'Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    manrope: 'Manrope,Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    source_sans_3: '"Source Sans 3",Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  }[token] || 'ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
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
  const responsiveRules = (breakpoint) => (
    `.cc-node.cc-hide-${breakpoint}{display:none!important}`
    + spacingRules(`${breakpoint}-`)
    + alignRules(`${breakpoint}-`)
    + columnRules(`${breakpoint}-`)
  );
  const focalRules = [...new Set(Object.values(document.nodes || {})
    .filter((node) => node?.type === 'image')
    .map((node) => `${Number.isInteger(node.props?.focal_x) ? node.props.focal_x : 50}-${Number.isInteger(node.props?.focal_y) ? node.props.focal_y : 50}`))]
    .sort((left, right) => left.localeCompare(right))
    .map((pair) => {
      const [x, y] = pair.split('-');
      return `.cc-focal-${pair} img{object-position:${x}% ${y}%}`;
    }).join('');
  return [
    `:root{--cc-primary:${tokens.color_primary};--cc-secondary:${tokens.color_secondary};--cc-accent:${tokens.color_accent};--cc-surface:${tokens.color_surface};--cc-text:${tokens.color_text};--cc-radius:${radius};--cc-font-heading:${fontStackCss(tokens.font_heading)};--cc-font-body:${fontStackCss(tokens.font_body)};--cc-sm:${density.sm};--cc-md:${density.md};--cc-lg:${density.lg};--cc-xl:${density.xl};--cc-2xl:${density.xxl};color-scheme:light}`,
    '*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--cc-surface);color:var(--cc-text);font-family:var(--cc-font-body);line-height:1.55}img{display:block;max-width:100%}',
    '.cc-node{min-width:0}.cc-container{margin-inline:auto;display:inherit;flex-direction:inherit;flex-wrap:inherit;gap:inherit}.cc-section{display:flex;width:100%}.cc-layout-stack>.cc-container{display:flex;flex-direction:column}.cc-layout-row>.cc-container{display:flex;flex-direction:row;flex-wrap:wrap}.cc-layout-grid>.cc-container{display:grid}',
    columnRules(),
    '.cc-section.cc-width-narrow>.cc-container{width:min(100% - 2rem,48rem)}.cc-section.cc-width-standard>.cc-container{width:min(100% - 2rem,72rem)}.cc-section.cc-width-wide>.cc-container{width:min(100% - 2rem,82.5rem)}.cc-section.cc-width-full>.cc-container{width:100%;padding-inline:1rem}.cc-node.cc-width-narrow:not(.cc-section){width:min(100%,48rem)}.cc-node.cc-width-standard:not(.cc-section){width:min(100%,72rem)}.cc-node.cc-width-wide:not(.cc-section){width:min(100%,82.5rem)}.cc-node.cc-width-full:not(.cc-section){width:100%}',
    spacingRules(),
    alignRules(),
    '.cc-node.cc-bg-transparent{background:transparent}.cc-node.cc-bg-surface{background:var(--cc-surface)}.cc-node.cc-bg-muted{background:#f5f6fa}.cc-node.cc-bg-brand{background:var(--cc-primary)}.cc-node.cc-bg-accent{background:var(--cc-accent)}.cc-node.cc-fg-default{color:var(--cc-text)}.cc-node.cc-fg-muted,.cc-tone-muted{color:#64748b}.cc-node.cc-fg-inverse,.cc-tone-inverse{color:#fff}.cc-node.cc-fg-brand,.cc-tone-brand{color:var(--cc-primary)}.cc-node.cc-fg-accent,.cc-tone-accent{color:var(--cc-accent)}.cc-tone-default{color:var(--cc-text)}',
    '.cc-node.cc-radius-inherit{border-radius:var(--cc-radius)}.cc-node.cc-radius-none{border-radius:0}.cc-node.cc-radius-sm{border-radius:.25rem}.cc-node.cc-radius-md{border-radius:.5rem}.cc-node.cc-radius-lg{border-radius:.9rem}.cc-node.cc-radius-xl{border-radius:1.35rem}.cc-node.cc-radius-full{border-radius:9999px}.cc-node.cc-shadow-none{box-shadow:none}.cc-node.cc-shadow-sm{box-shadow:0 2px 8px #181d3514}.cc-node.cc-shadow-md{box-shadow:0 8px 24px #181d3521}.cc-node.cc-shadow-lg{box-shadow:0 18px 50px #181d3529}',
    '.cc-heading{margin:0;font-family:var(--cc-font-heading);line-height:1.12;letter-spacing:-.025em}.cc-heading.cc-size-sm{font-size:1.25rem}.cc-heading.cc-size-md{font-size:1.5rem}.cc-heading.cc-size-lg{font-size:1.875rem}.cc-heading.cc-size-xl{font-size:clamp(1.55rem,3vw,2.35rem)}.cc-heading.cc-size-2xl{font-size:clamp(1.9rem,4vw,3.2rem)}.cc-heading.cc-size-3xl{font-size:clamp(2.25rem,6vw,4.5rem)}.cc-text{margin:0;max-width:68ch;white-space:pre-wrap}.cc-text.cc-size-sm{font-size:.875rem}.cc-text.cc-size-md{font-size:1rem}.cc-text.cc-size-lg{font-size:1.125rem}.cc-text-left{text-align:left}.cc-text-center{text-align:center}.cc-text-right{text-align:right}',
    '.cc-button{display:inline-flex;width:fit-content;align-items:center;justify-content:center;min-height:44px;padding:.75rem 1.15rem;border-radius:var(--cc-radius);font-weight:700;text-decoration:none;border:1px solid transparent;cursor:pointer}.cc-button-primary{background:var(--cc-primary);color:#fff}.cc-section.cc-bg-brand .cc-button-primary{background:var(--cc-surface);color:var(--cc-primary)}.cc-button-secondary{background:var(--cc-secondary);color:#fff}.cc-button-outline{border-color:currentColor;color:var(--cc-primary);background:transparent}.cc-button-link{padding-inline:0;color:var(--cc-primary)}',
    '.cc-form{display:grid;gap:var(--cc-md);padding:var(--cc-xl);border:1px solid #dfe3ec;border-radius:var(--cc-radius);background:#fff}.cc-field{display:grid;gap:.35rem}.cc-field input:not([type=checkbox]),.cc-field textarea,.cc-field select{width:100%;min-height:44px;border:1px solid #aab1c2;border-radius:.5rem;padding:.7rem;font:inherit}.cc-checkbox{grid-template-columns:auto 1fr;align-items:start}.cc-honeypot{position:absolute!important;left:-10000px!important;width:1px!important;height:1px!important;overflow:hidden!important}.cc-form-status{display:none;padding:.75rem;border-radius:.5rem}.cc-form-success{background:#e9f8f1;color:#145c3d}.cc-form-error{background:#fff1f1;color:#8b1f1f}.cc-form-status:target{display:block}',
    '.cc-image{margin:0}.cc-image-frame{overflow:hidden;border-radius:inherit;background:#eef1f6}.cc-image img{width:100%;height:100%;object-fit:cover}.cc-fit-contain img{object-fit:contain}.cc-aspect-auto .cc-image-frame img{height:auto}.cc-aspect-1-1 .cc-image-frame{aspect-ratio:1/1}.cc-aspect-4-3 .cc-image-frame{aspect-ratio:4/3}.cc-aspect-3-2 .cc-image-frame{aspect-ratio:3/2}.cc-aspect-16-9 .cc-image-frame{aspect-ratio:16/9}.cc-aspect-21-9 .cc-image-frame{aspect-ratio:21/9}.cc-image figcaption{padding-top:.5rem;color:#64748b;font-size:.8125rem}',
    focalRules,
    '.cc-faq{border:1px solid #dfe3ec;background:#fff;padding:var(--cc-md);border-radius:var(--cc-radius)}.cc-faq summary{cursor:pointer;font-family:var(--cc-font-heading);font-weight:700}.cc-faq p{margin:var(--cc-sm) 0 0;white-space:pre-wrap}',
    `@media(max-width:767px){.cc-layout-row>.cc-container{flex-direction:column}.cc-layout-grid>.cc-container{grid-template-columns:1fr}.cc-form{padding:var(--cc-lg)}.cc-button{width:100%}${responsiveRules('mobile')}}`,
    `@media(min-width:768px) and (max-width:1023px){${responsiveRules('tablet')}}`,
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

function reachableNodeIds(page, document) {
  const reachable = new Set();
  const pending = [...(page.root_node_ids || [])];
  while (pending.length) {
    const nodeId = pending.pop();
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    pending.push(...(document.nodes[nodeId]?.children || []));
  }
  return reachable;
}

function buildStructuredData({ project, page, baseUrl, clinic, document }) {
  const root = `${baseUrl}/#website`;
  const pageUrl = page.slug === 'inicio' ? `${baseUrl}/` : `${baseUrl}/${page.slug}/`;
  const organizationId = `${baseUrl}/#organization`;
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
    ...(clinic.schema_type === 'Dentist' ? { medicalSpecialty: 'Dentistry' } : {}),
  }, {
    '@type': 'WebPage',
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
  if (faqEntries.length) {
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
  const pending = [...page.root_node_ids];
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
  return `<script src="${escapeHtml(measurement.loader_url)}" ${scopeAttribute} data-api-url="${escapeHtml(measurement.api_url)}" data-event-bridge-url="/_clinicaclick/events" data-web-project-id="${escapeHtml(identity.projectId)}" data-web-revision-id="${escapeHtml(identity.revisionId)}" data-web-page-id="${escapeHtml(identity.pageId)}" data-consent-mode-enabled="${measurement.consent_mode_enabled ? 'true' : 'false'}" data-consent-provider="${escapeHtml(measurement.consent_provider)}" async></script>`;
}

function renderPage({ page, document, snapshot, context, project, baseUrl, clinic, cssFile, artifactMarker }) {
  const body = page.root_node_ids.map((nodeId) => renderNode(nodeId, document, snapshot, { ...context, page })).join('');
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
  const jsonLd = buildStructuredData({ project, page, baseUrl, clinic, document });
  const jsonLdText = stableJson(jsonLd);
  const jsonLdCspHash = sha256(jsonLdText, 'base64');
  const measurementOrigin = context.measurement.enabled ? context.measurement.api_url : null;
  // The public measurement runtime builds the consent/chat UI at runtime. It
  // injects scoped CSS and may use a public brand image served by the trusted
  // measurement origin. Keep the stricter static-site policy when measurement
  // is disabled, and open only those two directives when the trusted runtime
  // is embedded.
  const runtimeImageSources = measurementOrigin ? ` ${measurementOrigin} data:` : '';
  const runtimeStyleSources = measurementOrigin ? " 'unsafe-inline'" : '';
  const pageCsp = `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' https://media.clinicaclick.com${runtimeImageSources}; style-src 'self'${runtimeStyleSources}; script-src 'sha256-${jsonLdCspHash}'${measurementOrigin ? ` ${measurementOrigin}` : ''}; connect-src 'self'${measurementOrigin ? ` ${measurementOrigin}` : ''}; font-src 'self'; manifest-src 'self'; upgrade-insecure-requests`;
  const socialId = page.seo?.social_asset_id || document.seo.default_social_asset_id;
  const social = socialId ? snapshot.media_assets?.[socialId] : null;
  const socialUrl = social?.variants?.[0]?.url || social?.public_media?.url || null;
  const publicationBasePath = new URL(`${baseUrl}/`).pathname;
  const html = `<!doctype html><html lang="${escapeHtml(project.locale)}"><head><meta charset="utf-8"><meta name="clinicaclick-artifact-input" content="${escapeHtml(artifactMarker)}"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(pageCsp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="${robots}"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(pageUrl)}">${socialUrl && isSafePublicAssetUrl(socialUrl) ? `<meta property="og:image" content="${escapeHtml(socialUrl)}">` : ''}<link rel="stylesheet" href="${escapeHtml(`${baseUrl}/${cssFile}`)}"><script type="application/ld+json">${jsonLdText}</script>${measurementLoaderTag(context.measurement, { projectId: project.id, revisionId: context.revisionId, pageId: page.id })}</head><body data-cc-web-project-id="${escapeHtml(project.id)}" data-cc-web-revision-id="${escapeHtml(context.revisionId)}" data-cc-web-base-path="${escapeHtml(publicationBasePath)}">${body}</body></html>`;
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
  const urls = pages
    .filter((page) => page.robots.startsWith('index'))
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
  const runtimeImageSources = measurementOrigin ? ` ${measurementOrigin} data:` : '';
  const runtimeStyleSources = measurementOrigin ? " 'unsafe-inline'" : '';
  const headers = {
    'content-security-policy': `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' https://media.clinicaclick.com${runtimeImageSources}; style-src 'self'${runtimeStyleSources}; script-src ${scriptHashes.join(' ')}${measurementOrigin ? ` ${measurementOrigin}` : ''}; connect-src 'self'${measurementOrigin ? ` ${measurementOrigin}` : ''}; font-src 'self'; manifest-src 'self'; upgrade-insecure-requests`,
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
  const intakeForms = Object.fromEntries(document.pages.flatMap((page) => {
    const pagePath = page.slug === 'inicio' ? '/' : `/${page.slug}/`;
    return intakeFormsForPage(page, document).map((form) => [form.id, {
      page_path: pagePath,
      page_id: page.id,
      success_anchor: `cc-${form.id}-success`,
      error_anchor: `cc-${form.id}-error`,
      fields: form.props.fields.map((field) => ({
        name: field.name,
        type: field.type,
        required: field.required === true,
      })),
    }]);
  }));
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
  return {
    artifact_hash: artifactHash,
    manifest: { ...manifestCore, artifact_hash: artifactHash },
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
  normalizeClinicSnapshot,
  pageSeoAudit,
  safeAbsoluteBaseUrl,
  safePublicButtonUrl,
  sha256,
  stableJson,
};
