'use strict';

const { Op } = require('sequelize');
const {
  Clinica,
  GrupoClinica
} = require('../../models');

/**
 * Normaliza el identificador recibido (numero, CSV, group:ID, all)
 * y devuelve el contexto de alcance para consultas relacionadas
 * con clínicas/grupos.
 *
 * @param {string|number|null|undefined} rawValue Identificador recibido desde la ruta o query
 * @param {{ allowAll?: boolean }} [options]
 * @returns {Promise<{ scope: 'clinic'|'group'|'multi'|'all', clinicIds: number[], groupId: number|null, group?: any, original: string|null, isAll: boolean, isValid: boolean, notFound: boolean }>}
 */
async function resolveClinicScope(rawValue, options = {}) {
  const { allowAll = false } = options;
  const original = rawValue == null ? null : String(rawValue).trim();
  const result = {
    scope: 'clinic',
    clinicIds: [],
    groupId: null,
    group: null,
    original,
    isAll: false,
    isValid: false,
    notFound: false
  };

  if (!original || original.toLowerCase() === 'null' || original.toLowerCase() === 'undefined') {
    return result;
  }

  if (allowAll && original.toLowerCase() === 'all') {
    const clinics = await Clinica.findAll({ attributes: ['id_clinica'], raw: true });
    result.scope = 'all';
    result.isAll = true;
    result.clinicIds = clinics.map(c => c.id_clinica);
    result.isValid = true;
    return result;
  }

  if (original.startsWith('group:')) {
    const idStr = original.slice(6).trim();
    const groupId = Number.parseInt(idStr, 10);
    if (!Number.isInteger(groupId)) {
      return result;
    }

    const group = await GrupoClinica.findByPk(groupId, {
      include: [{ model: Clinica, as: 'clinicas', attributes: ['id_clinica'] }]
    });

    if (!group) {
      result.scope = 'group';
      result.groupId = groupId;
      result.notFound = true;
      return result;
    }

    const clinics = Array.isArray(group.clinicas) ? group.clinicas : [];
    result.scope = 'group';
    result.groupId = groupId;
    result.group = group.get ? group.get({ plain: true }) : group;
    result.clinicIds = clinics.map(c => c.id_clinica).filter(Number.isInteger);
    result.isValid = true;
    return result;
  }

  // CSV de clínicas ("12,14,27")
  if (original.includes(',')) {
    const ids = original
      .split(',')
      .map(v => Number.parseInt(v.trim(), 10))
      .filter(Number.isInteger);

    if (ids.length) {
      result.scope = ids.length > 1 ? 'multi' : 'clinic';
      result.clinicIds = ids;
      result.isValid = true;
    }
    return result;
  }

  const single = Number.parseInt(original, 10);
  if (Number.isInteger(single)) {
    result.scope = 'clinic';
    result.clinicIds = [single];
    result.isValid = true;
  }

  return result;
}

/**
 * Construye un filtro Sequelize sencillo en base a un listado de clínicas.
 * Devuelve null si el array está vacío (para poder omitir el filtro).
 *
 * @param {string} field Nombre del campo a filtrar
 * @param {number[]} clinicIds Listado de IDs de clínicas
 * @returns {object|null}
 */
function buildClinicWhere(field, clinicIds) {
  if (!Array.isArray(clinicIds) || clinicIds.length === 0) {
    return null;
  }
  if (clinicIds.length === 1) {
    return { [field]: clinicIds[0] };
  }
  return { [field]: { [Op.in]: clinicIds } };
}

/**
 * Devuelve una clausula WHERE para activos (Meta/Google Ads) contemplando
 * asignaciones por clínica o por grupo.
 *
 * @param {{ scope: string, clinicIds: number[], groupId: number|null }} scope
 * @param {{ includeGroupFallback?: boolean }} [options]
 * @returns {object}
 */
function buildAssetScopeWhere(scope, options = {}) {
  const { includeGroupFallback = true } = options;
  const where = { isActive: true };

  if (scope?.scope === 'group' && scope.groupId) {
    const clauses = [];
    clauses.push({ assignmentScope: 'group', grupoClinicaId: scope.groupId });
    if (includeGroupFallback && Array.isArray(scope.clinicIds) && scope.clinicIds.length) {
      clauses.push({ clinicaId: { [Op.in]: scope.clinicIds } });
    }
    where[Op.or] = clauses;
    return where;
  }

  if (Array.isArray(scope?.clinicIds) && scope.clinicIds.length) {
    if (scope.clinicIds.length === 1) {
      where.clinicaId = scope.clinicIds[0];
    } else {
      where.clinicaId = { [Op.in]: scope.clinicIds };
    }
  }

  return where;
}

module.exports = {
  resolveClinicScope,
  buildClinicWhere,
  buildAssetScopeWhere
};

