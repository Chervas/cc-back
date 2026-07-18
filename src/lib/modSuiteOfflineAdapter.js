'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { assertValidWebDocument } = require('./webDocument');

const ADAPTER_VERSION = 'modsuite-offline-v1';
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_DEPTH = 40;
const MAX_SOURCE_PROPERTIES = 100000;
const MAX_SECTION_CHILDREN = 50;

const LEGACY_NODE_TYPES = new Set([
  'container',
  'row',
  'col',
  'text',
  'image',
  'button',
  'contacto',
]);

const LEGACY_PAGE_TYPES = new Set([
  'pagina',
  'portada',
  'post',
  'categoria',
  'autor',
]);

const LEGACY_REVIEW_TYPES = new Set([
  'author',
  'authordescription',
  'authorname',
  'booking',
  'breadcrumbs',
  'category_list',
  'content',
  'description',
  'description_large',
  'description_short',
  'googlemaps',
  'info_accordion',
  'link_list',
  'menu',
  'name',
  'post_list',
  'reviews',
  'slider',
  'table_of_contents',
  'title',
  'video',
]);

const LEGACY_PRESENTATION_FIELDS = new Set([
  'animation',
  'animation_retard',
  'button_image',
  'button_image_position',
  'button_image_url',
  'button_style',
  'class',
  'class_laptop_scrollable',
  'class_mobile_scrollable',
  'class_tablet_scrollable',
  'columnClass',
  'containerClass',
  'editorBreadCSS',
  'editorCSS',
  'firstCSS',
  'htmlTagDiv',
  'max_width',
  'mouseOverCss',
  'rowClass',
  'stylesAll',
  'stylesAMP',
  'stylesLaptop',
  'stylesMobile',
  'stylesTablet',
  'text_style',
]);

const LEGACY_EXECUTABLE_FIELDS = new Set([
  'css',
  'customcss',
  'customhtml',
  'customjs',
  'customschemas',
  'headhtml',
  'html',
  'iframe',
  'javascript',
  'rawcss',
  'rawhtml',
  'schema',
  'schemamarkup',
  'script',
  'scripts',
  'srcdoc',
]);

const DANGEROUS_BLOCK_PATTERN = /<(script|style|noscript|template|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const UNCLOSED_DANGEROUS_BLOCK_PATTERN = /<(script|style|noscript|template|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*$/gi;
const MARKUP_PATTERN = /<[^>]*>/g;
const CODE_TEXT_PATTERNS = [
  /\b(?:java|vb)script\s*:/gi,
  /\bdata\s*:\s*text\/html/gi,
  /\bon[a-z]+\s*=/gi,
  /(?:^|\s)[.#][A-Za-z_-][\w-]*\s*\{[^{}]*\}/g,
  /@(?:import|font-face|keyframes|media|supports)\b[^{};]*(?:;|\{[^{}]*\})/gi,
];

class ModSuiteOfflineAdapterError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ModSuiteOfflineAdapterError';
    this.code = code;
    this.details = details;
  }
}

function normalizeLegacyType(value) {
  return String(value || '').trim().toLowerCase();
}

function stableSerializeLegacy(value) {
  const state = {
    active: new WeakSet(),
    properties: 0,
  };

  const visit = (entry, depth) => {
    if (depth > MAX_SOURCE_DEPTH) {
      throw new ModSuiteOfflineAdapterError(
        'legacy_source_too_deep',
        `El JSON legacy supera ${MAX_SOURCE_DEPTH} niveles.`
      );
    }
    if (entry === null) return 'null';
    if (typeof entry === 'string') return JSON.stringify(entry.normalize('NFC'));
    if (typeof entry === 'boolean') return entry ? 'true' : 'false';
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) {
        throw new ModSuiteOfflineAdapterError('legacy_source_not_json', 'El origen contiene un número no JSON.');
      }
      return JSON.stringify(Object.is(entry, -0) ? 0 : entry);
    }
    if (typeof entry !== 'object') {
      throw new ModSuiteOfflineAdapterError('legacy_source_not_json', 'El origen debe contener únicamente valores JSON.');
    }
    if (state.active.has(entry)) {
      throw new ModSuiteOfflineAdapterError('legacy_source_circular', 'El origen contiene una referencia circular.');
    }
    const prototype = Object.getPrototypeOf(entry);
    if (Array.isArray(entry) && prototype !== Array.prototype) {
      throw new ModSuiteOfflineAdapterError('legacy_source_not_plain_json', 'El origen debe usar arrays JSON planos.');
    }
    if (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null) {
      throw new ModSuiteOfflineAdapterError('legacy_source_not_plain_json', 'El origen debe usar objetos JSON planos.');
    }
    state.active.add(entry);
    let serialized;
    if (Array.isArray(entry)) {
      const keys = Reflect.ownKeys(entry);
      if (keys.some((key) => typeof key !== 'string')) {
        throw new ModSuiteOfflineAdapterError('legacy_source_not_json', 'El origen contiene claves no JSON.');
      }
      const unexpectedKeys = keys.filter((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key));
      if (unexpectedKeys.length > 0) {
        throw new ModSuiteOfflineAdapterError('legacy_source_not_plain_json', 'Los arrays legacy no admiten propiedades personalizadas.');
      }
      state.properties += entry.length;
      const items = [];
      for (let index = 0; index < entry.length; index += 1) {
        if (!Object.hasOwn(entry, index)) {
          throw new ModSuiteOfflineAdapterError('legacy_source_not_plain_json', 'Los arrays legacy no pueden ser dispersos.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!descriptor || descriptor.get || descriptor.set) {
          throw new ModSuiteOfflineAdapterError('legacy_source_not_plain_json', 'El origen contiene accesores ejecutables.');
        }
        items.push(visit(descriptor.value, depth + 1));
      }
      serialized = `[${items.join(',')}]`;
    } else {
      const keys = Reflect.ownKeys(entry);
      if (keys.some((key) => typeof key !== 'string')) {
        throw new ModSuiteOfflineAdapterError('legacy_source_not_json', 'El origen contiene claves no JSON.');
      }
      state.properties += keys.length;
      const normalizedKeys = new Map();
      for (const key of keys) {
        const normalizedKey = key.normalize('NFC');
        if (normalizedKeys.has(normalizedKey)) {
          throw new ModSuiteOfflineAdapterError(
            'legacy_source_key_collision',
            'El origen contiene claves que colisionan al normalizar Unicode.'
          );
        }
        normalizedKeys.set(normalizedKey, key);
      }
      serialized = `{${[...normalizedKeys.keys()].sort().map((normalizedKey) => {
        const key = normalizedKeys.get(normalizedKey);
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (descriptor?.get || descriptor?.set) {
          throw new ModSuiteOfflineAdapterError('legacy_source_not_plain_json', 'El origen contiene accesores ejecutables.');
        }
        return `${JSON.stringify(normalizedKey)}:${visit(descriptor.value, depth + 1)}`;
      }).join(',')}}`;
    }
    state.active.delete(entry);
    if (state.properties > MAX_SOURCE_PROPERTIES) {
      throw new ModSuiteOfflineAdapterError(
        'legacy_source_too_complex',
        `El JSON legacy supera ${MAX_SOURCE_PROPERTIES} propiedades.`
      );
    }
    return serialized;
  };

  const serialized = visit(value, 0);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > MAX_SOURCE_BYTES) {
    throw new ModSuiteOfflineAdapterError(
      'legacy_source_too_large',
      `El JSON legacy supera el límite offline de ${MAX_SOURCE_BYTES} bytes.`,
      { limit_bytes: MAX_SOURCE_BYTES, source_bytes: byteLength }
    );
  }
  return serialized;
}

function unwrapLegacyEnvelope(input) {
  let current = input;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current === 'string') {
      if (Buffer.byteLength(current, 'utf8') > MAX_SOURCE_BYTES) {
        throw new ModSuiteOfflineAdapterError('legacy_source_too_large', 'La configuración JSON embebida es demasiado grande.');
      }
      try {
        current = JSON.parse(current);
      } catch {
        throw new ModSuiteOfflineAdapterError('legacy_configuration_invalid_json', 'La configuración embebida no es JSON válido.');
      }
      continue;
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      if (current.wp_cast && typeof current.wp_cast === 'object') {
        current = current.wp_cast;
        continue;
      }
      if (typeof current.configuration === 'string') {
        current = current.configuration;
        continue;
      }
    }
    return current;
  }
  throw new ModSuiteOfflineAdapterError('legacy_envelope_too_deep', 'El envoltorio de configuración legacy tiene demasiados niveles.');
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '…',
    laquo: '«',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    raquo: '»',
  };
  return String(value).replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1]?.toLowerCase() === 'x';
      const number = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!Number.isInteger(number) || number < 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) {
        return ' ';
      }
      return String.fromCodePoint(number);
    }
    return Object.hasOwn(named, entity.toLowerCase()) ? named[entity.toLowerCase()] : match;
  });
}

function sanitizeLegacyText(value, maximum = 5000) {
  if (typeof value !== 'string') {
    return { text: '', hadMarkup: false, removedDangerous: false, truncated: false };
  }
  const raw = value.normalize('NFC');
  const hadMarkup = /<[^>]*>|&(?:lt|gt|#0*60|#x0*3c);/i.test(raw);
  let decoded = decodeHtmlEntities(raw);
  let removedDangerous = false;
  const removeDangerous = (pattern) => {
    const before = decoded;
    decoded = decoded.replace(pattern, ' ');
    if (decoded !== before) removedDangerous = true;
  };
  removeDangerous(DANGEROUS_BLOCK_PATTERN);
  removeDangerous(UNCLOSED_DANGEROUS_BLOCK_PATTERN);
  decoded = decoded
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!doctype[\s\S]*?>/gi, ' ')
    .replace(/<\s*(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\s*\/(?:p|div|li|h[1-6]|section|article|blockquote)\s*>/gi, '\n')
    .replace(MARKUP_PATTERN, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  for (const pattern of CODE_TEXT_PATTERNS) removeDangerous(pattern);
  decoded = decoded
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  const truncated = decoded.length > maximum;
  return {
    text: truncated ? decoded.slice(0, maximum).trimEnd() : decoded,
    hadMarkup,
    removedDangerous,
    truncated,
  };
}

function headingLevelFromLegacyMarkup(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^\s*<h([1-6])(?:\s[^>]*)?>/i);
  return match ? Number(match[1]) : null;
}

function splitText(value, maximum = 5000) {
  const parts = [];
  let remaining = String(value || '').trim();
  while (remaining.length > maximum) {
    let boundary = remaining.lastIndexOf(' ', maximum);
    if (boundary < Math.floor(maximum * 0.7)) boundary = maximum;
    parts.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function slugify(value, fallback = 'pagina') {
  const normalized = sanitizeLegacyText(String(value || ''), 160).text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160)
    .replace(/-+$/g, '');
  return normalized || fallback;
}

function deterministicId(prefix, sourceHash, path, suffix = '') {
  const digest = crypto
    .createHash('sha256')
    .update(`${ADAPTER_VERSION}\0${sourceHash}\0${path}\0${suffix}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function hasLegacyPresentation(node) {
  if (!node || typeof node !== 'object') return false;
  return Object.keys(node).some((key) => LEGACY_PRESENTATION_FIELDS.has(key));
}

function hasLegacyExecutableMetadata(node) {
  if (!node || typeof node !== 'object') return false;
  return Object.keys(node).some((key) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return LEGACY_EXECUTABLE_FIELDS.has(normalized) || /^on[a-z]+$/.test(normalized);
  });
}

function safeSourceType(type) {
  if (LEGACY_NODE_TYPES.has(type) || LEGACY_PAGE_TYPES.has(type) || LEGACY_REVIEW_TYPES.has(type)) return type;
  return 'unsupported';
}

function addReportEntry(context, {
  path,
  sourceType,
  status,
  targetNodeIds = [],
  issues = [],
  referenceFingerprint = undefined,
}) {
  context.entries.push({
    source_path: path,
    source_type: safeSourceType(sourceType),
    status,
    target_node_ids: targetNodeIds,
    issues: Array.from(new Set(issues)).sort(),
    ...(referenceFingerprint ? { reference_fingerprint: referenceFingerprint } : {}),
  });
}

function defaultStyleTokens({ width = 'standard', gap = 'md' } = {}) {
  return {
    background: 'transparent',
    foreground: 'default',
    content_width: width,
    spacing_top: 'none',
    spacing_bottom: 'none',
    gap,
    radius: 'inherit',
    shadow: 'none',
    align: 'stretch',
  };
}

function isSensitiveQueryKey(key) {
  const normalized = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  const compact = normalized.replace(/_/g, '');
  return /(?:^|_)(?:access|api|auth|key|pass|passwd|password|secret|signature|token)(?:_|$)/.test(normalized)
    || /^(?:accesskey|accesstoken|apikey|apikeyid|authkey|authtoken|clientsecret|password|refreshtoken|secretkey|signature)$/.test(compact);
}

function publicHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const unwrappedHostname = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.port && url.port !== '443') return null;
    if (
      !unwrappedHostname
      || unwrappedHostname === 'localhost'
      || unwrappedHostname.endsWith('.localhost')
      || unwrappedHostname.endsWith('.local')
      || unwrappedHostname.endsWith('.internal')
      || unwrappedHostname.endsWith('.lan')
      || unwrappedHostname.endsWith('.home')
      || unwrappedHostname.endsWith('.corp')
      || unwrappedHostname.endsWith('.private')
      || unwrappedHostname.endsWith('.intranet')
    ) return null;
    if (!unwrappedHostname.includes('.') || net.isIP(unwrappedHostname) !== 0) return null;
    for (const key of url.searchParams.keys()) {
      if (isSensitiveQueryKey(key)) return null;
    }
    let decodedHref;
    try {
      decodedHref = decodeURIComponent(url.href);
    } catch {
      return null;
    }
    if (
      /<\s*(?:script|iframe)\b/i.test(decodedHref)
      || /\b(?:java|vb)script\s*:/i.test(decodedHref)
      || /\bdata\s*:\s*text\/html/i.test(decodedHref)
      || /\bon[a-z]+\s*=/i.test(decodedHref)
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function safeRelativeAssetReference(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(value)) return null;
  if (value.startsWith('//') || value.split('/').includes('..')) return null;
  return value;
}

function findLegacyNodes(value, path, predicate, results = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return results;
  if (predicate(value)) results.push({ node: value, path });
  if (Array.isArray(value.content)) {
    value.content.forEach((child, index) => findLegacyNodes(child, `${path}/content/${index}`, predicate, results));
  }
  return results;
}

function displayNameForLegacyPage(page, index) {
  for (const candidate of [page?.name, page?.name_block, page?.title]) {
    const text = sanitizeLegacyText(candidate, 120).text;
    if (text) return text;
  }
  return `Página ${index + 1}`;
}

function aliasesForLegacyPage(page, index) {
  const aliases = [page?.name, page?.name_block, page?.title, displayNameForLegacyPage(page, index)]
    .map((candidate) => sanitizeLegacyText(candidate, 120).text.toLocaleLowerCase('es'))
    .filter(Boolean);
  return new Set(aliases);
}

function selectLegacyPages(source, options = {}) {
  let pages;
  let header = null;
  let footer = null;
  let arrayWasCatalog = false;

  if (Array.isArray(source)) {
    const candidates = source.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
    const pageLike = candidates.filter((entry) => {
      const type = normalizeLegacyType(entry.type);
      return LEGACY_PAGE_TYPES.has(type) || /page$/i.test(String(entry.name_block || '').trim());
    });
    pages = pageLike.length > 0 ? pageLike : [{
      name: options.title || 'Página importada',
      type: 'pagina',
      content: candidates,
    }];
    arrayWasCatalog = pageLike.length > 0;
  } else if (source && typeof source === 'object') {
    if (Array.isArray(source.pages)) {
      pages = source.pages;
      header = source.header && typeof source.header === 'object' ? source.header : null;
      footer = source.footer && typeof source.footer === 'object' ? source.footer : null;
    } else if (Array.isArray(source.content)) {
      const type = normalizeLegacyType(source.type);
      pages = LEGACY_PAGE_TYPES.has(type)
        ? [source]
        : [{
          name: source.name || source.name_block || options.title || 'Página importada',
          type: 'pagina',
          content: [source],
        }];
    }
  }

  if (!Array.isArray(pages) || pages.length === 0) {
    throw new ModSuiteOfflineAdapterError('legacy_pages_missing', 'No se han encontrado páginas legacy migrables.');
  }

  const requestedNames = (options.pageNames || [])
    .map((name) => sanitizeLegacyText(name, 120).text.toLocaleLowerCase('es'))
    .filter(Boolean);
  if (requestedNames.length > 0) {
    const matchedNames = new Set();
    const matched = pages.filter((page, index) => {
      const aliases = aliasesForLegacyPage(page, index);
      const requested = requestedNames.filter((name) => aliases.has(name));
      requested.forEach((name) => matchedNames.add(name));
      return requested.length > 0;
    });
    const missing = requestedNames.filter((name) => !matchedNames.has(name));
    if (missing.length > 0) {
      throw new ModSuiteOfflineAdapterError(
        'legacy_page_selection_missing',
        'Alguna página solicitada no existe en el JSON local.',
        { missing_count: missing.length }
      );
    }
    pages = matched;
  }

  if (pages.length > 50) {
    throw new ModSuiteOfflineAdapterError('legacy_page_limit', 'La selección supera el límite de 50 páginas por documento.');
  }
  return { pages, header, footer, arrayWasCatalog };
}

function structuralNode(node, type, id, children) {
  const directColumns = type === 'row' && Array.isArray(node.content)
    ? node.content.filter((child) => normalizeLegacyType(child?.type) === 'col').length
    : 1;
  const layout = type === 'row' ? (directColumns > 1 ? 'grid' : 'row') : 'stack';
  return {
    id,
    type: 'section',
    version: 1,
    props: {
      layout,
      columns: Math.max(1, Math.min(4, directColumns || 1)),
      semantic_tag: 'section',
    },
    children,
    style_tokens: defaultStyleTokens({
      width: type === 'container' ? 'standard' : 'full',
      gap: type === 'row' ? 'sm' : 'md',
    }),
  };
}

function recognizedContactFields(node, context, path) {
  const params = node?.content && typeof node.content === 'object' && Array.isArray(node.content.params)
    ? node.content.params
    : [];
  const found = new Set();
  for (const param of params.slice(0, 30)) {
    const label = sanitizeLegacyText(param?.name ?? param?.label ?? '', 120).text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    if (/\b(?:nombre|name)\b/.test(label) && !/apellido|surname|last/.test(label)) found.add('first_name');
    if (/apellido|surname|last name/.test(label)) found.add('last_name');
    if (/correo|e-?mail/.test(label)) found.add('email');
    if (/telefono|phone|movil|mobile/.test(label)) found.add('phone');
    if (/mensaje|message|consulta|comentario/.test(label)) found.add('message');
  }
  if (!found.has('email') && !found.has('phone')) found.add('phone');
  if (!found.has('first_name')) found.add('first_name');

  const localeEs = context.locale.toLowerCase().startsWith('es');
  const catalog = {
    first_name: { type: 'text', label: localeEs ? 'Nombre' : 'First name', autocomplete: 'given-name' },
    last_name: { type: 'text', label: localeEs ? 'Apellidos' : 'Last name', autocomplete: 'family-name' },
    email: { type: 'email', label: localeEs ? 'Email' : 'Email', autocomplete: 'email' },
    phone: { type: 'tel', label: localeEs ? 'Teléfono' : 'Phone', autocomplete: 'tel' },
    message: { type: 'textarea', label: localeEs ? '¿Cómo podemos ayudarte?' : 'How can we help?', autocomplete: 'off' },
  };
  const order = ['first_name', 'last_name', 'email', 'phone', 'message'];
  const fields = order.filter((name) => found.has(name)).map((name, index) => ({
    id: deterministicId('field', context.sourceHash, path, `${name}:${index}`),
    name,
    type: catalog[name].type,
    label: catalog[name].label,
    required: name === 'first_name' || name === 'email' || name === 'phone',
    autocomplete: catalog[name].autocomplete,
  }));
  fields.push({
    id: deterministicId('field', context.sourceHash, path, 'privacy_consent'),
    name: 'privacy_consent',
    type: 'checkbox',
    label: localeEs ? 'Acepto la política de privacidad' : 'I accept the privacy policy',
    required: true,
    autocomplete: 'off',
  });
  return fields;
}

function classifyButtonTarget(rawTarget, context, pageContext) {
  if (typeof rawTarget !== 'string' || rawTarget.trim() === '') return null;
  const target = rawTarget.trim();
  const https = publicHttpsUrl(target);
  if (https) {
    try {
      const url = new URL(https);
      const whatsappMatch = url.hostname.toLowerCase() === 'wa.me'
        ? url.pathname.match(/^\/(\d{8,15})\/?$/)
        : null;
      if (whatsappMatch) return { action: 'whatsapp', target: `+${whatsappMatch[1]}` };
    } catch {
      return null;
    }
    return { action: 'external_url', target: https };
  }
  const phone = target.match(/^tel:(\+[1-9][0-9]{7,14})$/i);
  if (phone) return { action: 'phone', target: phone[1] };
  const whatsapp = target.match(/^whatsapp:(\+[1-9][0-9]{7,14})$/i);
  if (whatsapp) return { action: 'whatsapp', target: whatsapp[1] };
  if (/^#(?:contacto|contact|formulario|form)$/i.test(target) && pageContext.primaryFormId) {
    return { action: 'intake_form_anchor', target: pageContext.primaryFormId };
  }
  if (/^\/[A-Za-z0-9][A-Za-z0-9/-]*\/?$/.test(target) && !target.includes('..')) {
    const slug = target.replace(/^\/+|\/+$/g, '').split('/').pop();
    const pageId = context.pageIdsBySlug.get(slug);
    if (pageId) return { action: 'internal_page', target: pageId };
  }
  return null;
}

function mapLegacyNode(node, path, context, pageContext) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    addReportEntry(context, {
      path,
      sourceType: 'unsupported',
      status: 'omitido',
      issues: ['legacy_node_not_object'],
    });
    return [];
  }
  const type = normalizeLegacyType(node.type);
  const presentationDiscarded = hasLegacyPresentation(node);
  const executableMetadataDiscarded = hasLegacyExecutableMetadata(node);

  if (!LEGACY_NODE_TYPES.has(type)) {
    const childIds = Array.isArray(node.content)
      ? node.content.flatMap((child, index) => mapLegacyNode(child, `${path}/content/${index}`, context, pageContext))
      : [];
    const needsReview = LEGACY_REVIEW_TYPES.has(type);
    addReportEntry(context, {
      path,
      sourceType: type,
      status: needsReview ? 'requiere_revision' : 'omitido',
      targetNodeIds: childIds,
      issues: [
        needsReview ? 'native_equivalent_not_available' : 'legacy_node_type_not_allowlisted',
        ...(childIds.length > 0 ? ['wrapper_omitted_children_retained'] : []),
        ...(executableMetadataDiscarded ? ['legacy_executable_metadata_discarded'] : []),
      ],
    });
    return childIds;
  }

  if (['container', 'row', 'col'].includes(type)) {
    const children = Array.isArray(node.content)
      ? node.content.flatMap((child, index) => mapLegacyNode(child, `${path}/content/${index}`, context, pageContext))
      : [];
    if (children.length > MAX_SECTION_CHILDREN) {
      throw new ModSuiteOfflineAdapterError(
        'legacy_section_children_limit',
        `Un nodo legacy produce más de ${MAX_SECTION_CHILDREN} hijos seguros.`,
        { source_path: path, child_count: children.length }
      );
    }
    const id = deterministicId('node', context.sourceHash, path, type);
    context.nodes[id] = structuralNode(node, type, id, children);
    const issues = [];
    if (presentationDiscarded) issues.push('legacy_presentation_discarded');
    if (executableMetadataDiscarded) issues.push('legacy_executable_metadata_discarded');
    if (!Array.isArray(node.content)) issues.push('legacy_children_missing');
    if (type === 'row' && Array.isArray(node.content)) {
      const directColumns = node.content.filter((child) => normalizeLegacyType(child?.type) === 'col').length;
      if (directColumns > 4) issues.push('legacy_columns_clamped_to_four');
    }
    addReportEntry(context, {
      path,
      sourceType: type,
      status: executableMetadataDiscarded
        ? 'requiere_revision'
        : (issues.length > 0 ? 'aproximado' : 'migrado'),
      targetNodeIds: [id],
      issues,
    });
    return [id];
  }

  if (type === 'text') {
    const sanitized = sanitizeLegacyText(node.content, 100000);
    if (!sanitized.text) {
      addReportEntry(context, {
        path,
        sourceType: type,
        status: 'omitido',
        issues: [sanitized.removedDangerous ? 'executable_markup_removed' : 'empty_after_sanitization'],
      });
      return [];
    }
    const headingLevel = headingLevelFromLegacyMarkup(node.content);
    const parts = splitText(sanitized.text, 5000);
    const targetNodeIds = [];
    for (let index = 0; index < parts.length; index += 1) {
      const id = deterministicId('node', context.sourceHash, path, `text:${index}`);
      const useHeading = index === 0 && parts.length === 1 && headingLevel && parts[index].length <= 180;
      context.nodes[id] = useHeading
        ? {
          id,
          type: 'heading',
          version: 1,
          props: { text: parts[index], level: headingLevel, size: headingLevel <= 2 ? 'xl' : 'lg', align: 'left', tone: 'default' },
          children: [],
        }
        : {
          id,
          type: 'text',
          version: 1,
          props: { text: parts[index], size: 'md', align: 'left', tone: 'default' },
          children: [],
        };
      targetNodeIds.push(id);
    }
    const issues = [];
    if (presentationDiscarded) issues.push('legacy_presentation_discarded');
    if (executableMetadataDiscarded) issues.push('legacy_executable_metadata_discarded');
    if (sanitized.hadMarkup) issues.push('legacy_markup_converted_to_plain_text');
    if (sanitized.removedDangerous) issues.push('executable_markup_removed');
    if (parts.length > 1) issues.push('legacy_text_split');
    addReportEntry(context, {
      path,
      sourceType: type,
      status: sanitized.removedDangerous || executableMetadataDiscarded
        ? 'requiere_revision'
        : (issues.length > 0 ? 'aproximado' : 'migrado'),
      targetNodeIds,
      issues,
    });
    return targetNodeIds;
  }

  if (type === 'image') {
    const sourceReference = typeof node.content === 'string' ? node.content.trim() : '';
    const safeReference = publicHttpsUrl(sourceReference) || safeRelativeAssetReference(sourceReference);
    const referenceFingerprint = sourceReference
      ? crypto.createHash('sha256').update(sourceReference, 'utf8').digest('hex')
      : null;
    if (!safeReference) {
      addReportEntry(context, {
        path,
        sourceType: type,
        status: 'omitido',
        issues: [
          'unsafe_or_unresolved_asset_reference',
          ...(executableMetadataDiscarded ? ['legacy_executable_metadata_discarded'] : []),
        ],
        referenceFingerprint,
      });
      return [];
    }
    const rawAlt = typeof node.alt_image === 'string' && node.alt_image.trim()
      ? node.alt_image
      : (typeof node.alt === 'string' && !/^(?:widget|image|imagen)$/i.test(node.alt.trim()) ? node.alt : '');
    const alt = sanitizeLegacyText(rawAlt, 500);
    const id = deterministicId('node', context.sourceHash, path, 'image');
    context.nodes[id] = {
      id,
      type: 'image',
      version: 1,
      props: {
        asset_id: deterministicId('legacy_asset', context.sourceHash, path, referenceFingerprint || 'missing'),
        alt: alt.text,
        decorative: alt.text === '',
        loading: 'lazy',
        fit: 'cover',
        aspect_ratio: 'auto',
      },
      children: [],
    };
    addReportEntry(context, {
      path,
      sourceType: type,
      status: 'requiere_revision',
      targetNodeIds: [id],
      issues: [
        'media_import_rights_and_mime_review_required',
        ...(alt.text ? [] : ['image_alt_text_review_required']),
        ...(presentationDiscarded ? ['legacy_presentation_discarded'] : []),
        ...(executableMetadataDiscarded ? ['legacy_executable_metadata_discarded'] : []),
      ],
      referenceFingerprint,
    });
    context.hasMediaPlaceholders = true;
    return [id];
  }

  if (type === 'button') {
    const labelSource = typeof node.text_button === 'string' && node.text_button.trim()
      ? node.text_button
      : (typeof node.content === 'string' && !/^button$/i.test(node.content.trim()) ? node.content : '');
    const label = sanitizeLegacyText(labelSource, 120);
    const target = classifyButtonTarget(node.url_button, context, pageContext);
    if (!target) {
      addReportEntry(context, {
        path,
        sourceType: type,
        status: 'requiere_revision',
        issues: [
          'button_target_not_safely_mappable',
          ...(executableMetadataDiscarded ? ['legacy_executable_metadata_discarded'] : []),
        ],
      });
      return [];
    }
    const id = deterministicId('node', context.sourceHash, path, 'button');
    context.nodes[id] = {
      id,
      type: 'button',
      version: 1,
      props: {
        label: label.text || (context.locale.toLowerCase().startsWith('es') ? 'Continuar' : 'Continue'),
        action: target.action,
        target: target.target,
        variant: 'primary',
        open_in_new_tab: target.action === 'external_url',
      },
      children: [],
    };
    const issues = [];
    if (!label.text) issues.push('button_label_defaulted');
    if (label.hadMarkup) issues.push('legacy_markup_converted_to_plain_text');
    if (presentationDiscarded) issues.push('legacy_presentation_discarded');
    if (executableMetadataDiscarded) issues.push('legacy_executable_metadata_discarded');
    addReportEntry(context, {
      path,
      sourceType: type,
      status: label.removedDangerous || executableMetadataDiscarded
        ? 'requiere_revision'
        : (issues.length > 0 ? 'aproximado' : 'migrado'),
      targetNodeIds: [id],
      issues,
    });
    return [id];
  }

  const id = deterministicId('node', context.sourceHash, path, 'contacto');
  const localeEs = context.locale.toLowerCase().startsWith('es');
  const legacyTitle = node.content && typeof node.content === 'object'
    ? sanitizeLegacyText(node.content.title, 180)
    : { text: '', hadMarkup: false, removedDangerous: false };
  context.nodes[id] = {
    id,
    type: 'intake_form',
    version: 1,
    props: {
      form_key: deterministicId('form', context.sourceHash, path, 'primary'),
      title: legacyTitle.text || (localeEs ? 'Contacta con la clínica' : 'Contact the clinic'),
      description: '',
      submit_label: localeEs ? 'Enviar' : 'Send',
      success_message: localeEs
        ? 'Gracias. La clínica contactará contigo lo antes posible.'
        : 'Thank you. The clinic will contact you shortly.',
      fields: recognizedContactFields(node, context, path),
    },
    children: [],
  };
  addReportEntry(context, {
    path,
    sourceType: type,
    status: 'requiere_revision',
    targetNodeIds: [id],
    issues: [
      'intake_configuration_required',
      'legacy_form_contract_approximated',
      'privacy_copy_review_required',
      ...(presentationDiscarded ? ['legacy_presentation_discarded'] : []),
      ...(executableMetadataDiscarded ? ['legacy_executable_metadata_discarded'] : []),
      ...(legacyTitle.removedDangerous ? ['executable_markup_removed'] : []),
    ],
  });
  context.hasIntakeForms = true;
  return [id];
}

function uniqueSlug(baseSlug, usedSlugs) {
  let slug = baseSlug;
  let counter = 2;
  while (usedSlugs.has(slug)) {
    const suffix = `-${counter}`;
    slug = `${baseSlug.slice(0, 160 - suffix.length).replace(/-+$/g, '')}${suffix}`;
    counter += 1;
  }
  usedSlugs.add(slug);
  return slug;
}

function createWrapperSection(id, semanticTag, children) {
  if (children.length > MAX_SECTION_CHILDREN) {
    throw new ModSuiteOfflineAdapterError(
      'legacy_page_children_limit',
      `Una página legacy produce más de ${MAX_SECTION_CHILDREN} raíces seguras.`,
      { child_count: children.length }
    );
  }
  return {
    id,
    type: 'section',
    version: 1,
    props: { layout: 'stack', columns: 1, semantic_tag: semanticTag },
    children,
    style_tokens: defaultStyleTokens({ width: 'full', gap: 'md' }),
  };
}

function adaptModSuiteDocument(input, options = {}) {
  stableSerializeLegacy(input);
  const source = unwrapLegacyEnvelope(input);
  const canonicalSource = stableSerializeLegacy(source);
  const sourceHash = crypto.createHash('sha256').update(canonicalSource, 'utf8').digest('hex');
  const locale = String(options.locale || 'es-ES').trim();
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)) {
    throw new ModSuiteOfflineAdapterError('invalid_locale', 'El locale debe tener formato es-ES.');
  }
  const selection = selectLegacyPages(source, options);
  const context = {
    sourceHash,
    locale,
    nodes: {},
    entries: [],
    pageIdsBySlug: new Map(),
    hasIntakeForms: false,
    hasMediaPlaceholders: false,
  };
  const usedSlugs = new Set();
  const pageDescriptors = selection.pages.map((page, index) => {
    const title = options.title && selection.pages.length === 1
      ? (sanitizeLegacyText(options.title, 120).text || `Página ${index + 1}`)
      : displayNameForLegacyPage(page, index);
    const requestedSlug = options.slug && selection.pages.length === 1 ? options.slug : title;
    const slug = uniqueSlug(slugify(requestedSlug, `pagina-${index + 1}`), usedSlugs);
    const id = deterministicId('page', sourceHash, `/pages/${index}`, slug);
    context.pageIdsBySlug.set(slug, id);
    return { page, index, title, slug, id };
  });

  const pages = pageDescriptors.map(({ page, index, title, slug, id }) => {
    const sourcePath = `/pages/${index}`;
    const sourceNodes = LEGACY_PAGE_TYPES.has(normalizeLegacyType(page.type))
      ? (Array.isArray(page.content) ? page.content : [])
      : [page];
    const contacts = sourceNodes.flatMap((node, nodeIndex) => findLegacyNodes(
      node,
      `${sourcePath}/content/${nodeIndex}`,
      (candidate) => normalizeLegacyType(candidate.type) === 'contacto'
    ));
    const pageContext = {
      primaryFormId: contacts[0]
        ? deterministicId('node', sourceHash, contacts[0].path, 'contacto')
        : null,
    };
    const childIds = sourceNodes.flatMap((node, nodeIndex) => mapLegacyNode(
      node,
      `${sourcePath}/content/${nodeIndex}`,
      context,
      pageContext
    ));
    const rootId = deterministicId('node', sourceHash, sourcePath, 'page-root');
    context.nodes[rootId] = createWrapperSection(rootId, 'main', childIds);
    const pageType = normalizeLegacyType(page.type);
    const executableMetadataDiscarded = hasLegacyExecutableMetadata(page);
    addReportEntry(context, {
      path: sourcePath,
      sourceType: pageType,
      status: executableMetadataDiscarded ? 'requiere_revision' : 'aproximado',
      targetNodeIds: [id, rootId],
      issues: [
        'legacy_page_metadata_and_presentation_discarded',
        ...(executableMetadataDiscarded ? ['legacy_executable_metadata_discarded'] : []),
      ],
    });
    return {
      id,
      title,
      slug,
      root_node_ids: [rootId],
      seo: {
        title: title.slice(0, 70),
        description: '',
        canonical_url: null,
        social_asset_id: null,
        index: false,
        follow: false,
      },
    };
  });

  const mapGlobal = (legacyPage, name, semanticTag) => {
    if (!legacyPage) return null;
    const path = `/${name}`;
    const sourceNodes = Array.isArray(legacyPage.content) ? legacyPage.content : [];
    const contacts = sourceNodes.flatMap((node, index) => findLegacyNodes(
      node,
      `${path}/content/${index}`,
      (candidate) => normalizeLegacyType(candidate.type) === 'contacto'
    ));
    const pageContext = {
      primaryFormId: contacts[0]
        ? deterministicId('node', sourceHash, contacts[0].path, 'contacto')
        : null,
    };
    const childIds = sourceNodes.flatMap((node, index) => mapLegacyNode(
      node,
      `${path}/content/${index}`,
      context,
      pageContext
    ));
    const id = deterministicId('node', sourceHash, path, `${name}-root`);
    context.nodes[id] = createWrapperSection(id, semanticTag, childIds);
    const executableMetadataDiscarded = hasLegacyExecutableMetadata(legacyPage);
    addReportEntry(context, {
      path,
      sourceType: normalizeLegacyType(legacyPage.type),
      status: executableMetadataDiscarded ? 'requiere_revision' : 'aproximado',
      targetNodeIds: [id],
      issues: [
        'legacy_global_metadata_and_presentation_discarded',
        ...(executableMetadataDiscarded ? ['legacy_executable_metadata_discarded'] : []),
      ],
    });
    return id;
  };

  const headerNodeId = mapGlobal(selection.header, 'header', 'header');
  const footerNodeId = mapGlobal(selection.footer, 'footer', 'footer');
  const document = {
    schema_version: 1,
    design_system: {
      brand: 'clinicaclick',
      tokens: {
        color_primary: '#5B5BF7',
        color_secondary: '#181D35',
        color_accent: '#22C3A6',
        color_surface: '#FFFFFF',
        color_text: '#181D35',
        font_heading: 'system',
        font_body: 'system',
        radius: 'lg',
        spacing_density: 'comfortable',
      },
    },
    pages,
    globals: { header_node_id: headerNodeId, footer_node_id: footerNodeId },
    nodes: context.nodes,
    bindings: {},
    seo: { title_suffix: '', indexing: 'noindex', default_social_asset_id: null },
    consent: {
      provider: 'inherit',
      preview_mode: true,
      privacy_policy_url: null,
      privacy_policy_version: null,
      privacy_consent_text: null,
    },
    integrations: {
      intake_config_id: null,
      chat_enabled: false,
      whatsapp_enabled: false,
      phone_enabled: false,
    },
  };
  const integrity = assertValidWebDocument(document);
  const statuses = {
    migrado: 0,
    aproximado: 0,
    omitido: 0,
    requiere_revision: 0,
  };
  for (const entry of context.entries) statuses[entry.status] += 1;
  const warnings = [
    { code: 'legal_configuration_required_before_approval' },
    ...(context.hasIntakeForms ? [{ code: 'intake_configuration_required_before_approval' }] : []),
    ...(context.hasMediaPlaceholders ? [{ code: 'media_placeholders_require_scoped_import' }] : []),
    ...(statuses.omitido > 0 ? [{ code: 'omitted_nodes_require_source_review' }] : []),
    ...(statuses.requiere_revision > 0 ? [{ code: 'manual_review_required' }] : []),
  ];
  const report = {
    adapter_version: ADAPTER_VERSION,
    source_format: 'modsuite-offline-json',
    source_sha256: sourceHash,
    document_hash: integrity.hash,
    summary: {
      pages: pages.length,
      source_nodes: context.entries.length,
      target_nodes: Object.keys(context.nodes).length,
      statuses,
      requires_review: statuses.omitido > 0 || statuses.requiere_revision > 0,
    },
    security: {
      remote_requests_performed: 0,
      executable_content_preserved: false,
      legacy_css_or_classes_preserved: false,
      legacy_structural_ids_preserved: false,
      output_schema_valid: true,
    },
    warnings,
    nodes: context.entries,
  };
  return { document, report };
}

module.exports = {
  ADAPTER_VERSION,
  MAX_SOURCE_BYTES,
  ModSuiteOfflineAdapterError,
  adaptModSuiteDocument,
  publicHttpsUrl,
  sanitizeLegacyText,
  stableSerializeLegacy,
  unwrapLegacyEnvelope,
};
