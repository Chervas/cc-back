'use strict';

const { Op, QueryTypes } = require('sequelize');

// Traducciones editoriales iniciales. Se crean como borradores INACTIVOS:
// la migración no abre revisiones en Meta ni modifica automatizaciones.
const TRANSLATIONS = {
  clinicaclick_confirmacion_datos_cita_48: {
    ca: ['Confirmació de dades de la cita (>48 h)', 'Hola {{1}}! Soc {{2}} de {{3}}\n\nHem programat la teva cita per al {{4}} a les {{5}}. Recorda que som a {{6}}. Em confirmes que has rebut aquest missatge? Gràcies 😊'],
    en: ['Appointment details confirmation (>48h)', 'Hi {{1}}! I’m {{2}} from {{3}}.\n\nWe have scheduled your appointment for {{4}} at {{5}}. Remember that we are at {{6}}. Could you confirm that you received this message? Thank you 😊'],
  },
  clinicaclick_confirmacion_cita_con_enlace: {
    ca: ['Confirmació de cita amb enllaç', 'Hola {{1}}! Soc {{2}}, hem parlat fa uns minuts. Hem programat la teva cita per al {{3}}, però per confirmar-la necessitem que emplenis aquestes dades durant les properes hores: {{4}}'],
    en: ['Appointment confirmation with link', 'Hi {{1}}! I’m {{2}}; we spoke a few minutes ago. We have scheduled your appointment for {{3}}, but to confirm it we need you to complete these details within the next few hours: {{4}}'],
  },
  clinicaclick_recordatorio_domingo_primera_visita: {
    ca: ['Recordatori de diumenge (primera visita)', 'Hola {{1}}, perdona que et molestem un diumenge 🙏 Només és per recordar-te la cita de demà a les {{2}} a {{3}}. Recorda que som a {{4}}. Me la confirmes?'],
    en: ['Sunday reminder (first visit)', 'Hi {{1}}, sorry to bother you on a Sunday 🙏 This is just to remind you of your appointment tomorrow at {{2}} at {{3}}. Remember that we are at {{4}}. Could you confirm it?'],
  },
  clinicaclick_recordatorio_mismo_dia_primera_visita: {
    ca: ['Recordatori el mateix dia a les 8:00 (primera visita)', 'Hola {{1}}, ho tenim tot preparat per rebre’t avui a les {{2}}.\n\nSom a {{3}}\n\nEt deixo un enllaç amb la ubicació: {{4}}\n\nSaps arribar-hi? Necessites alguna indicació?'],
    en: ['Same-day 8:00 reminder (first visit)', 'Hi {{1}}, we have everything ready to welcome you today at {{2}}.\n\nWe are at {{3}}\n\nHere is a link to the location: {{4}}\n\nDo you know how to get here? Do you need any directions?'],
  },
  clinicaclick_recordatorio_domingo_recurrente: {
    ca: ['Recordatori de diumenge (visita recurrent)', 'Hola {{1}}, perdona que et molestem un diumenge 🙏 Només és per recordar-te la cita de demà a les {{2}} a {{3}}. Me la confirmes?'],
    en: ['Sunday reminder (returning patient)', 'Hi {{1}}, sorry to bother you on a Sunday 🙏 This is just to remind you of your appointment tomorrow at {{2}} at {{3}}. Could you confirm it?'],
  },
  clinicaclick_recordatorio_mismo_dia_recurrente: {
    ca: ['Recordatori el mateix dia (visita recurrent)', 'Hola {{1}}, ho tenim tot preparat per rebre’t avui a les {{2}}. T’hi esperem 😊'],
    en: ['Same-day reminder (returning patient)', 'Hi {{1}}, we have everything ready to welcome you today at {{2}}. We look forward to seeing you 😊'],
  },
  clinicaclick_cita_cancelada: {
    ca: ['Cita cancel·lada', 'Hola {{1}}, la teva cita prevista per al {{2}} ha estat cancel·lada. Si vols reprogramar-la, digues-m’ho i ho revisem de seguida.'],
    en: ['Appointment canceled', 'Hi {{1}}, your appointment scheduled for {{2}} has been canceled. If you would like to reschedule it, let me know and we can arrange it straight away.'],
  },
  clinicaclick_no_show: {
    ca: ['El pacient no ha vingut', 'Hola {{1}}, t’hem estat esperant i finalment no has pogut venir 😕 Si vols, et puc programar una altra cita quan et vagi millor.'],
    en: ['Patient did not attend', 'Hi {{1}}, we were expecting you, but you were unable to attend in the end 😕 If you like, I can schedule another appointment for a time that suits you better.'],
  },
  clinicaclick_solicitar_resena: {
    ca: ['Sol·licitud de valoració 5-1', 'Hola {{1}}! Soc {{3}} de {{2}}. Et puc fer una pregunta? Com vas veure, a la clínica som una petita família i saber com et vam atendre és important per a nosaltres. Com valoraries la teva experiència amb nosaltres?\n\nRespon amb un número:\n\n5 ⭐⭐⭐⭐⭐\n4 ⭐⭐⭐⭐\n3 ⭐⭐⭐\n2 ⭐⭐\n1 ⭐\n\nLa teva opinió ens ajuda molt.'],
    en: ['Rating request 5-1', 'Hi {{1}}! I’m {{3}} from {{2}}. May I ask you a question? As you saw, we are a small family at the clinic, and knowing how we looked after you is important to us. How would you rate your experience with us?\n\nReply with a number:\n\n5 ⭐⭐⭐⭐⭐\n4 ⭐⭐⭐⭐\n3 ⭐⭐⭐\n2 ⭐⭐\n1 ⭐\n\nYour feedback helps us a lot.'],
  },
  clinicaclick_reactivar_paciente: {
    ca: ['Reactivar pacient', 'Hola {{1}}, com estàs? Fa temps que no et veiem per {{2}}. Només volíem recordar-te que som aquí per al que necessitis 😊'],
    en: ['Reactivate patient', 'Hi {{1}}, how are you? We haven’t seen you at {{2}} for a while. We just wanted to remind you that we are here whenever you need us 😊'],
  },
  clinicaclick_cumpleanos_nino: {
    ca: ['Aniversari infantil', 'Hola {{1}}, avui és l’aniversari de {{2}} 🎉 Des de {{3}} li enviem una felicitació molt especial. Esperem veure-us aviat!'],
    en: ['Child birthday', 'Hi {{1}}, today is {{2}}’s birthday 🎉 Everyone at {{3}} sends a very special birthday wish. We hope to see you both soon!'],
  },
  clinicaclick_cumpleanos_adulto: {
    ca: ['Aniversari adult', 'Hola {{1}} 🎉 Des de {{2}} et volem desitjar un feliç aniversari. Que tinguis un dia fantàstic 😊'],
    en: ['Adult birthday', 'Hi {{1}} 🎉 Everyone at {{2}} would like to wish you a happy birthday. Have a wonderful day 😊'],
  },
  clinicaclick_cumpleanos_mayor: {
    ca: ['Aniversari gent gran', 'Hola {{1}}, des de {{2}} et volem desitjar un feliç aniversari 🎉 T’enviem una forta abraçada i els nostres millors desitjos.'],
    en: ['Senior birthday', 'Hi {{1}}, everyone at {{2}} would like to wish you a happy birthday 🎉 We send you a big hug and our very best wishes.'],
  },
  clinicaclick_cumpleanos_promo_nino: {
    ca: ['Promoció d’aniversari infantil', 'Hola {{1}}, avui és l’aniversari de {{2}} 🎉 Des de {{3}} li volem fer un regal especial: {{4}}. Teniu {{5}} dies per demanar-lo 😊'],
    en: ['Child birthday promotion', 'Hi {{1}}, today is {{2}}’s birthday 🎉 Everyone at {{3}} would like to offer a special gift: {{4}}. You have {{5}} days to claim it 😊'],
  },
  clinicaclick_cumpleanos_promo_adulto: {
    ca: ['Promoció d’aniversari adult', 'Hola {{1}} 🎉 Des de {{2}} ho volem celebrar amb tu regalant-te {{3}}. Tens {{4}} dies per demanar-ho. Gaudeix-ne!'],
    en: ['Adult birthday promotion', 'Hi {{1}} 🎉 Everyone at {{2}} would like to celebrate with you by giving you {{3}}. You have {{4}} days to claim it. Enjoy!'],
  },
  clinicaclick_cumpleanos_promo_mayor: {
    ca: ['Promoció d’aniversari gent gran', 'Hola {{1}} 🎉 Des de {{2}} et volem felicitar i regalar-te {{3}}. Pots demanar-ho durant els propers {{4}} dies.'],
    en: ['Senior birthday promotion', 'Hi {{1}} 🎉 Everyone at {{2}} would like to wish you a happy birthday and give you {{3}}. You can claim it within the next {{4}} days.'],
  },
  clinicaclick_navidad_nino: {
    ca: ['Nadal infantil', 'Hola {{1}} 🎄 Des de {{2}} us volem desitjar un Bon Nadal i un Feliç Any Nou a {{3}} i a tota la família ✨'],
    en: ['Children’s Christmas greeting', 'Hi {{1}} 🎄 Everyone at {{2}} would like to wish {{3}} and the whole family a Merry Christmas and a Happy New Year ✨'],
  },
  clinicaclick_navidad_adulto: {
    ca: ['Nadal adult', 'Hola {{1}} 🎄 Des de {{2}} et desitgem un Bon Nadal i un Feliç Any Nou ✨ Gràcies per confiar en nosaltres.'],
    en: ['Adult Christmas greeting', 'Hi {{1}} 🎄 Everyone at {{2}} wishes you a Merry Christmas and a Happy New Year ✨ Thank you for trusting us.'],
  },
  clinicaclick_navidad_mayor: {
    ca: ['Nadal gent gran', 'Hola {{1}} 🎄 Des de {{2}} et volem desitjar un Bon Nadal i un Feliç Any Nou ✨ Amb tot el nostre afecte.'],
    en: ['Senior Christmas greeting', 'Hi {{1}} 🎄 Everyone at {{2}} would like to wish you a Merry Christmas and a Happy New Year ✨ With our warmest regards.'],
  },
  clinicaclick_recordatorio_dia_antes: {
    ca: ['Recordatori de cita el dia abans', 'Hola {{1}}! Perdona que et tornem a molestar avui.\n\nEt recordo la cita de demà a les {{2}} ⏰ a {{3}} 🏥\n\nSom a\n📍 {{4}}\n📞 Telèfon: {{5}}\n\nA aquesta hora imprimim l’agenda dels doctors i necessitem una última confirmació.\n\nEm confirmes que vindràs demà? 🙏'],
    en: ['Day-before appointment reminder', 'Hi {{1}}! Sorry to contact you again today.\n\nThis is a reminder of your appointment tomorrow at {{2}} ⏰ at {{3}} 🏥\n\nWe are at\n📍 {{4}}\n📞 Phone: {{5}}\n\nAt this time we print the doctors’ schedules and need one final confirmation.\n\nCould you confirm that you will attend tomorrow? 🙏'],
  },
  clinicaclick_confirmacion_datos_cita_24: {
    ca: ['Confirmació de dades de la cita (dia abans)', 'Hola {{1}}! Soc {{2}} de {{3}}.\n\nHem programat la teva cita per demà, {{4}}, a les {{5}}. Recorda que som a {{6}}. Em confirmes que has rebut aquest missatge i que t’hi esperem demà? Gràcies 😊'],
    en: ['Appointment details confirmation (day before)', 'Hi {{1}}! I’m {{2}} from {{3}}.\n\nWe have scheduled your appointment for tomorrow, {{4}}, at {{5}}. Remember that we are at {{6}}. Could you confirm that you received this message and that we should expect you tomorrow? Thank you 😊'],
  },
  clinicaclick_confirmacion_datos_cita_hoy: {
    ca: ['Confirmació de dades de la cita (mateix dia)', 'Hola {{1}}! Soc {{2}} de {{3}}.\n\nRecorda que tens una cita avui a les {{4}}. Som a {{5}}. Em confirmes que has rebut aquest missatge i que t’hi esperem avui? Gràcies 😊'],
    en: ['Appointment details confirmation (same day)', 'Hi {{1}}! I’m {{2}} from {{3}}.\n\nRemember that you have an appointment today at {{4}}. We are at {{5}}. Could you confirm that you received this message and that we should expect you today? Thank you 😊'],
  },
  clinicaclick_confirmacion_datos_cita_hoy_sin_respuesta: {
    ca: ['Confirmació de cita (mateix dia, sense resposta)', 'Perdona, {{1}}, però la cita és d’aquí a poc i ens agradaria saber si saps arribar-hi. Ens ho confirmes?'],
    en: ['Appointment confirmation (same day, no reply)', 'Sorry, {{1}}, but your appointment is coming up shortly and we would like to know whether you know how to get here. Could you confirm?'],
  },
  clinicaclick_confirmacion_datos_cita_24_sin_respuesta: {
    ca: ['Confirmació de cita (dia abans, sense resposta)', 'Perdona, {{1}}, però la cita és demà i necessitem tancar l’agenda del doctor. Ens la confirmes?'],
    en: ['Appointment confirmation (day before, no reply)', 'Sorry, {{1}}, but your appointment is tomorrow and we need to finalize the doctor’s schedule. Could you confirm it?'],
  },
  clinicaclick_confirmacion_datos_cita_48_sin_respuesta: {
    ca: ['Confirmació de cita (>48 h, sense resposta)', 'Perdona, {{1}}, però necessitem la teva confirmació per tancar l’agenda del doctor. Ens la confirmes?'],
    en: ['Appointment confirmation (>48h, no reply)', 'Sorry, {{1}}, but we need your confirmation to finalize the doctor’s schedule. Could you confirm the appointment?'],
  },
  clinicaclick_recordatorio_dia_antes_sin_respuesta: {
    ca: ['Recordatori del dia abans sense resposta', 'Perdona que insistim, {{1}}, però és important que deixem tancada l’agenda mèdica i per fer-ho necessito la teva confirmació.\n\nEm confirmes que vindràs demà?'],
    en: ['Day-before reminder with no reply', 'Sorry to follow up, {{1}}, but it is important that we finalize the clinical schedule, and I need your confirmation to do so.\n\nCould you confirm that you will attend tomorrow?'],
  },
  clinicaclick_confirmacion_datos_cita_reprogramada_48: {
    ca: ['Confirmació de cita reprogramada (>48 h)', 'Hola {{1}}.\n\nA causa d’uns ajustos necessaris a l’agenda de la clínica i dels doctors, hem hagut de reprogramar la teva cita per al proper {{2}} a les {{3}}.\n\nDisculpa les molèsties que aquest canvi t’hagi pogut causar. Em confirmes que has rebut aquest missatge i que tens disponibilitat? 🙏'],
    en: ['Rescheduled appointment confirmation (>48h)', 'Hi {{1}}.\n\nDue to necessary adjustments to the clinic’s and doctors’ schedules, we have had to reschedule your appointment for {{2}} at {{3}}.\n\nWe apologize for any inconvenience this change may have caused. Could you confirm that you received this message and that you are available? 🙏'],
  },
  clinicaclick_confirmacion_datos_cita_reprogramada_hoy: {
    ca: ['Confirmació de cita reprogramada (mateix dia)', 'Hola {{1}}.\n\nA causa d’uns ajustos necessaris a l’agenda de la clínica i dels doctors, hem hagut de traslladar la teva cita a avui, {{2}}, a les {{3}}.\n\nDisculpa les molèsties que aquest canvi t’hagi pogut causar. Em confirmes que has rebut aquest missatge i que tens disponibilitat? 🙏'],
    en: ['Rescheduled appointment confirmation (same day)', 'Hi {{1}}.\n\nDue to necessary adjustments to the clinic’s and doctors’ schedules, we have had to move your appointment to today, {{2}}, at {{3}}.\n\nWe apologize for any inconvenience this change may have caused. Could you confirm that you received this message and that you are available? 🙏'],
  },
  clinicaclick_confirmacion_datos_cita_reprogramada_24: {
    ca: ['Confirmació de cita reprogramada (dia abans)', 'Hola {{1}}.\n\nA causa d’uns ajustos necessaris a l’agenda de la clínica i dels doctors, hem hagut de reprogramar la teva cita amb nosaltres per demà, {{2}}, a les {{3}}.\n\nDisculpa les molèsties que aquest canvi t’hagi pogut causar. Em confirmes que has rebut aquest missatge i que tens disponibilitat? 🙏'],
    en: ['Rescheduled appointment confirmation (day before)', 'Hi {{1}}.\n\nDue to necessary adjustments to the clinic’s and doctors’ schedules, we have had to reschedule your appointment with us for tomorrow, {{2}}, at {{3}}.\n\nWe apologize for any inconvenience this change may have caused. Could you confirm that you received this message and that you are available? 🙏'],
  },
  clinicaclick_envio_consentimiento_firma: {
    ca: ['Enviament de consentiment per signar', 'Hola {{1}}, tens documentació pendent per a {{2}} a {{3}}. La pots revisar i signar aquí: {{4}}\n\nGràcies.'],
    en: ['Consent document for signature', 'Hi {{1}}, you have documents awaiting your review for {{2}} at {{3}}. You can review and sign them here: {{4}}\n\nThank you.'],
  },
  clinicaclick_recordatorio_resena_sin_respuesta: {
    ca: ['Recordatori de valoració sense resposta', 'Perdona que insistim, {{1}}, però conèixer la teva opinió ens ajuda molt a millorar.\n\nPodries respondre amb el número de la teva valoració?\n\n5 ⭐⭐⭐⭐⭐\n4 ⭐⭐⭐⭐\n3 ⭐⭐⭐\n2 ⭐⭐\n1 ⭐'],
    en: ['Rating reminder with no reply', 'Sorry to follow up, {{1}}, but your feedback helps us improve.\n\nCould you reply with the number that matches your rating?\n\n5 ⭐⭐⭐⭐⭐\n4 ⭐⭐⭐⭐\n3 ⭐⭐⭐\n2 ⭐⭐\n1 ⭐'],
  },
  clinicaclick_aviso_cita_sin_confirmar_noche: {
    ca: ['Avís nocturn de cita sense confirmar', 'Hola {{1}}, t’escric perquè no ens consta confirmada la teva cita de demà a les {{2}} a {{3}}.\n\nPer poder organitzar l’agenda, si no tenim notícies teves durant els propers minuts haurem d’alliberar l’hora.\n\nSi vols venir o necessites canviar-la, respon-nos per aquí i ho revisem.'],
    en: ['Evening notice for unconfirmed appointment', 'Hi {{1}}, I’m writing because your appointment tomorrow at {{2}} at {{3}} is not yet confirmed.\n\nTo organize the schedule, if we do not hear from you within the next few minutes we will need to release the slot.\n\nIf you would like to attend or need to change it, reply here and we will help.'],
  },
  clinicaclick_solicitar_resena_foto: {
    ca: ['Sol·licitud de valoració 5-1 amb foto', 'Hola {{1}}! Soc {{3}} de {{2}}. Et puc fer una pregunta? Com vas veure, a la clínica som una petita família i saber com et vam atendre és important per a nosaltres. Com valoraries la teva experiència amb nosaltres?\n\nRespon amb un número:\n\n5 ⭐⭐⭐⭐⭐\n4 ⭐⭐⭐⭐\n3 ⭐⭐⭐\n2 ⭐⭐\n1 ⭐\n\nLa teva opinió ens ajuda molt.'],
    en: ['Rating request 5-1 with photo', 'Hi {{1}}! I’m {{3}} from {{2}}. May I ask you a question? As you saw, we are a small family at the clinic, and knowing how we looked after you is important to us. How would you rate your experience with us?\n\nReply with a number:\n\n5 ⭐⭐⭐⭐⭐\n4 ⭐⭐⭐⭐\n3 ⭐⭐⭐\n2 ⭐⭐\n1 ⭐\n\nYour feedback helps us a lot.'],
  },
  clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil: {
    ca: ['Recordatori el mateix dia a les 8:00 (primera visita - accés difícil)', 'Hola {{1}}, ho tenim tot preparat per rebre’t avui a les {{2}}.\n\nSom a {{3}}\n\nEt deixo un enllaç amb la ubicació: {{4}}\n\nSaps arribar-hi? Necessites alguna indicació? Per facilitar-t’ho, et deixo més indicacions:\n\n{{5}}\n\nSi necessites ajuda, respon-nos per aquí.'],
    en: ['Same-day 8:00 reminder (first visit - difficult access)', 'Hi {{1}}, we have everything ready to welcome you today at {{2}}.\n\nWe are at {{3}}\n\nHere is a link to the location: {{4}}\n\nDo you know how to get here? Do you need any directions? To make it easier, here are some additional directions:\n\n{{5}}\n\nIf you need help, reply here.'],
  },
};

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return JSON.parse(value); } catch (_error) { return fallback; }
}

function extractPlaceholders(text) {
  return Array.from(new Set(
    Array.from(String(text || '').matchAll(/{{\s*(\d+)\s*}}/g)).map((match) => Number(match[1]))
  )).sort((left, right) => left - right);
}

function replaceBodyComponent(rawComponents, bodyText) {
  const components = parseJson(rawComponents, []);
  let replaced = false;
  const next = (Array.isArray(components) ? components : []).map((component) => {
    if (String(component?.type || '').toUpperCase() !== 'BODY') return component;
    replaced = true;
    return { ...component, text: bodyText };
  });
  if (!replaced) next.push({ type: 'BODY', text: bodyText });
  return JSON.stringify(next);
}

function jsonForDatabase(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function translationName(familyKey, locale) {
  const suffix = `__${locale}`;
  return `${String(familyKey).slice(0, 100 - suffix.length)}${suffix}`;
}

module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const names = Object.keys(TRANSLATIONS);
      const sources = await queryInterface.sequelize.query(
        `SELECT * FROM WhatsappTemplateCatalog WHERE name IN (:names) AND locale = 'es'`,
        { replacements: { names }, type: QueryTypes.SELECT, transaction },
      );
      const sourceByName = new Map(sources.map((source) => [source.name, source]));
      const missing = names.filter((name) => !sourceByName.has(name));
      if (missing.length) throw new Error(`whatsapp_translation_sources_missing:${missing.join(',')}`);

      for (const sourceName of names) {
        const source = sourceByName.get(sourceName);
        const familyKey = String(source.family_key || source.name);
        for (const locale of ['ca', 'en']) {
          const [displayName, bodyText] = TRANSLATIONS[sourceName][locale];
          if (JSON.stringify(extractPlaceholders(source.body_text)) !== JSON.stringify(extractPlaceholders(bodyText))) {
            throw new Error(`whatsapp_translation_placeholders_mismatch:${sourceName}:${locale}`);
          }

          const existing = await queryInterface.sequelize.query(
            'SELECT id, body_text, is_active FROM WhatsappTemplateCatalog WHERE family_key = :familyKey AND locale = :locale LIMIT 1',
            { replacements: { familyKey, locale }, type: QueryTypes.SELECT, transaction },
          );
          const payload = {
            name: translationName(familyKey, locale),
            family_key: familyKey,
            locale,
            display_name: displayName,
            category: source.category,
            body_text: bodyText,
            variables: jsonForDatabase(source.variables),
            components: replaceBodyComponent(source.components, bodyText),
            last_propagated_at: null,
            propagation_state: null,
            is_generic: !!source.is_generic,
            is_active: false,
            updated_at: new Date(),
          };

          let translationId = null;
          if (!existing.length) {
            await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{
              ...payload,
              created_at: new Date(),
            }], { transaction });
            const inserted = await queryInterface.sequelize.query(
              'SELECT id FROM WhatsappTemplateCatalog WHERE family_key = :familyKey AND locale = :locale LIMIT 1',
              { replacements: { familyKey, locale }, type: QueryTypes.SELECT, transaction },
            );
            translationId = Number(inserted[0]?.id || 0) || null;
          } else {
            translationId = Number(existing[0].id);
            // Solo corrige un borrador generado como copia literal. Nunca pisa
            // una traducción que ya haya sido editada por una persona.
            if (String(existing[0].body_text || '').trim() === String(source.body_text || '').trim()) {
              await queryInterface.bulkUpdate(
                'WhatsappTemplateCatalog',
                payload,
                { id: translationId },
                { transaction },
              );
            }
          }

          if (!translationId || source.is_generic) continue;
          const disciplineRows = await queryInterface.sequelize.query(
            'SELECT disciplina_code FROM WhatsappTemplateCatalogDisciplines WHERE template_catalog_id = :sourceId',
            { replacements: { sourceId: source.id }, type: QueryTypes.SELECT, transaction },
          );
          for (const row of disciplineRows) {
            const linked = await queryInterface.sequelize.query(
              'SELECT id FROM WhatsappTemplateCatalogDisciplines WHERE template_catalog_id = :translationId AND disciplina_code = :code LIMIT 1',
              { replacements: { translationId, code: row.disciplina_code }, type: QueryTypes.SELECT, transaction },
            );
            if (!linked.length) {
              await queryInterface.bulkInsert('WhatsappTemplateCatalogDisciplines', [{
                template_catalog_id: translationId,
                disciplina_code: row.disciplina_code,
                created_at: new Date(),
                updated_at: new Date(),
              }], { transaction });
            }
          }
        }
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const families = Object.keys(TRANSLATIONS);
    const rows = await queryInterface.sequelize.query(
      `SELECT c.id,
              EXISTS(SELECT 1 FROM WhatsappTemplates t WHERE t.catalog_template_id = c.id) AS has_instances
       FROM WhatsappTemplateCatalog c
       WHERE c.family_key IN (:families) AND c.locale IN ('ca', 'en')`,
      { replacements: { families }, type: QueryTypes.SELECT },
    );
    const removableIds = rows.filter((row) => !Number(row.has_instances)).map((row) => Number(row.id));
    const retainedIds = rows.filter((row) => Number(row.has_instances)).map((row) => Number(row.id));
    if (removableIds.length) {
      await queryInterface.bulkDelete('WhatsappTemplateCatalog', { id: { [Op.in]: removableIds } });
    }
    if (retainedIds.length) {
      await queryInterface.bulkUpdate(
        'WhatsappTemplateCatalog',
        { is_active: false, propagation_state: null, updated_at: new Date() },
        { id: { [Op.in]: retainedIds } },
      );
    }
  },
  _test: {
    TRANSLATIONS,
    extractPlaceholders,
    translationName,
  },
};
