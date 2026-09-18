'use strict';
const fs = require('node:fs');
const STATUS_FILE = '/var/lib/clinicaclick-transport-health/status.json';
const SERVER_STATUS_FILE = '/var/lib/clinicaclick-transport-health/servers.json';
const LABELS = { gateway: 'Recepción de WhatsApp', staging: 'Importación de conversaciones' };
const SERVER_LABELS = { 'maintenance-client': 'Mantenimiento de la comunicación con AWS',
  publisher: 'Renovación de certificados en AWS', authorized: 'Envíos de WhatsApp',
  onboarding: 'Conexión de números WhatsApp', inbox: 'Servidor de recepción de WhatsApp',
  'audit-writer': 'Registro de actividad', 'audit-reader': 'Consulta de actividad',
  google: 'Integración con Google', ai: 'Proveedores de inteligencia artificial', email: 'Entrega de correo',
  'ai-staging': 'Proveedores de inteligencia artificial (staging)',
  'bedrock-staging': 'Automatizaciones con IA (staging)',
  'email-staging': 'Entrega de correo (staging)', 'email-dev': 'Entrega de correo (DEV)' };
function readHealth({ enabled = process.env.TRANSPORT_CERTIFICATE_MONITOR_ENABLED === 'true',
  serversEnabled = process.env.SERVER_CERTIFICATE_MONITOR_ENABLED === 'true',
  filename = STATUS_FILE, serverFilename = SERVER_STATUS_FILE, now = Date.now(), read = fs.readFileSync, stat = fs.lstatSync } = {}) {
  return [...readFileHealth({ enabled, filename, now, read, stat }),
    ...readFileHealth({ enabled: serversEnabled, filename: serverFilename, now, read, stat, servers: true })];
}
function readFileHealth({ enabled, filename, now, read, stat, servers = false }) {
  if (!enabled) return [];
  const labels = servers ? SERVER_LABELS : LABELS;
  const problem = (id, detail) => ({ entity_type: 'transport_certificate', entity_id: id,
    label: labels[id] || 'Mantenimiento de certificados', measured: 1, detail });
  try {
    const info = stat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022 || info.size > 16384) throw Error();
    const status = JSON.parse(read(filename, 'utf8'));
    const age = now - Date.parse(status.checkedAt);
    const expected = servers ? status.expectedIds : Object.keys(LABELS);
    if (status.version !== 1 || !Number.isFinite(age) || age < -60000 || age > 36 * 3600000
      || !Array.isArray(expected) || expected.length < 2 || new Set(expected).size !== expected.length
      || expected.some(id => !Object.hasOwn(labels, id))
      || (servers && !['maintenance-client', 'publisher', 'authorized', 'onboarding', 'inbox'].every(id => expected.includes(id)))
      || !Array.isArray(status.certificates) || status.certificates.length !== expected.length
      || new Set(status.certificates.map(c => c.id)).size !== expected.length
      || status.certificates.some(c => !expected.includes(c.id))) throw Error();
    return status.certificates.flatMap(c => {
      if (!['healthy', 'renewed'].includes(c.status)) return [problem(c.id,
        `${labels[c.id]}: la comprobación o renovación del certificado ha fallado. Revisa su vigencia y el mantenimiento antes de que caduque. ${servers ? 'Este aviso no pausa clínicas ni envíos.' : 'Se conserva el certificado anterior.'}`)];
      const remaining = Date.parse(c.expiresAt) - now;
      if (!Number.isFinite(remaining) || remaining < 7 * 86400000) return [problem(c.id,
        `${labels[c.id]}: el certificado caduca en menos de siete días o su vigencia no se ha podido verificar. Revisa la renovación para evitar una interrupción.`)];
      return [];
    });
  } catch { return [problem(servers ? 'server-maintenance' : 'maintenance',
    `No hay una comprobación reciente y válida de los certificados ${servers ? 'de los servidores AWS' : 'de recepción de WhatsApp'}. Revisa el servicio de mantenimiento; este aviso no pausa clínicas ni envíos.`)]; }
}
module.exports = { readHealth, STATUS_FILE, SERVER_STATUS_FILE };
