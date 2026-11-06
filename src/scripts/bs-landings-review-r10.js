'use strict';

// Offline review recipe only. No database, provider, publication or billing
// client is loaded. Callers explicitly save a reviewed draft with normal CAS.
const assert = require('node:assert/strict');
const { assertValidWebDocument } = require('../lib/webDocument');
const { createReviewComponents } = require('../lib/webLandingReviewComponents');
const specification = require('./data/bs-landings-review-r10.json');

function reviewBsLandingDocument({ key, document: original, assets }) {
  const plan = specification.plans[key];
  if (!plan || !specification.review_only || plan.allowed_for_publication) throw Error('review_plan_not_allowed');
  assertValidWebDocument(original);
  assert.equal(original.seo.indexing, 'noindex', 'Only noindex drafts are accepted');
  assert(original.pages.every(page => page.seo.index === false));
  const document = structuredClone(original), nodes = document.nodes;
  const prefix = `r10_${key.replaceAll('-', '_')}`;
  const c = createReviewComponents(document, prefix, assets);
  const contexts = [];
  const descendants = nodeId => [nodes[nodeId], ...nodes[nodeId].children.flatMap(descendants)];
  const anchor = role => {
    const node = nodes[plan.anchors[role]];
    if (node?.type !== 'section') throw Error(`review_anchor_missing:${key}:${role}`);
    return node;
  };
  const cta = (name, label, interest = null) => {
    const nodeId = c.make(name, 'button', { label, action: 'intake_form_anchor', target: 'form_contact', variant: 'primary', open_in_new_tab: false });
    if (interest) contexts.push({ button_node_id: nodeId, form_node_id: 'form_contact', value: interest.id, label: interest.name });
    return nodeId;
  };
  const isDark = key === 'c06-cupon';
  const offersRoot = anchor('offers');
  if (!plan.price_module_preview_enabled || plan.capilar_hold) assert.equal(plan.offers.length, 0);

  const cards = plan.offers.map((offer) => {
    const p = offer.id;
    const body = [
      ...(offer.badge ? [c.text(`${p}_badge`, offer.badge, { size: 'md', tone: 'brand' })] : []),
      ...(offer.benefit ? [c.heading(`${p}_benefit`, offer.benefit, { level: 3, size: 'md' })] : []),
      c.heading(`${p}_name`, offer.name, { level: 3, size: 'md' }),
      c.price(`${p}_price`, offer),
      ...offer.inclusions.map((line, i) => c.text(`${p}_inclusion_${i}`, line)),
      ...(offer.finance_example ? [c.text(`${p}_finance_legal`, offer.finance_example, { size: 'md' })] : []),
      cta(`${p}_cta`, offer.cta, offer),
    ];
    const content = c.group(`${p}_content`, body, {
      gap: 'md', spacing_top: 'lg', spacing_bottom: 'lg', background: 'surface',
    }, { pin_last_child: true });
    const photo = offer.images ? c.imagePair(`${p}_photo`, offer.images, `${offer.name} · Imagen ilustrativa del servicio`, plan.horizontal_offer ? { height_mode: 'fill' } : {}) : null;
    if (plan.horizontal_offer) {
      const row = c.grid(`${p}_horizontal`, [photo, content], 2, 1, { gap: 'lg' });
      return c.group(`${p}_card`, [row], { background: 'surface', radius: 'lg', gap: 'none' });
    }
    return c.group(`${p}_card`, [...(photo ? [photo] : []), content], { background: 'surface', radius: 'lg', gap: 'none' });
  });
  const offersHeading = c.heading('offers_title', plan.offers_title, { tone: isDark ? 'inverse' : 'default' });
  const offersChildren = [c.text('offers_eyebrow', plan.capilar_hold ? 'TU PRIMER PASO' : 'CONOCE LAS OPCIONES', { size: 'sm', tone: isDark ? 'inverse' : 'brand' }), offersHeading];
  for (let i = 0; i < cards.length; i += 2) {
    offersChildren.push(cards.length === 1 ? cards[0] : c.grid(`offer_row_${i}`, cards.slice(i, i + 2)));
  }

  if (plan.ona_steps) {
    const steps = [
      ['Limpieza y exfoliación', 'La hidrodermoabrasión y el doble peeling ayudan a retirar impurezas y células superficiales.'],
      ['Hidratación sin agujas', 'Un sérum hidratante se aplica mediante electroporación. No es mesoterapia inyectada.'],
      ['Luz LED', 'El equipo incorpora el LED dentro del protocolo de cuidado facial.'],
      ['Electroestimulación', 'La electroestimulación de baja frecuencia trabaja la musculatura y el tono facial.'],
    ];
    offersChildren.push(c.heading('ona_steps_title', 'Así es tu sesión de ONA', { size: 'md' }));
    const stepCards = steps.map(([title, description], i) => c.group(`ona_step_${i}`, [
      c.text(`ona_step_${i}_number`, String(i + 1).padStart(2, '0'), { tone: 'brand' }),
      c.heading(`ona_step_${i}_title`, title, { level: 3, size: 'sm' }),
      c.text(`ona_step_${i}_description`, description),
    ], { background: 'muted', radius: 'lg', spacing_top: 'lg', spacing_bottom: 'lg' }));
    offersChildren.push(c.grid('ona_steps', stepCards, 4, 1));
  }
  if (plan.capilar_hold) {
    offersChildren.push(c.text('diagnostic_intro', 'Una sesión gratuita con el equipo capilar para valorar tu situación, conocer las opciones y explicar qué puedes esperar.'));
    offersChildren.push(c.grid('diagnostic_features', [
      ['Valoración de tu cabello', 'El equipo estudia si necesitas un tratamiento y qué alternativas pueden encajar.'],
      ['Información para decidir', 'Conoce la idoneidad, las expectativas y el presupuesto antes de dar el siguiente paso.'],
      ['El injerto no siempre es necesario', 'La recomendación depende de la valoración individual, no de elegir un paquete de antemano.'],
    ].map(([title, text], i) => c.group(`diagnostic_feature_${i}`, [
      c.heading(`diagnostic_feature_${i}_title`, title, { level: 3, size: 'sm' }),
      c.text(`diagnostic_feature_${i}_text`, text),
    ], { background: 'surface', radius: 'lg', spacing_top: 'lg', spacing_bottom: 'lg' })), 3));
    offersChildren.push(cta('diagnostic_cta', 'Solicitar diagnóstico gratuito'));
  }
  offersRoot.children = offersChildren;

  // Add economics before the CTA/image; never replace the representative
  // financing example with an empty asterisk or with the historical Pepper copy.
  const hero = anchor('hero');
  const h1 = descendants(hero.id).find(node => node.type === 'heading' && node.props.level === 1);
  if (!h1) throw Error('review_hero_title_missing');
  h1.props.text = plan.title;
  const message = descendants(hero.id).find(node => node.type === 'section' && node.children.includes(h1.id));
  message.children = message.children.filter(nodeId => !nodeId.startsWith(`${prefix}_hero_economic`) && !nodeId.startsWith(`${prefix}_hero_finance`));
  if (plan.hero_economics) {
    const e = plan.hero_economics;
    const economics = c.group('hero_economics', [
      c.price('hero_economic_price', { amount: e.amount, quantity: e.detail }, { inverse: isDark }),
      c.text('hero_economic_note', e.note, { size: 'md', tone: isDark ? 'inverse' : 'default' }),
      ...(key === 'c01-inj' ? [c.text('hero_finance_legal', specification.finance_legal_copy, { size: 'md' })] : []),
    ], { gap: 'sm' });
    const buttonIndex = message.children.findIndex(nodeId => nodes[nodeId].type === 'button');
    message.children.splice(buttonIndex < 0 ? message.children.length : buttonIndex, 0, economics);
  }
  if (plan.hero_images) {
    const heroRow = descendants(hero.id).find(node => node.type === 'section' && node.children.includes(message.id));
    assert(heroRow && heroRow.children.length === 2, 'Two-column hero required');
    heroRow.children = [message.id, c.imagePair('hero_diagnostic', plan.hero_images, 'Valoración capilar con el equipo · Fotografía de diagnóstico', { loading: 'eager' })];
  }

  if (plan.anchors.team) {
    const team = anchor('team');
    const photo = c.image('loza_photo', 'IMG-048', 'Dr. José Loza', { fit: 'contain' });
    const bio = c.group('loza_bio', [
      c.text('loza_eyebrow', 'CONOCE AL DOCTOR', { size: 'sm', tone: 'brand' }),
      c.heading('loza_name', 'Dr. José Loza'),
      c.text('loza_intro', 'Licenciado en Medicina por la Universidad de Sevilla y máster en Trasplante y Medicina Capilar por la Institución Universitaria Mississippi–Universidad de Alcalá. Compagina la práctica clínica con la formación de otros médicos.'),
      c.heading('loza_training_title', 'Formación en medicina capilar', { level: 3, size: 'sm' }),
      c.text('loza_training', 'Máster en Trasplante y Medicina Capilar; formación adicional en Medicina Estética.'),
      c.heading('loza_teaching_title', 'Experiencia docente', { level: 3, size: 'sm' }),
      c.text('loza_teaching', 'Profesor del máster de Medicina y Trasplante Capilar y formador de médicos en técnica FUE.'),
      c.heading('loza_surgery_title', 'Cirugía capilar FUE–DHI', { level: 3, size: 'sm' }),
      c.text('loza_surgery', 'Estudio de la zona donante, diseño del injerto y planificación del seguimiento en BS Capilar.'),
      c.text('loza_team_role', 'El diagnóstico gratuito lo realiza el equipo capilar. La intervención de cada profesional se concreta según la valoración.'),
      cta('loza_cta', 'Solicitar diagnóstico gratuito'),
    ], { gap: 'md' });
    const teamRow = c.grid('loza_row', [photo, bio]);
    nodes[teamRow].props.column_tracks = { desktop: [4, 8], tablet: [5, 7], mobile: [12] };
    team.children = [teamRow];
  }

  if (plan.anchors.gallery) {
    const gallery = anchor('gallery');
    const imageNodes = descendants(gallery.id).filter(node => node.type === 'image');
    const find = match => imageNodes.find(node => match.test(node.props.alt));
    const photos = [find(/recepci[oó]n/i), find(/espera/i), find(/cabina/i)];
    assert(photos.every(Boolean), 'Three existing clinic photos required');
    const pair = (name, originalImage, desktopFrame, mobileFrame) => {
      const make = (device, frame) => {
        const nodeId = c.make(`gallery_${name}_${device}`, 'image', {
          ...originalImage.props, loading: 'lazy', height_mode: 'auto', aspect_ratio: 'custom',
          fit: 'cover', frame_width: frame[0], frame_height: frame[1], focal_x: 50, focal_y: 50,
        }, [], { radius: 'lg' });
        nodes[nodeId].responsive = device === 'desktop' ? { mobile: { visible: false } } : { desktop: { visible: false }, tablet: { visible: false } };
        return nodeId;
      };
      return c.group(`gallery_${name}`, [make('desktop', desktopFrame), make('mobile', mobileFrame)], { gap: 'none' });
    };
    const main = pair('main', photos[0], [720, 400], [342, 250]);
    const secondary = c.grid('gallery_secondary', [
      pair('waiting', photos[1], [544, 192], [163, 220]),
      pair('room', photos[2], [544, 192], [163, 220]),
    ], 1, 2, { gap: 'md' });
    const row = c.grid('gallery_mosaic', [main, secondary], 2, 1, { gap: 'md' });
    nodes[row].props.column_tracks = { desktop: [7, 5], tablet: [7, 5], mobile: [12] };
    gallery.children = [
      c.text('gallery_eyebrow', 'ALICANTE', { size: 'sm', tone: 'brand' }),
      c.heading('gallery_title', 'Conoce dónde vamos a cuidarte'), row,
    ];
  }

  const form = nodes.form_contact;
  assert.equal(form?.type, 'intake_form');
  const offerOptions = form.props.fields.find(field => field.name === 'interest');
  if (offerOptions) {
    offerOptions.options = offerOptions.options.map(option => {
      const offer = plan.offers.find(item => item.id === option.value);
      return offer ? { ...option, label: offer.name } : option;
    });
  }
  for (const context of contexts) {
    context.native_interest_field = !!offerOptions?.options.some(option => option.value === context.value);
  }
  const pageCta = plan.page_cta || 'Solicitar información';
  const headerIds = new Set(descendants(document.globals.header_node_id).map(node => node.id));
  const contextual = new Set(contexts.map(context => context.button_node_id));
  const footerIds = new Set(descendants(document.globals.footer_node_id).map(node => node.id));
  for (const node of Object.values(nodes)) {
    if (node.type === 'text') node.props.text = node.props.text.replace(/(?:Programa )?\bBS 28\b/g, 'Programa BS 28');
    if (node.type === 'button' && (node.props.action === 'whatsapp'
      || (node.props.action === 'intake_form_anchor' && node.props.label === 'Solicitar contacto'))) {
      node.props = { ...node.props, label: 'Solicitar contacto', action: 'intake_form_anchor', target: 'form_contact', open_in_new_tab: false };
    } else if (node.type === 'button' && node.props.action === 'intake_form_anchor' && !contextual.has(node.id)) {
      node.props.label = pageCta;
      if (headerIds.has(node.id) && node.responsive?.desktop?.visible === false) {
        node.props.label = plan.clinic_id === 66 ? 'Solicitar diagnóstico' : key === 'c10-nut' ? 'Solicitar cita' : key === 'c10-med' ? 'Solicitar consulta' : 'Solicitar información';
      }
    }
    if (headerIds.has(node.id) && node.type === 'image') {
      const logo = assets[plan.clinic_id === 66 ? 'LOGO-CAPILAR' : 'LOGO-MEDICAL'];
      assert(logo?.id, 'Official header logo required');
      node.props = { ...node.props, asset_id: logo.id, fit: 'contain', height_mode: 'auto', aspect_ratio: 'custom', frame_width: logo.width, frame_height: logo.height, alt: plan.brand };
    }
    if (headerIds.has(node.id) && ['heading', 'text'].includes(node.type)) node.props.tone = 'default';
    if (footerIds.has(node.id) && node.type === 'heading' && /Solicitar|informaci[oó]n/i.test(node.props.text)) node.props.text = pageCta;
    if (footerIds.has(node.id) && node.type === 'text' && /DESCARGA TU DESCUENTO/i.test(node.props.text)) node.props.text = plan.contact_eyebrow || 'SOLICITA INFORMACIÓN';
  }
  form.props.submit_label = pageCta;
  form.props.title = pageCta;

  document.pages[0].title = plan.title.slice(0, 120);
  document.pages[0].seo.title = `${plan.title} · ${plan.brand}`.slice(0, 70);
  document.pages[0].seo.description = document.pages[0].seo.description.replace(/(?:Programa )?\bBS 28\b/g, 'Programa BS 28');
  // Remove only nodes made unreachable by replacing the requested subtrees.
  const reachable = new Set();
  const mark = nodeId => { if (reachable.has(nodeId)) return; reachable.add(nodeId); nodes[nodeId].children.forEach(mark); };
  document.pages.forEach(page => page.root_node_ids.forEach(mark));
  Object.values(document.globals).filter(Boolean).forEach(mark);
  for (const nodeId of Object.keys(nodes)) if (!reachable.has(nodeId)) delete nodes[nodeId];
  assert.deepEqual(document.integrations, original.integrations);
  assert.deepEqual(document.consent, original.consent);
  assert.deepEqual(document.bindings, original.bindings);
  assertValidWebDocument(document);
  return {
    document, contact_context: contexts,
    review: { revision: specification.revision, allowed_for_publication: false, patient_cases_enabled: false, patient_testimonials_enabled: false, capilar_hold: !!plan.capilar_hold, bf_not_ready: !!plan.bf_not_ready },
  };
}

module.exports = { reviewBsLandingDocument, specification };
