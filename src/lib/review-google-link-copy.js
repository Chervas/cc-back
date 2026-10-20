'use strict';
const { normalizeWhatsappLocale } = require('./whatsapp-template-locale');

function buildReviewGoogleLinkCopy({ url, team = '', locale = 'es' }) {
  const language = normalizeWhatsappLocale(locale, { fallback: 'es' });
  if (language === 'ca') return `*Pots clicar aquí per publicar la teva opinió a Google?*\n\n👉 ${url}\n\nAixò ens ajudarà molt perquè tothom podrà veure-la, *especialment si l’acompanyes d’unes paraules*\n\n*Si esmentes algú de l’equip a la ressenya*${team ? `, com ara ${team},` : ''} li ho farem saber. Gràcies!`;
  if (language === 'en') return `*Could you click here to publish your review on Google?*\n\n👉 ${url}\n\nThis will help us a great deal because everyone will be able to see it, *especially if you add a few words*\n\n*If you mention someone from the team in your review*${team ? `, such as ${team},` : ''} we will let them know. Thank you!`;
  return `*¿Puedes pinchar aquí para publicar tu opinión en Google?*\n\n👉 ${url}\n\nEsto nos ayudará muchísimo porque todo el mundo podrá verla, *especialmente si la acompañas de algunas palabras*\n\n*Si mencionas a alguien del equipo en la reseña*${team ? `, como a ${team},` : ''} se lo haremos saber ¡Gracias!`;
}
module.exports = { buildReviewGoogleLinkCopy };
