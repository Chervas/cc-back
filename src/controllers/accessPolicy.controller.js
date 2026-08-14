'use strict';

const { Op } = require('sequelize');
const {
  AccessPolicyOverride,
  UsuarioClinica,
  Clinica,
  Usuario,
  PatientDirectionProfile,
  PatientDirectionSetting,
} = require('../../models');
const { ADMIN_USER_IDS, STAFF_ROLES } = require('../lib/role-helpers');
const {
  ALLOWED_FEATURE_KEYS,
  ALLOWED_ROLE_CODES,
  getAccessPolicyCatalog,
  roleCodeFromMembership,
  normalizeFeatureKey,
  normalizeRoleCode,
} = require('../lib/access-policy');
const ALLOWED_SCOPE_TYPES = new Set(['group', 'clinic']);
const ALLOWED_EFFECTS = new Set(['allow', 'deny']);

const isAdmin = (userId) => ADMIN_USER_IDS.includes(Number(userId));

const parseIntOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const normalizeScopeType = (value) => String(value || '').trim().toLowerCase();

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

exports.getCatalog = async (req, res) => {
  try {
    const actorId = Number(req.userData?.userId);
    if (!Number.isFinite(actorId)) {
      return res.status(401).json({ message: 'Auth failed!' });
    }

    return res.json(getAccessPolicyCatalog());
  } catch (error) {
    console.error('[accessPolicy.getCatalog] Error:', error);
    return res.status(500).json({ message: 'Error retrieving access policy catalog', error: error.message });
  }
};

exports.getOverrides = async (req, res) => {
  try {
    const actorId = Number(req.userData?.userId);
    if (!Number.isFinite(actorId)) {
      return res.status(401).json({ message: 'Auth failed!' });
    }

    const scopeType = normalizeScopeType(req.query.scope_type);
    const scopeId = parseIntOrNull(req.query.scope_id);
    const requestedFeatureKey = req.query.feature_key ? normalizeFeatureKey(req.query.feature_key) : null;

    if (requestedFeatureKey && !ALLOWED_FEATURE_KEYS.has(requestedFeatureKey)) {
      return res.status(400).json({ message: 'feature_key invalid' });
    }

    const scopeAccess = await getScopeAccess(actorId);
    const where = requestedFeatureKey
      ? { feature_key: requestedFeatureKey }
      : { feature_key: { [Op.in]: Array.from(ALLOWED_FEATURE_KEYS) } };

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
        return res.json({ feature_key: requestedFeatureKey || 'all', items: [] });
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
      feature_key: requestedFeatureKey || 'all',
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

async function getClinicRowsForScope(scopeType, scopeId) {
  if (scopeType === 'clinic') {
    const clinic = await Clinica.findByPk(scopeId, {
      attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'],
      raw: true,
    });
    return clinic ? [clinic] : [];
  }

  return Clinica.findAll({
    where: { grupoClinicaId: scopeId },
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'],
    order: [['nombre_clinica', 'ASC']],
    raw: true,
  });
}

exports.getAssignments = async (req, res) => {
  try {
    const actorId = Number(req.userData?.userId);
    if (!Number.isFinite(actorId)) {
      return res.status(401).json({ message: 'Auth failed!' });
    }

    const scopeType = normalizeScopeType(req.query.scope_type);
    const scopeId = parseIntOrNull(req.query.scope_id);

    if (!ALLOWED_SCOPE_TYPES.has(scopeType)) {
      return res.status(400).json({ message: 'scope_type invalid' });
    }
    if (scopeId == null) {
      return res.status(400).json({ message: 'scope_id invalid' });
    }

    const scopeAccess = await getScopeAccess(actorId);
    if (!isScopeReadable(scopeAccess, scopeType, scopeId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const clinics = await getClinicRowsForScope(scopeType, scopeId);
    const clinicIds = clinics.map((clinic) => Number(clinic.id_clinica)).filter(Number.isFinite);
    if (!clinicIds.length) {
      return res.json({ scope_type: scopeType, scope_id: scopeId, roles: [], total: 0 });
    }

    const [memberships, patientDirectionSettings] = await Promise.all([
      UsuarioClinica.findAll({
        where: {
          id_clinica: { [Op.in]: clinicIds },
          rol_clinica: { [Op.in]: STAFF_ROLES },
        },
        attributes: ['id_usuario', 'id_clinica', 'rol_clinica', 'subrol_clinica', 'estado_invitacion'],
        order: [['id_clinica', 'ASC'], ['rol_clinica', 'ASC'], ['subrol_clinica', 'ASC']],
        raw: true,
      }),
      PatientDirectionSetting.findAll({
        where: {
          clinic_id: { [Op.in]: clinicIds },
          director_user_id: { [Op.ne]: null },
        },
        attributes: ['clinic_id', 'director_user_id', 'is_enabled'],
        order: [['clinic_id', 'ASC']],
        raw: true,
      }),
    ]);

    const candidateDirectorIds = [...new Set(
      patientDirectionSettings
        .map((row) => Number(row.director_user_id))
        .filter(Number.isFinite),
    )];
    const activeDirectorProfiles = candidateDirectorIds.length
      ? await PatientDirectionProfile.findAll({
          where: {
            user_id: { [Op.in]: candidateDirectorIds },
            is_active: true,
          },
          attributes: ['user_id'],
          raw: true,
        })
      : [];
    const activeDirectorIds = new Set(
      activeDirectorProfiles.map((profile) => Number(profile.user_id)).filter(Number.isFinite),
    );
    const directorAssignments = patientDirectionSettings.filter((setting) =>
      activeDirectorIds.has(Number(setting.director_user_id))
    );
    const userIds = [...new Set([
      ...memberships.map((row) => Number(row.id_usuario)),
      ...directorAssignments.map((row) => Number(row.director_user_id)),
    ].filter(Number.isFinite))];
    const users = userIds.length
      ? await Usuario.findAll({
          where: { id_usuario: { [Op.in]: userIds } },
          attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario', 'avatar', 'cargo_usuario', 'estado_cuenta'],
          raw: true,
        })
      : [];

    const userMap = new Map(users.map((user) => [Number(user.id_usuario), user]));
    const clinicMap = new Map(clinics.map((clinic) => [Number(clinic.id_clinica), clinic]));
    const roleCatalog = getAccessPolicyCatalog().roles || [];
    const roleMap = new Map(roleCatalog.map((role) => [role.code, role]));
    const grouped = new Map();

    for (const membership of memberships) {
      const roleCode = roleCodeFromMembership(membership);
      const user = userMap.get(Number(membership.id_usuario));
      const clinic = clinicMap.get(Number(membership.id_clinica));
      const role = roleMap.get(roleCode);
      if (!grouped.has(roleCode)) {
        grouped.set(roleCode, {
          role_code: roleCode,
          label: role?.label || roleCode,
          description: role?.description || null,
          count: 0,
          users: [],
        });
      }

      const bucket = grouped.get(roleCode);
      bucket.count += 1;
      bucket.users.push({
        id: Number(membership.id_usuario),
        name: [user?.nombre, user?.apellidos].filter(Boolean).join(' ').trim() || user?.email_usuario || `Usuario ${membership.id_usuario}`,
        email: user?.email_usuario || null,
        avatar: user?.avatar || null,
        title: user?.cargo_usuario || null,
        account_status: user?.estado_cuenta || null,
        clinic_id: Number(membership.id_clinica),
        clinic_name: clinic?.nombre_clinica || `Clínica ${membership.id_clinica}`,
        role: membership.rol_clinica,
        subrole: membership.subrol_clinica || null,
        invitation_status: membership.estado_invitacion || null,
      });
    }

    for (const assignment of directorAssignments) {
      const roleCode = 'patient_director';
      const user = userMap.get(Number(assignment.director_user_id));
      const clinic = clinicMap.get(Number(assignment.clinic_id));
      const role = roleMap.get(roleCode);
      if (!grouped.has(roleCode)) {
        grouped.set(roleCode, {
          role_code: roleCode,
          label: role?.label || 'Director de pacientes',
          description: role?.description || null,
          count: 0,
          users: [],
        });
      }

      const bucket = grouped.get(roleCode);
      bucket.count += 1;
      bucket.users.push({
        id: Number(assignment.director_user_id),
        name: [user?.nombre, user?.apellidos].filter(Boolean).join(' ').trim() || user?.email_usuario || `Usuario ${assignment.director_user_id}`,
        email: user?.email_usuario || null,
        avatar: user?.avatar || null,
        title: user?.cargo_usuario || 'Director de pacientes',
        account_status: user?.estado_cuenta || null,
        clinic_id: Number(assignment.clinic_id),
        clinic_name: clinic?.nombre_clinica || `Clínica ${assignment.clinic_id}`,
        role: roleCode,
        subrole: null,
        invitation_status: null,
        assignment_source: 'patient_direction',
        service_enabled: assignment.is_enabled === true || Number(assignment.is_enabled) === 1,
      });
    }

    const roles = roleCatalog
      .map((role) => grouped.get(role.code) || {
        role_code: role.code,
        label: role.label,
        description: role.description || null,
        count: 0,
        users: [],
      })
      .filter((role) => role.count > 0 || ['propietario', 'agencia', 'patient_director', 'doctor', 'assistant', 'reception', 'admin_staff'].includes(role.role_code));

    return res.json({
      scope_type: scopeType,
      scope_id: scopeId,
      clinic_ids: clinicIds,
      total: memberships.length + directorAssignments.length,
      roles,
    });
  } catch (error) {
    console.error('[accessPolicy.getAssignments] Error:', error);
    return res.status(500).json({ message: 'Error retrieving access policy assignments', error: error.message });
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
