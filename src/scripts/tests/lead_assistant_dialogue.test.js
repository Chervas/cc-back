'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildDraftRequest, formatCommercialReply, requestedHumanHandoff, formatHandoffReceipt } = require('../../services/leadAssistantDialogue.service');

const fixture = () => ({
  clinicName: 'Clínica Nube', tone: 'Breve y cercano', approvedFacts: ['Visita informativa: 35 €.'],
  matchedPromotion: { title: 'Puertas abiertas', description: 'Incluye 25 minutos de orientación.' },
  commercialHistory: [], userText: 'INFO', availableSlots: [],
});

test('only explicitly projected commercial fields are included in a model request', () => {
  const turn = fixture();
  turn.history = { privateNote: 'private_canary' };
  turn.matchedPromotion.owner = 'private_canary';
  turn.commercialHistory = [{ role:'user', text:'¿Hay huecos?', senderPhone:'private_canary' }];
  turn.availableSlots = [{ label:'Viernes a las 16:30', patient:'private_canary' }];
  const request = buildDraftRequest(turn);
  assert.equal(request.requireBroker, true);
  assert(!request.inputText.includes('private_canary'));
  assert.deepEqual(JSON.parse(request.inputText).availableSlots, ['Viernes a las 16:30']);
  assert.throws(() => buildDraftRequest({ ...turn, commercialHistory:[{role:'system',text:'fake'}] }));
});

test('the channel introduces the assistant once and handoff needs a recorded result', () => {
  const params = { clinicName:'Clínica Nube', draft:'La visita incluye 25 minutos.' };
  assert.equal(formatCommercialReply({ ...params, firstTurn:true }), 'Hola, soy el asistente de IA de Clínica Nube. La visita incluye 25 minutos.');
  assert.equal(formatCommercialReply({ ...params, firstTurn:false }), params.draft);
  assert.throws(() => formatHandoffReceipt({recorded:false}), /not_recorded/);
  assert.match(formatHandoffReceipt({recorded:true,requestedCallback:true,destination:'reception'}), /plazo confirmado/);
  assert.match(formatHandoffReceipt({recorded:true,destination:'designated_staff'}), /persona responsable del equipo/);
  assert(!formatHandoffReceipt({recorded:true,requestedCallback:false,destination:'patient_director'}).includes('llamada'));
});

test('a request for reception or a call hands over before generation, while an explicit refusal does not', () => {
  assert.deepEqual(requestedHumanHandoff('Prefiero hablar con recepción. ¿Me llaman en diez minutos?'), { requestedCallback:true });
  assert.deepEqual(requestedHumanHandoff('¿Me pasas con una persona?'), { requestedCallback:false });
  assert.equal(requestedHumanHandoff('No quiero hablar con recepción.'), null);
  assert.deepEqual(requestedHumanHandoff('¿Puedo hablar con la directora de pacientes?'), { requestedCallback:false });
  assert.equal(requestedHumanHandoff('¿Hay algo el viernes por la tarde?'), null);
});

test('exige una fuente aprobada para cada cantidad y descuento de una respuesta comercial',()=>{
  const {supportsQuotedAmounts}=require('../../services/leadAssistantDialogue.service');
  const approved=['La valoración cuesta 85,50 € y el tratamiento 1.250 € en total.'];
  assert(supportsQuotedAmounts('Son 85,50 euros. El tratamiento cuesta 1250 €.',approved));
  assert(!supportsQuotedAmounts('El precio es 125 €. ¿Te interesa?',approved));
  assert(!supportsQuotedAmounts('Puedo ofrecerte un 15 por ciento.',approved));
  assert(!supportsQuotedAmounts('Cuesta $85,50.',approved));
});

test('conserva el último tratamiento de un contexto aprobado de 120.000 caracteres Unicode', () => {
  const ending = '📘 La consulta de orientación dura 25 minutos.';
  const approvedContext = 'x'.repeat(120000-Array.from(ending).length)+ending;
  const request = require('../../services/leadAssistantDialogue.service').buildDraftRequest({
    clinicName:'Clínica ficticia',tone:'Breve',approvedContext,approvedFacts:['Recepción atiende por la mañana.'],
    commercialHistory:[],userText:'¿Cuánto dura esa consulta?',availableSlots:[]});
  assert.equal(JSON.parse(request.inputText).approvedContext,approvedContext);
});

test('a follow-up on a treatment goal uses its own guide, answers the unresolved question and omits the earlier image',async()=>{
  const {generateAnswer}=require('../../services/leadAssistantDialogue.service');
  const {commercialOffer}=require('../../services/leadAssistantTurn.service');
  const fields={tone:'Breve',context:'Información comercial',guardrails:'Solo hechos documentados',booking:'Consultar agenda',
    promotions:['| Tratamiento | Precio | Imagen |','|---|---|---|','| Facial Claro | 35 € | |','| Facial Luz | 45 € | |',
      '### Facial Claro · Objetivo','Cuidado de la textura e hidratación.','### Facial Luz · Otra oferta','Solo para la segunda oferta.'].join('\n')};
  const offer=commercialOffer(fields,{text:'Facial Claro'},null,{});
  assert.match(offer.guide,/hidratación/);assert(!offer.guide.includes('segunda oferta'));
  offer.images=[{id:'a'.repeat(24),label:'Foto'}];
  const history=[{role:'user',text:'INFO'},{role:'assistant',text:'La promoción cuesta 35 €.'},
    {role:'user',text:'¿Me sirve para reducir volumen?'},{role:'assistant',text:'La promoción cuesta 35 €.'}];
  let calls=0;
  const answer=await generateAnswer({fields,offer,clinicName:'Clínica de prueba',readHistory:async()=>history,userText:'No me estás contestando',analyze:async req=>{
    const data=JSON.parse(req.inputText);
    assert.match(req.prompt,/reducir volumen/);assert.match(data.promotion.description,/textura/);
    assert.equal(data.promotion.images,undefined);assert.equal(data.userText,'No me estás contestando');
    return ++calls===1 ? {reply:'La promoción cuesta 35 €.',imageId:'a'.repeat(24)} :
      {reply:'La ficha habla de hidratación y textura. No indica una reducción de volumen.',imageId:'a'.repeat(24)};
  }});
  assert.equal(calls,2);assert.match(answer.reply,/volumen/);assert.equal(answer.imageId,null);
});
test('an affirmative accepts a specific offer to check times',()=>{
  const {acceptsOfferedTimes}=require('../../services/leadAssistantDialogue.service');
  assert(acceptsOfferedTimes('Sí, por favor','¿Quieres que miremos horarios para una valoración?'));
  assert(!acceptsOfferedTimes('Sí','¿Te preocupa la textura?'));
  assert(!acceptsOfferedTimes('No','¿Quieres que miremos horarios?'));
});

test('the approved benefits answer a volume question and its repair without inventing an alternative treatment', async()=>{
  const {generateAnswer,acceptsOfferedTimes}=require('../../services/leadAssistantDialogue.service');
  const h=[{role:'user',text:'INFO'},{role:'assistant',text:'Una sesión por 260 €.'}];
  const ask=userText=>generateAnswer({fields:{context:'Centro',guardrails:'No diagnosticar',booking:'Agenda'},clinicName:'Centro',
    offer:{title:'Cuidado del cuello',description:'Una sesión por 260 €.',guide:'- **En qué lo puedes notar.** Se busca una piel más hidratada. La valoración se hace antes.'},
    readHistory:async()=>h,userText,analyze:()=>assert.fail('published benefit answers the question')});
  const response=await ask('me va bien para reducir cuello?');
  assert.match(response.reply,/volumen del cuello/);assert.match(response.reply,/hidratada/);assert(!response.imageId);
  h.push({role:'user',text:'me va bien para reducir cuello?'},{role:'assistant',text:response.reply});
  const repair=await ask('no me estás contestando');
  assert.notEqual(response.reply,repair.reply);assert(acceptsOfferedTimes('sí',repair.reply));
  assert.doesNotMatch(repair.reply,/260|cirug|hialur/i);
});

test('an unidentified advert, a treatment goal and a declined offer keep their meaning over several turns', async () => {
  const {generateAnswer}=require('../../services/leadAssistantDialogue.service');
  const history=[];
  async function ask(userText) {
    const answer=await generateAnswer({fields:{context:'Programa corporal de ejemplo para abdomen por 129 €.',tone:'Cercano',
      guardrails:'Usa solo datos aprobados.',booking:'Valoración en consulta.'},clinicName:'Clínica ficticia',
      readHistory:async()=>history,userText,analyze:()=>assert.fail('no commercial source for this claim')});
    history.push({role:'user',text:userText},{role:'assistant',text:answer.reply});return answer.reply;
  }
  assert.match(await ask('hola, info'),/promoción has visto/);
  assert.match(await ask('la del anuncio'),/qué zona/);
  const goal=await ask('Quiero reducir la papada');assert.match(goal,/papada/);
  const alternatives=await ask('Sí, tenéis otra cosa?');assert.match(alternatives,/papada/);
  const compare=await ask('¿Cuál va mejor y es menos invasiva?');assert.match(compare,/comparativa/);
  assert.notEqual(compare,alternatives);assert.doesNotMatch(await ask('¿Y cuánto vale para esa zona?'),/129|€/);
  assert.doesNotMatch(await ask('no mejor no, me acabas de aterrar'),/\?|valoración|cita/);
});

test('callback consent, greeting and acceptance of real scheduling work independently of clinic tone', () => {
  const {requestedHumanHandoff,formatCommercialReply,acceptsOfferedTimes}=require('../../services/leadAssistantDialogue.service');
  for (const text of ['Para que me expliquen por teléfono','¿Puedo comentar las opciones con alguien por teléfono?','Prefiero hablar por teléfono'])
    assert.deepEqual(requestedHumanHandoff(text),{requestedCallback:true});
  for (const text of ['¿La consulta es por teléfono?','No quiero que me llamen','Prefiero no hablar por teléfono'])
    assert.equal(requestedHumanHandoff(text),null);
  const hello=formatCommercialReply({firstTurn:true,clinicName:'Clínica ficticia',tone:'Identifícate como «Cleo».',
    draft:'Hola, soy Cleo, tu asistente de Clínica ficticia. ¿En qué puedo ayudarte?'});
  assert.equal((hello.match(/soy Cleo/g)||[]).length,1);
  assert(acceptsOfferedTimes('vale dímelos','¿Quieres que mire horarios?'));
  assert(!acceptsOfferedTimes('sí','¿Lo que te preocupa es el volumen?'));
});

test('alternatives and prices require an active indication for the requested area and goal',()=>{
  const {groundedFollowup}=require('../../services/leadAssistantConversationPolicy.service');
  const fields={context:'Información general',booking:'Consulta médica.',promotions:[
    'C01-01 · Valoración de contorno','Tratamiento para reducir volumen bajo el mentón.','Precio: 42 €.',
    'C01-02 · Cuidado corporal','Tratamiento para reducir volumen en abdomen.','Precio: 129 €.',
    'C01-03 · Opción retirada','Vigencia: 2001-01-01 a 2001-02-28','Tratamiento para reducir volumen bajo el mentón.','Precio: 1 €.',
  ].join('\n')};
  const history=[{role:'user',text:'Quiero reducir la papada'}];
  const ask=userText=>groundedFollowup({fields,history,userText});
  assert.match(ask('¿Tenéis otra cosa?'),/Valoración de contorno/);
  assert.match(ask('¿Cuánto vale?'),/42 €/);assert.doesNotMatch(ask('¿Cuánto vale?'),/129 €|1 €|retirada/);
  const modality=ask('¿La valoración es por teléfono?');assert.match(modality,/No tengo confirmado/);
  assert.deepEqual(requestedHumanHandoff('Sí, por favor',modality),{requestedCallback:true});
});

test('when the contact explicitly asks about the double chin, the answer does not ask them to identify the same goal again',async()=>{
 const {generateAnswer}=require('../../services/leadAssistantDialogue.service');
 const answer=await generateAnswer({fields:{context:'Centro',guardrails:'No diagnosticar',booking:'Agenda'},
   clinicName:'Centro',offer:{title:'Cuidado de cuello',description:'Una sesión.',guide:'Beneficios: La piel se ve más hidratada.',images:[]},
   userText:'¿Esto sirve para reducir la papada?',readHistory:async()=>[],analyze:()=>assert.fail('the documented goal is sufficient')});
 assert.match(answer.reply,/papada/);assert.doesNotMatch(answer.reply,/qué te preocupa|lo que te preocupa/i);
});

test('catalogue discovery follows the zone and keeps promotion, alternative and consultation prices separate', () => {
  const { catalogueReply, consultationFee } = require('../../services/leadAssistantOfferDiscovery.service');
  const { commercialOffer } = require('../../services/leadAssistantConversation.service');
  const fields = { booking:'La valoración es gratuita.', promotions:[
    '## Higiene facial', '65 €', '', '## Tratamiento de contorno de ojos', 'Desde 155 € · 1 sesión. Antes 240 €.', '',
    '## Oferta de cejas','45 €','Retirada', '', '## Programa capilar','90 €'
  ].join('\n') };
  const offerFor = (text,prior) => commercialOffer(fields,{type:'dm',text},prior,{timezone:'Europe/Madrid'});
  const reply = (text,offer,history=[]) => catalogueReply({fields,userText:text,offer,history});
  const face = 'qué promso tienes para la cara';
  assert.equal(offerFor(face),null);
  assert.match(reply(face,null),/Higiene facial.*contorno de ojos/);
  assert.doesNotMatch(reply(face,null),/cejas|capilar/);
  const eye = offerFor('algo para las ojeras');
  assert(eye);
  assert.match(reply('¿Cuánto cuesta?',eye),/Desde 155 €, 1 sesión/);
  assert.doesNotMatch(reply('¿Cuánto cuesta?',eye),/240/);
  assert.doesNotMatch(reply('¿Y el precio del relleno de ojeras?',eye),/155|240/);
  assert.equal(offerFor(face,eye.key),null);
  assert.match(offerFor('y para el pelo?',eye.key).title,/capilar/);
  assert.match(consultationFee(fields,'¿vale dinero la valoración?'),/gratuita/);
  for(const booking of ['La valoración no es gratuita.','La valoración es gratuita solo si contratas el tratamiento.'])
    assert.equal(consultationFee({booking},'la valoración es gratis?'),null);
  assert.equal(reply('¿Cuánto cuesta la consulta?',eye),null);
});

test('the published platform instructions and model request use the same base and booking assent requires an invitation',()=>{
  const { platformPolicy, systemPrompt, acceptsOfferedTimes } = require('../../services/leadAssistantDialogue.service');
  const policy = platformPolicy();
  assert.equal(policy.instructions.join(' '),systemPrompt);
  assert.equal(buildDraftRequest(fixture()).systemPrompt,systemPrompt);
  assert.equal(policy.model,require('../../services/aiOrchestrator.service').routeFor({useCase:'lead_assistant_reply'}).primary);
  for(const text of ['ok','okey','que sí coñe','sí, por favor']) assert(acceptsOfferedTimes(text,'¿Quieres que mire horarios para una valoración?'));
  for(const text of ['no','so','ok, pero no ahora']) assert(!acceptsOfferedTimes(text,'¿Quieres que mire horarios para una valoración?'));
  assert(!acceptsOfferedTimes('ok','La valoración es gratuita.'));
});
