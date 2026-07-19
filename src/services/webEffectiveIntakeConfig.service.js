'use strict';

const db = require('../../models');
const {
  RUNTIME_FEATURE_KEYS,
  parseRuntimeInheritance,
  recordDeclaresRuntime,
} = require('../lib/webRuntimeInheritance');

class WebEffectiveIntakeConfigError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'WebEffectiveIntakeConfigError';
    this.code = code;
    this.status = 409;
    this.details = details;
  }
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function queryOptions(transaction) {
  return {
    raw: true,
    ...(transaction ? { transaction } : {}),
  };
}

function plainIntakeConfig(record) {
  return record?.get ? record.get({ plain: true }) : record;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function invalidInheritance(rejectInvalidInheritance, code, message, details) {
  if (rejectInvalidInheritance) throw new WebEffectiveIntakeConfigError(code, message, details);
  return null;
}

function materializeInheritedIntakeConfig(direct, inherited, groupId) {
  if (!direct || !inherited) return inherited || direct || null;
  const base = direct?.get ? direct.get({ plain: true }) : direct;
  const runtime = inherited?.get ? inherited.get({ plain: true }) : inherited;
  const config = cloneJson(base.config && typeof base.config === 'object' ? base.config : {});
  const features = cloneJson(config.features && typeof config.features === 'object' ? config.features : {});
  const runtimeConfig = runtime.config && typeof runtime.config === 'object' ? runtime.config : {};
  const runtimeFeatures = runtimeConfig.features && typeof runtimeConfig.features === 'object'
    ? runtimeConfig.features
    : {};
  for (const key of RUNTIME_FEATURE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(runtimeFeatures, key)) features[key] = cloneJson(runtimeFeatures[key]);
    else delete features[key];
  }
  if (Object.keys(features).length) config.features = features;
  else delete config.features;
  for (const key of ['locations', 'snippet_verification']) {
    if (Object.prototype.hasOwnProperty.call(runtimeConfig, key)) config[key] = cloneJson(runtimeConfig[key]);
    else delete config[key];
  }
  config.runtime_inheritance = {
    schema_version: 1,
    scope_type: 'group',
    scope_id: groupId,
  };
  return {
    ...base,
    config,
    hmac_key: runtime.hmac_key ?? null,
  };
}

async function effectiveIntakeConfigForScope({
  scopeType,
  clinicId = null,
  groupId = null,
  groupIdHint = null,
  directRecord = undefined,
  groupRecord = undefined,
  preserveClinicConfig = false,
  rejectInvalidInheritance = false,
  models = db,
  transaction = null,
} = {}) {
  if (scopeType === 'group') {
    const resolvedGroupId = positiveInteger(groupId);
    if (!resolvedGroupId) return null;
    const supplied = groupRecord === undefined ? null : groupRecord;
    if (supplied) {
      const suppliedId = positiveInteger(supplied.group_id);
      if (supplied.assignment_scope !== 'group' || suppliedId !== resolvedGroupId) {
        return invalidInheritance(
          rejectInvalidInheritance,
          'web_intake_runtime_group_scope_mismatch',
          'La configuración de grupo no coincide con el ámbito solicitado.'
        );
      }
      return supplied;
    }
    return models.IntakeConfig.findOne({
      where: { assignment_scope: 'group', group_id: resolvedGroupId },
      ...queryOptions(transaction),
    });
  }

  const resolvedClinicId = positiveInteger(clinicId);
  if (scopeType !== 'clinic' || !resolvedClinicId) return null;
  const direct = directRecord === undefined
    ? await models.IntakeConfig.findOne({
      where: { assignment_scope: 'clinic', clinic_id: resolvedClinicId },
      ...queryOptions(transaction),
    })
    : directRecord;
  const inheritancePresent = Boolean(
    direct?.config
    && Object.prototype.hasOwnProperty.call(direct.config, 'runtime_inheritance')
  );
  const inheritance = parseRuntimeInheritance(direct?.config?.runtime_inheritance);
  if (direct) {
    // Un marker malformado no puede degradarse a override directo: podría
    // reactivar un HMAC/materialización antigua tras un rollout de grupo.
    if (inheritancePresent && !inheritance) {
      return invalidInheritance(
        rejectInvalidInheritance,
        'web_intake_runtime_inheritance_invalid',
        'La configuración heredada de la clínica no es íntegra.',
        { clinic_id: resolvedClinicId }
      );
    }
    if (recordDeclaresRuntime(direct) && !inheritance) return direct;
  }

  const hintedGroupId = positiveInteger(groupIdHint);
  const clinic = models.Clinica?.findByPk
    ? await models.Clinica.findByPk(resolvedClinicId, {
      attributes: ['grupoClinicaId'],
      ...queryOptions(transaction),
    })
    : null;
  const actualGroupId = models.Clinica?.findByPk
    ? positiveInteger(clinic?.grupoClinicaId)
    : hintedGroupId;
  if (!actualGroupId || (hintedGroupId && hintedGroupId !== actualGroupId)) {
    return inheritancePresent
      ? invalidInheritance(
        rejectInvalidInheritance,
        'web_intake_runtime_inheritance_membership_mismatch',
        'La clínica ya no pertenece al grupo de su runtime heredado.',
        { clinic_id: resolvedClinicId }
      )
      : null;
  }
  if (inheritance && (inheritance.type !== 'group' || inheritance.id !== actualGroupId)) {
    return invalidInheritance(
      rejectInvalidInheritance,
      'web_intake_runtime_inheritance_scope_mismatch',
      'El runtime heredado apunta a otro ámbito.',
      { clinic_id: resolvedClinicId, group_id: actualGroupId }
    );
  }

  const inherited = groupRecord === undefined
    ? await models.IntakeConfig.findOne({
      where: { assignment_scope: 'group', group_id: actualGroupId },
      ...queryOptions(transaction),
    })
    : groupRecord;
  if (
    inherited
    && (
      inherited.assignment_scope !== 'group'
      || positiveInteger(inherited.group_id) !== actualGroupId
    )
  ) {
    return invalidInheritance(
      rejectInvalidInheritance,
      'web_intake_runtime_inheritance_group_record_mismatch',
      'La configuración de grupo cargada no coincide con la clínica.',
      { clinic_id: resolvedClinicId, group_id: actualGroupId }
    );
  }
  const locations = Array.isArray(inherited?.config?.locations) ? inherited.config.locations : [];
  const includesClinic = locations.some((location) => (
    positiveInteger(location?.id ?? location?.clinic_id) === resolvedClinicId
  ));
  if (!includesClinic) {
    return inheritancePresent
      ? invalidInheritance(
        rejectInvalidInheritance,
        'web_intake_runtime_inheritance_location_missing',
        'La clínica no está incluida en las ubicaciones del runtime heredado.',
        { clinic_id: resolvedClinicId, group_id: actualGroupId }
      )
      : null;
  }
  return preserveClinicConfig && direct
    ? materializeInheritedIntakeConfig(direct, inherited, actualGroupId)
    : inherited;
}

function publicScopeMismatch(message, details = undefined) {
  throw new WebEffectiveIntakeConfigError(
    'web_intake_public_scope_mismatch',
    message,
    details
  );
}

function recordScope(record) {
  const value = plainIntakeConfig(record);
  if (!value) return null;
  if (value.assignment_scope === 'clinic') {
    const id = positiveInteger(value.clinic_id);
    return id ? { type: 'clinic', id } : null;
  }
  if (value.assignment_scope === 'group') {
    const id = positiveInteger(value.group_id);
    return id ? { type: 'group', id } : null;
  }
  return null;
}

/**
 * Resolve the three public-intake lookup results into one compatible clinic /
 * group identity before any credential is considered. Domain lookup is an
 * additional proof of that same identity, never a second authentication scope.
 */
async function resolveEffectivePublicIntakeRecords({
  clinicCfg = null,
  groupCfg = null,
  domainCfg = null,
  clinicId = null,
  groupId = null,
  models = db,
  transaction = null,
} = {}) {
  const directClinic = plainIntakeConfig(clinicCfg);
  const suppliedGroup = plainIntakeConfig(groupCfg);
  const domainRecord = plainIntakeConfig(domainCfg);
  const clinicScope = recordScope(directClinic);
  const groupScope = recordScope(suppliedGroup);
  const domainScope = recordScope(domainRecord);

  if (directClinic && clinicScope?.type !== 'clinic') {
    publicScopeMismatch('La configuración indicada como clínica no pertenece a una clínica.');
  }
  if (suppliedGroup && groupScope?.type !== 'group') {
    publicScopeMismatch('La configuración indicada como grupo no pertenece a un grupo.');
  }
  if (domainRecord && !domainScope) {
    publicScopeMismatch('La configuración localizada por dominio no tiene un ámbito válido.');
  }

  const clinicIds = new Set([
    positiveInteger(clinicId),
    clinicScope?.type === 'clinic' ? clinicScope.id : null,
    domainScope?.type === 'clinic' ? domainScope.id : null,
  ].filter(Boolean));
  if (clinicIds.size > 1) {
    publicScopeMismatch(
      'La clínica indicada no coincide con la configuración localizada.',
      { clinic_ids: [...clinicIds] }
    );
  }
  const effectiveClinicId = [...clinicIds][0] || null;

  let actualGroupId = null;
  if (effectiveClinicId && models.Clinica?.findByPk) {
    const clinic = await models.Clinica.findByPk(effectiveClinicId, {
      attributes: ['grupoClinicaId'],
      ...queryOptions(transaction),
    });
    if (!clinic) {
      publicScopeMismatch(
        'La clínica indicada no existe o ya no está disponible.',
        { clinic_id: effectiveClinicId }
      );
    }
    actualGroupId = positiveInteger(clinic?.grupoClinicaId);
  }
  const suppliedGroupIds = [
    positiveInteger(groupId),
    groupScope?.type === 'group' ? groupScope.id : null,
    domainScope?.type === 'group' ? domainScope.id : null,
  ].filter(Boolean);
  if (effectiveClinicId && models.Clinica?.findByPk && !actualGroupId && suppliedGroupIds.length) {
    publicScopeMismatch(
      'La clínica indicada no pertenece al grupo suministrado.',
      { clinic_id: effectiveClinicId, group_ids: suppliedGroupIds }
    );
  }
  const groupIds = new Set([
    ...suppliedGroupIds,
    actualGroupId,
  ].filter(Boolean));
  if (groupIds.size > 1) {
    publicScopeMismatch(
      'El grupo indicado no coincide con la pertenencia efectiva de la clínica.',
      { clinic_id: effectiveClinicId, group_ids: [...groupIds] }
    );
  }
  const effectiveGroupId = [...groupIds][0] || null;

  let effectiveGroupCfg = suppliedGroup;
  if (!effectiveGroupCfg && effectiveGroupId) {
    effectiveGroupCfg = await models.IntakeConfig.findOne({
      where: { assignment_scope: 'group', group_id: effectiveGroupId },
      ...queryOptions(transaction),
    });
  }
  if (effectiveGroupCfg) {
    effectiveGroupCfg = await effectiveIntakeConfigForScope({
      scopeType: 'group',
      groupId: effectiveGroupId,
      groupRecord: effectiveGroupCfg,
      rejectInvalidInheritance: true,
      models,
      transaction,
    });
  }

  // In a domain-only request, the domain's clinic row is the narrow owner.
  // Materializing it with the current group runtime preserves its local
  // campaigns/domains while preventing the broader group candidate from
  // winning merely because both share the same HMAC.
  const narrowDirect = directClinic || (domainScope?.type === 'clinic' ? domainRecord : null);
  let effectiveClinicCfg = null;
  if (effectiveClinicId) {
    effectiveClinicCfg = await effectiveIntakeConfigForScope({
      scopeType: 'clinic',
      clinicId: effectiveClinicId,
      groupIdHint: effectiveGroupId,
      directRecord: narrowDirect || undefined,
      groupRecord: effectiveGroupCfg || undefined,
      preserveClinicConfig: true,
      rejectInvalidInheritance: true,
      models,
      transaction,
    });
  }

  let effectiveDomainCfg = null;
  if (domainScope?.type === 'clinic') effectiveDomainCfg = effectiveClinicCfg;
  else if (domainScope?.type === 'group') effectiveDomainCfg = effectiveGroupCfg;

  return {
    clinicCfg: effectiveClinicCfg,
    groupCfg: effectiveGroupCfg,
    domainCfg: effectiveDomainCfg,
  };
}

module.exports = {
  WebEffectiveIntakeConfigError,
  effectiveIntakeConfigForScope,
  materializeInheritedIntakeConfig,
  resolveEffectivePublicIntakeRecords,
};
