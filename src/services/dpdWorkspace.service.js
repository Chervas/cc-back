'use strict';

const { createHash, randomBytes } = require('node:crypto');
const seed = require('../contracts/dpd/workspace.json');
const statuses = ['Por revisar', 'En curso', 'Parcial', 'Sin evidencia suficiente', 'Brecha identificada',
  'Condicionado al supuesto', 'Acreditado en el alcance indicado', 'Validación del DPD pendiente', 'Validado por el DPD', 'No aplica'];
const reviewKeys = new Set([...seed.checklist, ...seed.controls, ...seed.tasks].map(item => 'review-' + item.id));
const fieldKeys = new Set(seed.fields.filter(f => f.scope === 'modelo').map(f => 'field-' + f.key));
const text = (value, max) => typeof value === 'string' && value.length <= max;
const error = (status, message) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const conflict = () => error(409, 'Otra sesión ha actualizado este apartado. Recarga para ver su versión.');
const guestKey = 'guest-access';

function cleanValue(key, input) {
  if (key === 'contract' && Array.isArray(input) && input.length > 0 && input.length <= 120
      && input.every(b => b && text(b.title, 300) && b.title.trim() && text(b.text, 50000))
      && JSON.stringify(input).length <= 250000) {
    return input.map(b => ({ title: b.title.trim(), text: b.text }));
  }
  if (fieldKeys.has(key) && text(input, 3000)) return input.trim();
  if (reviewKeys.has(key) && input && statuses.includes(input.status) && text(input.note, 8000)
      && text(input.owner, 180) && (input.status !== 'Validado por el DPD' || input.note.trim())) {
    return { status: input.status, note: input.note.trim(), owner: input.owner.trim() };
  }
  throw error(400, 'Revisa el contenido. Para registrar una validación del DPD, indica su evidencia y fecha.');
}

function createWorkspace(Entry, now = () => new Date()) {
  async function write(key, revision, value, actor) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw error(400, 'Falta la versión de la edición.');
    const data = { key, value, revision: revision + 1, updated_by: actor, updated_at: now() };
    if (revision === 0) {
      try { await Entry.create(data, { logging: false }); }
      catch (e) { if (e.name === 'SequelizeUniqueConstraintError') throw conflict(); throw e; }
    } else {
      const [count] = await Entry.update(data, { where: { key, revision }, logging: false });
      if (count !== 1) throw conflict();
    }
    return data;
  }
  async function getGuest() { return Entry.findByPk(guestKey, { raw: true, logging: false }); }
  async function currentGrantRevision(expected) {
    const row = await getGuest();
    if (Number.isSafeInteger(expected) && row && row.value.invitationRevision === expected) return row.revision;
    return expected;
  }
  function guestInfo(row) {
    if (!row) return { revision: 0, state: 'Sin invitación' };
    const v = row.value;
    const state = !v.email ? 'Revocado' : Date.parse(v.until) <= now().getTime() ? 'Caducado'
      : v.session ? 'En uso' : 'Pendiente de apertura';
    return { revision: row.revision, state, email: v.email, until: v.until };
  }
  return {
    async read(admin) {
      const { Op } = require('sequelize');
      const rows = await Entry.findAll({ where: { key: { [Op.ne]: guestKey } }, raw: true, logging: false });
      const changes = Object.fromEntries(rows.filter(r => !r.key.startsWith('field-proveedor_10_')).map(r => [r.key, r]));
      if (changes.contract) changes.contract.value = changes.contract.value.map(b => ({
        title: b.title.replace(/Clínica Clic\b/g,'Clínica Click'),
        text: b.text.replace(/Clínica Clic\b/g,'Clínica Click').replace(/^\| \{\{proveedor_10_1\}\} \| Correo de soporte [^\n]*\n?/gm,''),
      }));
      return { ...seed, statuses, changes,
        ...(admin ? { guest: guestInfo(await getGuest()) } : {}) };
    },
    save(key, body, actor) { return write(key, body.revision, cleanValue(key, body.value), actor); },
    async invite(body, actor) {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!text(email,254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw error(400, 'Introduce el correo del invitado.');
      const secret = token();
      const until = new Date(now().getTime() + 86400000).toISOString();
      const row = await write(guestKey, await currentGrantRevision(body.revision), { email, until, invite: digest(secret) }, actor);
      return { guest: guestInfo(row), invitation: secret };
    },
    async revoke(revision, actor) { return guestInfo(await write(guestKey, await currentGrantRevision(revision), {}, actor)); },
    async redeem(body) {
      const invalid = () => error(403, 'El correo o la invitación no son válidos, o el enlace ya ha caducado.');
      if (!validToken(body.invitation) || !text(body.email,254)) throw invalid();
      const row = await getGuest();
      if (!row || row.value.email !== body.email.trim().toLowerCase() || row.value.invite !== digest(body.invitation)
          || Date.parse(row.value.until) <= now().getTime()) throw invalid();
      const session = token();
      const until = new Date(now().getTime() + 8 * 3600000).toISOString();
      await write(guestKey, row.revision, { email: row.value.email, invitationRevision: row.revision, session: digest(session), until }, row.updated_by);
      return session;
    },
    async checkSession(secret) {
      if (!validToken(secret)) return false;
      const row = await getGuest();
      return Boolean(row && row.value.session === digest(secret) && Date.parse(row.value.until) > now().getTime());
    },
    async logout(secret) {
      if (!validToken(secret)) return;
      const row = await getGuest();
      if (row?.value.session === digest(secret)) await write(guestKey, row.revision, {}, row.updated_by);
    },
  };
}
module.exports = { createWorkspace, cleanValue };
