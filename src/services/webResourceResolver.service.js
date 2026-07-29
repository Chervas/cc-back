'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const {
  contentFieldValues,
  isSafePublicAssetUrl,
  projectSafeMediaMetadata,
  projectSafeMediaRights,
  projectSafeMediaVariants,
  publicMediaIsAuthorizedForWeb,
} = require('../lib/webContent');

const CLINIC_LIVE_FIELDS = new Set([
  'name',
  'address',
  'phone',
  'email',
  'website',
  'hours',
  'booking_url',
]);
const TREATMENT_FIELDS = new Set(['name', 'title', 'description', 'short_description', 'price_from']);
const PROFESSIONAL_FIELDS = new Set(['name', 'title', 'alt_text']);
const POST_LIST_CONTENT_TYPES = new Set([
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
const MAX_POST_LIST_SNAPSHOT_ENTRIES = 120;

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function addReference(references, kind, id, path, extra = {}) {
  if (id === undefined || id === null || id === '') return;
  references.push({ kind, id: String(id), path, ...extra });
}

function collectWebResourceReferences(document, scope = null) {
  const references = [];
  addReference(references, 'intake_config', document?.integrations?.intake_config_id, '/integrations/intake_config_id');
  addReference(references, 'media', document?.seo?.default_social_asset_id, '/seo/default_social_asset_id');
  for (let index = 0; index < (document?.pages || []).length; index += 1) {
    addReference(references, 'media', document.pages[index]?.seo?.social_asset_id, `/pages/${index}/seo/social_asset_id`);
  }
  for (const [nodeId, node] of Object.entries(document?.nodes || {})) {
    if (node?.type === 'image') {
      addReference(references, 'media', node.props?.asset_id, `/nodes/${nodeId}/props/asset_id`);
    }
    if (node?.type === 'gallery') {
      for (let index = 0; index < (node.props?.items || []).length; index += 1) {
        addReference(
          references,
          'media',
          node.props.items[index]?.asset_id,
          `/nodes/${nodeId}/props/items/${index}/asset_id`
        );
      }
    }
  }
  for (const [bindingId, binding] of Object.entries(document?.bindings || {})) {
    const path = `/bindings/${bindingId}/source_id`;
    if (binding?.source === 'content_entry') {
      addReference(references, 'content_entry', binding.source_id, path, { field: binding.field });
    } else if (binding?.source === 'treatment' || binding?.source === 'professional') {
      addReference(references, binding.source, binding.source_id, path, { field: binding.field });
    } else if (binding?.source === 'clinic') {
      const effectiveClinicId = binding.source_id || (scope?.type === 'clinic' ? scope.id : null);
      if (effectiveClinicId) {
        addReference(references, 'clinic', effectiveClinicId, path, {
          field: binding.field,
          implicit_scope: !binding.source_id,
        });
      } else {
        references.push({ kind: 'clinic_scope', id: null, path, field: binding.field });
      }
    }
  }
  return references;
}

function collectPostListContentTypes(document) {
  const types = new Set();
  let requested = 0;
  for (const node of Object.values(document?.nodes || {})) {
    if (node?.type === 'post_list') {
      const nodeLimit = Number(node.props?.limit);
      requested += Number.isSafeInteger(nodeLimit) && nodeLimit > 0 ? Math.min(12, nodeLimit) : 6;
      for (const type of node.props?.content_types || []) {
        if (POST_LIST_CONTENT_TYPES.has(type)) types.add(type);
      }
    } else if (node?.type === 'link_list' && node.props?.source === 'cms_index') {
      const nodeLimit = Number(node.props?.cms_index?.limit);
      requested += Number.isSafeInteger(nodeLimit) && nodeLimit > 0 ? Math.min(12, nodeLimit) : 6;
      for (const type of node.props?.cms_index?.content_types || []) {
        if (POST_LIST_CONTENT_TYPES.has(type)) types.add(type);
      }
    } else if (node?.type === 'category_list') {
      const nodeLimit = Number(node.props?.limit);
      requested += Number.isSafeInteger(nodeLimit) && nodeLimit > 0 ? Math.min(12, nodeLimit) : 8;
      types.add('category');
    }
  }
  return {
    types: [...types].sort(),
    limit: Math.min(MAX_POST_LIST_SNAPSHOT_ENTRIES, Math.max(0, requested)),
  };
}

async function groupIdForClinic(scope, models, transaction) {
  if (scope.type !== 'clinic') return null;
  const clinic = await models.Clinica.findByPk(scope.id, {
    attributes: ['grupoClinicaId'],
    raw: true,
    transaction,
  });
  return positiveInteger(clinic?.grupoClinicaId);
}

function accessForRow(row, scope, inheritedGroupId, allowGroupInheritance) {
  const value = plain(row);
  if (value.scopeType === scope.type) {
    const resourceId = Number(value.scopeType === 'clinic' ? value.clinicaId : value.grupoClinicaId);
    return resourceId === Number(scope.id) ? { allowed: true, inherited: false } : { allowed: false, inherited: false };
  }
  if (
    allowGroupInheritance
    && scope.type === 'clinic'
    && value.scopeType === 'group'
    && inheritedGroupId
    && Number(value.grupoClinicaId) === inheritedGroupId
  ) {
    return { allowed: true, inherited: true };
  }
  // Un proyecto de grupo nunca ve recursos de una clínica individual.
  return { allowed: false, inherited: false };
}

function snapshotScope(row, inherited) {
  const value = plain(row);
  return {
    type: value.scopeType,
    id: Number(value.scopeType === 'clinic' ? value.clinicaId : value.grupoClinicaId),
    inherited: Boolean(inherited),
  };
}

function mediaAvailable(row) {
  const value = plain(row);
  const publicMedia = plain(value.publicMediaAsset);
  if (!publicMedia || value.status !== 'ready') return false;
  const rights = projectSafeMediaRights(value.rights);
  if (rights.expires_at && Date.parse(rights.expires_at) <= Date.now()) return false;
  const variants = projectSafeMediaVariants(value.variants);
  return publicMediaIsAuthorizedForWeb(value, publicMedia)
    && variants.every((variant) => isSafePublicAssetUrl(variant?.url));
}

function snapshotMedia(row, inherited) {
  const value = plain(row);
  const publicMedia = plain(value.publicMediaAsset);
  return {
    id: value.id,
    version: Number(value.version),
    scope: snapshotScope(value, inherited),
    kind: value.kind,
    title: value.title,
    alt_text: value.altText,
    decorative: Boolean(value.decorative),
    focal_points: value.focalPoints || {},
    rights: (() => {
      const rights = projectSafeMediaRights(value.rights);
      return {
        origin: rights.origin,
        license_url: rights.license_url,
        credit: rights.credit,
        expires_at: rights.expires_at,
      };
    })(),
    variants: projectSafeMediaVariants(value.variants),
    metadata: projectSafeMediaMetadata(value.mediaMetadata),
    public_media: {
      id: Number(publicMedia.id),
      url: publicMedia.public_url,
      content_type: publicMedia.content_type,
      size_bytes: Number(publicMedia.size_bytes || 0),
    },
  };
}

function snapshotContent(row, inherited) {
  const value = plain(row);
  const publicContent = value.type === 'testimonial'
    ? {
        quote: value.content?.quote || '',
        attribution: value.content?.attribution ?? null,
      }
    : value.content;
  return {
    id: value.id,
    version: Number(value.version),
    scope: snapshotScope(value, inherited),
    type: value.type,
    locale: value.locale,
    title: value.title,
    content: publicContent,
    sources: value.sources || [],
    schema_config: value.schemaConfig || { enabled: true, profile: 'auto', include_sources: false },
    content_hash: value.contentHash,
    fields: contentFieldValues(value),
  };
}

function normalizedText(value, maximum = 2048) {
  const result = String(value ?? '').normalize('NFC').trim();
  return result ? result.slice(0, maximum) : null;
}

function treatmentHiddenForClinic(value, clinicId) {
  return Array.isArray(value.eliminado_por_clinica)
    && value.eliminado_por_clinica.some((item) => Number(item) === Number(clinicId));
}

function treatmentAccess(row, scope, inheritedGroupId) {
  const value = plain(row) || {};
  if (![true, 1, '1'].includes(value.activo)) return { allowed: false, inherited: false };
  const ownerClinicId = positiveInteger(value.clinica_id);
  const ownerGroupId = positiveInteger(value.grupo_clinica_id);
  if (scope.type === 'clinic') {
    if (treatmentHiddenForClinic(value, scope.id)) return { allowed: false, inherited: false };
    if (ownerClinicId) return { allowed: ownerClinicId === Number(scope.id), inherited: false };
    if (ownerGroupId) {
      return {
        allowed: Boolean(inheritedGroupId) && ownerGroupId === Number(inheritedGroupId),
        inherited: ownerGroupId === Number(inheritedGroupId),
      };
    }
    return { allowed: value.origen === 'sistema', inherited: true };
  }
  if (ownerClinicId) return { allowed: false, inherited: false };
  if (ownerGroupId) return { allowed: ownerGroupId === Number(scope.id), inherited: false };
  return { allowed: value.origen === 'sistema', inherited: true };
}

function treatmentSnapshot(row, inherited) {
  const value = plain(row) || {};
  const numericPrice = Number(value.precio_base);
  const price = Number.isFinite(numericPrice) && numericPrice > 0
    ? `${numericPrice.toLocaleString('es-ES', { maximumFractionDigits: 2 })} €`
    : null;
  const description = normalizedText(value.descripcion);
  return {
    id: String(value.id_tratamiento),
    scope: {
      type: positiveInteger(value.clinica_id) ? 'clinic' : (positiveInteger(value.grupo_clinica_id) ? 'group' : 'system'),
      id: positiveInteger(value.clinica_id) || positiveInteger(value.grupo_clinica_id),
      inherited: Boolean(inherited),
    },
    fields: {
      name: normalizedText(value.nombre, 255),
      title: normalizedText(value.nombre, 255),
      description,
      short_description: description ? description.slice(0, 280) : null,
      price_from: price,
    },
  };
}

function professionalSnapshot(row) {
  const value = plain(row) || {};
  const doctor = plain(value.doctor) || {};
  const name = [doctor.nombre, doctor.apellidos]
    .map((part) => normalizedText(part, 191))
    .filter(Boolean)
    .join(' ');
  return {
    id: String(value.id),
    clinic_id: positiveInteger(value.clinica_id),
    fields: {
      name: name || null,
      title: normalizedText(value.rol_en_clinica || doctor.cargo_usuario, 191),
      alt_text: name || null,
    },
  };
}

function intakeAccess(row, scope, inheritedGroupId, allowGroupInheritance) {
  const value = plain(row) || {};
  if (scope.type === 'group') {
    return value.assignment_scope === 'group' && Number(value.group_id) === Number(scope.id)
      ? { allowed: true, inherited: false }
      : { allowed: false, inherited: false };
  }
  if (value.assignment_scope === 'clinic' && Number(value.clinic_id) === Number(scope.id)) {
    return { allowed: true, inherited: false };
  }
  if (
    allowGroupInheritance
    && inheritedGroupId
    && value.assignment_scope === 'group'
    && Number(value.group_id) === Number(inheritedGroupId)
  ) {
    const locations = Array.isArray(value.config?.locations) ? value.config.locations : [];
    const assigned = locations.some((location) => (
      positiveInteger(location?.id ?? location?.clinic_id) === Number(scope.id)
    ));
    return { allowed: assigned, inherited: assigned };
  }
  return { allowed: false, inherited: false };
}

function unresolvedReference(reference, reason) {
  return {
    kind: reference.kind,
    id: reference.id,
    path: reference.path,
    ...(reference.field ? { field: reference.field } : {}),
    reason,
  };
}

async function resolveWebDocumentResources({
  document,
  scope,
  models = db,
  transaction = undefined,
  allowGroupInheritance = false,
  referenceKinds = null,
} = {}) {
  const allowedKinds = Array.isArray(referenceKinds)
    ? new Set(referenceKinds.map((kind) => String(kind || '').trim()).filter(Boolean))
    : null;
  const references = collectWebResourceReferences(document, scope)
    .filter((reference) => !allowedKinds || allowedKinds.has(reference.kind));
  const postListCollection = !allowedKinds || allowedKinds.has('content_entry')
    ? collectPostListContentTypes(document)
    : { types: [], limit: 0 };
  const mediaIds = [...new Set(references.filter((item) => item.kind === 'media').map((item) => item.id))];
  const contentIds = [...new Set(references.filter((item) => item.kind === 'content_entry').map((item) => item.id))];
  const treatmentIds = [...new Set(references
    .filter((item) => item.kind === 'treatment')
    .map((item) => positiveInteger(item.id))
    .filter(Boolean))];
  const professionalIds = [...new Set(references
    .filter((item) => item.kind === 'professional')
    .map((item) => positiveInteger(item.id))
    .filter(Boolean))];
  const intakeIds = [...new Set(references
    .filter((item) => item.kind === 'intake_config')
    .map((item) => positiveInteger(item.id))
    .filter(Boolean))];
  const clinicIds = [...new Set(references
    .filter((item) => item.kind === 'clinic')
    .map((item) => positiveInteger(item.id))
    .filter(Boolean))];
  const inheritedGroupId = allowGroupInheritance
    ? await groupIdForClinic(scope, models, transaction)
    : null;
  const contentScopes = (() => {
    if (!scope?.type || !scope?.id) return [];
    if (scope.type === 'clinic') {
      const scopes = [{ scopeType: 'clinic', clinicaId: Number(scope.id) }];
      if (allowGroupInheritance && inheritedGroupId) {
        scopes.push({ scopeType: 'group', grupoClinicaId: Number(inheritedGroupId) });
      }
      return scopes;
    }
    if (scope.type === 'group') return [{ scopeType: 'group', grupoClinicaId: Number(scope.id) }];
    return [];
  })();
  const mediaRows = mediaIds.length
    ? await models.WebMediaAsset.findAll({
      where: { id: { [Op.in]: mediaIds } },
      include: [{
        model: models.PublicMediaAsset,
        as: 'publicMediaAsset',
        attributes: [
          'id',
          'scope_type',
          'clinica_id',
          'grupo_clinica_id',
          'public_url',
          'content_type',
          'size_bytes',
          'sensitivity',
          'status',
          'metadata',
        ],
        required: true,
      }],
      transaction,
    })
    : [];
  const referencedContentRows = contentIds.length
    ? await models.WebContentEntry.findAll({
      where: { id: { [Op.in]: contentIds } },
      transaction,
    })
    : [];
  const postListContentRows = postListCollection.types.length && postListCollection.limit > 0 && contentScopes.length
    ? await models.WebContentEntry.findAll({
      where: {
        status: 'published',
        type: { [Op.in]: postListCollection.types },
        [Op.or]: contentScopes,
      },
      order: [['updatedAt', 'DESC'], ['id', 'ASC']],
      limit: postListCollection.limit,
      transaction,
    })
    : [];
  const contentRows = [
    ...referencedContentRows,
    ...postListContentRows.filter((row) => !contentIds.includes(String(plain(row).id))),
  ];
  const treatmentRows = treatmentIds.length && models.Tratamiento
    ? await models.Tratamiento.findAll({
      where: { id_tratamiento: { [Op.in]: treatmentIds } },
      attributes: [
        'id_tratamiento', 'nombre', 'descripcion', 'precio_base', 'activo', 'origen',
        'clinica_id', 'grupo_clinica_id', 'eliminado_por_clinica',
      ],
      transaction,
    })
    : [];
  const professionalRows = professionalIds.length && models.DoctorClinica && models.Usuario
    ? await models.DoctorClinica.findAll({
      where: { id: { [Op.in]: professionalIds }, activo: true },
      attributes: ['id', 'doctor_id', 'clinica_id', 'rol_en_clinica', 'activo'],
      include: [{
        model: models.Usuario,
        as: 'doctor',
        attributes: ['id_usuario', 'nombre', 'apellidos', 'cargo_usuario', 'isProfesional', 'estado_cuenta'],
        required: true,
      }],
      transaction,
    })
    : [];
  const intakeRows = intakeIds.length && models.IntakeConfig
    ? await models.IntakeConfig.findAll({
      where: { id: { [Op.in]: intakeIds } },
      attributes: ['id', 'clinic_id', 'group_id', 'assignment_scope', 'config'],
      transaction,
    })
    : [];
  const professionalClinicIds = professionalRows
    .map((row) => positiveInteger(plain(row)?.clinica_id))
    .filter(Boolean);
  for (const id of professionalClinicIds) clinicIds.push(id);
  const uniqueClinicIds = [...new Set(clinicIds)];
  const clinicRows = uniqueClinicIds.length
    ? await models.Clinica.findAll({
      where: { id_clinica: { [Op.in]: uniqueClinicIds } },
      attributes: ['id_clinica', 'grupoClinicaId'],
      raw: true,
      transaction,
    })
    : [];
  const mediaById = new Map(mediaRows.map((row) => [String(row.id), row]));
  const contentById = new Map(contentRows.map((row) => [String(row.id), row]));
  const treatmentById = new Map(treatmentRows.map((row) => [String(plain(row).id_tratamiento), row]));
  const professionalById = new Map(professionalRows.map((row) => [String(plain(row).id), row]));
  const intakeById = new Map(intakeRows.map((row) => [String(plain(row).id), row]));
  const clinicById = new Map(clinicRows.map((row) => [String(row.id_clinica), row]));
  const resolved = [];
  const unresolved = [];
  const contentEntries = {};
  const mediaAssets = {};
  const treatments = {};
  const professionals = {};
  let intakeConfig = null;
  const liveBindings = [];

  for (const reference of references) {
    if (reference.kind === 'treatment') {
      const row = treatmentById.get(reference.id);
      const access = row
        ? treatmentAccess(row, scope, inheritedGroupId || (scope.type === 'group' ? scope.id : null))
        : { allowed: false, inherited: false };
      const snapshot = row && access.allowed ? treatmentSnapshot(row, access.inherited) : null;
      if (!snapshot || !TREATMENT_FIELDS.has(reference.field) || snapshot.fields[reference.field] == null) {
        unresolved.push(unresolvedReference(reference, row && access.allowed ? 'field_unavailable' : 'not_accessible_or_unavailable'));
        continue;
      }
      treatments[reference.id] = snapshot;
      resolved.push({ kind: 'treatment', id: reference.id, path: reference.path, field: reference.field, inherited: access.inherited });
      continue;
    }
    if (reference.kind === 'professional') {
      const row = professionalById.get(reference.id);
      const value = plain(row) || {};
      const doctor = plain(value.doctor) || {};
      const clinic = clinicById.get(String(value.clinica_id));
      const allowed = Boolean(row)
        && [true, 1, '1'].includes(value.activo)
        && [true, 1, '1'].includes(doctor.isProfesional)
        && doctor.estado_cuenta !== 'inactivo'
        && (scope.type === 'clinic'
          ? Number(value.clinica_id) === Number(scope.id)
          : Number(clinic?.grupoClinicaId) === Number(scope.id));
      const snapshot = allowed ? professionalSnapshot(row) : null;
      if (!snapshot || !PROFESSIONAL_FIELDS.has(reference.field) || snapshot.fields[reference.field] == null) {
        unresolved.push(unresolvedReference(reference, snapshot ? 'field_unavailable' : 'not_accessible_or_unavailable'));
        continue;
      }
      professionals[reference.id] = snapshot;
      resolved.push({ kind: 'professional', id: reference.id, path: reference.path, field: reference.field, inherited: false });
      continue;
    }
    if (reference.kind === 'intake_config') {
      const row = intakeById.get(reference.id);
      const access = row
        ? intakeAccess(row, scope, inheritedGroupId, allowGroupInheritance)
        : { allowed: false, inherited: false };
      if (!row || !access.allowed) {
        unresolved.push(unresolvedReference(reference, 'not_accessible_or_unavailable'));
        continue;
      }
      const value = plain(row);
      intakeConfig = {
        id: String(value.id),
        scope: {
          type: value.assignment_scope,
          id: positiveInteger(value.assignment_scope === 'clinic' ? value.clinic_id : value.group_id),
          inherited: Boolean(access.inherited),
        },
      };
      resolved.push({ kind: 'intake_config', id: reference.id, path: reference.path, inherited: access.inherited });
      continue;
    }
    if (reference.kind === 'clinic_scope') {
      unresolved.push(unresolvedReference(reference, 'explicit_clinic_required'));
      continue;
    }
    if (reference.kind === 'clinic') {
      const clinicId = positiveInteger(reference.id);
      const groupClinic = clinicById.get(reference.id);
      const allowed = scope.type === 'clinic'
        ? clinicId === Number(scope.id) && Boolean(groupClinic)
        : Number(groupClinic?.grupoClinicaId) === Number(scope.id);
      if (!allowed || !CLINIC_LIVE_FIELDS.has(reference.field)) {
        unresolved.push(unresolvedReference(reference, 'not_accessible_or_unavailable'));
        continue;
      }
      liveBindings.push({
        source: 'clinic',
        source_id: String(clinicId),
        field: reference.field,
        resolver: 'clinic_public_v1',
        implicit_scope: Boolean(reference.implicit_scope),
      });
      resolved.push({
        kind: 'clinic',
        id: reference.id,
        path: reference.path,
        field: reference.field,
        inherited: false,
      });
      continue;
    }
    const row = reference.kind === 'media'
      ? mediaById.get(reference.id)
      : contentById.get(reference.id);
    if (!row) {
      unresolved.push(unresolvedReference(reference, 'not_accessible_or_unavailable'));
      continue;
    }
    const access = accessForRow(row, scope, inheritedGroupId, allowGroupInheritance);
    if (!access.allowed) {
      unresolved.push(unresolvedReference(reference, 'not_accessible_or_unavailable'));
      continue;
    }
    if (reference.kind === 'media') {
      if (!mediaAvailable(row)) {
        unresolved.push(unresolvedReference(reference, 'not_accessible_or_unavailable'));
        continue;
      }
      if (!mediaAssets[reference.id]) mediaAssets[reference.id] = snapshotMedia(row, access.inherited);
      resolved.push({
        kind: 'media',
        id: reference.id,
        path: reference.path,
        version: Number(plain(row).version),
        inherited: access.inherited,
      });
      continue;
    }

    const value = plain(row);
    const fields = contentFieldValues(value);
    if (value.status !== 'published' || fields[reference.field] == null) {
      unresolved.push(unresolvedReference(
        reference,
        value.status === 'published' ? 'field_unavailable' : 'not_accessible_or_unavailable'
      ));
      continue;
    }
    if (!contentEntries[reference.id]) contentEntries[reference.id] = snapshotContent(row, access.inherited);
    resolved.push({
      kind: 'content_entry',
      id: reference.id,
      path: reference.path,
      field: reference.field,
      version: Number(value.version),
      inherited: access.inherited,
    });
  }

  for (const row of postListContentRows) {
    const value = plain(row);
    const id = String(value?.id || '');
    if (!id || contentEntries[id]) continue;
    const access = accessForRow(row, scope, inheritedGroupId, allowGroupInheritance);
    if (!access.allowed || value.status !== 'published' || !postListCollection.types.includes(value.type)) continue;
    contentEntries[id] = snapshotContent(row, access.inherited);
    resolved.push({
      kind: 'content_entry',
      id,
      path: '/nodes/*/props/content_types',
      version: Number(value.version),
      inherited: access.inherited,
      collection: 'post_list',
    });
  }

  return {
    references,
    resolved,
    unresolved,
    snapshot: {
      schema_version: 1,
      content_entries: contentEntries,
      media_assets: mediaAssets,
      live_bindings: liveBindings,
      treatments,
      professionals,
      intake_config: intakeConfig,
    },
  };
}

module.exports = {
  accessForRow,
  collectWebResourceReferences,
  mediaAvailable,
  resolveWebDocumentResources,
  snapshotContent,
  snapshotMedia,
};
