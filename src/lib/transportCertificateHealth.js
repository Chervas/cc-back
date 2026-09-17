'use strict';
const fs = require('node:fs');
const STATUS_FILE = '/var/lib/clinicaclick-transport-health/status.json';
const LABELS = { gateway: 'Recepción de WhatsApp', staging: 'Importación de conversaciones' };
function readHealth({ enabled = process.env.TRANSPORT_CERTIFICATE_MONITOR_ENABLED === 'true',
  filename = STATUS_FILE, now = Date.now(), read = fs.readFileSync, stat = fs.lstatSync } = {}) {
  if (!enabled) return [];
  const problem = (id, detail) => ({ entity_type: 'transport_certificate', entity_id: id,
    label: LABELS[id] || 'Mantenimiento de certificados', measured: 1, detail });
  try {
    const info = stat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022 || info.size > 16384) throw Error();
    const status = JSON.parse(read(filename, 'utf8'));
    const age = now - Date.parse(status.checkedAt);
    if (status.version !== 1 || !Number.isFinite(age) || age < -60000 || age > 36 * 3600000
      || !Array.isArray(status.certificates) || status.certificates.length !== 2
      || new Set(status.certificates.map(c => c.id)).size !== 2 || status.certificates.some(c => !Object.hasOwn(LABELS, c.id))) throw Error();
    return status.certificates.flatMap(c => {
      if (!['healthy', 'renewed'].includes(c.status)) return [problem(c.id,
        `${LABELS[c.id]}: la comprobación o renovación del certificado ha fallado. Se conserva el certificado anterior; revisa su vigencia y el mantenimiento antes de que caduque.`)];
      const remaining = Date.parse(c.expiresAt) - now;
      if (!Number.isFinite(remaining) || remaining < 7 * 86400000) return [problem(c.id,
        `${LABELS[c.id]}: el certificado caduca en menos de siete días o su vigencia no se ha podido verificar. Revisa la renovación para evitar una interrupción.`)];
      return [];
    });
  } catch { return [problem('maintenance', 'No hay una comprobación reciente y válida de los certificados de recepción de WhatsApp. Revisa el servicio de mantenimiento; este aviso no pausa clínicas ni envíos.')]; }
}
module.exports = { readHealth, STATUS_FILE };
