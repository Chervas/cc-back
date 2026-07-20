'use strict';

const crypto = require('node:crypto');
const Ajv = require('ajv');
const WEB_DOCUMENT_SCHEMA = require('../contracts/web-document-v1.schema.json');

const WEB_DOCUMENT_VERSION = 1;
const WEB_DOCUMENT_LIMITS = Object.freeze({
  maxBytes: 512 * 1024,
  maxJsonDepth: 40,
  maxTreeDepth: 12,
  maxNodes: 500,
  maxPages: 50,
  maxChildrenPerNode: 50,
  maxBindings: 500,
  maxTotalProperties: 10000,
  maxTotalTextCharacters: 100000,
});

const FORBIDDEN_PROPERTY_NAMES = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'html',
  'raw_html',
  'innerhtml',
  'dangerouslysetinnerhtml',
  'css',
  'raw_css',
  'stylesheet',
  'styles',
  'style',
  'class',
  'classname',
  'classes',
  'javascript',
  'script',
  'scripts',
  'srcdoc',
  'iframe',
]);

const FORBIDDEN_STRING_PATTERNS = [
  /<\s*script\b/i,
  /<\s*iframe\b/i,
  /javascript\s*:/i,
  /data\s*:\s*text\/html/i,
  /\bon[a-z]+\s*=/i,
];

const BINDABLE_PROPS = Object.freeze({
  heading: new Set(['text']),
  text: new Set(['text']),
  faq: new Set(['question', 'answer']),
  image: new Set(['asset_id', 'alt']),
  gallery: new Set(),
  button: new Set(['label', 'target']),
  intake_form: new Set(['title', 'description']),
  section: new Set(),
  divider: new Set(),
  spacer: new Set(),
});

const FIELD_TYPES = Object.freeze({
  first_name: 'text',
  last_name: 'text',
  email: 'email',
  phone: 'tel',
  message: 'textarea',
  preferred_contact: 'select',
  privacy_consent: 'checkbox',
});

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  strictTypes: false,
  strictRequired: true,
  allowUnionTypes: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  unicodeRegExp: true,
});
const validateSchema = ajv.compile(WEB_DOCUMENT_SCHEMA);

class WebDocumentValidationError extends Error {
  constructor(errors, message = 'WebDocument v1 no es válido') {
    super(message);
    this.name = 'WebDocumentValidationError';
    this.code = 'WEB_DOCUMENT_INVALID';
    this.errors = errors;
  }
}

function validationError(keyword, instancePath, message, params = {}) {
  return { keyword, instancePath, message, params };
}

function normalizeAjvErrors(errors = []) {
  return errors.map((error) => ({
    keyword: error.keyword,
    instancePath: error.instancePath || '/',
    message: error.message || 'valor no válido',
    params: error.params || {},
  }));
}

function inspectJsonValue(value, state, path, depth) {
  if (depth > WEB_DOCUMENT_LIMITS.maxJsonDepth) {
    throw new WebDocumentValidationError([
      validationError('maxJsonDepth', path, `supera ${WEB_DOCUMENT_LIMITS.maxJsonDepth} niveles JSON`),
    ]);
  }

  if (value === null || typeof value === 'boolean') return;

  if (typeof value === 'string') {
    state.totalStringBytes += Buffer.byteLength(value, 'utf8');
    if (state.totalStringBytes > WEB_DOCUMENT_LIMITS.maxBytes) {
      throw new WebDocumentValidationError([
        validationError(
          'maxBytes',
          path,
          `supera el límite de ${WEB_DOCUMENT_LIMITS.maxBytes} bytes de texto y claves`
        ),
      ]);
    }
    for (const pattern of FORBIDDEN_STRING_PATTERNS) {
      if (pattern.test(value)) {
        throw new WebDocumentValidationError([
          validationError('forbiddenContent', path, 'contiene código o markup no permitido'),
        ]);
      }
    }
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WebDocumentValidationError([
        validationError('jsonType', path, 'debe ser un número JSON finito'),
      ]);
    }
    return;
  }

  if (typeof value !== 'object') {
    throw new WebDocumentValidationError([
      validationError('jsonType', path, `tipo ${typeof value} no permitido`),
    ]);
  }

  if (state.active.has(value)) {
    throw new WebDocumentValidationError([
      validationError('circularObject', path, 'contiene una referencia circular en memoria'),
    ]);
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new WebDocumentValidationError([
      validationError('jsonType', path, 'debe contener únicamente objetos JSON planos'),
    ]);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new WebDocumentValidationError([
      validationError('jsonType', path, 'no admite propiedades Symbol'),
    ]);
  }

  state.totalProperties += ownKeys.length;
  if (state.totalProperties > WEB_DOCUMENT_LIMITS.maxTotalProperties) {
    throw new WebDocumentValidationError([
      validationError(
        'maxTotalProperties',
        path,
        `supera ${WEB_DOCUMENT_LIMITS.maxTotalProperties} propiedades totales`
      ),
    ]);
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string') continue;
    state.totalStringBytes += Buffer.byteLength(key, 'utf8');
    if (state.totalStringBytes > WEB_DOCUMENT_LIMITS.maxBytes) {
      throw new WebDocumentValidationError([
        validationError(
          'maxBytes',
          path,
          `supera el límite de ${WEB_DOCUMENT_LIMITS.maxBytes} bytes de texto y claves`
        ),
      ]);
    }
  }

  state.active.add(value);
  if (Array.isArray(value)) {
    const unexpectedKeys = ownKeys.filter((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key));
    if (unexpectedKeys.length > 0) {
      throw new WebDocumentValidationError([
        validationError('jsonType', `${path}/${unexpectedKeys[0]}`, 'los arrays no admiten propiedades personalizadas'),
      ]);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new WebDocumentValidationError([
          validationError('jsonType', `${path}/${index}`, 'los arrays dispersos no están permitidos'),
        ]);
      }
      inspectJsonValue(value[index], state, `${path}/${index}`, depth + 1);
    }
  } else {
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.get || descriptor?.set) {
        throw new WebDocumentValidationError([
          validationError('jsonType', `${path}/${key}`, 'getters y setters no están permitidos'),
        ]);
      }

      const normalizedKey = key.normalize('NFC');
      const comparableKey = normalizedKey.toLowerCase();
      if (FORBIDDEN_PROPERTY_NAMES.has(comparableKey) || /^on[a-z]+$/i.test(normalizedKey)) {
        throw new WebDocumentValidationError([
          validationError('forbiddenProperty', `${path}/${key}`, 'propiedad de código o estilo no permitida'),
        ]);
      }
      inspectJsonValue(value[key], state, `${path}/${key}`, depth + 1);
    }
  }
  state.active.delete(value);
}

function canonicalizeValue(value, path = '/') {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map((item, index) => canonicalizeValue(item, `${path}/${index}`));

  const normalizedKeys = new Map();
  for (const key of Object.keys(value)) {
    const normalizedKey = key.normalize('NFC');
    if (normalizedKeys.has(normalizedKey)) {
      throw new WebDocumentValidationError([
        validationError('canonicalKeyCollision', path, 'dos propiedades colisionan al normalizar Unicode'),
      ]);
    }
    normalizedKeys.set(normalizedKey, key);
  }

  const canonical = {};
  for (const normalizedKey of [...normalizedKeys.keys()].sort()) {
    const originalKey = normalizedKeys.get(normalizedKey);
    canonical[normalizedKey] = canonicalizeValue(value[originalKey], `${path}/${normalizedKey}`);
  }
  return canonical;
}

function canonicalSerialize(value) {
  inspectJsonValue(value, {
    active: new WeakSet(),
    totalProperties: 0,
    totalStringBytes: 0,
  }, '/', 0);
  return JSON.stringify(canonicalizeValue(value));
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalSerialize(value), 'utf8').digest('hex');
}

function validatePublicHttpsUrl(value, path, errors) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) {
      errors.push(validationError('safeUrl', path, 'debe ser una URL https sin credenciales'));
    }
  } catch {
    errors.push(validationError('safeUrl', path, 'debe ser una URL https válida'));
  }
}

function validateIntakeForm(node, path, errors) {
  const fields = node.props.fields;
  const ids = new Set();
  const names = new Set();

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const fieldPath = `${path}/props/fields/${index}`;
    if (ids.has(field.id)) {
      errors.push(validationError('uniqueFieldId', `${fieldPath}/id`, 'el id de campo está repetido'));
    }
    if (names.has(field.name)) {
      errors.push(validationError('uniqueFieldName', `${fieldPath}/name`, 'el campo está repetido'));
    }
    ids.add(field.id);
    names.add(field.name);

    if (FIELD_TYPES[field.name] !== field.type) {
      errors.push(validationError(
        'fieldType',
        `${fieldPath}/type`,
        `el campo ${field.name} debe usar el tipo ${FIELD_TYPES[field.name]}`
      ));
    }
    if (field.name === 'preferred_contact') {
      if (!Array.isArray(field.options) || field.options.length === 0) {
        errors.push(validationError('fieldOptions', `${fieldPath}/options`, 'preferred_contact necesita opciones'));
      }
    } else if (field.options !== undefined) {
      errors.push(validationError('fieldOptions', `${fieldPath}/options`, 'solo preferred_contact admite opciones'));
    }
  }

  const privacy = fields.find((field) => field.name === 'privacy_consent');
  if (!privacy || privacy.required !== true) {
    errors.push(validationError(
      'privacyConsent',
      `${path}/props/fields`,
      'debe incluir un único privacy_consent obligatorio'
    ));
  }
  if (!names.has('email') && !names.has('phone')) {
    errors.push(validationError(
      'contactField',
      `${path}/props/fields`,
      'debe incluir email o teléfono para poder responder al lead'
    ));
  }
}

function effectiveSectionColumns(node, breakpoint) {
  if (breakpoint === 'desktop') return Number(node.props.columns);
  const override = node.responsive && node.responsive[breakpoint];
  return Number(override && Number.isInteger(override.columns) ? override.columns : node.props.columns);
}

function validateSectionColumnTracks(node, path, errors) {
  const tracksByBreakpoint = node.props.column_tracks;
  if (!tracksByBreakpoint) return;
  for (const breakpoint of ['desktop', 'tablet', 'mobile']) {
    const tracks = tracksByBreakpoint[breakpoint];
    if (!tracks) continue;
    const expectedColumns = effectiveSectionColumns(node, breakpoint);
    if (tracks.length !== expectedColumns) {
      errors.push(validationError(
        'columnTracks',
        `${path}/props/column_tracks/${breakpoint}`,
        `debe incluir ${expectedColumns} anchos, uno por columna`
      ));
      continue;
    }
    const total = tracks.reduce((sum, value) => sum + value, 0);
    if (total !== 12) {
      errors.push(validationError(
        'columnTracks',
        `${path}/props/column_tracks/${breakpoint}`,
        'los anchos de columnas deben sumar 12'
      ));
    }
  }
}

function validateGraph(document) {
  const errors = [];
  const nodes = document.nodes;
  const nodeIds = new Set(Object.keys(nodes));
  const pageIds = new Set();
  const pageSlugs = new Set();
  const entryReferences = new Map();
  const entryScopes = new Map();
  const parents = new Map();
  const bindingReferences = new Map();
  const intakeButtonReferences = [];
  let totalTextCharacters = 0;

  const addEntryReference = (nodeId, path, scope) => {
    const references = entryReferences.get(nodeId) || [];
    references.push(path);
    entryReferences.set(nodeId, references);
    if (!entryScopes.has(nodeId)) entryScopes.set(nodeId, scope);
  };

  for (let index = 0; index < document.pages.length; index += 1) {
    const page = document.pages[index];
    if (pageIds.has(page.id)) {
      errors.push(validationError('uniquePageId', `/pages/${index}/id`, 'el id de página está repetido'));
    }
    if (pageSlugs.has(page.slug)) {
      errors.push(validationError('uniquePageSlug', `/pages/${index}/slug`, 'el slug de página está repetido'));
    }
    pageIds.add(page.id);
    pageSlugs.add(page.slug);

    for (let rootIndex = 0; rootIndex < page.root_node_ids.length; rootIndex += 1) {
      const rootId = page.root_node_ids[rootIndex];
      const rootPath = `/pages/${index}/root_node_ids/${rootIndex}`;
      if (!nodeIds.has(rootId)) {
        errors.push(validationError('nodeReference', rootPath, `el nodo ${rootId} no existe`));
      } else {
        if (nodes[rootId].type !== 'section') {
          errors.push(validationError('rootNodeType', rootPath, 'la raíz de página debe ser una sección'));
        }
        addEntryReference(rootId, rootPath, { kind: 'page', pageId: page.id });
      }
    }
    if (page.seo?.canonical_url) {
      validatePublicHttpsUrl(page.seo.canonical_url, `/pages/${index}/seo/canonical_url`, errors);
    }
  }

  for (const globalName of ['header_node_id', 'footer_node_id']) {
    const nodeId = document.globals[globalName];
    if (nodeId === null) continue;
    const globalPath = `/globals/${globalName}`;
    if (!nodeIds.has(nodeId)) {
      errors.push(validationError('nodeReference', globalPath, `el nodo ${nodeId} no existe`));
    } else {
      if (nodes[nodeId].type !== 'section') {
        errors.push(validationError('rootNodeType', globalPath, 'un global debe apuntar a una sección'));
      }
      addEntryReference(nodeId, globalPath, { kind: 'global' });
    }
  }

  for (const [nodeKey, node] of Object.entries(nodes)) {
    const nodePath = `/nodes/${nodeKey}`;
    if (node.id !== nodeKey) {
      errors.push(validationError('nodeIdentity', `${nodePath}/id`, 'el id debe coincidir con la clave del nodo'));
    }

    const stringValues = Object.values(node.props).filter((value) => typeof value === 'string');
    totalTextCharacters += stringValues.reduce((sum, value) => sum + value.length, 0);
    if (node.type === 'gallery') {
      totalTextCharacters += node.props.items.reduce((sum, item) => (
        sum + item.alt.length + (item.caption?.length || 0)
      ), 0);
    }

    for (let index = 0; index < node.children.length; index += 1) {
      const childId = node.children[index];
      const childPath = `${nodePath}/children/${index}`;
      if (!nodeIds.has(childId)) {
        errors.push(validationError('nodeReference', childPath, `el nodo ${childId} no existe`));
        continue;
      }
      const existingParent = parents.get(childId);
      if (existingParent) {
        errors.push(validationError(
          'multipleParents',
          childPath,
          `el nodo ${childId} ya pertenece a ${existingParent}`
        ));
      } else {
        parents.set(childId, nodeKey);
      }
    }

    for (const bindingId of node.binding_ids || []) {
      const references = bindingReferences.get(bindingId) || [];
      references.push(nodeKey);
      bindingReferences.set(bindingId, references);
      if (!Object.hasOwn(document.bindings, bindingId)) {
        errors.push(validationError('bindingReference', `${nodePath}/binding_ids`, `el binding ${bindingId} no existe`));
      }
    }

    if (node.type === 'image') {
      if (node.props.decorative && node.props.alt !== '') {
        errors.push(validationError('imageAlt', `${nodePath}/props/alt`, 'una imagen decorativa debe tener alt vacío'));
      }
      if (!node.props.decorative && node.props.alt.trim() === '') {
        errors.push(validationError('imageAlt', `${nodePath}/props/alt`, 'una imagen informativa necesita texto alternativo'));
      }
    }

    if (node.type === 'section') {
      validateSectionColumnTracks(node, nodePath, errors);
    }

    if (node.type === 'gallery') {
      const assetIds = new Set();
      for (let index = 0; index < node.props.items.length; index += 1) {
        const item = node.props.items[index];
        const itemPath = `${nodePath}/props/items/${index}`;
        if (assetIds.has(item.asset_id)) {
          errors.push(validationError(
            'uniqueGalleryAsset',
            `${itemPath}/asset_id`,
            'una galería no puede repetir la misma imagen'
          ));
        }
        assetIds.add(item.asset_id);
        if (item.decorative && item.alt !== '') {
          errors.push(validationError(
            'galleryAlt',
            `${itemPath}/alt`,
            'una imagen decorativa debe tener alt vacío'
          ));
        }
        if (!item.decorative && item.alt.trim() === '') {
          errors.push(validationError(
            'galleryAlt',
            `${itemPath}/alt`,
            'una imagen informativa necesita texto alternativo'
          ));
        }
      }
    }

    if (node.type === 'button') {
      const { action, target } = node.props;
      if (action === 'external_url') {
        validatePublicHttpsUrl(target, `${nodePath}/props/target`, errors);
      } else if (action === 'internal_page' && !pageIds.has(target)) {
        errors.push(validationError('pageReference', `${nodePath}/props/target`, `la página ${target} no existe`));
      } else if (action === 'intake_form_anchor') {
        if (!nodeIds.has(target) || nodes[target].type !== 'intake_form') {
          errors.push(validationError('formReference', `${nodePath}/props/target`, 'debe apuntar a un intake_form existente'));
        } else {
          intakeButtonReferences.push({ nodeId: nodeKey, targetId: target, path: `${nodePath}/props/target` });
        }
      }
    }

    if (node.type === 'intake_form') {
      validateIntakeForm(node, nodePath, errors);
    }
  }

  if (totalTextCharacters > WEB_DOCUMENT_LIMITS.maxTotalTextCharacters) {
    errors.push(validationError(
      'maxTotalTextCharacters',
      '/nodes',
      `supera ${WEB_DOCUMENT_LIMITS.maxTotalTextCharacters} caracteres de contenido`
    ));
  }

  for (const [nodeId, references] of entryReferences.entries()) {
    if (references.length > 1) {
      errors.push(validationError(
        'multipleRoots',
        references[1],
        `el nodo raíz ${nodeId} se reutiliza en más de una página/global`
      ));
    }
    if (parents.has(nodeId)) {
      errors.push(validationError('rootHasParent', references[0], `el nodo raíz ${nodeId} también tiene padre`));
    }
  }

  for (const [bindingId, binding] of Object.entries(document.bindings)) {
    const bindingPath = `/bindings/${bindingId}`;
    const node = nodes[binding.target_node_id];
    if (!node) {
      errors.push(validationError('nodeReference', `${bindingPath}/target_node_id`, 'el nodo de destino no existe'));
    } else {
      if (!BINDABLE_PROPS[node.type].has(binding.target_prop)) {
        errors.push(validationError(
          'bindingTarget',
          `${bindingPath}/target_prop`,
          `${binding.target_prop} no es enlazable en ${node.type}`
        ));
      }
      const references = bindingReferences.get(bindingId) || [];
      if (!references.includes(binding.target_node_id)) {
        errors.push(validationError(
          'bindingReference',
          bindingPath,
          'el nodo de destino debe declarar este binding en binding_ids'
        ));
      }
    }
    if (binding.source !== 'clinic' && !binding.source_id) {
      errors.push(validationError(
        'bindingSource',
        `${bindingPath}/source_id`,
        `la fuente ${binding.source} necesita source_id`
      ));
    }
  }

  for (const [bindingId, references] of bindingReferences.entries()) {
    if (references.length > 1) {
      errors.push(validationError(
        'bindingReference',
        `/bindings/${bindingId}`,
        'un binding solo puede pertenecer a su nodo de destino'
      ));
    }
  }

  const state = new Map();
  const reachable = new Set();
  const nodeScopes = new Map();
  const visit = (nodeId, depth, path, scope) => {
    if (!nodeIds.has(nodeId)) return;
    if (depth > WEB_DOCUMENT_LIMITS.maxTreeDepth) {
      errors.push(validationError(
        'maxTreeDepth',
        path,
        `supera ${WEB_DOCUMENT_LIMITS.maxTreeDepth} niveles de bloques`
      ));
      return;
    }
    if (state.get(nodeId) === 'visiting') {
      errors.push(validationError('nodeCycle', path, `ciclo detectado en ${nodeId}`));
      return;
    }
    if (state.get(nodeId) === 'visited') return;
    state.set(nodeId, 'visiting');
    reachable.add(nodeId);
    if (!nodeScopes.has(nodeId)) nodeScopes.set(nodeId, scope);
    const node = nodes[nodeId];
    for (let index = 0; index < node.children.length; index += 1) {
      visit(node.children[index], depth + 1, `/nodes/${nodeId}/children/${index}`, scope);
    }
    state.set(nodeId, 'visited');
  };

  for (const [nodeId] of entryReferences.entries()) {
    visit(nodeId, 1, `/nodes/${nodeId}`, entryScopes.get(nodeId));
  }

  for (const reference of intakeButtonReferences) {
    const buttonScope = nodeScopes.get(reference.nodeId);
    const formScope = nodeScopes.get(reference.targetId);
    if (!buttonScope || !formScope) continue;
    const isAllowed = buttonScope.kind === 'global'
      ? formScope.kind === 'global'
      : formScope.kind === 'global'
        || (formScope.kind === 'page' && formScope.pageId === buttonScope.pageId);
    if (!isAllowed) {
      errors.push(validationError(
        'formScopeReference',
        reference.path,
        buttonScope.kind === 'global'
          ? 'un botón global solo puede apuntar a un formulario global'
          : 'un botón de página solo puede apuntar a un formulario global o de esa misma página'
      ));
    }
  }

  for (const nodeId of nodeIds) {
    if (!reachable.has(nodeId)) {
      errors.push(validationError('orphanNode', `/nodes/${nodeId}`, 'el nodo no es alcanzable desde una página o global'));
    }
  }

  return errors;
}

function validateWebDocument(document) {
  let canonical;
  try {
    canonical = canonicalSerialize(document);
  } catch (error) {
    if (error instanceof WebDocumentValidationError) {
      return { valid: false, errors: error.errors, canonical: null, hash: null, stats: null };
    }
    throw error;
  }

  const byteLength = Buffer.byteLength(canonical, 'utf8');
  const errors = [];
  if (byteLength > WEB_DOCUMENT_LIMITS.maxBytes) {
    errors.push(validationError(
      'maxBytes',
      '/',
      `supera el límite de ${WEB_DOCUMENT_LIMITS.maxBytes} bytes`,
      { byteLength, limit: WEB_DOCUMENT_LIMITS.maxBytes }
    ));
  }

  const schemaValid = validateSchema(document);
  if (!schemaValid) errors.push(...normalizeAjvErrors(validateSchema.errors));
  if (schemaValid) errors.push(...validateGraph(document));

  const valid = errors.length === 0;
  const hash = valid ? crypto.createHash('sha256').update(canonical, 'utf8').digest('hex') : null;
  return {
    valid,
    errors,
    canonical,
    hash,
    stats: {
      byteLength,
      nodeCount: document && typeof document === 'object' && document.nodes
        ? Object.keys(document.nodes).length
        : 0,
      pageCount: document && typeof document === 'object' && Array.isArray(document.pages)
        ? document.pages.length
        : 0,
      bindingCount: document && typeof document === 'object' && document.bindings
        ? Object.keys(document.bindings).length
        : 0,
    },
  };
}

function assertValidWebDocument(document) {
  const result = validateWebDocument(document);
  if (!result.valid) throw new WebDocumentValidationError(result.errors);
  return result;
}

function hashWebDocument(document, options = {}) {
  if (options.validate === false) return canonicalHash(document);
  return assertValidWebDocument(document).hash;
}

module.exports = {
  WEB_DOCUMENT_SCHEMA,
  WEB_DOCUMENT_VERSION,
  WEB_DOCUMENT_LIMITS,
  WebDocumentValidationError,
  canonicalSerialize,
  hashWebDocument,
  validateWebDocument,
  assertValidWebDocument,
};
