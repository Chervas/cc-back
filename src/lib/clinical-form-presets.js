'use strict';
// Manual professional forms transcribed from the four supplied BS Medical Word
// documents. Source screening wording is informational, never an execution gate.
const FORM_PRESET_KEYS=['initial-general','facial','corporal','hair'];
const f=(id,label,type='textarea',extra={})=>({id,label,type,...extra});
const yes=(id,label,help)=>f(id,label,'yesno',help?{help}:{});
const options=labels=>labels.map((label,index)=>typeof label==='object'?label:{value:'option_'+(index+1),label});
const choice=(id,label,labels,extra={})=>f(id,label,'select',{options:options(labels),...extra});
const multi=(id,label,labels,extra={})=>f(id,label,'multiselect',{options:options(labels),...extra});
const none={value:'none',label:'Ninguna',exclusive:true};
const section=(id,title,fields,description)=>({id,title,fields,...(description?{description}:{})});
const identity=()=>section('identity','Quién viene y quién le atiende',[
 f('patient_name','Nombre y apellidos','readonly',{context_key:'patient.full_name'}),
 f('birth_date','Fecha de nacimiento','readonly',{context_key:'patient.birth_date'}),
 f('age','Edad','readonly',{context_key:'patient.age'}),f('sex','Sexo registrado','readonly',{context_key:'patient.sex'}),
 f('phone','Teléfono','readonly',{context_key:'patient.phone'}),f('email','Correo electrónico','readonly',{context_key:'patient.email'}),
 f('consultation_date','Fecha de la consulta','readonly',{context_key:'episode.date'}),
 f('professional','Profesional responsable del episodio','readonly',{context_key:'professional.name'}),
 f('professional_specialty','Especialidad','text'),f('professional_registration','Número de colegiado','text'),
]);
const screening=(fields)=>section('screening','Cribado clínico',fields,'Revisa el cribado antes de proponer tratamiento.');
const commonScreening={
 pregnancy:yes('pregnancy','¿Está embarazada, podría estarlo o da lactancia?'),
 implanted:yes('implanted_device','¿Lleva marcapasos, desfibrilador, bomba de insulina o neuroestimulador?'),
 metal:yes('metal_implant','¿Tiene implante metálico, prótesis o material de osteosíntesis en la zona a tratar?'),
 cancer:yes('cancer','¿Cáncer activo o tratamiento oncológico en curso o reciente?'),
 coagulation:yes('coagulation','¿Trastorno de la coagulación, o toma anticoagulantes o antiagregantes?'),
 infection:yes('infection','¿Tiene hoy infección, herida o herpes activo en la zona?'),
 isotretinoin:yes('isotretinoin','¿Toma o ha tomado isotretinoína oral en los últimos 6 meses?'),
 epilepsy:yes('epilepsy','¿Epilepsia, o alteración de la sensibilidad al calor en la zona?'),
 thrombosis:yes('thrombosis','¿Trombosis, tromboflebitis o varices con complicación?'),
};
const health=(extras=[])=>section('health','Medicación, alergias y antecedentes',[
 f('medication','Medicación actual o reciente','textarea',{reference_target:'medicacion'}),
 f('allergies','Alergias','textarea',{reference_target:'alergias'}),...extras,
]);
const phototype=()=>choice('phototype','Fototipo',['I','II','III','IV','V','VI']);
const measures=()=>[f('weight','Peso actual','number',{unit:'kg',min:0}),f('height','Talla','number',{unit:'cm',min:0}),f('bmi','IMC registrado','number',{unit:'kg/m²',min:0})];
const assessment=(extra=[])=>section('assessment','Valoración médica',[
 f('assessment','Diagnóstico u orientación','textarea',{required:true}),f('proposal','Propuesta de tratamiento, zonas y sesiones'),...extra,
 choice('suitability','Valoración',['Apto','No apto','Derivar'],{required:true}),
 choice('photo_consent_status','Estado del consentimiento fotográfico',['No comprobado','Pendiente','Consta documento firmado'],{help:'Comprueba el documento en Consentimientos.'}),
 f('clinical_notes','Notas médicas relevantes','textarea',{reference_target:'notas_medicas'}),
],'Registra la valoración y las indicaciones de esta consulta.');
function formPreset(key){
 let title,area,kind='standard',sections;
 if(key==='initial-general'){
  title='Anamnesis · primera consulta';area='general';kind='initial';
  const identification=identity();identification.fields.push(f('patient_code','Código de cliente','readonly',{context_key:'patient.code'}),f('profession','Profesión','readonly',{context_key:'patient.profession'}),f('how_known','Cómo nos ha conocido','readonly',{context_key:'patient.how_known'}));
  sections=[identification,
   section('reason','Motivo de la consulta',[f('reason','Motivo, con sus palabras'),f('prior_treatments','Tratamientos previos relacionados'),f('prior_results','Qué tal le fue')]),
   screening(Object.values(commonScreening)),
   section('conditions','Enfermedades actuales',[multi('conditions','Marcar lo que proceda',[none,'Diabetes','Hipertensión arterial','Patología cardiaca','Asma o disnea','Anemia','Patología tiroidea','Enfermedad hepática','Enfermedad renal','Hernia de hiato o reflujo','Varices o edemas en piernas','Enfermedad autoinmune','Colagenopatía','Miopatía','Trastorno psiquiátrico','Herpes de repetición','Hiperpigmentación tras embarazo','Lesión sospechosa en la piel'],{reference_target:'antecedentes'}),f('other_conditions','Otras enfermedades · especificar','textarea',{reference_target:'antecedentes'})]),
   health([f('personal_history','Antecedentes personales','textarea',{reference_target:'antecedentes'}),f('family_history','Antecedentes familiares de interés','textarea',{reference_target:'antecedentes'}),f('surgical_history','Antecedentes quirúrgicos y anestesias previas','textarea',{reference_target:'antecedentes'})]),
   section('habits','Hábitos y datos que orientan',[yes('smoking','¿Fuma?'),f('cigarettes','Cigarrillos al día','number',{min:0}),yes('alcohol','¿Consume alcohol?'),f('alcohol_frequency','Frecuencia de consumo de alcohol','text'),yes('recent_sun','¿Sol o UVA en las dos últimas semanas?'),yes('sunscreen','¿Usa fotoprotector a diario?'),...measures(),phototype(),f('last_hair_removal','Última depilación','date'),f('hair_removal_method','Método de depilación','text')]),assessment()];
 }else if(key==='facial'){
  title='Anamnesis facial';area='estetica';
  sections=[identity(),section('reason','Qué le preocupa',[f('reason','Qué le preocupa, con sus palabras'),f('onset','Desde cuándo','text'),f('prior_treatments','Qué ha probado antes'),f('event','Evento o fecha','text')]),
   screening([commonScreening.pregnancy,commonScreening.isotretinoin,yes('recurrent_herpes','¿Tiene herpes labial de repetición?'),yes('screening_allergies','¿Alergia a salicilatos o aspirina, a anestésicos locales o al látex?'),yes('keloids','¿Tiende a hacer queloides o cicatrices abultadas?'),yes('permanent_filler','¿Le han puesto alguna vez relleno permanente o biopolímeros en la cara?'),yes('implanted_device','¿Lleva marcapasos, dispositivo implantado o implantes metálicos en la zona?'),yes('immune_cancer','¿Enfermedad autoinmune, cáncer activo o tratamiento inmunosupresor?'),commonScreening.infection]),
   section('skin','Su piel',[phototype(),yes('postinflammatory_marks','¿Le queda mancha cuando se le va un grano o una herida?'),yes('melasma','¿Tiene o ha tenido melasma o manchas?'),yes('rosacea','¿Se pone roja con facilidad, o le han dicho rosácea?'),yes('acne','¿Acné activo ahora?'),yes('sensitivity','¿Piel sensible o que reacciona a casi todo?'),yes('recent_sun','¿Sol o UVA en las dos últimas semanas?'),yes('planned_sun','¿Tiene prevista exposición solar en las próximas semanas?'),yes('sunscreen','¿Usa fotoprotector a diario?'),yes('skin_products','¿Usa en casa retinol, ácidos o exfoliantes?'),yes('smoking','¿Fuma?')]),
   section('prior','Qué se ha hecho ya en la cara',[multi('facial_treatments','Tratamientos previos',['Toxina botulínica','Relleno de ácido hialurónico','Bioestimulador','Hilos tensores','Peelings','Láser o IPL','Microagujas o dermapen','Radiofrecuencia','Cirugía facial']),f('last_treatment','Lo último, y cuándo'),f('prior_reaction','Alguna reacción o resultado que no le gustó')]),
   health([f('conditions','Enfermedades relevantes · tiroides, diabetes, autoinmunes','textarea',{reference_target:'antecedentes'})]),assessment()];
 }else if(key==='corporal'){
  title='Anamnesis corporal';area='estetica';
  sections=[identity(),section('reason','Qué le preocupa',[f('reason','Qué le preocupa'),multi('zones','Zonas',['Abdomen','Flancos','Muslos','Glúteos','Brazos','Papada','Espalda','Piernas']),multi('objectives','Objetivo',['Grasa localizada','Flacidez','Celulitis','Tono muscular','Piernas cansadas','Postoperatorio']),f('onset','Desde cuándo','text'),f('prior_treatments','Qué ha probado antes, y qué tal le fue'),f('event','Evento o fecha','text')]),
   screening([commonScreening.pregnancy,commonScreening.implanted,commonScreening.metal,yes('iud','¿Lleva DIU?','El documento original indica considerar este dato al valorar EMShape de abdomen.'),yes('abdominal_hernia','¿Tiene hernia abdominal o diástasis de rectos?','El documento original indica revisar este dato antes de valorar EMShape de abdomen.'),commonScreening.cancer,commonScreening.thrombosis,commonScreening.coagulation,commonScreening.epilepsy,yes('infection','¿Infección, herida o lesión en la piel de la zona?'),yes('recent_surgery','¿Cirugía abdominal o estética en los últimos 6 meses?')]),
   health([multi('conditions','Salud y antecedentes',[none,'Tiroides','Diabetes','Hipertensión arterial','Patología cardiaca','Enfermedad renal','Enfermedad hepática','Linfedema diagnosticado','Lipedema diagnosticado','Varices o edemas','Estreñimiento habitual','Enfermedad autoinmune'],{reference_target:'antecedentes'}),f('surgical_history','Antecedentes quirúrgicos','textarea',{reference_target:'antecedentes'})]),
   section('habits','Peso, hábitos y vida diaria',[...measures(),f('usual_weight','Peso habitual','number',{unit:'kg',min:0}),f('maximum_weight','Peso máximo','number',{unit:'kg',min:0}),f('weight_loss','¿Ha perdido peso este año? Cuántos kilos y cómo'),yes('weight_program','¿Está en un programa de pérdida de peso o con GLP-1?'),yes('bariatric','¿Cirugía bariátrica o balón?'),yes('smoking','¿Fuma?'),f('cigarettes','Cigarrillos al día','number',{min:0}),yes('exercise','¿Hace ejercicio?'),f('exercise_details','Cuál y cuántos días','text'),yes('posture','¿Trabaja de pie o sentada muchas horas?'),yes('water','¿Bebe al menos litro y medio de agua al día?'),yes('fluid_retention','¿Retiene líquidos o se le hinchan las piernas?'),yes('sleep','¿Duerme bien?')]),
   assessment([choice('body_study','Estudio Corporal BS',['Realizado','Se cita','No comprobado']),choice('standardized_photo','Fotografía estandarizada',['Hecha','Pendiente','No comprobado'])])];
 }else if(key==='hair'){
  title='Anamnesis capilar';area='capilar';
  sections=[identity(),section('reason','Qué le preocupa',[multi('concerns','Motivo',['Se me cae el pelo','He perdido densidad','Entradas','Coronilla','Picor o descamación']),f('onset','Desde cuándo','text'),choice('onset_pattern','Cómo empezó',['De golpe','Poco a poco']),yes('worsening','¿Ha ido a peor en los últimos 6 meses?')]),
   screening([yes('pregnancy','¿Está embarazada, podría estarlo, da lactancia o ha dado a luz en los últimos 12 meses?'),yes('fertility','Mujer en edad fértil: ¿busca embarazo o no usa anticoncepción?','El documento original indica considerar este dato al valorar dutasteride.'),yes('acute_loss','¿La caída es brusca y por zonas, o hay lesiones, costras o supuración en el cuero cabelludo?'),yes('cancer','¿Tratamiento oncológico actual o en el último año?'),commonScreening.coagulation,yes('isotretinoin','¿Toma isotretinoína oral?'),yes('uncontrolled_conditions','¿Enfermedad tiroidea o autoinmune sin controlar?'),yes('biotin','¿Toma biotina o suplementos capilares?','El documento original advierte de interferencia en la analítica. El profesional decide la valoración y las instrucciones; no se genera una orden automática.')]),
   health([multi('family_alopecia','Alopecia en la familia',['Padre','Madre','Hermanos','Abuelos'],{reference_target:'antecedentes'}),yes('blood_test','¿Analítica en el último año?'),f('blood_test_date','Fecha de la analítica','date'),yes('strict_diet','¿Dieta estricta o pérdida de peso importante?'),yes('stress','¿Estrés fuerte, enfermedad o cirugía en 6 meses?'),yes('anemia','¿Anemia o ferritina baja conocida?'),yes('thyroid','¿Problemas de tiroides?'),yes('smoking','¿Fuma?'),yes('regular_period','Mujer: ¿regla regular?'),yes('contraception_menopause','Mujer: ¿toma anticonceptivo o está en menopausia?')]),
   section('prior','Qué ha usado ya para el pelo',[multi('hair_treatments','Tratamientos previos',['Minoxidil tópico','Minoxidil oral','Finasteride','Dutasteride','Champús o lociones','Vitaminas o suplementos','Mesoterapia o PRP','LED o láser','Injerto capilar']),f('prior_results','Lo último, cuánto tiempo y qué tal le fue')]),
   section('examination','Exploración médica',[choice('hamilton','Patrón Hamilton',['I','II','III','IV','V','VI','VII']),choice('ludwig','Patrón Ludwig',['I','II','III']),yes('pull_test','Pull test positivo'),yes('scaling','Descamación o seborrea'),yes('miniaturization','Miniaturización en tricoscopia'),yes('standardized_photo','Foto estandarizada hecha')]),
   assessment([choice('requested_tests','Analítica solicitada',['De inicio, CAP-33','Ampliada, CAP-08','Ninguna'])])];
 }else return null;
 for(const field of sections.find(section=>section.id==='reason').fields)if(field.id==='reason'||field.id==='concerns')field.required=true;
 return{title,description:key==='corporal'?'Acompaña al Estudio Corporal BS (COR-03), no lo sustituye.':'Antecedentes y valoración de la consulta.',area_key:area,form_schema:{version:1,key,title,kind,sections}};
}
module.exports={FORM_PRESET_KEYS,formPreset};
