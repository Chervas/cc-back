'use strict';
const C = require('./clinical-episode-contract');
const TYPES = ['text','textarea','yesno','select','multiselect','date','number','readonly'];
const CONTEXT_KEYS = ['patient.full_name','patient.document','patient.code','patient.history_number','patient.birth_date','patient.sex','patient.age','patient.phone','patient.email','patient.profession','patient.how_known','professional.name','episode.date'];
const REFERENCE_FIELDS = ['alergias','medicacion','antecedentes','notas_medicas'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(message = 'Revisa los campos del formulario.', details) { return C.error(400,'clinical_form_invalid',message,details); }
function identity(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value) || ['__proto__','constructor','prototype'].includes(value)) throw invalid();
  return value;
}
function label(value,max=240) { const out=C.text(value,'form_label',max); if(!out)throw invalid();return out; }
function schema(value) {
  if(value == null)return null;
  if(!object(value)||value.version!==1||!['initial','standard'].includes(value.kind||'standard')||!Array.isArray(value.sections)||!value.sections.length||value.sections.length>30)throw invalid();
  const keys=new Set(),sectionKeys=new Set();let count=0;
  const sections=value.sections.map(section=>{
    if(!object(section)||!Array.isArray(section.fields)||section.fields.length>100)throw invalid();
    const id=identity(section.id);if(sectionKeys.has(id))throw invalid();sectionKeys.add(id);
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
      if(field.type==='readonly'){if(!CONTEXT_KEYS.includes(field.context_key))throw invalid();out.context_key=field.context_key;out.required=false;}
      else if(field.context_key!==undefined)throw invalid();
      if(field.reference_target!==undefined){if(!REFERENCE_FIELDS.includes(field.reference_target)||field.type==='readonly')throw invalid();out.reference_target=field.reference_target;}
      return out;
    });
    return{id,title:label(section.title),...(section.description?{description:label(section.description,2000)}:{}),fields};
  });
  const out={version:1,key:identity(value.key),title:label(value.title),kind:value.kind||'standard',sections};
  if(Buffer.byteLength(JSON.stringify(out))>256000)throw invalid('El formulario es demasiado extenso.');return out;
}
function answers(definition,input,{final=false}={}){
  if(!object(input))throw invalid('Revisa las respuestas del formulario.');
  const fields=definition.sections.flatMap(section=>section.fields),byId=new Map(fields.map(field=>[field.id,field]));
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
function hasContent(data){return !!data?.instances?.some(instance=>Object.values(instance.answers||{}).some(value=>value!==null&&value!==''&&(!Array.isArray(value)||value.length)));}
module.exports={TYPES,CONTEXT_KEYS,REFERENCE_FIELDS,identity,schema,answers,hasContent,invalid,object};
