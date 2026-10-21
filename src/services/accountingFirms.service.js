'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');

const {
  sequelize,
  AccountingFirm,
  AccountingFirmClinicAssignment,
  AccountingFirmUser,
  Clinica,
  GrupoClinica,
  Usuario,
  UsuarioClinica,
  AuthSession,
  AuthEmailChallenge,
  AuthTrustedDevice,
  PasswordResetToken,
  SyncLog,
} = db;

function domainError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function newPassword() {
  return crypto.randomBytes(32).toString('base64url');
}

function accessEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || email.endsWith('@acceso.clinicaclick.com')) {
    throw domainError(400, 'accounting_firm_email_required', 'Indica el correo de acceso de la gestoría. Recibirá las verificaciones de inicio de sesión.');
  }
  return email;
}

function alternateEmails(value) {
  if (typeof value === 'string') { try { return alternateEmails(JSON.parse(value)); } catch { return [value.trim().toLowerCase()]; } }
  if (Array.isArray(value)) return value.flatMap(alternateEmails);
  if (value && typeof value === 'object') return Object.values(value).flatMap(alternateEmails);
  return [];
}

async function invalidateAccess(userId, transaction) {
  const at = new Date();
  await AuthSession.update({ state: 'revoked', ended_at: at }, { where: { user_id: userId, state: 'active' }, transaction });
  await AuthEmailChallenge.update({ state: 'revoked' }, { where: { user_id: userId, state: { [Op.in]: ['pending', 'verified'] } }, transaction });
  await AuthTrustedDevice.update({ revoked_at: at }, { where: { user_id: userId, revoked_at: null }, transaction });
  await PasswordResetToken.update({ status: 'revoked' }, { where: { user_id: userId, status: 'pending' }, transaction });
}

async function assertManagedScope(actorId, clinics) {
  const { canUserAccessFeature } = require('../lib/access-policy');
  for (const clinic of clinics) {
    if (!await canUserAccessFeature({ actorId, clinicId: Number(clinic.id_clinica), featureKey: 'accounting.firm.manage' })) {
      throw domainError(403, 'accounting_firm_scope_forbidden', 'Necesitas gestionar el acceso de todas las clínicas de esta gestoría.');
    }
  }
}

async function recordAccess(firm, user, actorId, action, transaction) {
  await SyncLog.create({ job_type: 'accounting_firm_access', status: 'completed', start_time: new Date(), end_time: new Date(),
    records_processed: 1, status_report: { firm_id: Number(firm.id), user_id: Number(user.id_usuario), actor_id: actorId, action } }, { transaction });
}

function portalUrl() {
  const clean = value => String(value || '').trim().replace(/\/+$/, '');
  const explicit = clean(process.env.ACCOUNTING_PORTAL_URL);
  if (explicit) return explicit;
  // Match the canonical sign-in/reset frontend base; never derive the copied
  // credential link from request Host/Origin or fall back to DEV in public CRM.
  const namespace = process.env.RUNTIME_NAMESPACE || process.env.JOB_RUNTIME_NAMESPACE;
  const base = clean(process.env.EMAIL_PUBLIC_APP_URL) || clean(process.env.FRONTEND_PUBLIC_URL)
    || (namespace === 'dev' ? 'http://localhost:4203' : 'https://crm.clinicaclick.com');
  return `${base}/gestoria`;
}


function serializeFirm(firm, clinics, user = null) {
  return {
    id: firm.public_id,
    name: firm.name,
    scope_type: firm.scope_type,
    scope_key: firm.scope_key,
    active: !!firm.active,
    clinics: clinics.map((clinic) => ({
      id: Number(clinic.id_clinica),
      name: clinic.nombre_clinica,
    })),
    access: user ? {
      configured: true,
      email: user.email_usuario,
      last_login: user.ultimo_login || null,
      status: user.estado_cuenta,
    } : {
      configured: false,
      email: null,
      last_login: null,
      status: null,
    },
    portal_url: portalUrl(),
  };
}

async function ensureFirmForClinic(clinicId, transaction = null) {
  const id = positiveInteger(clinicId);
  const clinic = await Clinica.findByPk(id, {
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'],
    transaction,
  });
  if (!clinic) throw domainError(404, 'clinic_not_found', 'Clínica no encontrada.');
  const groupId = positiveInteger(clinic.grupoClinicaId);
  const scopeKey = groupId ? `group:${groupId}` : `clinic:${id}`;
  let firm = await AccountingFirm.findOne({ where: { scope_key: scopeKey }, transaction });
  if (!firm) {
    const group = groupId
      ? await GrupoClinica.findByPk(groupId, { attributes: ['nombre_grupo'], transaction })
      : null;
    firm = await AccountingFirm.create({
      public_id: crypto.randomUUID(),
      scope_key: scopeKey,
      scope_type: groupId ? 'group' : 'clinic',
      group_id: groupId,
      primary_clinic_id: groupId ? null : id,
      name: `Gestoría · ${group?.nombre_grupo || clinic.nombre_clinica}`,
      active: true,
    }, { transaction });
  }
  const scopedClinics = groupId
    ? await Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica', 'nombre_clinica'],
      order: [['nombre_clinica', 'ASC']],
      transaction,
    })
    : [clinic];
  const scopedClinicIds = scopedClinics.map((scopedClinic) => Number(scopedClinic.id_clinica));
  for (const scopedClinic of scopedClinics) {
    await AccountingFirmClinicAssignment.upsert({
      firm_id: firm.id,
      clinic_id: scopedClinic.id_clinica,
    }, {
      transaction,
    });
  }
  await AccountingFirmClinicAssignment.destroy({
    where: {
      firm_id: firm.id,
      ...(scopedClinicIds.length ? { clinic_id: { [Op.notIn]: scopedClinicIds } } : {}),
    },
    transaction,
  });
  return { firm, clinics: scopedClinics };
}

async function firmUser(firmId, transaction = null) {
  const link = await AccountingFirmUser.findOne({
    where: { firm_id: firmId },
    order: [['created_at', 'DESC']],
    transaction,
  });
  if (!link) return null;
  return Usuario.findByPk(link.user_id, {
    attributes: ['id_usuario', 'email_usuario', 'ultimo_login', 'estado_cuenta'],
    transaction,
  });
}

async function getFirm({ clinicId }) {
  const { firm, clinics } = await ensureFirmForClinic(clinicId);
  return serializeFirm(firm, clinics, await firmUser(firm.id));
}

async function issueCredentials({ clinicId, actorId, email }) {
  return sequelize.transaction(async (transaction) => {
    const { firm, clinics } = await ensureFirmForClinic(clinicId, transaction);
    await firm.reload({ transaction, lock: transaction.LOCK.UPDATE });
    await assertManagedScope(actorId, clinics);
    const resets = await SyncLog.count({ where: { job_type: 'accounting_firm_access', status: 'completed',
      start_time: { [Op.gte]: new Date(Date.now() - 15 * 60000) },
      [Op.and]: [require('sequelize').where(require('sequelize').json('status_report.firm_id'), Number(firm.id))] }, transaction });
    if (resets >= 5) throw domainError(429, 'accounting_firm_rate_limited', 'Se han realizado demasiados cambios de acceso. Espera unos minutos.');
    // Same directory lock order as canonical administrative credential changes;
    // a primary/alternate address cannot be claimed by concurrent accounts.
    const directory = await Usuario.findAll({ attributes: ['id_usuario', 'email_usuario', 'emails_alternativos'],
      order: [['id_usuario', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    const existingLink = await AccountingFirmUser.findOne({
      where: { firm_id: firm.id },
      order: [['created_at', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    let user = existingLink
      ? await Usuario.findByPk(existingLink.user_id, { transaction, lock: transaction.LOCK.UPDATE })
      : null;
    const normalizedEmail = accessEmail(email ?? user?.email_usuario);
    const duplicate = directory.find(value => [String(value.email_usuario || '').trim().toLowerCase(), ...alternateEmails(value.emails_alternativos)].includes(normalizedEmail));
    if (duplicate && Number(duplicate.id_usuario) !== Number(user?.id_usuario)) {
      throw domainError(409, 'accounting_firm_email_in_use', 'Ese correo ya pertenece a otra cuenta.');
    }
    if (!user) {
      user = await Usuario.create({
        nombre: 'Gestoría',
        apellidos: firm.name.replace(/^Gestoría\s*·\s*/, ''),
        email_usuario: normalizedEmail,
        email_factura: normalizedEmail,
        email_notificacion: normalizedEmail,
        password_usuario: '',
        cargo_usuario: 'Gestoría externa',
        estado_cuenta: 'activo',
        es_provisional: false,
        creado_por: actorId,
      }, { transaction });
      await AccountingFirmUser.create({
        firm_id: firm.id,
        user_id: user.id_usuario,
        status: 'active',
      }, { transaction });
    }
    const password = newPassword();
    await user.update({
      password_usuario: await bcrypt.hash(password, 12),
      email_usuario: normalizedEmail,
      email_factura: normalizedEmail,
      email_notificacion: normalizedEmail,
      estado_cuenta: 'activo',
    }, { transaction });
    if (existingLink) await existingLink.update({ status: 'active' }, { transaction });
    await invalidateAccess(user.id_usuario, transaction);
    for (const clinic of clinics) {
      const [membership] = await UsuarioClinica.findOrCreate({
        where: { id_usuario: user.id_usuario, id_clinica: clinic.id_clinica },
        defaults: {
          id_usuario: user.id_usuario,
          id_clinica: clinic.id_clinica,
          rol_clinica: 'personaldeclinica',
          subrol_clinica: 'Gestoría',
          estado_invitacion: 'aceptada',
          invitado_por: actorId,
          fecha_invitacion: new Date(),
          responded_at: new Date(),
        },
        transaction,
      });
      if (membership.subrol_clinica !== 'Gestoría' || membership.rol_clinica !== 'personaldeclinica') {
        await membership.update({
          rol_clinica: 'personaldeclinica',
          subrol_clinica: 'Gestoría',
          estado_invitacion: 'aceptada',
        }, { transaction });
      }
    }
    const clinicIds = clinics.map((clinic) => Number(clinic.id_clinica));
    await UsuarioClinica.destroy({
      where: {
        id_usuario: user.id_usuario,
        subrol_clinica: 'Gestoría',
        ...(clinicIds.length ? { id_clinica: { [Op.notIn]: clinicIds } } : {}),
      },
      transaction,
    });
    await recordAccess(firm, user, actorId, existingLink ? 'reset' : 'create', transaction);
    const base = serializeFirm(firm, clinics, user);
    const message = [
      `Acceso a ${firm.name}`,
      `URL: ${base.portal_url}`,
      `Usuario: ${user.email_usuario}`,
      `Contraseña inicial: ${password}`,
      'El acceso no caduca. Puedes revocarlo o restablecer la contraseña desde Clinicaclick.',
      'Al iniciar sesión se aplican las verificaciones de seguridad del sistema.',
      'Por seguridad, guarda estas credenciales en tu gestor de contraseñas.',
    ].join('\n');
    return {
      ...base,
      credentials: {
        email: user.email_usuario,
        password,
        message,
      },
    };
  });
}

async function revokeAccess({ clinicId, actorId }) {
  return sequelize.transaction(async transaction => {
    const { firm, clinics } = await ensureFirmForClinic(clinicId, transaction);
    await firm.reload({ transaction, lock: transaction.LOCK.UPDATE });
    await assertManagedScope(actorId, clinics);
    const link = await AccountingFirmUser.findOne({ where: { firm_id: firm.id }, order: [['created_at', 'DESC']], transaction });
    const user = link ? await Usuario.findByPk(link.user_id, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (user && (link.status !== 'revoked' || user.estado_cuenta !== 'inactivo')) {
      await user.update({ estado_cuenta: 'inactivo', password_usuario: await bcrypt.hash(newPassword(), 12) }, { transaction });
      await link.update({ status: 'revoked' }, { transaction });
      await invalidateAccess(user.id_usuario, transaction);
      await recordAccess(firm, user, actorId, 'revoke', transaction);
    }
    return serializeFirm(firm, clinics, user);
  });
}

async function activeFirmLink(actorId) {
  return AccountingFirmUser.findOne({
    where: { user_id: positiveInteger(actorId), status: 'active' },
    order: [['created_at', 'DESC']],
  });
}

async function isPortalUser({ actorId }) {
  // Revoked external identities must never fall through to general staff ACLs.
  return !!(await AccountingFirmUser.findOne({ where: { user_id: positiveInteger(actorId) } }));
}

async function portalScope({ actorId }) {
  const link = await activeFirmLink(actorId);
  if (!link) throw domainError(403, 'accounting_portal_forbidden', 'Este usuario no tiene acceso al portal de gestoría.');
  const firm = await AccountingFirm.findByPk(link.firm_id);
  if (!firm?.active) throw domainError(403, 'accounting_firm_inactive', 'El acceso de gestoría está desactivado.');
  const clinics = firm.scope_type === 'group' && positiveInteger(firm.group_id)
    ? await Clinica.findAll({
      where: { grupoClinicaId: Number(firm.group_id) },
      attributes: ['id_clinica', 'nombre_clinica'],
      order: [['nombre_clinica', 'ASC']],
    })
    : await Clinica.findAll({
      where: { id_clinica: positiveInteger(firm.primary_clinic_id) || -1 },
      attributes: ['id_clinica', 'nombre_clinica'],
      order: [['nombre_clinica', 'ASC']],
    });
  const user = await Usuario.findByPk(actorId, {
    attributes: ['id_usuario', 'email_usuario', 'ultimo_login', 'estado_cuenta'],
  });
  if (user?.estado_cuenta !== 'activo') throw domainError(403, 'accounting_portal_forbidden', 'El acceso de gestoría está desactivado.');
  return serializeFirm(firm, clinics, user);
}

async function assertPortalClinic({ actorId, clinicId }) {
  const scope = await portalScope({ actorId });
  const id = positiveInteger(clinicId);
  if (!scope.clinics.some((clinic) => clinic.id === id)) {
    throw domainError(403, 'accounting_portal_clinic_forbidden', 'La clínica no pertenece a esta gestoría.');
  }
  return { scope, clinicId: id };
}

module.exports = {
  domainError,
  getFirm,
  issueCredentials,
  revokeAccess,
  isPortalUser,
  portalScope,
  assertPortalClinic,
};
