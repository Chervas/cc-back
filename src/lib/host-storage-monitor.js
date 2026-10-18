'use strict';

const WARNING = 80;
const RECOVERY = 75;
const REPEAT_MS = 24 * 60 * 60 * 1000;

function sample(stats) {
  const { blocks, bfree, bavail, bsize } = stats;
  if (![blocks, bfree, bavail, bsize].every(Number.isSafeInteger)
    || blocks <= 0 || bsize <= 0 || bavail < 0 || bfree < bavail || bfree > blocks) {
    throw Error('host_storage_sample_invalid');
  }
  const used = blocks - bfree;
  return { usedPercent: 100 * used / (used + bavail), totalBytes: blocks * bsize,
    availableBytes: bavail * bsize, usedBytes: used * bsize };
}

function decision(snapshot, previous = null, now = Date.now()) {
  if (!Number.isFinite(snapshot?.usedPercent) || snapshot.usedPercent < 0 || snapshot.usedPercent > 100
    || !Number.isSafeInteger(snapshot.availableBytes) || !Number.isSafeInteger(snapshot.totalBytes)
    || !Number.isSafeInteger(now)) throw Error('host_storage_observation_invalid');
  const valid = previous?.version === 1 && [80, 90, 95].includes(previous.notifiedBand)
    && Number.isSafeInteger(previous.notifiedAt) && previous.notifiedAt <= now;
  const state = valid ? previous : null;
  if (snapshot.usedPercent < RECOVERY) return state
    ? { notify: true, eventKey: 'system.host_storage_recovered', band: 0, nextState: null }
    : { notify: false, nextState: null };
  if (snapshot.usedPercent < WARNING) return { notify: false, nextState: state };
  const band = snapshot.usedPercent >= 95 ? 95 : snapshot.usedPercent >= 90 ? 90 : 80;
  if (state && band <= state.notifiedBand && now - state.notifiedAt < REPEAT_MS) {
    return { notify: false, nextState: state };
  }
  return { notify: true, band, eventKey: band >= 90 ? 'system.host_storage_critical' : 'system.host_storage_warning',
    nextState: { version: 1, notifiedBand: Math.max(band, state?.notifiedBand || 0), notifiedAt: now } };
}

function alert(snapshot, next, now = Date.now()) {
  const gib = bytes => (bytes / 1024 ** 3).toFixed(1);
  const recovered = next.band === 0;
  return { eventKey: next.eventKey, force: true, channelsOverride: { panel: true, email: true, whatsapp: false },
    metadata: { source: 'host_storage_monitor', occurred_at: new Date(now).toISOString(),
      mount: '/', used_percent: Number(snapshot.usedPercent.toFixed(2)), available_bytes: snapshot.availableBytes,
      threshold_percent: recovered ? RECOVERY : next.band },
    payload: { severity: recovered ? 'info' : next.band >= 90 ? 'critical' : 'warning',
      title: recovered ? 'Espacio de disco recuperado en el servidor CRM/DEV'
        : `Disco del servidor CRM/DEV al ${snapshot.usedPercent.toFixed(1)}%`,
      detail: `Disco principal /: ${snapshot.usedPercent.toFixed(1)}% utilizado; quedan ${gib(snapshot.availableBytes)} GiB disponibles de ${gib(snapshot.totalBytes)} GiB. `
        + (recovered ? 'El uso ha bajado del 75%. Esto no confirma ni reenvia comunicaciones omitidas.'
          : 'CRM, DEV, MySQL y las pruebas comparten este disco. Si se agota, pueden fallar escrituras y automatizaciones. Este aviso indica riesgo de capacidad, no confirma una caida de WhatsApp ni de Meta.'),
      action: recovered ? 'Comprobar por separado los avisos de cita pendientes. No se han reenviado mensajes.'
        : 'Revisar el crecimiento y liberar solo temporales terminados autorizados, o ampliar almacenamiento. No borrar bases reales, binlogs ni backups sin revisar su recuperacion.' } };
}

async function check({ stats, previous, now = Date.now(), notify }) {
  const snapshot = sample(stats);
  const next = decision(snapshot, previous, now);
  if (!next.notify) return { snapshot, nextState: next.nextState, notified: false };
  const result = await notify(alert(snapshot, next, now));
  // A disabled channel or failed enqueue must be retried at the next check.
  if (!result?.created?.some(item => item.channel === 'email')
    && !result?.skipped?.some(item => item.channel === 'email' && item.reason === 'throttled')) {
    throw Error('host_storage_email_not_queued');
  }
  return { snapshot, nextState: next.nextState, notified: true, eventKey: next.eventKey,
    deliveries: result.created || [] };
}

module.exports = { WARNING, RECOVERY, REPEAT_MS, sample, decision, alert, check };
