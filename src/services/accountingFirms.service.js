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
} = db;

function domainError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readablePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(15);
  const value = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  return `${value.slice(0, 5)}-${value.slice(5, 10)}-${value.slice(10, 15)}`;
}

function portalUrl() {
  return String(process.env.ACCOUNTING_PORTAL_URL || 'http://localhost:4203/gestoria').replace(/\/+$/, '');
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
    where: { firm_id: firmId, status: 'active' },
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

async function issueCredentials({ clinicId, actorId }) {
  return sequelize.transaction(async (transaction) => {
    const { firm, clinics } = await ensureFirmForClinic(clinicId, transaction);
    const existingLink = await AccountingFirmUser.findOne({
      where: { firm_id: firm.id, status: 'active' },
      order: [['created_at', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    let user = existingLink
      ? await Usuario.findByPk(existingLink.user_id, { transaction, lock: transaction.LOCK.UPDATE })
      : null;
    if (!user) {
      const base = firm.scope_key.replace(':', '-');
      let email = `gestoria+${base}@acceso.clinicaclick.com`;
      const duplicate = await Usuario.findOne({ where: { email_usuario: email }, transaction });
      if (duplicate) email = `gestoria+${base}-${crypto.randomBytes(2).toString('hex')}@acceso.clinicaclick.com`;
      user = await Usuario.create({
        nombre: 'Gestoría',
        apellidos: firm.name.replace(/^Gestoría\s*·\s*/, ''),
        email_usuario: email,
        email_factura: email,
        email_notificacion: email,
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
    const password = readablePassword();
    await user.update({
      password_usuario: await bcrypt.hash(password, 10),
      estado_cuenta: 'activo',
    }, { transaction });
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
    const base = serializeFirm(firm, clinics, user);
    const message = [
      `Acceso a ${firm.name}`,
      `URL: ${base.portal_url}`,
      `Usuario: ${user.email_usuario}`,
      `Contraseña temporal: ${password}`,
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

async function activeFirmLink(actorId) {
  return AccountingFirmUser.findOne({
    where: { user_id: positiveInteger(actorId), status: 'active' },
    order: [['created_at', 'DESC']],
  });
}

async function isPortalUser({ actorId }) {
  return !!(await activeFirmLink(actorId));
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
  isPortalUser,
  portalScope,
  assertPortalClinic,
};
