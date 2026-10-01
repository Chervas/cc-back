'use strict';

const REASONS = Object.freeze({
  provider_phone_unavailable: ['Meta ya no permite consultar este n\u00famero con su permiso actual (100/33). Puede haberse eliminado o perdido su vinculaci\u00f3n.', 'Revisar la cuenta en Meta y reconectar el permiso de este n\u00famero en Ajustes > WhatsApp.'],
  meta_error_131042_payment_missing: ['Meta ha rechazado un env\u00edo por un problema de pago (c\u00f3digo 131042). No confirma que falte la tarjeta.', 'Revisar el m\u00e9todo de pago y la facturaci\u00f3n de esta cuenta en Meta.'],
  meta_error_131031_account_locked: ['Meta ha bloqueado la cuenta de WhatsApp (c\u00f3digo 131031).', 'Revisar la restricci\u00f3n de esta cuenta en Meta y contactar con su soporte.'],
  account_event_account_offboarded: ['Meta ha desvinculado el acceso de la aplicaci\u00f3n a WhatsApp (ACCOUNT_OFFBOARDED). No significa por s\u00ed solo que el n\u00famero est\u00e9 baneado.', 'Reconectar el permiso del n\u00famero en Ajustes > WhatsApp.'],
  account_event_partner_removed: ['Meta ha retirado la vinculaci\u00f3n del socio que daba acceso a este WhatsApp.', 'Revisar la asignaci\u00f3n en Meta y reconectar el permiso en Ajustes > WhatsApp.'],
  account_event_account_restriction: ['Meta ha comunicado una restricci\u00f3n de esta cuenta de WhatsApp.', 'Revisar las restricciones de la cuenta en Meta y su historial en Monitorizaci\u00f3n > WhatsApp.'],
  account_event_account_deleted: ['Meta ha comunicado que esta cuenta de WhatsApp ha sido eliminada.', 'Revisar la cuenta en Meta antes de intentar una nueva conexi\u00f3n.'],
  waba_health_blocked: ['Meta informa que esta cuenta de WhatsApp no puede enviar mensajes.', 'Revisar el estado de la cuenta en Meta y el historial en Monitorizaci\u00f3n > WhatsApp.'],
  waba_account_review_rejected: ['Meta ha rechazado la revisi\u00f3n de esta cuenta de WhatsApp.', 'Revisar el motivo de rechazo de esta cuenta en Meta.'],
  asset_inactive: ['El n\u00famero est\u00e1 desactivado en Clinicaclick.', 'Revisar la activaci\u00f3n del n\u00famero en Ajustes > WhatsApp.'],
});
const PAYMENT_REASON = 'meta_error_131042_payment_missing';

function blockingReason(reason) {
  if (REASONS[reason]) return REASONS[reason];
  if (/^(provider_status|compliance)_(banned|blocked|disabled|locked|restricted|scheduled_for_disable|suspended)$/.test(reason)) {
    return ['Meta ha comunicado un bloqueo o restricci\u00f3n de esta cuenta de WhatsApp.', 'Revisar las restricciones de la cuenta en Meta y el historial en Monitorizaci\u00f3n > WhatsApp.'];
  }
  if (/^(provider_status|registration)_(deleted|disconnected|not_registered|offline|pending|unregistered|failed)$/.test(reason)) {
    return ['Meta no confirma una conexi\u00f3n operativa de este n\u00famero.', 'Comprobar la conexi\u00f3n del n\u00famero en Ajustes > WhatsApp antes de reconectarlo.'];
  }
  return ['El estado del n\u00famero impide enviar; no se ha identificado una causa concreta.', 'Revisar el motivo t\u00e9cnico en Monitorizaci\u00f3n > WhatsApp.'];
}

function buildHealthTransitionContent({ asset = {}, health = {}, previousReason = null, blocked, paymentHref = null }) {
  const digits = String(asset.metaAssetName || '').replace(/\D/g, '');
  const number = /^\d{9,15}$/.test(digits) ? `N\u00famero: +${digits}. ` : '';
  const reason = health.blocking_reason_code || health.reason_code;
  if (blocked) {
    const [cause, action] = blockingReason(reason);
    return {
      detail: `${number}${cause} Clinicaclick ha detenido los nuevos env\u00edos que dependan de este n\u00famero.`,
      action: reason === PAYMENT_REASON && paymentHref ? `Revisar pagos en Meta: ${paymentHref}` : action,
    };
  }
  const payment = asset.additionalData?.payment;
  const confirmedPaymentStatus = ['sent', 'delivered', 'read'].includes(payment?.last_success_status);
  const paymentRecovery = previousReason === PAYMENT_REASON
    && String(health.source || '').endsWith('_payment_recovered') && confirmedPaymentStatus;
  const recovered = paymentRecovery
    ? 'Meta ha confirmado un mensaje posterior al error de pago 131042. Se ha levantado el bloqueo de pago de este n\u00famero.'
    : previousReason === PAYMENT_REASON
      ? 'La conexi\u00f3n vuelve a estar operativa, pero este aviso no acredita que se haya corregido el m\u00e9todo de pago.'
      : 'La conexi\u00f3n de este n\u00famero vuelve a estar operativa. Se ha levantado su bloqueo de env\u00edo.';
  return {
    detail: `${number}${recovered}`,
    action: 'Comprobar el historial antes de reactivar manualmente las campa\u00f1as pausadas. No se reenv\u00edan mensajes fallidos desde este aviso.',
  };
}

module.exports = { buildHealthTransitionContent };
