'use strict';

const assert = require('node:assert/strict');
const {
  WEB_DOCUMENT_LIMITS,
  WebDocumentValidationError,
  assertValidWebDocument,
  canonicalSerialize,
  hashWebDocument,
  validateWebDocument,
} = require('../../lib/webDocument');
const { buildValidWebDocument } = require('./fixtures/webDocumentV1.fixture');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function addGlobalForm(document) {
  const section = clone(document.nodes.section_hero);
  section.id = 'section_global_header';
  section.props.semantic_tag = 'header';
  section.children = ['form_global'];
  const form = clone(document.nodes.form_lead);
  form.id = 'form_global';
  form.props.form_key = 'global_contact';
  form.props.fields = form.props.fields.map((field) => ({ ...field, id: `global_${field.id}` }));
  document.nodes.section_global_header = section;
  document.nodes.form_global = form;
  document.globals.header_node_id = section.id;
}

function addSecondPageForm(document) {
  const section = clone(document.nodes.section_hero);
  section.id = 'section_other_page';
  section.children = ['form_other_page'];
  const form = clone(document.nodes.form_lead);
  form.id = 'form_other_page';
  form.props.form_key = 'other_page_contact';
  form.props.fields = form.props.fields.map((field) => ({ ...field, id: `other_${field.id}` }));
  document.nodes.section_other_page = section;
  document.nodes.form_other_page = form;
  document.pages.push({
    ...clone(document.pages[0]),
    id: 'page_other',
    title: 'Otra página',
    slug: 'otra-pagina',
    root_node_ids: [section.id],
    seo: { ...clone(document.pages[0].seo), canonical_url: null },
  });
}

function assertInvalid(document, keyword) {
  const result = validateWebDocument(document);
  assert.equal(result.valid, false, `se esperaba documento inválido para ${keyword}`);
  assert.ok(
    result.errors.some((error) => error.keyword === keyword),
    `falta error ${keyword}: ${JSON.stringify(result.errors)}`
  );
  assert.throws(
    () => assertValidWebDocument(document),
    (error) => error instanceof WebDocumentValidationError && error.code === 'WEB_DOCUMENT_INVALID'
  );
}

function testValidContractCoversInitialBlocks() {
  const document = buildValidWebDocument();
  const result = assertValidWebDocument(document);
  assert.equal(result.valid, true);
  assert.equal(result.stats.nodeCount, 6);
  assert.deepEqual(new Set(Object.values(document.nodes).map((node) => node.type)), new Set([
    'section',
    'heading',
    'text',
    'image',
    'button',
    'intake_form',
  ]));
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.equal(result.hash, 'c370fa2dad56edad3e21d1147d0fa1210122d8e950ee0a98c3531a190598b6e1');
}

function testNoArbitraryCodeMarkupStylesOrClasses() {
  const html = buildValidWebDocument();
  html.nodes.text_intro.props.text = '<strong>No permitido</strong>';
  assertInvalid(html, 'pattern');

  const css = buildValidWebDocument();
  css.nodes.section_hero.props.css = 'display:none';
  assertInvalid(css, 'forbiddenProperty');

  const className = buildValidWebDocument();
  className.nodes.section_hero.className = 'fixed inset-0';
  assertInvalid(className, 'forbiddenProperty');

  const handler = buildValidWebDocument();
  handler.nodes.button_primary.onclick = 'alert(1)';
  assertInvalid(handler, 'forbiddenProperty');

  const javascriptUrl = buildValidWebDocument();
  javascriptUrl.nodes.button_primary.props.action = 'external_url';
  javascriptUrl.nodes.button_primary.props.target = 'javascript:alert(1)';
  assertInvalid(javascriptUrl, 'forbiddenContent');
}

function testGraphReferencesCyclesDepthAndOrphans() {
  const missing = buildValidWebDocument();
  missing.nodes.section_hero.children.push('node_missing');
  assertInvalid(missing, 'nodeReference');

  const cycle = buildValidWebDocument();
  cycle.nodes.section_hero.children.push('section_hero');
  assertInvalid(cycle, 'nodeCycle');

  const orphan = buildValidWebDocument();
  orphan.nodes.text_orphan = {
    id: 'text_orphan',
    type: 'text',
    version: 1,
    props: { text: 'No está conectado al árbol' },
    children: [],
  };
  assertInvalid(orphan, 'orphanNode');

  const tooDeep = buildValidWebDocument();
  tooDeep.bindings = {};
  tooDeep.nodes = {};
  tooDeep.pages[0].root_node_ids = ['section_01'];
  for (let index = 1; index <= WEB_DOCUMENT_LIMITS.maxTreeDepth + 1; index += 1) {
    const id = `section_${String(index).padStart(2, '0')}`;
    const nextId = index === WEB_DOCUMENT_LIMITS.maxTreeDepth + 1
      ? 'text_final'
      : `section_${String(index + 1).padStart(2, '0')}`;
    tooDeep.nodes[id] = {
      id,
      type: 'section',
      version: 1,
      props: { layout: 'stack', columns: 1 },
      children: [nextId],
    };
  }
  tooDeep.nodes.text_final = {
    id: 'text_final',
    type: 'text',
    version: 1,
    props: { text: 'Final' },
    children: [],
  };
  assertInvalid(tooDeep, 'maxTreeDepth');
}

function testSemanticImageFormButtonAndBindingRules() {
  const image = buildValidWebDocument();
  image.nodes.image_hero.props.decorative = true;
  assertInvalid(image, 'imageAlt');

  const form = buildValidWebDocument();
  form.nodes.form_lead.props.fields = form.nodes.form_lead.props.fields.filter(
    (field) => field.name !== 'privacy_consent'
  );
  assertInvalid(form, 'privacyConsent');

  const wrongFieldType = buildValidWebDocument();
  wrongFieldType.nodes.form_lead.props.fields[1].type = 'text';
  assertInvalid(wrongFieldType, 'fieldType');

  const missingPage = buildValidWebDocument();
  missingPage.nodes.button_primary.props.action = 'internal_page';
  missingPage.nodes.button_primary.props.target = 'page_missing';
  assertInvalid(missingPage, 'pageReference');

  const binding = buildValidWebDocument();
  binding.bindings.binding_clinic_name.target_prop = 'asset_id';
  assertInvalid(binding, 'bindingTarget');
}

function testIntakeButtonTargetsStayInsideTheirEffectiveScope() {
  const localToGlobal = buildValidWebDocument();
  addGlobalForm(localToGlobal);
  localToGlobal.nodes.button_primary.props.target = 'form_global';
  assert.equal(validateWebDocument(localToGlobal).valid, true);

  const localToOtherPage = buildValidWebDocument();
  addSecondPageForm(localToOtherPage);
  localToOtherPage.nodes.button_primary.props.target = 'form_other_page';
  assertInvalid(localToOtherPage, 'formScopeReference');

  const globalToGlobal = buildValidWebDocument();
  addGlobalForm(globalToGlobal);
  const globalButton = clone(globalToGlobal.nodes.button_primary);
  globalButton.id = 'button_global';
  globalButton.props.target = 'form_global';
  globalToGlobal.nodes.button_global = globalButton;
  globalToGlobal.nodes.section_global_header.children.unshift(globalButton.id);
  assert.equal(validateWebDocument(globalToGlobal).valid, true);

  const globalToLocal = clone(globalToGlobal);
  globalToLocal.nodes.button_global.props.target = 'form_lead';
  assertInvalid(globalToLocal, 'formScopeReference');
}

function testTypedFaqIsPlainTextAndLeafOnly() {
  const valid = buildValidWebDocument();
  valid.nodes.faq_implantes = {
    id: 'faq_implantes',
    type: 'faq',
    version: 1,
    props: {
      question: '¿Cuánto dura una primera visita?',
      answer: 'Depende del caso, pero reservamos tiempo para valorar y resolver dudas.',
    },
    children: [],
    style_tokens: { background: 'surface', radius: 'lg', spacing_top: 'sm', spacing_bottom: 'sm' },
    binding_ids: ['faq_question_binding', 'faq_answer_binding'],
  };
  valid.bindings.faq_question_binding = {
    target_node_id: 'faq_implantes',
    target_prop: 'question',
    source: 'content_entry',
    source_id: 'faq_content_entry',
    field: 'question',
  };
  valid.bindings.faq_answer_binding = {
    target_node_id: 'faq_implantes',
    target_prop: 'answer',
    source: 'content_entry',
    source_id: 'faq_content_entry',
    field: 'answer',
  };
  valid.nodes.section_hero.children.push('faq_implantes');
  const result = assertValidWebDocument(valid);
  assert.equal(result.valid, true);
  assert.equal(result.stats.nodeCount, 7);

  const markup = clone(valid);
  markup.nodes.faq_implantes.props.answer = '<img src=x onerror=alert(1)>Respuesta';
  assertInvalid(markup, 'forbiddenContent');

  const withChild = clone(valid);
  withChild.nodes.faq_implantes.children = ['text_intro'];
  assertInvalid(withChild, 'maxItems');

  const wrongFaqTarget = clone(valid);
  wrongFaqTarget.bindings.faq_question_binding.target_prop = 'text';
  assertInvalid(wrongFaqTarget, 'bindingTarget');
}

function testStructuralAndByteLimits() {
  const tooManyNodes = buildValidWebDocument();
  for (let index = 0; index < WEB_DOCUMENT_LIMITS.maxNodes; index += 1) {
    const id = `extra_${String(index).padStart(4, '0')}`;
    tooManyNodes.nodes[id] = {
      id,
      type: 'text',
      version: 1,
      props: { text: 'Extra' },
      children: [],
    };
  }
  assertInvalid(tooManyNodes, 'maxProperties');

  const tooLarge = buildValidWebDocument();
  tooLarge.bindings = {};
  tooLarge.nodes = {};
  tooLarge.pages[0].root_node_ids = [];
  for (let sectionIndex = 0; sectionIndex < 10; sectionIndex += 1) {
    const sectionId = `section_${String(sectionIndex).padStart(2, '0')}`;
    tooLarge.pages[0].root_node_ids.push(sectionId);
    const children = [];
    tooLarge.nodes[sectionId] = {
      id: sectionId,
      type: 'section',
      version: 1,
      props: { layout: 'stack', columns: 1 },
      children,
    };
    for (let childIndex = 0; childIndex < 49; childIndex += 1) {
      const childId = `text_${String(sectionIndex).padStart(2, '0')}_${String(childIndex).padStart(2, '0')}`;
      children.push(childId);
      tooLarge.nodes[childId] = {
        id: childId,
        type: 'text',
        version: 1,
        props: { text: '😀'.repeat(1200) },
        children: [],
      };
    }
  }
  assertInvalid(tooLarge, 'maxBytes');
}

function testCanonicalSerializationAndHash() {
  const original = buildValidWebDocument();
  const reordered = {
    integrations: original.integrations,
    consent: original.consent,
    seo: original.seo,
    bindings: original.bindings,
    nodes: original.nodes,
    globals: original.globals,
    pages: original.pages,
    design_system: original.design_system,
    schema_version: original.schema_version,
  };
  assert.equal(hashWebDocument(original), hashWebDocument(reordered));
  assert.equal(canonicalSerialize(original), canonicalSerialize(reordered));

  const decomposed = clone(original);
  decomposed.nodes.form_lead.props.description = original.nodes.form_lead.props.description.normalize('NFD');
  assert.equal(hashWebDocument(original), hashWebDocument(decomposed));

  const changedOrder = clone(original);
  changedOrder.nodes.section_hero.children.reverse();
  assert.notEqual(hashWebDocument(original), hashWebDocument(changedOrder));

  const circular = {};
  circular.self = circular;
  assert.throws(
    () => canonicalSerialize(circular),
    (error) => error instanceof WebDocumentValidationError && error.errors[0].keyword === 'circularObject'
  );

  const arrayWithHiddenInput = [];
  arrayWithHiddenInput.className = 'arbitrary-class';
  assert.throws(
    () => canonicalSerialize(arrayWithHiddenInput),
    (error) => error instanceof WebDocumentValidationError && error.errors[0].keyword === 'jsonType'
  );
}

function run() {
  testValidContractCoversInitialBlocks();
  testNoArbitraryCodeMarkupStylesOrClasses();
  testGraphReferencesCyclesDepthAndOrphans();
  testSemanticImageFormButtonAndBindingRules();
  testIntakeButtonTargetsStayInsideTheirEffectiveScope();
  testTypedFaqIsPlainTextAndLeafOnly();
  testStructuralAndByteLimits();
  testCanonicalSerializationAndHash();
  console.log('web_document_contract.test.js: ok');
}

run();
