'use strict';

const { assertValidWebDocument } = require('../lib/webDocument');

const DESIGN_SYSTEM = Object.freeze({
  brand: 'clinicaclick',
  tokens: {
    color_primary: '#5B5BF7',
    color_secondary: '#181D35',
    color_accent: '#22C3A6',
    color_surface: '#FFFFFF',
    color_text: '#181D35',
    font_heading: 'manrope',
    font_body: 'inter',
    radius: 'lg',
    spacing_density: 'comfortable',
  },
});

function baseDocument({ title, slug = 'inicio', rootIds, nodes, bindings = {}, seoDescription }) {
  return {
    schema_version: 1,
    design_system: JSON.parse(JSON.stringify(DESIGN_SYSTEM)),
    pages: [{
      id: 'page-inicio',
      title,
      slug,
      root_node_ids: rootIds,
      seo: {
        title: title.slice(0, 70),
        description: seoDescription.slice(0, 180),
        canonical_url: null,
        social_asset_id: null,
        index: false,
        follow: false,
      },
    }],
    globals: { header_node_id: null, footer_node_id: null },
    nodes,
    bindings,
    seo: { title_suffix: '', indexing: 'noindex', default_social_asset_id: null },
    consent: {
      provider: 'inherit',
      preview_mode: true,
      privacy_policy_url: null,
      privacy_policy_version: null,
      privacy_consent_text: null,
    },
    integrations: {
      intake_config_id: null,
      chat_enabled: false,
      whatsapp_enabled: false,
      phone_enabled: false,
    },
  };
}

function section(id, children, options = {}) {
  return {
    id,
    type: 'section',
    version: 1,
    props: {
      layout: options.layout || 'stack',
      columns: options.columns || 1,
      semantic_tag: options.semanticTag || 'section',
    },
    children,
    style_tokens: {
      background: options.background || 'surface',
      foreground: options.foreground || 'default',
      content_width: options.width || 'standard',
      spacing_top: options.spacingTop || 'xl',
      spacing_bottom: options.spacingBottom || 'xl',
      gap: options.gap || 'md',
      radius: 'inherit',
      shadow: 'none',
      align: options.align || 'stretch',
    },
    responsive: options.columns && options.columns > 1 ? { mobile: { columns: 1 } } : {},
  };
}

function heading(id, text, level = 2, options = {}) {
  return {
    id,
    type: 'heading',
    version: 1,
    props: {
      text,
      level,
      size: options.size || (level === 1 ? '3xl' : 'xl'),
      align: options.align || 'left',
      tone: options.tone || 'default',
    },
    children: [],
    ...(options.bindingIds ? { binding_ids: options.bindingIds } : {}),
  };
}

function text(id, value, options = {}) {
  return {
    id,
    type: 'text',
    version: 1,
    props: {
      text: value,
      size: options.size || 'md',
      align: options.align || 'left',
      tone: options.tone || 'default',
    },
    children: [],
  };
}

function button(id, label, target, options = {}) {
  return {
    id,
    type: 'button',
    version: 1,
    props: {
      label,
      action: options.action || 'intake_form_anchor',
      target,
      variant: options.variant || 'primary',
      open_in_new_tab: false,
    },
    children: [],
    ...(options.bindingIds ? { binding_ids: options.bindingIds } : {}),
  };
}

function intakeForm(id, options = {}) {
  const fields = [
    { id: `${id}-name`, name: 'first_name', type: 'text', label: 'Nombre', required: true, autocomplete: 'given-name' },
    { id: `${id}-phone`, name: 'phone', type: 'tel', label: 'Teléfono', required: true, autocomplete: 'tel' },
  ];
  if (options.email) fields.push({
    id: `${id}-email`, name: 'email', type: 'email', label: 'Email', required: false, autocomplete: 'email',
  });
  if (options.preferredContact) fields.push({
    id: `${id}-contact`,
    name: 'preferred_contact',
    type: 'select',
    label: '¿Cómo prefieres que contactemos?',
    required: false,
    options: [
      { value: 'telefono', label: 'Por teléfono' },
      { value: 'whatsapp', label: 'Por WhatsApp' },
      { value: 'email', label: 'Por email' },
    ],
  });
  if (options.message) fields.push({
    id: `${id}-message`,
    name: 'message',
    type: 'textarea',
    label: options.messageLabel || '¿Cómo podemos ayudarte?',
    required: false,
    autocomplete: 'off',
    placeholder: options.messagePlaceholder || 'Cuéntanos brevemente qué necesitas',
  });
  fields.push({
    id: `${id}-privacy`,
    name: 'privacy_consent',
    type: 'checkbox',
    label: 'He leído y acepto la política de privacidad',
    required: true,
    autocomplete: 'off',
  });
  return {
    id,
    type: 'intake_form',
    version: 1,
    props: {
      form_key: options.formKey || 'primary-contact',
      title: options.title || 'Pide tu primera visita',
      description: options.description || 'Déjanos tus datos y el equipo de la clínica te contactará.',
      submit_label: options.submitLabel || 'Quiero que me contacten',
      success_message: 'Gracias. La clínica contactará contigo lo antes posible.',
      fields,
    },
    children: [],
  };
}

function quickTreatment() {
  const formId = 'rapid-form-primary';
  const nodes = {
    'rapid-hero': section('rapid-hero', ['rapid-title', 'rapid-copy', 'rapid-cta'], {
      semanticTag: 'main', background: 'brand', foreground: 'inverse', width: 'narrow', spacingTop: '2xl', spacingBottom: '2xl', align: 'center',
    }),
    'rapid-title': heading('rapid-title', 'Da el primer paso hacia tu nueva sonrisa', 1, { tone: 'inverse', align: 'center' }),
    'rapid-copy': text('rapid-copy', 'Una primera valoración clara, cercana y sin tecnicismos innecesarios.', { tone: 'inverse', align: 'center', size: 'lg' }),
    'rapid-cta': button('rapid-cta', 'Pedir primera visita', formId),
    'rapid-benefits': section('rapid-benefits', ['rapid-benefits-title', 'rapid-benefit-one', 'rapid-benefit-two', 'rapid-benefit-three'], { width: 'wide', layout: 'grid', columns: 3, gap: 'lg' }),
    'rapid-benefits-title': heading('rapid-benefits-title', 'Qué puedes esperar', 2),
    'rapid-benefit-one': text('rapid-benefit-one', 'Valoración personal para entender tu caso y tus prioridades.'),
    'rapid-benefit-two': text('rapid-benefit-two', 'Opciones explicadas de forma sencilla antes de decidir.'),
    'rapid-benefit-three': text('rapid-benefit-three', 'Un equipo que te acompaña durante todo el proceso.'),
    'rapid-form-section': section('rapid-form-section', [formId], { background: 'muted', width: 'narrow' }),
    [formId]: intakeForm(formId, { message: true }),
  };
  return baseDocument({
    title: 'Tratamiento de decisión rápida',
    rootIds: ['rapid-hero', 'rapid-benefits', 'rapid-form-section'],
    nodes,
    seoDescription: 'Landing directa para tratamientos con una decisión inicial rápida y una llamada a la acción clara.',
  });
}

function consideredTreatment() {
  const formId = 'considered-form-primary';
  const nodes = {
    'considered-hero': section('considered-hero', ['considered-title', 'considered-copy', 'considered-cta'], { semanticTag: 'main', width: 'narrow', spacingTop: '2xl', spacingBottom: '2xl' }),
    'considered-title': heading('considered-title', 'Decide con toda la información y a tu ritmo', 1),
    'considered-copy': text('considered-copy', 'Te explicamos alternativas, fases y próximos pasos para que puedas valorar el tratamiento con tranquilidad.', { size: 'lg' }),
    'considered-cta': button('considered-cta', 'Solicitar una valoración', formId),
    'considered-process': section('considered-process', ['considered-process-title', 'considered-step-one', 'considered-step-two', 'considered-step-three'], { background: 'muted', layout: 'grid', columns: 3, width: 'wide', gap: 'lg' }),
    'considered-process-title': heading('considered-process-title', 'Un proceso claro desde el principio', 2),
    'considered-step-one': text('considered-step-one', '1. Escuchamos qué necesitas y resolvemos tus primeras dudas.'),
    'considered-step-two': text('considered-step-two', '2. Valoramos tu caso y explicamos las opciones adecuadas.'),
    'considered-step-three': text('considered-step-three', '3. Recibes un plan comprensible antes de tomar una decisión.'),
    'considered-form-section': section('considered-form-section', [formId], { width: 'narrow' }),
    [formId]: intakeForm(formId, { email: true, message: true, preferredContact: true, title: 'Cuéntanos qué quieres valorar' }),
  };
  return baseDocument({
    title: 'Tratamiento de alta consideración',
    rootIds: ['considered-hero', 'considered-process', 'considered-form-section'],
    nodes,
    seoDescription: 'Landing educativa para tratamientos que requieren comparar opciones y resolver dudas antes de decidir.',
  });
}

function generalClinic() {
  const formId = 'clinic-form-primary';
  const nodes = {
    'clinic-hero': section('clinic-hero', ['clinic-title', 'clinic-copy', 'clinic-cta'], { semanticTag: 'main', background: 'brand', foreground: 'inverse', width: 'narrow', spacingTop: '2xl', spacingBottom: '2xl' }),
    'clinic-title': heading('clinic-title', 'Tu clínica, cerca de ti', 1, { tone: 'inverse', bindingIds: ['clinic-name-binding'] }),
    'clinic-copy': text('clinic-copy', 'Atención cercana, opciones explicadas con claridad y un equipo preparado para ayudarte.', { tone: 'inverse', size: 'lg' }),
    'clinic-cta': button('clinic-cta', 'Pedir cita', formId),
    'clinic-trust': section('clinic-trust', ['clinic-trust-title', 'clinic-trust-one', 'clinic-trust-two', 'clinic-trust-three'], { layout: 'grid', columns: 3, width: 'wide' }),
    'clinic-trust-title': heading('clinic-trust-title', 'Cuidamos cada detalle de tu visita', 2),
    'clinic-trust-one': text('clinic-trust-one', 'Te escuchamos antes de recomendarte el siguiente paso.'),
    'clinic-trust-two': text('clinic-trust-two', 'Explicamos el plan y resolvemos tus dudas sin prisas.'),
    'clinic-trust-three': text('clinic-trust-three', 'Facilitamos el contacto y el seguimiento desde el primer día.'),
    'clinic-form-section': section('clinic-form-section', [formId], { background: 'muted', width: 'narrow' }),
    [formId]: intakeForm(formId, { message: true, preferredContact: true }),
  };
  const bindings = {
    'clinic-name-binding': {
      target_node_id: 'clinic-title',
      target_prop: 'text',
      source: 'clinic',
      source_id: null,
      field: 'name',
    },
  };
  return baseDocument({
    title: 'Captación general de clínica',
    rootIds: ['clinic-hero', 'clinic-trust', 'clinic-form-section'],
    nodes,
    bindings,
    seoDescription: 'Landing general de clínica con propuesta de valor, confianza y formulario de primera visita.',
  });
}

function localCallWhatsapp() {
  const formId = 'local-form-primary';
  const nodes = {
    'local-hero': section('local-hero', ['local-title', 'local-copy', 'local-call', 'local-whatsapp'], { semanticTag: 'main', background: 'accent', foreground: 'inverse', width: 'narrow', spacingTop: '2xl', spacingBottom: '2xl', align: 'center' }),
    'local-title': heading('local-title', 'Habla ahora con una clínica cercana', 1, { tone: 'inverse', align: 'center' }),
    'local-copy': text('local-copy', 'Elige cómo prefieres contactar o déjanos tus datos para que te llamemos.', { tone: 'inverse', align: 'center', size: 'lg' }),
    'local-call': button('local-call', 'Llamar a la clínica', '+34900000000', { action: 'phone', variant: 'secondary', bindingIds: ['local-phone-binding'] }),
    'local-whatsapp': button('local-whatsapp', 'Escribir por WhatsApp', '+34900000000', { action: 'whatsapp', variant: 'outline', bindingIds: ['local-whatsapp-binding'] }),
    'local-address': section('local-address', ['local-address-title', 'local-address-value'], { width: 'narrow' }),
    'local-address-title': heading('local-address-title', 'Dónde estamos', 2),
    'local-address-value': text('local-address-value', 'Dirección de la clínica', { bindingIds: ['local-address-binding'] }),
    'local-form-section': section('local-form-section', [formId], { background: 'muted', width: 'narrow' }),
    [formId]: intakeForm(formId, { preferredContact: true, message: true }),
  };
  // text() no añade bindings para mantener su API pequeña.
  nodes['local-address-value'].binding_ids = ['local-address-binding'];
  const bindings = {
    'local-phone-binding': { target_node_id: 'local-call', target_prop: 'target', source: 'clinic', source_id: null, field: 'phone' },
    'local-whatsapp-binding': { target_node_id: 'local-whatsapp', target_prop: 'target', source: 'clinic', source_id: null, field: 'phone' },
    'local-address-binding': { target_node_id: 'local-address-value', target_prop: 'text', source: 'clinic', source_id: null, field: 'address' },
  };
  const document = baseDocument({
    title: 'Campaña local con llamada y WhatsApp',
    rootIds: ['local-hero', 'local-address', 'local-form-section'],
    nodes,
    bindings,
    seoDescription: 'Landing local centrada en llamada, WhatsApp y contacto rápido con la clínica.',
  });
  document.integrations.whatsapp_enabled = true;
  document.integrations.phone_enabled = true;
  return document;
}

function qualificationForm() {
  const formId = 'qualify-form-primary';
  const nodes = {
    'qualify-hero': section('qualify-hero', ['qualify-title', 'qualify-copy'], { semanticTag: 'main', width: 'narrow', spacingTop: '2xl' }),
    'qualify-title': heading('qualify-title', 'Cuéntanos qué necesitas', 1),
    'qualify-copy': text('qualify-copy', 'Con unas pocas respuestas podremos preparar mejor el primer contacto contigo.', { size: 'lg' }),
    'qualify-form-section': section('qualify-form-section', [formId], { width: 'narrow', spacingTop: 'lg' }),
    [formId]: intakeForm(formId, {
      email: true,
      preferredContact: true,
      message: true,
      title: 'Empecemos por lo esencial',
      messageLabel: '¿Qué te gustaría resolver?',
      messagePlaceholder: 'Describe tu consulta sin incluir información médica sensible',
      submitLabel: 'Enviar mi solicitud',
      formKey: 'qualification-contact',
    }),
  };
  return baseDocument({
    title: 'Formulario de cualificación',
    rootIds: ['qualify-hero', 'qualify-form-section'],
    nodes,
    seoDescription: 'Landing con formulario de cualificación para preparar un contacto útil y reducir leads incompletos.',
  });
}

const DEFINITIONS = Object.freeze([
  {
    id: '61e5a73e-bcd5-47f0-a145-a0ddcbd76001',
    catalog_key: 'quick-treatment-v1',
    name: 'Tratamiento directo',
    description: 'Para una decisión inicial rápida, con beneficios breves y una llamada a la acción visible.',
    category: 'treatment',
    document: quickTreatment(),
  },
  {
    id: '61e5a73e-bcd5-47f0-a145-a0ddcbd76002',
    catalog_key: 'considered-treatment-v1',
    name: 'Tratamiento explicado',
    description: 'Para tratamientos que necesitan contexto, fases y un formulario más completo.',
    category: 'treatment',
    document: consideredTreatment(),
  },
  {
    id: '61e5a73e-bcd5-47f0-a145-a0ddcbd76003',
    catalog_key: 'general-clinic-v1',
    name: 'Clínica general',
    description: 'Presentación general de la clínica con confianza y captación de primera visita.',
    category: 'clinic',
    document: generalClinic(),
  },
  {
    id: '61e5a73e-bcd5-47f0-a145-a0ddcbd76004',
    catalog_key: 'local-call-whatsapp-v1',
    name: 'Contacto local',
    description: 'Prioriza llamada y WhatsApp, manteniendo un formulario como alternativa.',
    category: 'local',
    document: localCallWhatsapp(),
  },
  {
    id: '61e5a73e-bcd5-47f0-a145-a0ddcbd76005',
    catalog_key: 'qualification-form-v1',
    name: 'Formulario de cualificación',
    description: 'Recoge los datos mínimos para preparar mejor el primer contacto.',
    category: 'qualification',
    document: qualificationForm(),
  },
]);

for (const definition of DEFINITIONS) assertValidWebDocument(definition.document);

module.exports = {
  BUILTIN_WEB_TEMPLATES_V1: DEFINITIONS,
  DESIGN_SYSTEM,
};
