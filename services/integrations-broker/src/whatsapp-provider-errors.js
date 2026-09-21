'use strict';

// Bounded vocabulary; Graph's raw messages, tokens, URLs and recipients never
// leave the broker. Only explicit 4xx rejections without an accepted ID qualify.
const MESSAGES = Object.freeze({
  100: 'Meta ha rechazado un parámetro de la solicitud.',
  130429: 'Meta ha limitado temporalmente la frecuencia de envío.',
  131026: 'Meta no ha podido entregar el mensaje al destinatario.',
  131031: 'Meta ha restringido la cuenta de WhatsApp.',
  131042: 'Meta requiere revisar el método de pago de la cuenta.',
  131047: 'La ventana de conversación ha terminado; utiliza una plantilla aprobada.',
  131048: 'Meta ha limitado los envíos por su política de calidad.',
  131049: 'Meta ha limitado este mensaje de marketing para el destinatario.',
  131056: 'Meta ha limitado los mensajes entre este remitente y destinatario.',
  132000: 'El número de variables no coincide con la plantilla aprobada.',
  132001: 'La plantilla o su idioma no existe en la cuenta de WhatsApp del remitente.',
  132005: 'El texto de la plantilla supera el límite admitido por Meta.',
  132007: 'El contenido de la plantilla incumple la política de Meta.',
  132012: 'El formato de las variables no coincide con la plantilla aprobada.',
  132015: 'Meta ha pausado la plantilla.',
  132016: 'Meta ha deshabilitado la plantilla.',
  133010: 'Meta indica que el número emisor no está registrado.',
});
const PROVIDER_ERRORS = Object.freeze(Object.fromEntries(Object.keys(MESSAGES).map(code => [code, `whatsapp_provider_${code}`])));
function fromGraphError(value, httpStatus) {
  if (!Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus >= 500
    || !Number.isSafeInteger(value?.error?.code) || value?.messages?.length) return null;
  return PROVIDER_ERRORS[value.error.code] || null;
}
function diagnostic(code) {
  const entry = Object.entries(PROVIDER_ERRORS).find(([, value]) => value === code);
  return entry ? { code: Number(entry[0]), message: MESSAGES[entry[0]] } : null;
}
module.exports = { PROVIDER_ERRORS, fromGraphError, diagnostic };
