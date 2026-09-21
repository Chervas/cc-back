'use strict';
const { hash } = require('./adapter');
const ROLES = new Set(['Doctores', 'Auxiliares y enfermeros', 'Administrativos']);
function validateRoster(plan) {
  if (plan.version !== 1 || plan.target !== 'crm' || plan.group_id !== 29 || !Array.isArray(plan.staff) || !plan.staff.length || plan.staff.length > 20) throw Error('STAFF_PLAN_INVALID');
  const emails = new Set(), ids = new Set();
  for (const p of plan.staff) {
    if (!p.name || !p.alias || !/^[a-z0-9-]+$/.test(p.alias) || !ROLES.has(p.role)
      || !Array.isArray(p.clinics) || !p.clinics.length || p.clinics.some(id => ![66,72].includes(id))
      || new Set(p.clinics).size !== p.clinics.length || emails.has(p.alias)) throw Error('STAFF_ENTRY_INVALID');
    if (p.booking_clinics && (!Array.isArray(p.booking_clinics) || p.booking_clinics.some(id=>!p.clinics.includes(id)))) throw Error('STAFF_BOOKING_SCOPE');
    if (p.id != null && (!Number.isSafeInteger(p.id) || p.id < 10 || ids.has(p.id) || !p.expected_name)) throw Error('STAFF_EXISTING_ID_INVALID');
    emails.add(p.alias); if (p.id) ids.add(p.id);
  }
  if (!/^[a-z0-9.]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(plan.mailbox)) throw Error('STAFF_TEMPORARY_MAILBOX_INVALID');
  return plan;
}
function aliasEmail(mailbox, tag) { const [name,domain] = mailbox.split('@'); return `${name}+bs-${tag}@${domain}`; }
function assertActivationIdentity(entry, user, memberships, allowedClinics) {
  if (!user || Number(user.id_usuario) !== entry.id || user.nombre !== entry.expected_name
    || !user.es_provisional || user.estado_cuenta !== 'activo') throw Error('STAFF_NOT_MATCHING_PROVISIONAL');
  if (!memberships.length || memberships.some(m => !allowedClinics.includes(Number(m.id_clinica)) || !['personaldeclinica','propietario'].includes(m.rol_clinica))) throw Error('STAFF_OUTSIDE_AUTHORIZED_SCOPE');
}
async function activateEntry(c, entry, { actorId, allowedClinics }) {
  let id = entry.id;
  if (id) {
    const [[user]] = await c.query('SELECT * FROM Usuarios WHERE id_usuario=? FOR UPDATE',[id]);
    const [memberships] = await c.query('SELECT * FROM UsuarioClinica WHERE id_usuario=? FOR UPDATE',[id]);
    assertActivationIdentity(entry,user,memberships,allowedClinics);
    const [r] = await c.query('UPDATE Usuarios SET email_usuario=?,password_usuario=?,es_provisional=0,isProfesional=1,updatedAt=UTC_TIMESTAMP() WHERE id_usuario=? AND es_provisional=1', [entry.email,entry.password_hash,id]);
    if (r.affectedRows !== 1) throw Error('STAFF_ACTIVATION_CHANGED');
  } else {
    const [r] = await c.query('INSERT INTO Usuarios (nombre,apellidos,email_usuario,password_usuario,isProfesional,estado_cuenta,es_provisional,creado_por,fecha_creacion,createdAt,updatedAt) VALUES (?,?,?, ?,1,\'activo\',0,?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())',[entry.name,entry.surname || '',entry.email,entry.password_hash,actorId]);
    id = Number(r.insertId);
  }
  for (const clinic of entry.clinics) {
    if (!allowedClinics.includes(clinic)) throw Error('STAFF_MEMBERSHIP_SCOPE');
    const [[m]] = await c.query('SELECT * FROM UsuarioClinica WHERE id_usuario=? AND id_clinica=? FOR UPDATE',[id,clinic]);
    if (m) {
      // Keep the pre-existing ownership decision, never grant ownership anew.
      const role = m.rol_clinica === 'propietario' ? 'propietario' : 'personaldeclinica';
      await c.query("UPDATE UsuarioClinica SET rol_clinica=?,subrol_clinica=?,estado_invitacion='aceptada',invite_token=NULL,responded_at=UTC_TIMESTAMP(),updatedAt=UTC_TIMESTAMP() WHERE id_usuario=? AND id_clinica=?", [role,role === 'propietario' ? m.subrol_clinica : entry.role,id,clinic]);
    } else {
      await c.query("INSERT INTO UsuarioClinica (id_usuario,id_clinica,rol_clinica,subrol_clinica,estado_invitacion,invitado_por,responded_at,createdAt,updatedAt) VALUES (?,?,'personaldeclinica',?,'aceptada',?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())",[id,clinic,entry.role,actorId]);
    }
    if (entry.booking_clinics && !entry.booking_clinics.includes(clinic)) continue;
    const [professionals] = await c.query('SELECT * FROM DoctorClinicas WHERE doctor_id=? AND clinica_id=? FOR UPDATE',[id,clinic]);
    if (professionals.length > 1) throw Error('STAFF_PROFESSIONAL_DUPLICATE');
    if (professionals.length) await c.query('UPDATE DoctorClinicas SET rol_en_clinica=?,activo=1,recibe_citas=1,updated_at=UTC_TIMESTAMP() WHERE id=?',[entry.role,professionals[0].id]);
    else await c.query('INSERT INTO DoctorClinicas (doctor_id,clinica_id,rol_en_clinica,activo,recibe_citas,created_at,updated_at) VALUES (?,?,?,1,1,UTC_TIMESTAMP(),UTC_TIMESTAMP())',[id,clinic,entry.role]);
  }
  const [[saved]] = await c.query('SELECT id_usuario,email_usuario,password_usuario,es_provisional,estado_cuenta FROM Usuarios WHERE id_usuario=?',[id]);
  if (saved.email_usuario !== entry.email || saved.password_usuario !== entry.password_hash || saved.es_provisional || saved.estado_cuenta !== 'activo') throw Error('STAFF_POST_WRITE_MISMATCH');
  return { id, email:entry.email, name:entry.name, clinics:entry.clinics, role:entry.role };
}
module.exports = { validateRoster, aliasEmail, assertActivationIdentity, activateEntry, hash };
