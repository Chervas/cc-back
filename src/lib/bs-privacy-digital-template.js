'use strict';

// Tablet-first presentation of the supplied LOPD. This is not a new legal
// notice: substantive wording, including the source's spelling, is preserved.
// Paper identity/signature blanks and the duplicate yes/no table are omitted;
// the existing consent engine owns the four independent decisions and signing.
const { createHash } = require('node:crypto');
const { CHOICE_SCHEMA_VERSION, CHOICE_KEYS, CHOICE_LABELS, validateForm } = require('./consent-document-choices');

const RENDERER_VERSION = 'bs-privacy-digital/v1';
const SOURCE_DOCUMENT_SHA256 = 'e31760491bf0929ca25a4976f4f2c463cece9af7a41ecb6c0e84508aaddb741f';
const APPROVED_LEGACY_HTML_SHA256 = '268938759b654c0eb2316a78f50b44b5cf111df72640e1edc3a0e712dca518ab';
const sha256 = text => createHash('sha256').update(String(text), 'utf8').digest('hex');
const normalizeText = text => String(text).replace(/\s+/gu, ' ').trim();
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

// Source paragraphs 6–32 after whitespace-only normalization. Headings are
// semantic headings; the five legal bases are semantic list items, not edits.
const LEGAL_BLOCKS = Object.freeze([
  ['p', 'En cumplimiento del Reglamento Europeo (UE) 2016/679 (RGPD) de protección de datos personales le comunicamos a continuación que tratamiento realizamos de los datos que nos proporciona:'],
  ['h3', 'El responsable de sus datos es:'],
  ['p', 'INSTITUTO OBES ALICANTE S.L. con CIF B54847090 y domicilio en C/ ARQUITECTO MORELL 9 BAJO 03003 ALICANTE y teléfono 966283955 email info@bsmedical.es Contacto con el delegado de protección de datos o DPO dpo@bsmedical.es'],
  ['h3', '¿Con qué finalidad trato sus datos personales?'],
  ['p', 'Con la finalidad de realizar la gestión del tratamiento médico que nos solicita sobre nuestros servicios en medicina y cirugía estética facial y corporal, cirugía y tratamiento de la obesidad, nutrición, psicología, cirugía capilar (micro injertos) y su tratamiento sea realizado por un profesional sujeto a la obligación de secreto profesional. Así como las tareas administrativas derivadas de la prestación asistencial y, por otro lado, con fines de gestión contable, fiscal y administrativa.'],
  ['h3', '¿Qué datos recabaremos sobre usted?'],
  ['p', 'Recabaremos sus datos personales, así como los datos médicos y clínicos necesarios para prestarles el servicio que nos solicita, incluyendo análisis clínicos, fotografías para la valoración de la evolución del tratamiento, así como las pruebas médicas solicitas con la finalidad de realizar los tratamientos médicos solicitados y que ofertamos en nuestra clínica.'],
  ['h3', '¿Por cuánto tiempo conservaré sus datos personales?'],
  ['p', 'Conservaré los datos personales incluidos en su historial clínico durante un período mínimo de cinco años a contar desde la fecha de alta de cada proceso asistencial, de acuerdo a la Ley 41/2002 de autonomía del paciente y derechos y obligaciones en materia de información y documentación clínica y la Ley 10/2014, de 29 diciembre, de la Comunidad Valenciana. Cuatro Años a efectos fiscales: Los libros de contabilidad y otros libros registros obligatorios según la normativa tributaria que proceda (IRPF, IVA, IS, etc.). Artículos 66 a 70 Ley General Tributaria. Seis años a efectos mercantiles: (facturas, contratos, documentos bancarios, etc.). Art. 30 Código Comercio.'],
  ['h3', '¿Cuál es la legitimación para el tratamiento de sus datos personales?'],
  ['li', 'La ejecución de un contrato para la prestación de la asistencia médica que nos solicita (artículo 6.1.b RGPD) y su tratamiento sea realizado por un profesional sujeto a la obligación de secreto profesional (Art. 9.2 h y artículo 9.3 RGPD)'],
  ['li', 'El cumplimiento de obligaciones legales aplicables a la actividad médica derivadas de la Ley 41/2002 de autonomía del paciente y derechos y obligaciones en materia de información y documentación clínica (artículo 6.1.c RGPD)'],
  ['li', 'El cumplimiento de obligaciones legales derivadas de la legislación mercantil y tributaria. (artículo 6.1.c RGPD)'],
  ['li', 'El tratamiento de datos de salud en el caso de que nos solicite servicios que no sean sanitarios y que ofertamos en nuestra clínica se trataran amparados en su consentimiento que le solicitamos al pie de este documento (artículo 6.1.a RGPD) En el caso de no darnos su consentimiento no podremos prestarle nuestros servicios.'],
  ['li', 'Su consentimiento expreso e inequívoco para informado sobre nuestros servicios. (artículo 6.1.a RGPD) que le solicitamos al pie de este documento.'],
  ['h3', '¿A qué destinatarios se comunicarán sus datos personales?'],
  ['p', 'Sus datos sean cedidos a Los hospitales con los cuales el INSTITUTO OBES ALICANTE S.L. tiene acuerdos de colaboración con la finalidad de realizar el tratamiento médico-quirúrgico que nos solicita y que son imprescindibles para prestarle los servicios. No obstante, si usted es intervenido en algún hospital, esté también será responsable del tratamiento de sus datos. A mediadores y empresas de financiación con la finalidad de tramitar la financiación si nos la solicita. No se comunicarán a terceros ajenos a la clínica, salvo en los supuestos legalmente previstos.'],
  ['h3', '¿Cómo he obtenidos sus datos personales?'],
  ['p', 'Los datos personales que le conciernen me los ha proporcionado usted.'],
  ['h3', '¿Se van a realizar transferencias de datos a terceros países?'],
  ['p', 'No se van a producir Transferencias Internacionales de datos'],
  ['h3', 'Ud. podrá ejercitar los siguientes derechos en relación a sus datos personales:'],
  ['p', 'Podrá ejercitar los derechos de acceso, rectificación, supresión, limitación, portabilidad, retirada del consentimiento y oposición de sus datos personales en la dirección de correo electrónico dpo@bsmedical.es o en la dirección de correo postal C/ ARQUITECTO MORELL 9 BAJO 03003 ALICANTE acreditando su identidad. Podrá encontrar toda la información de cómo ejercer estos derechos y como obtener los formularios para ejercitar sus derechos en la política de privacidad de nuestra página web www.bsmedical.es y/o www.bscapilar.es .'],
  ['h3', 'Derecho De Reclamación A La Autoridad De Control'],
  ['p', 'Podrá solicitar la tutela de derechos que no hayan sido debidamente atendidos a la Agencia Española de Protección de datos. Bien a través de la sede electrónica de su portal web (www.agpd.es), o bien mediante escrito dirigido a su dirección postal (C/Jorge Juan, 6, 28001-Madrid).'],
  ['h3', 'Información y consentimiento'],
  ['p', 'Con la firma del presente documento me considero informado y consiento el tratamiento de mis datos con las premisas anteriormente expuestas.'],
].map(([tag, text]) => Object.freeze({ tag, text })));

const LEGAL_BODY_TEXT = LEGAL_BLOCKS.map(block => block.text).join('\n');
// Preserve the source's logical ordering for audit: clauses, four decisions,
// final declaration. Decision controls are rendered separately by the engine.
const LEGAL_TEXT = [...LEGAL_BLOCKS.slice(0, -1).map(block => block.text),
  ...CHOICE_KEYS.map(key => CHOICE_LABELS[key]), LEGAL_BLOCKS.at(-1).text].join('\n');
const LEGAL_BODY_SHA256 = sha256(LEGAL_BODY_TEXT);
const LEGAL_TEXT_SHA256 = sha256(LEGAL_TEXT);

const IDENTITY_FIELDS = Object.freeze([
  ['nombre_completo', 'Paciente'], ['dni', 'DNI o documento de identidad'],
  ['fecha_nacimiento', 'Fecha de nacimiento'], ['compania', 'Compañía'], ['direccion', 'Dirección'],
  ['codigo_postal', 'Código postal'], ['ciudad', 'Población'], ['provincia', 'Provincia'],
  ['telefono', 'Teléfono'], ['telefono2', 'Segundo teléfono'], ['email', 'Correo electrónico'],
].map(([key, label]) => Object.freeze({ key, label })));
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function identityValue(value) {
  return typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
    ? normalizeText(value) : '';
}
function renderIdentity(context) {
  const patient = record(context?.paciente) ? context.paciente : {};
  const fields = IDENTITY_FIELDS.map(field => ({ ...field, value: Object.prototype.hasOwnProperty.call(patient, field.key)
    ? identityValue(patient[field.key]) : '' }))
    .filter(field => field.value);
  if (!fields.length) return '';
  return '<section class="consent-patient-identity"><h3>Datos del paciente</h3><dl>'
    + fields.map(field => `<div><dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd></div>`).join('')
    + '</dl></section>\n';
}
function renderLegalBlocks() {
  let html = '', inList = false;
  for (const { tag, text } of LEGAL_BLOCKS) {
    if (tag === 'li' && !inList) { html += '<ul>\n'; inList = true; }
    if (tag !== 'li' && inList) { html += '</ul>\n'; inList = false; }
    html += `<${tag}>${escapeHtml(text)}</${tag}>\n`;
  }
  return html + (inList ? '</ul>\n' : '');
}
function metadata() {
  return {
    schema_version: RENDERER_VERSION,
    renderer_version: RENDERER_VERSION,
    source_document_sha256: SOURCE_DOCUMENT_SHA256,
    source_html_sha256: APPROVED_LEGACY_HTML_SHA256,
    legal_text_sha256: LEGAL_TEXT_SHA256,
    legal_body_sha256: LEGAL_BODY_SHA256,
    text_normalization: 'whitespace-collapse-and-trim/v1',
    choice_schema_version: CHOICE_SCHEMA_VERSION,
  };
}
function buildBsPrivacyDigitalHtml(context = {}) {
  return {
    html: '<section lang="es" class="bs-privacy-digital" data-consent-presentation="' + RENDERER_VERSION
      + '"><h2>Protección de datos</h2>\n' + renderIdentity(context) + renderLegalBlocks() + '</section>',
    metadata: metadata(),
    consent_form: { schema_version: CHOICE_SCHEMA_VERSION, fields: CHOICE_KEYS.map(key => ({
      key, type: 'yes_no', required: true, label: CHOICE_LABELS[key],
    })) },
  };
}
function jsonRecord(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return record(value) ? value : null;
}
function isApprovedPrivacyPresentation({ bodyHtml, bodyJson } = {}) {
  const canonical = buildBsPrivacyDigitalHtml(), body = jsonRecord(bodyJson);
  const marker = jsonRecord(body?.digital_presentation), expected = canonical.metadata;
  if (bodyHtml !== canonical.html || !marker || Object.keys(marker).length !== Object.keys(expected).length
    || Object.keys(expected).some(key => marker[key] !== expected[key])) return false;
  try { return JSON.stringify(validateForm(body.consent_form)) === JSON.stringify(canonical.consent_form); }
  catch { return false; }
}

module.exports = { RENDERER_VERSION, SOURCE_DOCUMENT_SHA256, APPROVED_LEGACY_HTML_SHA256,
  LEGAL_BLOCKS, LEGAL_BODY_SHA256, LEGAL_TEXT_SHA256, LEGAL_TEXT, IDENTITY_FIELDS,
  buildBsPrivacyDigitalHtml, isApprovedPrivacyPresentation };
