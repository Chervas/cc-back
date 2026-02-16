'use strict';

const { Op } = require('sequelize');
const { AccessPolicyOverride, UsuarioClinica, Clinica } = require('../../models');
const { ADMIN_USER_IDS, STAFF_ROLES, isGlobalAdmin } = require('../lib/role-helpers');
const ALLOWED_SCOPE_TYPES = new Set(['group', 'clinic']);
const ALLOWED_FEATURE_KEYS = new Set(['marketing']);
const ALLOWED_ROLE_CODES = new Set(['doctor', 'assistant', 'reception', 'admin_staff', 'unknown']);
const ALLOWED_EFFECTS = new Set(['allow', 'deny']);

const isAdmin = (userId) => ADMIN_USER_IDS.includes(Number(userId));

const parseIntOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const normalizeScopeType = (value) => String(value || '').trim().toLowerCase();
const normalizeFeatureKey = (value) => String(value || '').trim().toLowerCase();
const normalizeRoleCode = (value) => String(value || '').trim().toLowerCase();

async function getScopeAccess(actorId) {
  if (isAdmin(actorId)) {
    const clinics = await Clinica.findAll({
      attributes: ['id_clinica', 'grupoClinicaId'],
      raw: true,
    });

    const clinicIds = clinics.map((c) => Number(c.id_clinica)).filter(Number.isFinite);
    const groupIds = clinics
      .map((c) => Number(c.grupoClinicaId))
      .filter(Number.isFinite);

    return {
      readClinicIds: clinicIds,
      readGroupIds: [...new Set(groupIds)],
      ownerClinicIds: clinicIds,
      ownerGroupIds: [...new Set(groupIds)],
    };
  }

  const rows = await UsuarioClinica.findAll({
    where: {
      id_usuario: actorId,
      rol_clinica: { [Op.in]: STAFF_ROLES },
    },
    attributes: ['id_clinica', 'rol_clinica'],
    raw: true,
  });

  const clinicIds = rows.map((r) => Number(r.id_clinica)).filter(Number.isFinite);
  const clinicRows = clinicIds.length
    ? await Clinica.findAll({
        where: { id_clinica: { [Op.in]: clinicIds } },
        attributes: ['id_clinica', 'grupoClinicaId'],
        raw: true,
      })
    : [];
  const groupByClinicId = new Map(
    clinicRows
      .map((c) => [Number(c.id_clinica), Number(c.grupoClinicaId)])
      .filter(([, groupId]) => Number.isFinite(groupId)),
  );

  const readClinicIds = [];
  const ownerClinicIds = [];
  const readGroupIds = [];
  const ownerGroupIds = [];

  for (const row of rows) {
    const clinicId = Number(row.id_clinica);
    const groupId = Number(groupByClinicId.get(clinicId));
    const isOwner = row.rol_clinica === 'propietario';

    if (Number.isFinite(clinicId)) {
      readClinicIds.push(clinicId);
      if (isOwner) ownerClinicIds.push(clinicId);
    }

    if (Number.isFinite(groupId)) {
      readGroupIds.push(groupId);
      if (isOwner) ownerGroupIds.push(groupId);
    }
  }

  return {
    readClinicIds: [...new Set(readClinicIds)],
    readGroupIds: [...new Set(readGroupIds)],
    ownerClinicIds: [...new Set(ownerClinicIds)],
    ownerGroupIds: [...new Set(ownerGroupIds)],
  };
}

function isScopeReadable(scopeAccess, scopeType, scopeId) {
  if (scopeType === 'clinic') return scopeAccess.readClinicIds.includes(scopeId);
  if (scopeType === 'group') return scopeAccess.readGroupIds.includes(scopeId);
  return false;
}

function isScopeWritable(actorId, scopeAccess, scopeType, scopeId) {
  if (isAdmin(actorId)) return true;
  if (scopeType === 'clinic') return scopeAccess.ownerClinicIds.includes(scopeId);
  if (scopeType === 'group') return scopeAccess.ownerGroupIds.includes(scopeId);
  return false;
}

exports.getOverrides = async (req, res) => {
  try {
    const actorId = Number(req.userData?.userId);
    if (!Number.isFinite(actorId)) {
      return res.status(401).json({ message: 'Auth failed!' });
    }

    const scopeType = normalizeScopeType(req.query.scope_type);
    const scopeId = parseIntOrNull(req.query.scope_id);
    const featureKey = normalizeFeatureKey(req.query.feature_key || 'marketing');

    if (!ALLOWED_FEATURE_KEYS.has(featureKey)) {
      return res.status(400).json({ message: 'feature_key invalid' });
    }

    const scopeAccess = await getScopeAccess(actorId);
    const where = { feature_key: featureKey };

    if (scopeType && scopeId != null) {
      if (!ALLOWED_SCOPE_TYPES.has(scopeType)) {
        return res.status(400).json({ message: 'scope_type invalid' });
      }
      if (!isScopeReadable(scopeAccess, scopeType, scopeId)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
      where.scope_type = scopeType;
      where.scope_id = scopeId;
    } else {
      const clauses = [];
      if (scopeAccess.readClinicIds.length) {
        clauses.push({ scope_type: 'clinic', scope_id: { [Op.in]: scopeAccess.readClinicIds } });
      }
      if (scopeAccess.readGroupIds.length) {
        clauses.push({ scope_type: 'group', scope_id: { [Op.in]: scopeAccess.readGroupIds } });
      }
      if (!clauses.length) {
        return res.json({ feature_key: featureKey, items: [] });
      }
      where[Op.or] = clauses;
    }

    const rows = await AccessPolicyOverride.findAll({
      where,
      attributes: ['scope_type', 'scope_id', 'feature_key', 'role_code', 'effect', 'updated_at'],
      order: [['scope_type', 'ASC'], ['scope_id', 'ASC'], ['role_code', 'ASC']],
      raw: true,
    });

    return res.json({
      feature_key: featureKey,
      items: rows.map((r) => ({
        scope_type: r.scope_type,
        scope_id: Number(r.scope_id),
        feature_key: r.feature_key,
        role_code: r.role_code,
        effect: r.effect,
        updated_at: r.updated_at,
      })),
    });
  } catch (error) {
    console.error('[accessPolicy.getOverrides] Error:', error);
    return res.status(500).json({ message: 'Error retrieving access policy overrides', error: error.message });
  }
};

exports.upsertOverride = async (req, res) => {
  try {
    const actorId = Number(req.userData?.userId);
    if (!Number.isFinite(actorId)) {
      return res.status(401).json({ message: 'Auth failed!' });
    }

    const scopeType = normalizeScopeType(req.body.scope_type);
    const scopeId = parseIntOrNull(req.body.scope_id);
    const featureKey = normalizeFeatureKey(req.body.feature_key || 'marketing');
    const roleCode = normalizeRoleCode(req.body.role_code);
    const state = String(req.body.state ?? req.body.effect ?? '').trim().toLowerCase();

    if (!ALLOWED_SCOPE_TYPES.has(scopeType)) {
      return res.status(400).json({ message: 'scope_type invalid' });
    }
    if (scopeId == null) {
      return res.status(400).json({ message: 'scope_id invalid' });
    }
    if (!ALLOWED_FEATURE_KEYS.has(featureKey)) {
      return res.status(400).json({ message: 'feature_key invalid' });
    }
    if (!ALLOWED_ROLE_CODES.has(roleCode)) {
      return res.status(400).json({ message: 'role_code invalid' });
    }

    let effect = null;
    if (state && state !== 'inherit' && state !== 'null') {
      if (!ALLOWED_EFFECTS.has(state)) {
        return res.status(400).json({ message: 'state/effect invalid' });
      }
      effect = state;
    }

    const scopeAccess = await getScopeAccess(actorId);
    if (!isScopeWritable(actorId, scopeAccess, scopeType, scopeId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const keyWhere = {
      scope_type: scopeType,
      scope_id: scopeId,
      feature_key: featureKey,
      role_code: roleCode,
    };

    if (!effect) {
      await AccessPolicyOverride.destroy({ where: keyWhere });
      return res.json({
        removed: true,
        item: {
          scope_type: scopeType,
          scope_id: scopeId,
          feature_key: featureKey,
          role_code: roleCode,
          effect: null,
        },
      });
    }

    const [row, created] = await AccessPolicyOverride.findOrCreate({
      where: keyWhere,
      defaults: {
        ...keyWhere,
        effect,
        updated_by: actorId,
      },
    });

    if (!created) {
      row.effect = effect;
      row.updated_by = actorId;
      await row.save();
    }

    return res.json({
      removed: false,
      item: {
        scope_type: row.scope_type,
        scope_id: Number(row.scope_id),
        feature_key: row.feature_key,
        role_code: row.role_code,
        effect: row.effect,
        updated_at: row.updated_at,
      },
    });
  } catch (error) {
    console.error('[accessPolicy.upsertOverride] Error:', error);
    return res.status(500).json({ message: 'Error updating access policy override', error: error.message });
  }
};
