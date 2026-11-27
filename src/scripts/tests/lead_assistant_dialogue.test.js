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
