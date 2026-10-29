'use strict';
const C = require('./clinical-episode-contract');
const { sectionIcon } = require('./clinical-section-icons');
const TYPES = ['text','textarea','yesno','select','multiselect','date','number','readonly'];
const CONTEXT_KEYS = ['patient.full_name','patient.document','patient.code','patient.history_number','patient.birth_date','patient.sex','patient.age','patient.phone','patient.email','patient.profession','patient.how_known','professional.name','episode.date'];
const REFERENCE_FIELDS = ['alergias','medicacion','antecedentes','notas_medicas'];
const CHOICE_CATALOGS = Object.freeze({
  hamilton_norwood: ['I','II','III','III_vertex','IV','V','VI','VII'].map(value => ({value,label:value==='III_vertex'?'III (vértex)':value})),
  ludwig: ['I','II','III'].map(value => ({value,label:value})),
});
const MAX_REPETITIONS=100, MAX_REPEATED_ANSWERS=5000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(message = 'Revisa los campos del formulario.', details) { return C.error(400,'clinical_form_invalid',message,details); }
function identity(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value) || ['__proto__','constructor','prototype'].includes(value)) throw invalid();
  return value;
}
function label(value,max=240) { const out=C.text(value,'form_label',max); if(!out)throw invalid();return out; }
function schema(value) {
  if(value == null)return null;
  if(!object(value)||![1,2].includes(value.version)||!['initial','standard'].includes(value.kind||'standard')||!Array.isArray(value.sections)||!value.sections.length||value.sections.length>30)throw invalid();
  const keys=new Set(),sectionKeys=new Set();let count=0;
  const sections=value.sections.map(section=>{
    if(!object(section)||!Array.isArray(section.fields)||section.fields.length>100)throw invalid();
    const id=identity(section.id);if(sectionKeys.has(id))throw invalid();sectionKeys.add(id);
    const icon=sectionIcon(section.icon,()=>invalid('Elige un icono disponible para la sección.'));
    let repeatable;
    if(section.repeatable!==undefined){
      if(value.version!==2||!object(section.repeatable)||Object.keys(section.repeatable).some(key=>!['item_label','add_label'].includes(key))||!section.fields.length)throw invalid('Revisa el grupo repetible.');
      repeatable={item_label:label(section.repeatable.item_label,120),add_label:label(section.repeatable.add_label,160)};
    }
    const fields=section.fields.map(field=>{
      if(!object(field)||!TYPES.includes(field.type)||++count>250)throw invalid();
      const id=identity(field.id);if(keys.has(id))throw invalid('Hay claves de campo repetidas.');keys.add(id);
      if(field.required!==undefined&&typeof field.required!=='boolean')throw invalid();
      const out={id,label:label(field.label),type:field.type,required:field.required===true};
      for(const [key,max]of [['help',1500],['unit',40]])if(field[key]!=null)out[key]=label(field[key],max);
      if(field.max_length!==undefined){if(!['text','textarea'].includes(field.type)||!Number.isInteger(field.max_length)||field.max_length<1||field.max_length>20000)throw invalid();out.max_length=field.max_length;}
      for(const key of ['min','max'])if(field[key]!==undefined){if(field.type!=='number'||typeof field[key]!=='number'||!Number.isFinite(field[key]))throw invalid();out[key]=field[key];}
      if(out.min!==undefined&&out.max!==undefined&&out.min>out.max)throw invalid();
      if(['select','multiselect'].includes(field.type)){
        if(!Array.isArray(field.options)||!field.options.length||field.options.length>100)throw invalid();const optionKeys=new Set();
        out.options=field.options.map(option=>{if(!object(option))throw invalid();const value=identity(option.value);if(optionKeys.has(value))throw invalid();optionKeys.add(value);if(option.exclusive!==undefined&&typeof option.exclusive!=='boolean')throw invalid();return{value,label:label(option.label),...(option.exclusive===true?{exclusive:true}:{})};});
      }else if(field.options!==undefined)throw invalid();
      if(field.choice_catalog!==undefined){
        const canonical=typeof field.choice_catalog==='string'&&Object.hasOwn(CHOICE_CATALOGS,field.choice_catalog)?CHOICE_CATALOGS[field.choice_catalog]:null;
        if(field.type!=='select'||!canonical||out.options.length!==canonical.length||out.options.some((option,index)=>option.value!==canonical[index].value||option.label!==canonical[index].label||option.exclusive))throw invalid('La escala visual debe conservar sus opciones originales.');
        out.choice_catalog=field.choice_catalog;
      }
      if(field.type==='readonly'){if(!CONTEXT_KEYS.includes(field.context_key))throw invalid();out.context_key=field.context_key;out.required=false;}
      else if(field.context_key!==undefined)throw invalid();
      if(field.reference_target!==undefined){if(!REFERENCE_FIELDS.includes(field.reference_target)||field.type==='readonly')throw invalid();out.reference_target=field.reference_target;}
      return out;
    });
    return{id,title:label(section.title),...(icon?{icon}:{}),...(section.description?{description:label(section.description,2000)}:{}),...(repeatable?{repeatable}:{}),fields};
  });
  const out={version:value.version,key:identity(value.key),title:label(value.title),kind:value.kind||'standard',sections};
  if(Buffer.byteLength(JSON.stringify(out))>256000)throw invalid('El formulario es demasiado extenso.');return out;
}
function answers(definition,input,{final=false}={}){
  if(!object(input))throw invalid('Revisa las respuestas del formulario.');
  const fields=definition.sections.filter(section=>!section.repeatable).flatMap(section=>section.fields),byId=new Map(fields.map(field=>[field.id,field]));
  if(Object.keys(input).some(key=>!byId.has(key)||byId.get(key).type==='readonly'))throw invalid('Hay una respuesta no permitida.');
  const output={};
  for(const field of fields){
    if(field.type==='readonly')continue;
    let value=Object.hasOwn(input,field.id)?input[field.id]:null;
    if(value===''||Array.isArray(value)&&!value.length)value=null;
    if(value!==null){
      if(['text','textarea'].includes(field.type)){if(typeof value!=='string')throw invalid();value=C.text(value,field.id,field.max_length||20000);}
      else if(field.type==='yesno'){if(!['yes','no','unknown','not_applicable'].includes(value))throw invalid();}
      else if(field.type==='number'){if(typeof value!=='number'||!Number.isFinite(value)||field.min!==undefined&&value<field.min||field.max!==undefined&&value>field.max)throw invalid();}
      else if(field.type==='date'){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value)||Number(value.slice(0,4))<1||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw invalid();}
      else if(field.type==='select'){if(typeof value!=='string'||!field.options.some(option=>option.value===value))throw invalid();}
      else if(field.type==='multiselect'){
        if(!Array.isArray(value)||value.length>field.options.length||new Set(value).size!==value.length||value.some(item=>typeof item!=='string'||!field.options.some(option=>option.value===item)))throw invalid();
        if(value.length>1&&field.options.some(option=>option.exclusive&&value.includes(option.value)))throw invalid('La opción «Ninguna» no se puede combinar con otras.');
        value=field.options.filter(option=>value.includes(option.value)).map(option=>option.value);
      }
    }
    if(final&&field.required&&value===null)throw C.error(400,'clinical_form_required','Completa los campos obligatorios antes de cerrar.',{form_key:definition.key,field:field.id});
    output[field.id]=value;
  }
  return output;
}
function repeatedAnswers(definition,input,{final=false}={}){
  if(definition.version!==2){if(input!==undefined)throw invalid('Este formulario no contiene grupos repetibles.');return undefined;}
  if(!object(input))throw C.error(428,'clinical_form_repetitions_required','Vuelve a abrir el episodio para conservar sus grupos de respuestas.');
  const sections=definition.sections.filter(section=>section.repeatable),byId=new Map(sections.map(section=>[section.id,section]));
  if(Object.keys(input).some(key=>!byId.has(key)))throw invalid('Hay un grupo de respuestas no permitido.');
  const output={},ids=new Set();let count=0;
  for(const section of sections){
    const items=Object.hasOwn(input,section.id)?input[section.id]:undefined;
    if(!Array.isArray(items)||items.length<1||items.length>MAX_REPETITIONS)throw invalid('Cada grupo necesita al menos un registro y admite hasta 100.');
    output[section.id]=items.map(item=>{
      if(!object(item)||Object.keys(item).some(key=>!['id','answers'].includes(key))||typeof item.id!=='string'||!UUID.test(item.id)||ids.has(item.id))throw invalid('Los registros repetidos necesitan identificadores únicos.');
      ids.add(item.id);count+=section.fields.length;if(count>MAX_REPEATED_ANSWERS)throw invalid('Hay demasiadas respuestas repetidas en este formulario.');
      try{return{id:item.id,answers:answers({...definition,sections:[{...section,repeatable:undefined}]},item.answers,{final})};}
      catch(error){if(error.code==='clinical_form_required')error.details={...error.details,section:section.id,repetition_id:item.id};throw error;}
    });
  }
  return output;
}
function initialRepetitions(definition){
  if(definition.version!==2)return undefined;
  return Object.fromEntries(definition.sections.filter(section=>section.repeatable).map(section=>[section.id,[{id:require('node:crypto').randomUUID(),answers:{}}]]));
}
const hasAnswer=value=>value!=null&&(typeof value==='string'?!!value.trim():Array.isArray(value)?value.length>0:typeof value==='number'&&Number.isFinite(value));
function answeredFields(instance){
  return(instance.definition_snapshot?.sections||[]).flatMap(section=>{
    const entries=section.repeatable?(instance.repetitions?.[section.id]||[]):[{answers:instance.answers||{}}];
    return entries.flatMap(item=>section.fields.filter(field=>field.type!=='readonly'&&hasAnswer(item.answers[field.id])).map(field=>({field,value:item.answers[field.id],section_id:section.id,...(item.id?{repetition_id:item.id}:{})})));
  });
}
function hasContent(data){return !!data?.instances?.some(instance=>Object.values(instance.answers||{}).some(hasAnswer)||Object.values(instance.repetitions||{}).some(items=>items.some(item=>Object.values(item.answers||{}).some(hasAnswer))));}
module.exports={TYPES,CONTEXT_KEYS,REFERENCE_FIELDS,CHOICE_CATALOGS,MAX_REPETITIONS,MAX_REPEATED_ANSWERS,identity,schema,answers,repeatedAnswers,initialRepetitions,answeredFields,hasContent,invalid,object};
