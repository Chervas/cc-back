'use strict';

const FAMILY = 'clinicaclick_lead_primera_visita_con_llamada';
const BEFORE = 'Hola {{1}} ¿Qué tal estás? 😊\n\nSoy {{2}}. Te escribo desde {{3}}. Mis compañeras me han pasado una solicitud de contacto tuya. ¿Quieres que programemos una primera visita? Si ya no te interesa o ha sido un error, no te preocupes, indícanoslo y no te molestaremos más.';
const AFTER = 'Hola {{1}} ¿Qué tal estás? 😊\n\nSoy {{2}}. Te escribo desde {{3}}. Hemos intentado llamarte por tu solicitud para realizar una primera visita. ¿Quieres que la programemos por aquí? Si ya no te interesa o ha sido un error, no te preocupes, indícanoslo y no te molestaremos más.';
async function change(queryInterface, expected, next) {
  // Only the canonical Spanish catalogue, never a previously approved Meta
  // instance or a clinic's personal template. New remote versions are propagated
  // separately through the standard broker and keep their actual approval state.
  await queryInterface.sequelize.query(`UPDATE WhatsappTemplateCatalog
    SET body_text=:next,
        components=JSON_SET(components, '$[0].text', :next),
        propagation_state=NULL, last_propagated_at=NULL, updated_at=NOW()
    WHERE family_key=:family AND locale='es' AND is_active=1
      AND body_text=:expected AND JSON_UNQUOTE(JSON_EXTRACT(components,'$[0].type'))='BODY'`,
  { replacements: { next, expected, family: FAMILY } });
}
module.exports = {
  up: queryInterface => change(queryInterface, BEFORE, AFTER),
  down: queryInterface => change(queryInterface, AFTER, BEFORE),
  __testing: { BEFORE, AFTER, FAMILY },
};
