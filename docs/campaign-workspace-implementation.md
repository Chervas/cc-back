# Campaign workspace: implementacion en curso

Estado: EN CURSO. El mock aprobado NO se considera implementado por publicar el
contrato de lectura. No sustituir la ruta productiva hasta completar los comandos,
las pruebas de permisos y el QA autenticado. Referencia UX canonica en front:
`src/Documentacion/20.17-marketing-arquitectura-experiencia-objetivos.md`, apartado 19.

## Contrato de lectura

`GET /api/marketing/campaign-workspace?scope=1|group:28|1,70|all&days=7|30`

- Requiere sesion y lectura en TODAS las clinicas solicitadas. `all` se intersecta
  con las clinicas autorizadas antes de consultar informacion de negocio.
- No cambia activos, conversiones, anuncios, permisos, cobros ni asignaciones.
- Consulta snapshots persistentes por los jobs existentes. No hace llamadas a
  Google/Meta en cada navegacion y no almacena informacion clinica en el navegador.
- Ventanas de dias completos, calendario Europe/Madrid y comparativa anterior de
  igual duracion. No compara un dia parcial con un dia completo.
- Identidad: proveedor + cuenta + campana. La asignacion revisada prevalece.
  Una cuenta compartida no atribuye toda su inversion a cada sede.
- La lectura de inventario no requiere crear y emparejar otra campana local.
  La seleccion y la incorporacion futura se guardan por cuenta y workspace,
  separadas de OAuth. Su integracion con la activacion/recepcion sigue en curso.
- Leads: `LeadIntake.id` unico atribuido. No son personas deduplicadas por email,
  ni conversiones declaradas por Google/Meta. Identidad Google completa prevalece
  sobre UTM; fallback por UTM solo si es inequivoco dentro de la clinica.
- Citas: `CitaPaciente.lead_intake_id`, misma clinica, fecha de creacion de la cita;
  excluye canceladas, reprogramadas y reservas provisionales. No se prorratean
  citas del canal ni se interpreta `status_lead=citado` como una cita real.
- Presupuestos aceptados: `EconomicBudget.accepted_amount` mediante el enlace
  verificable presupuesto -> paciente/clinica -> cita -> interesado -> campana.
  Una atribucion ambigua se excluye; no usar precios del catalogo, facturas,
  cobros ni repartos estimados. Ver "Presupuestos Aceptados: Fuente Y Limites".
- Leads/citas por anuncio: `null` mientras no exista identidad CRM a nivel de
  anuncio. No etiquetar conversiones de plataforma como leads ni inventar ganador.
- Importes agregados: no sumar monedas distintas ni presentar moneda desconocida
  como EUR. Se conserva la inversion individual de cada campana.

## Salud

Seis bloques estables, sin navegacion interior: ausencia de leads, coste por lead,
entrega de anuncios, conexiones/recepcion, privacidad y senales CRM. Cada uno
expone cobertura, ventana y evidencias. Incidencias y campanas afectadas son
contadores distintos. Fallos compartidos del mismo activo se deduplican.

La comprobacion de consentimiento se ha extraido SIN cambiar comportamiento desde
`campaignOnboarding.controller.js` a `campaignMeasurementReadiness.service.js`.
Onboarding y workspace reutilizan la misma verificacion firmada, scope, hash,
caducidad y seleccion efectiva de la web de grupo. Instalar el snippet no acredita
haber recibido un formulario. Autorizar senales tampoco acredita su entrega.

## Cuentas Y Persistencia

`GET/PUT /api/marketing/campaign-workspace/configuration?scope=1|group:28`

- GET devuelve cuentas efectivas sin tokens, inventario visible, configuracion,
  version y permiso de escritura. PUT requiere escritura sobre todas las sedes.
- PUT solo acepta `expected_version` y `accounts`: `provider`, `account_id`,
  `include_future`, `campaign_ids`. No acepta autorizaciones de conversiones ni
  optimizacion dentro de este comando.
- `CampaignWorkspaceSettings` tiene una fila por clinica/grupo. El guardado bloquea
  el propietario, verifica cuentas/campanas autorizadas y registra la version en
  `CampaignWorkspaceEvents` dentro de la misma transaccion. Conflicto: HTTP 409.
- Las selecciones de clinica prevalecen sobre las de grupo; los agregados CSV
  conservan la politica de las cuentas compartidas. Sin configuracion nueva se
  mantiene la lectura anterior, sin deducir una nueva autorizacion operativa.
- OAuth y mapeo reutilizan los endpoints existentes. El nuevo parametro explicito
  `workspace_group_id` de mapeo Ads exige grupo coherente, clinica perteneciente al
  grupo y permiso completo. Usa el grant de grupo, no el override de una sede.
  Las peticiones antiguas mantienen su contrato de asignacion de clinica.
- La nueva UI de cuentas usa autorizacion real, bloqueo de doble envio y URLs
  OAuth limitadas al proveedor. No cambia pujas, anuncios ni conversiones. Meta
  avisa de la sustitucion si se elige otra cuenta publicitaria efectiva.

Migracion aditiva `20260910140000-create-campaign-workspace-settings.js` aplicada
individualmente en DEV el 2026-09-10 mediante `sequelize-cli db:migrate --name`.
Valida columnas, indices unicos y FK; es reanudable. No se ejecutaron otras
migraciones ni se guardaron selecciones de clientes durante la verificacion.

## Preparacion Web Acotada

El endpoint existente `PUT /api/intake/config/:clinicId` admite
`mutation_kind=campaign_preparation`. Requiere la misma autorizacion de escritura
efectiva que el editor completo: una clinica no puede cambiar el consentimiento
de la web compartida sin seleccionar/autorizar el grupo.

- Solo admite dominio, recepcion de formularios, proveedor CMP y tres URLs legales.
  Rechaza conversiones, HMAC, pruebas firmadas y cualquier otro campo del editor.
- `GET /api/intake/config/admin` devuelve `preparation_revision`. El nuevo comando
  comprueba esa revision bajo bloqueo y agrega el dominio sin borrar otros.
- Conserva chatbot, llamadas, flujos, sedes y politicas Google/Meta ya guardadas.
  Una instalacion inicial no habilita widgets ni senales publicitarias.
- Reutiliza reconstruccion de pruebas firmadas y hooks de reconciliacion actuales.
  Cambiar el consentimiento no fabrica una verificacion positiva. El job recibe
  el origen `marketing:campaign_web_preparation`.
- El modal compartido real ya tiene Preparar / Instalar / Comprobar. Descarga el
  plugin WordPress o genera el snippet con el HMAC real del scope. Reutiliza el
  verificador firmado; no fabrica un formulario de prueba ni activa senales Ads.
- GET admin devuelve tambien `preparation_can_write`, calculado sobre el scope
  efectivo completo. Una consulta admin por dominio no puede caer en otra
  configuracion ajena cuando no existe la del scope solicitado.
- `merge_verified_domains=true`, solo en la mutacion de verificacion, valida
  estrictamente la prueba entrante y conserva las pruebas operativas vigentes
  de otros dominios. No confunde TTL de emision con TTL operativo.
- Salud consulta `FormSubmissionEvents` de los ultimos siete dias por fecha de
  recepcion del servidor, con join obligatorio al lead de la misma clinica. Cada
  destino web debe tener recepcion; se ignoran parametros publicitarios, pero no
  rutas ni parametros funcionales. La consulta no proyecta campos del formulario
  ni identificadores del paciente. Sin recibo reciente queda sin comprobar, no
  declara un fallo solo porque aun no haya envios.

## Plan Gestionado

- `GET /api/marketing/managed-campaigns/quote?clinica_id=1&investment=650`
  requiere sesion y acceso a la clinica. Devuelve un calculo orientativo versionado
  `global-managed-v1`: maximo de 999 EUR y 149 + inversion + 20% + 50%. No calcula
  impuestos ni crea contratos, pagos, facturas o instrucciones de reparto Stripe.
- El POST existente `/managed-campaigns/request` admite `global_plan` con
  `quote_version`, `investment` y `goal`. Recalcula el importe en servidor, guarda
  el desglose solicitado, y crea el registro gestionado draft/observe y su cuenta
  unfunded. El contrato anterior de presupuesto total se conserva para otros
  consumidores. Una segunda solicitud vigente devuelve 409 con el registro real.
- El dialogo usa solicitudes, estados, propuesta, enlace de contenido y revision
  reales. En un grupo identifica la clinica de cada propuesta; no reparte un
  presupuesto arbitrariamente entre sedes. No necesita cuentas Ads para solicitar.
- Para las nuevas solicitudes Global, aprobar exige contenido disponible y
  aceptacion explicita de la revision vigente. La aprobacion pasa a revision del
  equipo, no a activa. Pedir cambios reutiliza el comando versionado existente.
- El selector de clinica/grupo cancela lecturas y cierra los dialogos del scope
  anterior. Plan gestionado carga por separado del informe: su fallo no impide
  ver los resultados. El contenedor nuevo aun NO sustituye la ruta productiva.

## Pendientes Antes De Sustituir La Ruta

- Contenedor y navegacion productivos con la UI aprobada. Mantener los interiores
  existentes de Objetivos y Captar nuevos pacientes; adaptar solo su navegacion.
- Conexion OAuth, cuentas, politica de incorporacion futura y excepciones de
  cuentas compartidas: servicios/dialogo inicial preparados; falta integrarlos
  en el contenedor, completar asignaciones y comprobar el recorrido real.
- Preparacion web reutilizable, prueba real de recepcion, permisos de formularios
  nativos y estados de entrega de senales por proveedor.
- Activacion de medicion: el onboarding anterior exige consentimiento web incluso
  para casos nativos; no reutilizarlo ciegamente ni relajar gates de conversiones.
  Una configuracion nueva con `activation=null` no demuestra que la medicion
  anterior este desactivada: hidratar y conservar los contratos existentes.
- Optimiza: comprobacion persistente de compatibilidad Google/Meta, mandato
  explicito por recursos revisados y pausa de ajustes disponibles en DEV;
  faltan recomendaciones y ejecucion acotada con jobs. El onboarding
  guided anterior no representa los nuevos permisos. Nunca anunciar ajustes
  como activos a partir de una comprobacion de compatibilidad.
- Solicitud gestionada y aprobaciones preparadas con servicios existentes;
  pendientes de QA visual integrado, sin cobros ni publicacion en cuentas reales.
- Completar frescura/cobertura del inventario de anuncios sin insights, registros
  de recepcion, tipos de destino desconocido y divisa de cuentas Meta antiguas.
- QA responsive y navegacion real en Chromium, estados inicial/configurado,
  comparativa temporal, cambio de clinica/grupo, permisos y errores recuperables.

## Integracion Y Guardas De Senales

- Ruta temporal de QA en DEV: `/marketing/objetivos/integracion-campanas`.
  No esta enlazada en el menu ni sustituye la ruta canonica. Usa APIs reales,
  incluido el calculo gestionado, la seleccion de cuentas y la preparacion web.
- El contenedor usa el inventario de clinicas de `RoleService` y el selector
  global. `filteredClinics` del selector no sirve como inventario inicial: solo
  se rellena al elegir un grupo. Esto se detecto con un reload real en Chromium.
- La grafica aprobada es ahora un componente compartido, sin depender de datos
  del mock. Admite las fechas ISO reales y las numericas de la referencia.
  Leads/citas sin campana asignada permanecen `null`, tambien en los KPI, y no
  producen una grafica falsa a cero. Los anuncios se paginan de diez en diez.
- La preparacion web conserva URLs legales relativas a raiz, compatibles con
  el editor y con varios dominios compartidos. Rechaza hosts relativos `//`,
  barras inversas, controles, esquemas ejecutables y credenciales en las URLs.
- `campaignWorkspaceSignalPolicy.service` consulta la autorizacion vigente en
  cada envio, sin cache de sesion. La seleccion actual de cuentas Y el snapshot
  autorizado limitan cuentas, campanas, incorporacion futura e hitos. Ampliar la
  seleccion no amplifica una autorizacion anterior; la revocacion es inmediata.
- Solo se aplica a configuraciones que tengan una referencia explicita
  `config.campaigns.workspace_policy`, ligada al setting y su scope. Una
  referencia invalida, inexistente o ajena bloquea el envio. Las configuraciones
  anteriores conservan su comportamiento y no generan consultas adicionales.
- Google registra el motivo/version en su auditoria existente. Meta requiere
  consentimiento explicito para los eventos CRM del workspace y no usa pixel ni
  token global como respaldo de un workspace migrado, tampoco en ViewContent.
- Hay un comando inicial de medicion, descrito abajo, pero permanece bloqueado en
  el despliegue y NO habilita senales ni Optimiza. La base es compartida con
  staging: no basta con que solo el runtime nuevo entienda un flag.
- Los hitos QualifiedLead, Schedule y Purchase del workspace exigen una capacidad
  interna del lifecycle CRM. Un JSON publico no puede fabricarla. Lead/Contact
  conservan la recepcion web; el tracking de visitas es independiente. Tanto la
  politica del registro web como la del anunciante limitan un envio cuando son
  registros distintos. Quedan pendientes la identidad Meta canonica, payload minimo,
  elegibilidad del destino y auditoria durable de entrega Meta. El sender legacy
  no prueba entrega por ausencia de excepcion. Estas guardas no se presentan
  como una implementacion completa de Medicion ni de Optimiza.

## Preparacion Y Activacion Inicial

- `campaignMode.service.js` extrae, sin reinventar sus reglas, la resolucion de
  modo anterior: IntakeConfig de clinica/grupo, onboarding completado y fallback
  de estrategias activas con readiness verificada. El controller anterior usa el
  mismo servicio; se conserva su contrato de tests y el historial no se borra.
- `GET /api/marketing/campaign-workspace/preparation` solo lee el scope permitido.
  Distingue seleccion confirmada, clinica pendiente, destino desconocido,
  instalacion/consentimiento y recepcion real. OAuth por si solo no verifica los
  formularios nativos. Un SHA-256 liga la pantalla de revision a las cuentas,
  comprobaciones y registro Intake vigentes; no expone HMAC ni credenciales.
- El contenedor de integracion tiene los tres pasos y conserva el paso en la URL.
  No cambia los interiores de los hubs ni sustituye aun la ruta canonica.
- `PUT /api/marketing/campaign-workspace/activation` es una base limitada a
  `mode=measurement`, `signals.enabled=false` y confirmacion expresa. Exige
  version/revision vigente, recepcion comprobada, permiso sobre todo el grupo y
  ausencia de modos/politicas de optimizacion incompatibles. Una web compartida
  no puede migrarse desde una clinica individual.
- La transaccion bloquea propietario, setting e Intake, escribe la referencia
  de politica, el contrato connect_only sin autorizacion de uploads y la
  auditoria. Conserva los ajustes de proveedor/visitas y las demas funciones web:
  el permiso CRM se controla en un punto, no apagando toda la integracion.
  El onboarding anterior rechaza scopes ya migrados para no borrar sus permisos.
- `CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED` debe permanecer ausente/false hasta
  cerrar y verificar TODOS los emisores y workers que comparten la base. No se
  ha habilitado en DEV ni en staging. El guard se evalua en servidor antes de
  cualquier escritura; no es un parametro que pueda mandar el navegador.
- No esta terminado el objetivo: faltan incorporacion/asignacion nativa completa,
  preparacion y autorizacion de conversiones Google/Meta, entrega auditable Meta,
  Optimiza real en ambos proveedores y atribucion economica/anuncio. Esta base
  no debe publicitarse como un flujo completo ni activarse para clientes todavia.
- Regresion de Web: 400 pruebas OK, mas contratos WordPress/Ed25519/provisionador.
  Se corrigio un test antiguo que no aislaba `cleanupOverviewCache`: ahora simula
  tambien ese paso y prohibe cualquier consulta SQL durante la prueba de limpieza.

## Verificacion Inicial 2026-09-10

- Preparacion y activacion limitada: regresion completa `npm run test:marketing`
  con 400 pruebas Web y 248 de Campanas OK. Build `bedd4440106b05d2`:
  Chromium autenticado, 51 comprobaciones y 23 capturas, cero errores JS y
  cero escrituras de negocio. Evidencia:
  `/home/ubuntu/qa-evidence/campaign-workspace-preparation-20260910/`.

## Confirmacion De Clinica En Cuenta Compartida

- `PUT /api/marketing/campaign-workspace/assignment` confirma SOLO la primera
  asignacion de una campana externa visible a una clinica activa del grupo.
  No crea Campaign, Campana, CampaignRequest ni targets internos obligatorios.
- Requiere permiso de escritura en todas las clinicas del grupo, version de
  seleccion vigente, cuenta OAuth autorizada y campana incluida en el inventario
  autorizado. Revalida los miembros del grupo y bloquea filas en la transaccion.
- Reutiliza `saveAssignmentWithinScope` y la auditoria canonica
  `ExternalCampaignAssignmentAudit`. Una decision existente, archivada,
  concurrente o de otro grupo nunca se mueve/reactiva implicitamente. Tambien
  detecta identificadores de cuenta antiguos con formato.
- El dialogo muestra solo clinicas elegibles del alcance. Elegir no guarda:
  requiere `Confirmar clinica`. Cerrar vuelve al mismo paso y recarga evidencia.
- Asignar no equivale a recepcion lista. Google ya consume las asignaciones
  revisadas en su enrutamiento; completar el enrutamiento nativo Meta, el acceso
  a los formularios y la prueba de recepcion sigue siendo trabajo pendiente.
- Contratos aislados: 27 pruebas entre asignacion, permisos y preparacion OK;
  ninguna asignacion de clientes guardada durante el QA.

## Historial De Verificacion

- Confirmacion de clinica: build `dc8934c8caea70e6`, 57 comprobaciones y
  25 capturas Chromium, 25 respuestas API 200, cero errores JS y escrituras.
  Dialogo verificado en 1440 y 390 px, seleccion explicita y retorno al mismo
  paso. Evidencia `/home/ubuntu/qa-evidence/campaign-workspace-assignment-20260910/`.
  Regresion de campanas tras la asignacion: 258 pruebas OK.

- Bateria existente `npm run test:marketing-campaigns`: 141 pruebas OK despues
  de extraer la validacion de consentimiento (antes de los ultimos tests nuevos).
- Tests nuevos de alcance, metrica y Salud; sin mutaciones a proveedores.
- Lectura local Arriaga: clinicas 1 y 70, grupo 28. Cuenta Google compartida tambien
  con otro mapping de clinica; no hay ExternalCampaignAssignments para esa cuenta.
  Meta persiste inventario en SocialAdsEntities, no en ExternalCampaignInventories.
  Estas excepciones no se han corregido cambiando datos de negocio durante el QA.
- Despues de la migracion: lectura de grupo Arriaga en 325 ms, 2 cuentas,
  10 campanas visibles y 6 bloques de Salud. Settings y eventos: 0 filas.
- Configuracion: tests de guardado/versionado, permisos, agregados y migracion;
  compilacion Angular aislada del informe y dialogo real de cuentas. Aun no hay
  build publicado ni QA Chromium de la implementacion nueva.
- Verificacion posterior al guardado y alcance de grupo: bateria de campanas
  181 pruebas OK; `campaign_workspace_*.test.js` 63 pruebas OK; regresiones OAuth
  incluidas. Front: 6 contratos de seleccion/OAuth, TypeScript y compilacion
  Angular aislada OK. Ninguna autorizacion operativa guardada en clientes reales.
- Preparacion web: 9 contratos nuevos, junto con verificacion firmada, merge,
  configuracion efectiva y hooks del runtime (22 pruebas OK). No se ha probado
  este guardado sobre ninguna web real ni se ha reiniciado el backend.
- Ampliacion: contratos reales de solicitud gestionada (permisos, importe,
  draft/unfunded y revision/contenido) probados con modelos aislados. Regresion
  `managed_campaign_finance.test.js` OK. Recepcion web: 6 pruebas, sin datos
  personales ni escrituras a leads reales. Contenedor y dialogos compilan con ngc.
- Regresion posterior: `npm run test:marketing-campaigns` 196 pruebas OK (57
  contratos). Front: 22 tests y 12 comprobaciones de presentacion OK; ngc del
  contenedor, cuentas, preparacion web y plan gestionado OK.
- Inventario Meta: los anuncios sin insights siguen visibles, sin inventar gasto.
  La frescura usa `updated_at` de sincronizacion, no `updated_time` de edicion en
  Meta. Tests de inventario/metricas comprueban la fusion y estados rechazados.
- Primer build completo publicado solo en DEV y backend DEV reiniciado para
  integrar las APIs nuevas. Staging y gateway no se han reiniciado ni promovido.
- Chromium autenticado con el login real: 41 comprobaciones, 20 capturas,
  respuestas workspace 200, cero errores JS y cero escrituras de negocio.
  Incluye grupo Arriaga, agregado total tras reload, navegacion con origen,
  dialogos web/cuentas/gestionado y grafica real a 1440/1024/390 px, cuadricula
  a ras y tooltip visible DD/mes/YYYY. Evidencia:
  `/home/ubuntu/qa-evidence/campaign-workspace-live-20260910-final/`.
- Regresion de campanas: 220 pruebas OK antes de los ajustes finales. Contratos
  posteriores de recepcion/URLs y Meta: 19 OK; informe/Salud: 29 OK. Front:
  27 tests, 15 comprobaciones de presentacion y tres contratos de ciclo de vida
  del dialogo/paginacion OK. Compilacion Angular aislada y build completo OK.
- Revalidacion del build DEV `e07e8b383f638f6e`: 44 comprobaciones, 21 capturas,
  cero errores JS y cero escrituras en
  `/home/ubuntu/qa-evidence/campaign-workspace-live-20260910-verified/`.
  Incluye estados de anuncio en castellano y tabla movil. El caso real tenia ocho
  anuncios; la navegacion de mas de diez se cubre en el contrato de paginacion.

## Presupuestos Aceptados: Fuente Y Limites

- `campaignEconomicAttribution.service.js` es el unico punto de enlace del
  informe con `EconomicBudget.accepted_amount`. Lee presupuestos actualmente
  `accepted` o `partially_accepted`, por `responded_at` en los dos periodos
  comparados, sin consultar precios de tratamientos ni importes cobrados.
- Enlace real: presupuesto -> (clinica, paciente) -> cita con `lead_intake_id`
  -> interesado con cuenta/campana canonica. La cita y el lead deben preceder
  la aceptacion; se excluyen citas canceladas, reprogramadas o provisionales.
  La cita puede ser anterior al periodo del informe.
- Un presupuesto se cuenta una vez por su ID, aunque existan varias citas o
  varios leads de esa misma campana. Dos campanas, un origen desconocido o
  identidades contradictorias se excluyen; no se decide por ultimo contacto,
  nombre/UTM, precio del catalogo ni reparto proporcional.
- Se suma en centimos y se presenta en EUR, moneda del dominio economico actual,
  independientemente de la moneda de inversion publicitaria. Son presupuestos,
  no ingresos cobrados. Se usa la aceptacion vigente, no una reconstruccion de
  todas las versiones historicas que hayan sido anuladas o reemplazadas.
- Google utiliza sus campos canonicos de LeadIntake. La recepcion nativa Meta
  incorpora una identidad verificada en LeadAttributionAudit, que el informe y
  el calculo economico leen mediante `leadAdvertisingIdentity.service.js`.
  Los registros Meta antiguos sin esa prueba no se atribuyen por nombres/UTM.
  El servidor devuelve cobertura agregada, nunca datos de pacientes ni lineas
  de tratamientos. El nivel anuncio sigue pendiente de conectar al informe.
- Contratos: 10 casos nuevos mas 21 del informe OK; frontend comprueba moneda
  independiente, comparacion real y explicacion cuando falta atribucion.
- Verificacion integrada final de este avance: Campanas 268 pruebas OK;
  frontend 35 tests (incluyen 15 comprobaciones de presentacion), ngc y build
  `f8e9afaa76387f39` OK. Chromium autenticado: 58 comprobaciones, 25 capturas,
  25 respuestas workspace 200, cero errores JS y cero escrituras de negocio.
  Evidencia `/home/ubuntu/qa-evidence/campaign-workspace-budget-20260910-retry/`.
  Un primer arranque inmediatamente posterior al reinicio agoto el timeout
  antes de cargar la vista; quedo capturado en el directorio sin `-retry`.
  La repeticion completa y los reloads posteriores pasaron, sin ocultar ese fallo.

## Auditoria Inicial: Recepcion Nativa Meta

- Auditoria del receptor actual en `intake.controller.js`: valida la firma, pero
  consulta la primera pagina mapeada con cache de cinco minutos y obtiene el lead
  con `META_GRAPH_TOKEN` global. Si falla esa lectura, continua creando un lead
  vacio; el vinculo a campana depende de AdCache/Campana. Estos puntos deben
  sustituirse antes de considerar terminado el recorrido nativo.
- `ClinicMetaAsset.pageAccessToken`, `metaConnectionId` y las asignaciones OAuth
  ya permiten resolver credenciales acotadas. No debe elegirse arbitrariamente
  una clinica cuando la pagina o cuenta publicitaria pertenezca a un grupo.
- `oauth.routes.js` ya suscribe paginas a `leadgen`, pero solo registra el
  resultado en logs y traga errores. La preparacion necesita prueba persistida
  de acceso/suscripcion, distinta de haber recibido efectivamente un formulario.
- El [SDK oficial de Meta](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/lead.js)
  confirma campos `ad_id`, `adset_id`, `campaign_id`, `form_id`, `is_organic` y
  `created_time` en Lead. La guia web de recuperacion devolvio 429 en esta sesion;
  no se han usado articulos de terceros como contrato tecnico.
- Reutilizar la identidad externa en recepcion, informe por anuncio y KPI de
  presupuestos Meta; no inventar UTMs ni crear una Campaign local. Las escrituras
  de LeadIntake tienen indices unicos para event_id y external_source/external_id.
  Existe `intakeQuickChatOutbox.service.js` para persistir lead, auditoria y outbox
  atomicamente, y JobRequests para entregas/reintentos con namespace de runtime.
- Aun no se ha modificado la recepcion nativa ni llamado a Meta en este avance.

## Recepcion Nativa Meta: Implementacion Posterior

- Se sustituye el receptor sincrono por un acuse durable: primero valida HMAC,
  despues persiste `campaign_meta_lead_receive` en JobRequests y solo entonces
  devuelve 200. Una caida de la cola devuelve 503 para permitir la reentrega.
  Las paginas no conectadas se ignoran. Payload: IDs firmados de lead, pagina,
  formulario y anuncio; sin contactos, tokens ni runtime indicado por el emisor.
- El job usa el namespace del runtime API; desde gateway se dirige al worker
  `META_LEAD_JOB_RUNTIME_NAMESPACE`, o al fallback operativo de automatizaciones
  (staging por defecto), nunca a un namespace elegido por el webhook. Usa
  el scheduler existente con
  ocho intentos y su backoff habitual. No es un cron ni un barrido nocturno.
  El job queda registrado como fallido al agotar intentos, no como un interesado
  vacio. Los errores de proveedor se reducen a codigos seguros, sin Axios config.
- Credenciales de la pagina/conexion asignada y activa; sin META_GRAPH_TOKEN
  global. Se revalida la asignacion OAuth, caducidad y propiedad antes de escribir.
  Meta Lead se consulta con el token de pagina y Ad con el token de conexion;
  sus IDs deben coincidir con el aviso firmado. Campos contrastados con
  [Ad del SDK oficial](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/ad.js).
- En cuentas compartidas manda ExternalCampaignAssignment. Sin decision unica,
  activa y dentro de la clinica autorizada, no se crea ni mueve el lead. Una
  cuenta exclusiva de clinica puede incorporar campanas nuevas; se respeta la
  seleccion guardada y `include_future`. No se crea una segunda Campaign/Campana.
- Lead y auditoria se guardan en una transaccion. La identidad publicitaria
  (cuenta, campana, anuncio, pagina, formulario y clinica) se escribe solo desde
  la respuesta verificada del proveedor. Se guardan email/telefono normalizados,
  pero no se copian respuestas personalizadas de salud a la auditoria analitica.
  Una reentrega reutiliza el ID externo; no deduplica contactos entre clinicas.
  El autorreply existente se encola despues del commit y se puede reintentar.
- El informe consulta exclusivamente la proyeccion JSON de identidad y los IDs
  de leads de su ambito. Pruebas contradictorias quedan sin atribucion; nunca
  se vuelven a resolver por el nombre de la campana.
- Despliegue: actualizar primero el worker que procesa JobRequests y despues
  los receptores API/gateway, con el mismo namespace previsto. No enviar nuevos
  jobs a un worker que todavia no registre este tipo. DEV no es leader del cron,
  pero su worker puede consumir JobRequests del namespace dev; son controles
  independientes. Esta tarea no encola formularios reales, activa permisos ni
  reinicia staging.
- Pendiente para cerrar el recorrido nativo completo: inventario de todos los
  formularios/destinos, dialogo de paginas/permisos, prueba persistida de
  suscripcion y visibilidad/reintento contextual de recepciones fallidas.
  Recibir un formulario no demuestra que todos los formularios de una campana
  esten preparados. No se ha puesto ese estado artificialmente en verde.
- QA detecto y corrigio una incompatibilidad de Sequelize con el argumento
  string de JSON_EXTRACT (duplicaba el signo dolar). La proyeccion utiliza ahora
  `Sequelize.json`, con contrato del SQL MySQL generado y comprobacion SQL real
  de lectura. No se oculta el error devolviendo listas o importes vacios.
- La primera navegacion inmediatamente tras PM2 podia recibir 502 del proxy
  antes de que escuchara la API. El runner comprueba ahora la disponibilidad del
  listener antes de navegar y conserva tiempos/errores de red; no altera la
  autenticacion ni reintenta de forma encubierta errores del workspace.
- Verificacion de este tramo: 290 pruebas de Campanas OK, suite completa Web
  OK (incluido contrato PHP/Ed25519/compilador/provisionador), y proyeccion SQL
  real de solo lectura OK. Chromium autenticado: 58 comprobaciones, 25 capturas,
  25 respuestas workspace 200, cero errores JS y cero escrituras de negocio.
  Evidencia `/home/ubuntu/qa-evidence/campaign-workspace-meta-reception-20260910-verified/`.
  Se conservan los intentos anteriores: `-observed` detecto el 500 del agregado;
  `-fixed` registro los 502 de arranque antes de la barrera de disponibilidad.
  Las pruebas del receptor usan proveedor y persistencia aislados: no son una
  importacion ni una prueba de permisos reales de Meta.

## Comprobacion de Destinos y Formularios Meta

- El dialogo real de preparacion consulta `GET /campaign-workspace/meta-preparation`.
  Abrirlo solo lee inventario y evidencia local; no consulta Graph ni escribe.
  `POST /campaign-workspace/meta-preparation/check` hace una comprobacion
  explicita del inventario publicitario y actualiza exclusivamente su cache.
  No modifica anuncios, paginas, suscripciones, conversiones ni presupuestos.
- Requiere campana visible y asignada, cuenta seleccionada y una conexion OAuth
  vigente del ambito. Revalida todo despues del I/O y serializa el guardado;
  la revision impide sobrescribir una comprobacion concurrente. No acepta tokens,
  clinica o actor suministrados por el navegador. La cuenta compartida conserva
  su asignacion revisada; nunca se crea una segunda Campaign/Campana.
- Lectura paginada de anuncios, hasta 20 paginas de 100, usando cursores sobre
  el endpoint fijo, no las URLs `next`. Comprueba cuenta/campana/anuncio y
  pagina/formulario. No basta el objetivo publicitario ni el primer anuncio.
  Paginacion incompleta, creatividades desconocidas y destinos mixtos quedan
  pendientes. CTA de formulario con un enlace a la web no cuenta como un
  segundo destino de recepcion. Los metadatos del formulario se limitan a
  ID, nombre, pagina y estado: no se piden respuestas, contactos o test leads.
- Usa el cliente Meta y su pausa/cuota compartidas, con timeout total de 45 s
  para Graph y sin reintentos interactivos en cada llamada. El limite temporal
  y de paginas no equivale a una comprobacion completa. Para inventarios que lo
  superen sigue pendiente pasar el mismo detector a un job de fondo y conectar
  la renovacion nocturna; no se ha añadido un cron paralelo ni un bucle al abrir
  el informe. Una comprobacion de destinos caduca para readiness en 24 h.
- Evidencia nativa: proyeccion JSON de la identidad verificada del receptor,
  join obligatorio al LeadIntake de la misma clinica y recepcion en los ultimos
  siete dias para CADA formulario de la misma cuenta/campana/pagina. Una
  recepcion de otra campana que reutilice el formulario no vale. Se comprueban
  de nuevo asignaciones OAuth y caducidad de cuentas y paginas. Un error
  explicito de acceso a un formulario invalida la recepcion preparada aunque
  exista una recepcion anterior. No se lee PII para este informe.
- El estado nativo usa por ahora las paginas ya conectadas en ClinicMetaAsset.
  NO se reutiliza `oauth/meta/map-assets` para añadir paginas de recepcion:
  ese endpoint sustituye la pagina social principal. Sigue pendiente el
  almacenamiento independiente de varias paginas, su accion de conexion,
  verificacion persistida de `leadgen` y reintento contextual de jobs fallidos.
  El dialogo detecta e informa de esas faltas; no debe darse por cerrado el
  recorrido nativo completo ni promoverse la ruta canonica todavia.
- Campos contrastados con el SDK oficial:
  [AdCreative](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/ad-creative.js),
  [CTA](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/ad-creative-link-data-call-to-action-value.js)
  y [LeadgenForm](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/leadgen-form.js).
- La cache de destinos conserva el estado/nombre mas reciente de SocialAdsEntity;
  no congela campanas activas cuando la sincronizacion nocturna las ve pausadas.
  Identidades contradictorias de un mismo lead no prueban dos formularios.
- Verificacion: 313 pruebas de Campanas y 3 del cliente Meta OK; consulta SQL
  real de la proyeccion/join nativos OK, sin escribir. Build publicado DEV
  `f23a68b436c7d2cc` (aviso previo de bundle inicial 4.58 MB).
  Regresion Chromium autenticada: 58 comprobaciones, 25 capturas, cero errores
  JS/escrituras. Evidencia `campaign-workspace-meta-destination-20260910` bajo
  `/home/ubuntu/qa-evidence/`. QA del dialogo: 14 comprobaciones, 6 capturas,
  `campaign-meta-preparation-20260910-passed`. La apertura inicial usa la API
  real del grupo BS Medical; las cuatro capturas `fixture` prueban listas largas
  y permisos mediante respuestas GET aisladas del navegador, no datos reales.
  No se ejecuto Graph ni se guardo inventario de clientes en este QA.
  Se corrigio un fallo real de retorno: cerrar sin comprobar no recarga ni
  pliega la campana abierta. Los intentos anteriores conservan el fallo de
  retorno y los ajustes del runner para la zona tactil MDC y el hover del menu.

## Reutilizacion De La Recepcion Meta Existente

- La recepcion de formularios Meta ya existia. Este avance no crea otro receptor,
  otra tabla de conexiones ni otro flujo de leads. Reutiliza `ClinicMetaAsset`,
  las asignaciones OAuth y la cola `JobRequests` para comprobar o reparar la
  suscripcion de una pagina ya conectada. No modifica `oauth/meta/map-assets` ni
  sustituye el perfil de Redes sociales. Multipagina independiente sigue pendiente.
- Comando `POST /campaign-workspace/meta-preparation/page`: cuenta, campana,
  pagina detectada, revision y accion `check` o `enable`. Solo `enable` acepta y
  exige `confirmed: true`. Autenticacion y escritura sobre todo el scope;
  el actor procede de la sesion, nunca del payload. El resultado HTTP 202 es
  una tarea pendiente, no una recepcion habilitada.
- Job `campaign_meta_page_reception`: tres intentos con el backoff/namespace
  existentes, sin nuevo cron. Guarda IDs, revision, accion y huella, nunca tokens
  ni respuestas de formularios. Revalida usuario, seleccion, clinica, OAuth y
  credencial antes de consultar, antes de habilitar y antes de persistir.
  Conserva la guarda compartida `assertSharedMarketingAssetMutationAccess`:
  habilitar exige acceso a todas las clinicas que usan el activo; una clinica
  aislada no cambia una pagina propiedad del grupo.
- `check` consulta `has_lead_access` y `subscribed_apps`; no crea test leads ni
  descarga contactos. `enable` agrega `leadgen` solo si falta y conserva los
  demas campos de suscripcion (Messenger/social). Si no puede leer el conjunto
  completo, no lo reemplaza. Un POST exitoso no basta: otro GET debe verificarlo.
  El helper acotado `metaSubscribePage` comparte cuotas/pausas/telemetria con
  `metaGet`, no sigue redirecciones y no reintenta POST ambiguos dentro de HTTP.
- La prueba se guarda en `additionalData.campaign_lead_reception`, preservando
  metadatos ajenos, con ID del job, app, fecha y huella de pagina/scope/conexion/
  credencial. Caduca en 24 h o al cambiar la conexion. `prepared` significa acceso
  y suscripcion comprobados; NO inventa una recepcion ni convierte el indicador
  `ready` en verde sin el correspondiente formulario recibido en CRM.
- El dialogo muestra las conexiones existentes y una accion por pagina. Se puede
  cancelar la confirmacion sin escribir; tras encolar consulta solo el estado
  publico del job. La espera visual se limita a 60 s, permite cerrar y volver a
  consultar sin repetir la autorizacion. El estado no devuelve payload, tokens
  ni contactos. El comprobador de destinos conserva su accion separada.
- Contratos primarios: [ejemplo oficial de suscripcion](https://github.com/facebook/facebook-java-business-sdk/blob/main/examples/PageSubscribedAppsPost.java),
  [muestra oficial de webhooks](https://github.com/fbsamples/lead-ads-webhook-sample/blob/main/postman/FB%20Lead%20Ads%20%28Part%201%20-%20The%20Webhook%29.postman_collection.json)
  y [campos de Page del SDK](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/page.js).
  La referencia web de Meta devolvio 429; no se usaron fuentes secundarias como
  contrato. Sigue pendiente verificar la operacion con una autorizacion real de
  cliente: las pruebas de comandos usan proveedores aislados, no Graph de clientes.
- Verificacion de este avance: 330 pruebas de Campanas y 4 del cliente Meta OK;
  build DEV `9350470e251b696b` publicado. Chromium autenticado: 58 comprobaciones
  y 25 capturas del workspace con APIs reales; dialogo 26 comprobaciones y 12
  capturas, apertura real mas fixtures de confirmacion/resultado en navegador.
  Sin errores JS ni escrituras reales. Evidencias bajo `/home/ubuntu/qa-evidence/`:
  `campaign-workspace-meta-page-20260910` y `campaign-meta-page-20260910-verified`.
  La inspeccion manual corrigio el pie de confirmacion movil antes del pase final.
  No se han ejecutado cambios de suscripcion reales ni activado publicidad/senales.

## Borrador De Servicio Y Hitos Del CRM

- `PUT /campaign-workspace/preferences` guarda la eleccion de Medicion u Optimiza,
  los hitos solicitados (`lead`, `contact`, `qualified_lead`, `schedule`) y los
  limites propuestos de optimizacion. Es un BORRADOR, no una autorizacion activa.
  No toca `IntakeConfig`, conversiones, recepcion, emisores, politicas ni anuncios.
  Los presupuestos aceptados continuan como KPI: este borrador no habilita Purchase.
- La migracion aditiva `20260910170000-add-campaign-workspace-preferences.js`
  incorpora `CampaignWorkspaceSettings.preferences` JSON nullable. Aplicada
  individualmente en la BD compartida y registrada en SequelizeMeta, sin ejecutar
  otras migraciones ni actualizar configuraciones de clientes. El rollback rechaza
  perder borradores poblados sin un archivo explicito previo.
- Exige escritura sobre todo el ambito, actor autenticado, cuentas confirmadas,
  version vigente y asignaciones OAuth aun validas. Bloquea propietario y setting
  en transaccion; una nueva clinica del grupo requiere revisar la autorizacion.
  Valida campos/eventos/limites conocidos y rechaza negative_keywords sin Google.
  Audita `preferences_saved` en la misma transaccion. Guardado identico idempotente.
- La UX permanece en el segundo paso. Elegir hitos o limites invalida la revision;
  guardar actualiza solo configuracion/preparacion, sin recargar ni plegar el informe.
  El tercer paso muestra el servicio elegido y requiere la misma version comprobada.
  Ni frontend ni backend degradan silenciosamente un borrador con senales/Optimiza
  a la activacion parcial de Medicion sin senales. El gate de despliegue sigue cerrado.
- Los limites son preferencias solicitadas, no evidencia de un executor implementado.
  Sigue pendiente comprobar compatibilidad/currency por cuenta, preparar y autorizar
  los destinos Google/Meta, conectar los emisores y ejecutar Optimiza con esas guardas.
  La autorizacion documentada de conversiones mejoradas es especifica por cuenta y
  evento; OAuth o este borrador no la reemplazan. Se reutilizaran las APIs existentes
  de conversiones, sin crear ni normalizar acciones publicitarias al guardar.
- Correccion adicional: `loadWorkspacePreparation` pasa el scope autorizado al
  resolvedor de evidencia nativa, igual que el informe. No cambia el receptor existente.
- Verificacion: 292 pruebas backend `campaign_*.test.js`, 38 de frontend y
  compilacion Angular completa correctas. Build DEV `7de02b12ae69ed49`,
  10/09/2026 16:26:43 UTC; aviso previo de bundle inicial 4.58 MB frente a 3 MB.
  Se reinicio solo `pm2-back-dev`; staging, gateway y preview conservan proceso.
- Chromium autenticado: workspace real 58 comprobaciones/25 capturas; borradores
  27/7; recepcion Meta 26/12. Cero errores JS y cero escrituras reales de negocio.
  Las pruebas de guardar borrador/conflicto (tres PUT) y habilitar pagina (un POST)
  se interceptan por completo en el navegador; NO son operaciones reales sobre
  clientes/proveedores ni sustituyen una prueba autorizada de entrega. La lectura
  SQL posterior confirma cero filas con preferences pobladas.
  Evidencia en `/home/ubuntu/qa-evidence/`: `campaign-workspace-preferences-20260910`,
  `campaign-preferences-20260910-final` y `campaign-meta-preferences-regression-20260910`.
  Revisadas manualmente capturas de seleccion/limites, revision movil y Salud.
  El runner distingue el area tactil expandida de Material de un desbordamiento
  de texto; no se recorta el control para satisfacer una medicion incorrecta.

## Preparacion De Conversiones Google

- El segundo paso abre un dialogo de la cuenta usando las APIs existentes de
  conversiones. Recibir formularios ya estaba implementado: NO se crea otro
  receptor. Crear una accion de conversion o validar el acceso de envio son
  operaciones distintas de recibir un formulario y de autorizar hitos del CRM.
- La apertura consulta todos los tipos de acciones para detectar conflictos,
  no solo UPLOAD_CLICKS. Pagina Google Search con la misma consulta y token;
  no acepta resultados parciales, ciclos o respuestas incompletas. Limites:
  20 paginas, 45 segundos totales, 10 segundos por llamada, sin reintentos
  interactivos. No se envia pageSize: Google fija paginas de 10.000 filas.
- Reutiliza solo nombres canonicos inequivocos. Duplicados, tipos incompatibles,
  propietarios distintos, estado no habilitado, acciones principales o recuento
  incompatible requieren revision. La validacion del servidor comprueba tambien
  propietario/tipo/categoria; no acepta un indicador ready del navegador.
- Preparar pide una confirmacion separada y crea SOLO los hitos que faltan como
  secundarios, sin normalizar acciones actuales ni tocar anuncios, pujas o
  presupuesto. Revalida scope, actor, conexion y todas las clinicas que usan la
  cuenta justo antes de crear. La autorizacion sobre una sola asignacion no
  permite cambiar una cuenta compartida con otras clinicas.
- Comprobar acceso reutiliza Data Manager con validateOnly y GCLID_1, sin PII
  ni ingestión de conversiones. Un resultado de otra cuenta/accion/evento no
  aparece como valido. La prueba visual no persiste una autorizacion. Tras una
  creacion incierta no se reintenta automaticamente: se exige consultar otra
  vez y cerrar invalida la preparacion anterior aunque el POST haya fallado.
- Incidencia detectada con Chromium: DEV sigue configurado en Google Ads v21,
  retirada por Google el 05/08/2026. La consulta real devolvia 404 HTML. El
  cliente compartido admite ahora una version explicita por operacion; las
  consultas, altas y normalizacion de conversiones usan v24. No se cambia .env,
  el endpoint configurado, los fallbacks o la version de los demas jobs. Las
  respuestas de error de consulta/validacion son JSON controlado, no el error
  Axios crudo. La nueva consulta de Arriaga devolvio 200 y 27 acciones.
- Pendiente imprescindible antes de cerrar TODA la integracion: migrar y probar
  los demas consumidores Google Ads que aun usan v21. No se ha acreditado que
  OAuth/discovery, inventario, informes o ejecucion general funcionen sobre esa
  version retirada. Tambien faltan prueba persistente de destinos, autorizacion
  por cuenta/evento, emisores completos y tratamiento UX de acciones actuales
  incompatibles. El gate de activacion permanece cerrado y la ruta es temporal.
- Contratos primarios: [paginacion Search](https://developers.google.com/google-ads/api/docs/reporting/paging),
  [ConversionAction v24](https://developers.google.com/google-ads/api/reference/rpc/v24/ConversionAction),
  [retirada v21](https://ads-developers.googleblog.com/2026/06/google-ads-api-v21-sunset-reminder.html)
  y [versiones disponibles](https://developers.google.com/google-ads/api/docs/sunset-dates).
- Verificacion: 303 pruebas principales backend y cuatro suites adicionales
  Google correctas; 46 pruebas frontend. Compilacion Angular DEV publicada
  `45b80fe8e47463cd`, 10/09/2026 17:13:55 UTC, con el aviso previo de bundle
  inicial 4.58 MB frente a 3 MB. Solo se reinicio `pm2-back-dev`; staging,
  gateway y preview mantienen sus procesos. Sin migraciones ni cambios en .env.
- Chromium autenticado: dialogo 26 comprobaciones y 9 capturas; workspace real
  58 y 25, en 1440/1024/390 px. Cero errores JS y cero escrituras reales de
  negocio. La consulta Google real devuelve 27 acciones (200 en el primer pase,
  304 con ETag revalidado despues). Los dos POST de creacion y cuatro de validacion
  son fixtures interceptadas en el navegador: NO se crearon acciones de clientes
  ni se llamo a Data Manager real. La seleccion/borrador del escenario tambien
  se simula solo en GET; SQL confirma cero filas preferences pobladas.
- Evidencias: `/home/ubuntu/qa-evidence/campaign-google-conversions-20260910-complete`
  y `campaign-workspace-google-conversions-20260910`. Revisadas manualmente las
  capturas de conversiones, confirmacion, reautorizacion, Salud y grafica movil.
  Los intentos previos se conservan: error real v21, espera del reinicio DEV,
  area tactil MDC y 304 correctamente tratado como revalidacion, no error.

## Google Ads v24 Y Descubrimiento De Cuentas

- El cliente compartido usa v24 por defecto y DEV fija esa version en su .env.
  Las consultas de inventario, resultados y servicios existentes ya no apuntan
  por defecto a v21. La configuracion explicita de endpoint/base URL se conserva.
  `GOOGLE_ADS_API_VERSION_FALLBACKS` deja de utilizarse: una llamada no se repite
  contra otra version, el prefijo historico /googleads/ ni otro metodo HTTP.
  Tampoco sigue redirecciones con credenciales. El script operativo de discovery
  reutiliza la misma resolucion de URL; no se ha ejecutado ese script.
- El selector pide `GET /oauth/google/ads/accounts?view=selection` con el scope
  de clinica/grupo. Conserva autenticacion, ACL de inventario y grant existentes.
  Solo lee identidades/nombres/moneda/tipo: no consultas de manager_link por cada
  cuenta ni mappings de otras clinicas. La vista administrativa completa conserva
  su contrato. No crea cuentas, invitaciones, assignments ni campañas al abrir.
- CustomerClient incluye descendientes directos e indirectos. Se consulta una
  vez por jerarquia accesible, con paginacion, deduplicacion y validacion de IDs.
  Limites interactivos: 40 segundos en total, hasta 8 segundos por llamada,
  100 peticiones, 20 paginas por Search y 5.000 cuentas. Ciclos, identidades
  incompatibles, respuestas parciales, timeout o errores de permisos no devuelven
  una lista supuestamente completa. No se inicia un job por abrir el selector.
- Chromium encontro CUSTOMER_NOT_ENABLED en una cuenta incluida por Google en
  listAccessibleCustomers. Se excluye SOLO ese rechazo explicito y las cuentas
  CLOSED/CANCELED de la jerarquia, indicando unavailableAccountCount. No se
  confunden USER_PERMISSION_DENIED, permisos del developer token o caidas con
  cuentas inactivas. La lectura real posterior devolvio 37 cuentas accesibles y
  19 no habilitadas en 5,27 s; sin cambiar mappings de clientes.
- Una caida temporal conserva el paso y seleccion actuales. Reintentar repite
  discovery, no recarga destructivamente el borrador ni inicia OAuth. Tokens
  caducados o permisos insuficientes si abren la autorizacion existente.
  Mas de seis cuentas habilitan busqueda local por nombre/numero, sin peticiones
  adicionales. Se aceptan acentos y numeros con guiones; al cambiar la busqueda
  se limpia la eleccion pendiente para no conectar una cuenta que quedo oculta.
- El cron leader de DEV permanece false y la auditoria previa no encontro jobs
  Google/campaign pendientes o activos del namespace dev. No se ha lanzado sync,
  backfill, ejecucion de campañas, creacion de conversiones ni ingesta de pacientes
  para la QA. Las escrituras de transporte se prueban con proveedores simulados.
  Los contadores de uso y renovacion de credenciales conservan su funcionamiento.
- Staging, gateway y sus .env no cambian; staging sigue configurado en v21 y
  necesita una promocion/migracion propia. Solo se reinicia backend DEV.
  Este cambio NO completa los contratos de activacion, prueba persistente de
  destinos, autorizacion de hitos, emisores, Optimiza ni integracion canonica.
  Tampoco acredita una ejecucion real end-to-end de todos los jobs/mutaciones.
- Fuentes primarias: [CustomerClient v24](https://developers.google.com/google-ads/api/reference/rpc/v24/CustomerClient),
  [notas de version](https://developers.google.com/google-ads/api/docs/release-notes),
  [retirada v21](https://ads-developers.googleblog.com/2026/06/google-ads-api-v21-sunset-reminder.html).
- Verificacion: 311 pruebas backend principales, ocho suites de regresion
  Google/OAuth y 48 pruebas frontend correctas. Build DEV `b1d43bdb8abd93e7`,
  10/09/2026 17:50:36 UTC, 140998 ms; aviso previo de bundle 4.58 MB frente a 3 MB.
  Chromium autenticado: 71 comprobaciones y 29 capturas en 1440/1024/390 px,
  sin errores JS ni escrituras de negocio. Las dos lecturas reales de cuentas
  tardan 5,01 y 4,64 s (304 con cuerpo revalidado). Solo el error transitorio
  de connection-status se simula mediante un GET interceptado; no hay POST
  ni asignaciones reales en esta prueba. Se comprueban filtro, cuenta elegida,
  limpieza de seleccion oculta, reintento y regresion de navegacion/graficas.
  Evidencia: `/home/ubuntu/qa-evidence/campaign-workspace-google-v24-20260910-search`.
  Se conservan los pases anteriores, incluido el rechazo CUSTOMER_NOT_ENABLED.
  Las capturas del selector, busqueda movil y Salud se revisaron manualmente.
- Regresion Chromium de conversiones sobre el mismo build: 26 comprobaciones,
  nueve capturas, cero errores JS y cero escrituras reales. Consulta Google real;
  seleccion/borrador, altas y validaciones del escenario interceptadas por el
  navegador, sin crear conversiones ni enviar pacientes. Evidencia:
  `/home/ubuntu/qa-evidence/campaign-google-conversions-v24-20260910`.

## Comprobacion Google persistente (2026-09-10)

- `GET /marketing/campaign-workspace/google-preparation` lee la comprobacion
  del ambito/cuenta; `POST .../google-preparation/check` acepta solamente
  `account_id` y `expected_version`. Los hitos proceden del borrador guardado,
  no del navegador. Solo lead/contact/qualified_lead/schedule, nunca Purchase
  por la presencia del KPI de presupuestos aceptados.
- Ambos endpoints requieren sesion y acceso al ambito completo. La escritura
  exige permiso write, cuenta seleccionada, mapping activo y assignment activo
  del mismo grant Google, con scopes Ads y Data Manager. Grants o MCC ambiguos
  no seleccionan el primero. Se revalidan membresias, ACL, contexto y run ID
  antes de persistir el resultado de una consulta remota.
- JSON nullable `CampaignWorkspaceSettings.signal_preparation`, version de
  esquema 1. Migracion individual `20260910200000-add-campaign-workspace-signal-preparation.js`,
  aditiva e idempotente, aplicada y registrada sobre la BD compartida. No se
  ejecutan otras migraciones ni se rellenan configuraciones de clientes para QA.
  El down exige archivo explicito si existen comprobaciones guardadas.
- Se guarda un marcador `checking` en una transaccion corta antes de llamar
  al proveedor. Una segunda transaccion publica el resultado; cada una aumenta
  la version y audita actor/cuenta/hitos/estado, sin tokens ni pacientes.
  No se mantienen bloqueos SQL durante las peticiones externas. Un fallo o
  interrupcion nunca conserva el verde anterior. El marcador vence a los dos
  minutos; un resultado tardio no pisa un nuevo intento o una configuracion nueva.
- Validez de 24 h, con huella de owner, miembros, cuentas/campañas seleccionadas,
  preferencias, mappings, assignment conectado y scopes del grant. La rotacion
  ordinaria del access token no invalida la prueba. Cambiar cuentas/preferencias
  borra la evidencia, incluso si mas tarde se vuelve a la seleccion anterior.
  Expirar invalida al leer; no es necesario un job nocturno por comprobacion.
  El registro actual queda acotado por la seleccion y el historial en auditoria.
- Reutiliza el listado Google paginado y la inspeccion de acciones canonicas:
  propietario, categoria, UPLOAD_CLICKS, ENABLED, MANY_PER_CLICK y secundaria.
  La prueba Data Manager utiliza validateOnly y GCLID_1, sin datos de pacientes,
  eventos ingeridos ni cambios en pujas. Presupuesto interactivo de 55 s,
  hasta 15 s de inventario y 8 s por validacion; UI espera hasta 65 s.
  Un cuerpo vacio JSON puede ser correcto; avisos, errores, campos inesperados,
  HTML o respuestas no JSON no confirman la validacion. No sigue redirecciones.
  Referencia: [events.ingest](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest).
- El dialogo recupera el resultado guardado y comprueba tambien la accion
  actual antes de mostrar verde. Mantiene el detalle tecnico plegado, muestra
  fecha/caducidad/avisos y conserva el paso al cerrar. Refresca la version local
  de configuracion para no guardar despues con una version anterior.
- Esta prueba no es consentimiento ni permiso comercial, no acredita la
  autorizacion documentada de conversiones mejoradas de una clinica y NO
  habilita ningun emisor. Antes de activar se deberan revalidar acciones/grants
  y guardar el mandato por cuenta/hito. Gate de activacion permanece cerrado.
  La recepcion existente de formularios, señales actuales y los jobs no cambian.
- Verificacion de este tramo: 327 pruebas backend principales, ocho suites
  Google/OAuth adicionales y 49 frontend. Lectura real del contexto Google de
  Arriaga (dos clinicas, mapping/assignment/grant), sustituyendo solo en memoria
  la seleccion aun no guardada: sin escritura ni llamada a Google. SQL posterior:
  cero settings, borradores y pruebas de clientes poblados.
- Build DEV `d5da323ba434b8f3`, 10/09/2026 18:30:19 UTC, 145357 ms. Mantiene
  el aviso previo de bundle inicial 4.58 MB frente a 3 MB. Chromium autenticado:
  44 comprobaciones y 11 capturas del dialogo, cero errores JS/escrituras reales.
  Listado real de 27 acciones Google; borrador, persistencia, alta y validacion
  del escenario interceptados en navegador. No acredita una ingesta real ni
  una autorizacion de hitos de un cliente. Evidencia:
  `/home/ubuntu/qa-evidence/campaign-google-proof-20260910-verified`.
- QA detecto un aviso operativo real sobre el modal movil. Los dialogos de este
  workspace quedan por encima sin marcarlo como atendido; el aviso sigue pendiente
  al cerrar. Tambien se conserva una edicion local ante respuestas tardias de
  preparacion. Pruebas de hit target y de respuesta retrasada incluidas.
  Se conserva el pase fallido `campaign-google-proof-20260910-final`.
- Reiniciado solo DEV (PID 1161535, contador 8529). Staging, gateway y proceso
  preview no reiniciados. No promocion ni cambios publicitarios o de cobro.
  La implementacion completa continua EN CURSO; no cambiar aun la ruta canonica.
- Regresion general sobre el mismo build: 71 comprobaciones y 29 capturas en
  1440/1024/390 px, con APIs reales de inventario, informe, Salud y preparacion.
  Sin errores JS, errores de servidor en el workspace ni escrituras de negocio.
  Revisadas manualmente Salud desktop y grafica movil a ras, ademas del dialogo.
  Evidencia: `/home/ubuntu/qa-evidence/campaign-workspace-google-proof-20260910`.
## Entregas Meta Del Workspace (2026-09-10)

La recepcion de formularios existente se conserva. Esta ampliacion registra la
entrega posterior de un evento autorizado; no constituye otro receptor de leads
ni completa todavia todos los emisores CRM del objetivo.

- `MetaSignalDeliveries`: tabla aditiva, migracion individual
  `20260910210000-create-meta-signal-deliveries.js`, aplicada y registrada en la
  BD compartida sin poblar configuraciones ni eventos de clientes. Incluye
  identidad acotada, clave de deduplicacion, versiones de todas las politicas,
  destino/grant, lease y respuesta resumida. No almacena payload, token, email,
  telefono, IP, URL, valor economico, nombre de clinica o tratamiento. Las claves
  de evento son hashes de identificadores, no datos anonimos. No borrar una
  tabla poblada mediante rollback sin archivo explicito.
- La rama nueva de `metaCapi.service` usa `metaWorkspaceSignalDelivery` y el
  cliente Meta compartido. Mantiene el contrato anterior de las instalaciones
  no migradas. Los eventos web independientes como ViewContent siguen fuera
  de esta migracion y no se presentan como entregas CRM comprobadas.
- Antes de reservar y antes de enviar se recargan clinica, configuraciones,
  asignacion OAuth, cuenta y credencial. Una web de grupo requiere una sede
  explicitamente incluida en `locations`. El destino debe estar definido en la
  configuracion del anunciante; no se admite disfrazar el pixel/token global ni
  completar una configuracion parcial con otro anunciante. Se preserva la
  version de cada autorizacion web/grupo, no solamente la ultima consultada.
- Consentimiento publicitario expreso por evento, seleccion vigente, activacion
  y hito autorizado siguen siendo requisitos separados. QualifiedLead/Schedule
  requieren la capacidad privada del CRM: un JSON publico no puede generarla.
  El contrato admite el identificador nativo verificado internamente; el job de
  ciclo de vida descrito debajo ya usa esa llamada, sin activar clientes.
- Payload nuevo de lista cerrada: datos de matching hashed, sin metadatos
  clinicos/economicos arbitrarios. Los hitos CRM no llevan URL ni datos del
  navegador. Los eventos web conservan solo el origen HTTPS y el agente del
  navegador, eliminando ruta y parametros; no se registran esos campos en la
  tabla. El seguimiento propio no cambia. Esto es minimizacion tecnica, no una
  certificacion de elegibilidad de una clinica/categoria ante Meta.
- `accepted` significa `events_received: 1`, nunca conversion atribuida. Los
  avisos son `warning`; rechazo, timeout/respuesta desconocida, proceso en curso
  y cancelacion permanecen diferenciados. Mensajes crudos del proveedor se
  descartan tambien en la telemetria del cliente CAPI.
- Reserva transaccional corta antes del POST, lease de 90 s y timeout HTTP de
  8 s. No bloquea SQL durante la red. Actualizacion final condicionada por lease.
  Una entrega confirmada no se repite; colisiones de campana, fecha o destino
  no cambian silenciosamente el evento. Una peticion repetida puede recuperar
  un lease vencido usando la identidad original, dentro de las 24 h siguientes
  a la primera reserva. Pasado ese limite interno no se repite un resultado
  ambiguo, tampoco al crear otro job o pedir un reintento manual. Una entrega
  confirmada mantiene su deduplicacion. El cliente comparte cuota y
  pausa persistente, rechaza redirecciones y no hace reintentos HTTP ocultos.
- La tabla sigue siendo registro de entrega, no la cola. El nuevo job
  `campaign_meta_crm_signal` descrito debajo reutiliza `JobRequest` para los
  hitos CRM nativos. El receptor de formularios conserva su propia cola. No hay
  un cron nocturno que envie estos hitos ni se debe confundir con el refresco
  diario de informes. Ese refresco no autoriza conversiones.
- Salud consulta registros de las ultimas 24 h, sin llamadas al proveedor ni
  escrituras. Solo cuenta la misma clinica/cuenta/campana/dataset y el grant y
  politicas vigentes. Expone recibidos, avisos y sin confirmar en el detalle
  existente. Una prueba de una campana no valida todo el grupo; sin entregas,
  con otro grant o historia truncada no muestra OK. Limite conservador de
  10000 registros por ambito; superar el limite conserva cobertura desconocida.
  Google sigue pendiente de conectar a su propia evidencia de entrega.

Referencias de contrato: [ServerEvent del SDK oficial](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/serverside/server-event.js),
[EventResponse](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/serverside/event-response.js)
y [ejemplo CRM oficial de Meta](https://github.com/facebook/Conversion-Leads-Salesforce-APEX).

La activacion de clientes permanece cerrada. Antes del cierre global siguen
pendientes las pruebas/autorizaciones ligadas a cada destino real, emisores y
jobs CRM completos (incluida atribucion Meta web), Optimiza Google/Meta,
configuracion independiente de paginas, metricas por anuncio y cambio de ruta
canonica. Este avance no reduce ese alcance ni habilita cobros/publicidad.

Verificacion backend: 360 pruebas de Campanas, conversiones Google y cliente
Meta correctas. Incluyen rechazo de permisos revocados, cambios de ambito y
version durante el envio, tokens/destinos globales, colisiones, lease perdido,
timeouts, respuestas ambiguas, privacidad del payload/telemetria y migracion
reentrante. Tras el QA de lectura, settings, pruebas y entregas nuevas siguen
a cero en la BD compartida. No se envio ningun evento publicitario real.

## Hitos CRM Meta En La Cola Existente (2026-09-10)

- `leadQualificationMilestone` usa ahora el dispatcher `leadLifecycleConversion`:
  encola Meta antes del upload Google sin modificar el payload ni las reglas
  anteriores de Google. Un fallo de un proveedor no impide intentar el otro ni
  deshace una cita/lead. Purchase conserva su carril Google anterior y no entra
  en Meta. No se modifica ninguno de los receptores de formularios.
- `campaign_meta_crm_signal`: job por evento, prioridad normal, ocho intentos,
  backoff/namespace/recuperacion del scheduler existente. No crea un cron ni
  modifica el catalogo de refresco nocturno. Guarda IDs locales, hito, fecha y
  una huella de identidad/destino/politicas; no guarda identificadores Meta,
  contactos, tokens, respuestas de formularios ni payload CAPI. La huella es
  seudonima, no anonima.
- Encolado requiere la capacidad interna del CRM, gate de despliegue abierto y
  autorizacion actual del workspace. El worker exige origen interno, tipo
  correcto y ausencia de solicitante HTTP; los jobs creados manualmente por el
  endpoint administrativo no fabrican hitos. Reintentar un job existente vuelve
  a comprobar todo. Con el gate actual cerrado no consulta leads ni crea jobs.
- Relee el lead y la identidad guardada por el receptor Meta: `meta_graph`,
  misma clinica, cuenta, campana, anuncio, pagina, formulario y lead nativo.
  Identidades ambiguas o datos aportados por formularios no sirven. Reutiliza el
  resolvedor de recepcion para validar acceso actual y asignacion de campana;
  una cuenta de grupo exige una asignacion explicita de clinica.
- QualifiedLead requiere cualificacion vigente o cita real enlazada. Schedule
  requiere la cita enlazada de la misma clinica, no cancelada ni provisional.
  Lead descartado/archivado/eliminado o movido cancela el envio. No selecciona
  nombre, email, telefono, notas, tratamiento ni precio: el matching nativo usa
  exclusivamente el identificador verificado de Meta.
- No interpreta consentimiento de contacto/WhatsApp/analitica como publicitario.
  Los formularios nativos recibidos sin consentimiento publicitario explicito
  siguen en el CRM, pero no generan este envio. La procedencia Meta por si sola
  no es consentimiento. No se rellena retroactivamente ningun permiso.
- Congela mediante huella la identidad, destino/grant y vector de versiones al
  encolar; no adopta la nueva cuenta/dataset/politica si cambian mientras espera.
  Revalida tambien el origen/consentimiento despues de reservar la entrega y
  antes del POST. Recibos aceptados/con aviso no se repiten; fallos temporales y
  429 reintentan, permisos/rechazos definitivos no. Errores se guardan saneados.
  Eventos fuera de siete dias se descartan. La ventana interna de reintento de
  entregas sin confirmar es 24 h desde la primera reserva, no se renueva con
  cada intento. No es una afirmacion de deduplicacion indefinida del proveedor.
- **Limites pendientes antes de abrir activacion:** vincular prueba tecnica y
  autorizacion completa por destino, cubrir atribucion Meta web y configuracion
  nativa independiente de la web. El guardado atomico de los escritores CRM
  existentes queda implementado en el apartado siguiente. Esto no convierte
  los emisores anteriores de Google o entradas futuras en outbox automaticamente
  ni autoriza un barrido retroactivo de clientes.

Pruebas nuevas ejecutan el recorrido real de resolucion, politica, emisor y
registro con modelos/proveedor aislados: identidad nativa, grupos, cambios de
destino, consentimiento retirado durante reserva, duplicados, reintentos,
limite de 24 h, citas canceladas/provisionales y aislamiento de Google. No se
realiza ningun POST publicitario real. El objetivo global sigue EN CURSO.

Verificacion del corte: 387 pruebas backend correctas (23 nuevas del job,
ademas de la regresion de Campanas, receptores, Google y ciclo de vida).
Chromium autenticado tras reiniciar solo DEV: 71 comprobaciones, 29 capturas,
cero errores JS/servidor y cero escrituras de negocio. Lecturas reales de
informes/conexiones; solo el caso de caida temporal Google sustituye su GET.
Evidencia: `/home/ubuntu/qa-evidence/campaign-meta-crm-20260910-final`.
Inspeccion manual de Salud desktop, dialogo movil y grafica movil con tooltip.
Auditoria SQL antes/despues: gate cerrado, settings=0, entregas=0 y jobs de este
tipo=0. Sin migraciones, cambios de configuracion, cobros ni promocion a staging.

## Guardado Atomico Del Hito Y Job Meta (2026-09-10)

- `leadCrmSignalPersistence` guarda los hitos Meta en la misma transaccion que
  cualifica el lead o enlaza su cita. Los puntos existentes cubiertos son
  `updateLeadStatus`, `resolveLeadNotice`, `saveCallOutcome` y `createCita`.
  La creacion integra el callback dentro de la transaccion ya existente de
  cita/idioma y tambien de la nueva reserva por perfiles, sin ejecutar red.
- Un error de persistencia/BD durante el encolado aborta toda la unidad; no se
  devuelve silenciosamente `queued:false` dejando un hito sin job. La ausencia
  de consentimiento, seleccion o autorizacion es distinta: se guarda el CRM
  sin enviar señales. Con el gate cerrado o para otros origenes se conserva la
  ruta de persistencia anterior, sin abrir nuevas transacciones de marketing.
- Los resolvedores de identidad, configuracion, acceso y politica reciben la
  misma transaccion; ven el cambio CRM aun no confirmado, no otro snapshot del
  pool. JobRequest hereda esa transaccion, sin una transaccion anidada. Se
  bloquean y revalidan cita/lead antes de enlazar: otro propietario, otra sede
  o una cita ya cancelada produce conflicto, no una reasignacion silenciosa.
- Los resultados se recuerdan en memoria solo tras commit mediante una clave
  privada en el objeto del lead. El dispatcher posterior reutiliza ese resultado
  sin volver a encolar. Si hay rollback no se publica la marca. Google mantiene
  su emision existente fuera de la transaccion; consentimientos, automatizaciones
  y sockets tambien permanecen fuera. No se cambia el receptor de formularios.
- Los otros escritores de citas auditados (importacion historica de reactivacion
  y sesiones de bonos) no asignan `lead_intake_id` ni emitian estos hitos; no se
  convierten en fuentes publicitarias. Una futura entrada CRM debe usar este
  contrato, no escribir una cita y confiar en un hook posterior no durable.
- Prueba SQL opt-in `CC_QA_MYSQL_ATOMIC=true node -r dotenv/config
  src/scripts/tests/crm_signal_atomic_mysql_qa.js`: tres tablas TEMPORARY de
  sesion, clones de esquema sin datos de clientes. Usa los modelos de persistencia
  y `enqueueUniqueJobRequest` reales; el resolvedor publicitario es un fixture y
  no llama a Meta. Verifica commit, rollback del segundo job, deduplicacion y
  rollback de creacion de cita. DROP TEMPORARY y cierre de la conexion al salir.
  Ningun worker puede ver esas tablas o jobs; no crea tablas permanentes.
- La prueba unitaria del resolvedor comprueba que todas sus lecturas y el alta
  del job usan la transaccion suministrada. La bateria de comandos incluye
  consentimiento denegado, ambito cambiado, doble cualificacion, fallo de commit,
  conservacion de la campana existente y rollback de idioma/cita.

La activacion sigue cerrada. No promocionar ni habilitar señales porque este
contrato este completo: faltan las autorizaciones por destino y el resto de la
integracion descrito arriba. El objetivo global permanece EN CURSO.

Verificacion final: 442 pruebas backend correctas, sin fallos ni omitidas;
cuatro comprobaciones MySQL sobre tres tablas temporales de sesion. Chromium
autenticado tras el ultimo reinicio exclusivo de DEV: 71 comprobaciones,
29 capturas a 1440/1024/390, cero errores JS/servidor y cero escrituras de
negocio. Lecturas reales salvo el GET de caida temporal Google simulado.
Evidencia: `/home/ubuntu/qa-evidence/campaign-meta-atomic-20260910-final`.
Dialogo de Salud y grafica/tooltip movil inspeccionados manualmente. Los avisos
operativos reales siguen pendientes; no se cierran ni se marcan atendidos.
Frontend sin cambios de UI/build (`f47f72d30ee68e28`). DEV PID `1173603`,
reinicios `8535`; staging/gateway/preview mantienen PID. Auditoria SQL antes y
despues: gate cerrado, settings=0, entregas=0, jobs CRM Meta=0. Sin migraciones,
llamadas publicitarias, cobros ni promocion de codigo a staging.

## Entregas Google En Salud (2026-09-10)

- Se reutiliza `GoogleAdsConversionUploadAttempts`, sin otra tabla o cola.
  El emisor anade a los nuevos intentos autorizados del workspace una referencia
  de campana y una huella del contexto efectivo: configuracion web/publicitaria,
  todas las versiones de politica, mapping, grant y cuenta de acceso. No guarda
  tokens, contactos ni propiedades clinicas en esa referencia; tampoco la envia
  a Google. Rotar un access token no invalida una entrega, cambiar el grant si.
- El informe consulta las ultimas 24 h por clinica/cuenta y limita la lectura a
  10.000 filas. Un resultado truncado, una campana sin asignar o un historial sin
  referencia verificable no produce OK. No se reconstruye la campana de un
  intento antiguo a partir del nombre, del total de la cuenta o de otro lead.
- Antes de contar, relee configuracion efectiva, accion/destino por evento,
  cuenta/grant, asignacion activa y autorizaciones actuales. La configuracion
  de grupo solo cubre las sedes explicitas. Una reconexion posterior al intento,
  una revocacion, cambio de conversion, clinica o version invalida esa evidencia.
  No cambia ni sustituye los gates de emision; su integracion completa con la
  prueba tecnica por destino sigue pendiente y la activacion permanece cerrada.
- `accepted` significa recibido pero aun procesandose; no se cuenta como
  procesado sin avisos. Un terminal exige requestId y diagnostico de la misma
  cuenta/accion para el unico evento enviado por ese intento. Se distinguen
  procesamiento correcto, avisos/parcial, rechazo y falta de confirmacion.
  Incluso SUCCESS puede contener avisos, segun la
  [referencia oficial de Diagnostics](https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve).
  Ningun estado confirma atribucion o incremento de conversiones en Ads.
- Salud conserva seis bloques y su unico detalle. Suma recibidos por proveedor,
  procesados sin avisos/procesando en Google y avisos/sin confirmar, sin prestar
  el estado entre campanas o inventar cobertura donde faltan datos. `0 de 0`
  tampoco lleva el indicador verde de una comprobacion real.
- El job `googleDataManagerDiagnostics` existente sigue reconciliando los
  estados; no se crea otro cron ni se altera su horario. El GET de Salud es
  `private, no-store`, usa registros persistentes y no consulta al proveedor,
  refresca tokens ni escribe diagnosticos. La ventana de entregas de 24 h es
  independiente del periodo de resultados seleccionado y del refresco nocturno.

Pruebas: emisor real con transporte aislado, resolvedor scoped Google real con
modelos aislados, herencia web/anunciante con dos politicas, multiples destinos,
revocacion/reconexion, ausencia de historial, limite de filas y diagnosticos
incompletos. Arriaga no tiene inventario Google visible en el scope de grupo
actual; la lectura MySQL valida ademas el SQL/atributos con una cuenta inexistente
y cero filas. No se presenta esa lectura como una entrega real a Google.

Verificacion: 459 pruebas backend correctas, sin fallos ni omitidas. Incluye
el recorrido emisor -> intento -> reconciliador Diagnostics -> Salud, con
modelos/transporte aislados, y retirada posterior de autorizacion. Chromium:
71 comprobaciones generales con lecturas reales y 29 capturas en
`/home/ubuntu/qa-evidence/campaign-google-delivery-20260910-real-final`;
33 adicionales y nueve capturas de Salud Google/Meta en
`/home/ubuntu/qa-evidence/campaign-google-delivery-20260910-complete`.
Este segundo recorrido parte de sesion/GET real y sustituye solo el GET del
informe con casos de entregas; no crea recibos o configuraciones de clientes.
Inspeccion manual del detalle desktop/movil y del scroll hacia Google. El
regreso desde campañas de ambos proveedores conserva Salud como origen.
Cero errores JS/servidor y cero escrituras de negocio; el caso de caida temporal
Google de la regresion general tambien es un GET simulado. El primer intento
general en `...-real` termino con 143 tras las comprobaciones; no se usa como
evidencia de aprobacion, se repitio y termino correctamente en `...-real-final`.

Solo reinicios backend DEV, PID final `1176755`, reinicios `8538`. Frontend
sin cambios de UI/build (`f47f72d30ee68e28`); staging/gateway/preview conservan
PID. Auditoria SQL antes/despues: gate cerrado, settings=0, entregas Meta=0 y
jobs CRM Meta=0. Sin migraciones, emisiones publicitarias, cobros ni promocion.
El objetivo completo sigue EN CURSO: este lector no completa la autorizacion
por destino, Meta web, Optimiza Google/Meta ni el cambio de ruta canonica.

## Preparacion Del Destino Meta Por Cuenta (2026-09-10)

`campaignWorkspaceMetaSignalPreparation.service` prepara el destino de las
senales sin utilizar `IntakeConfig`, una instalacion web o el perfil social.
Reutiliza las cuentas seleccionadas, `ClinicMetaAsset`, el grant scoped actual
y la columna JSON `CampaignWorkspaceSettings.signal_preparation`. No crea otro
receptor de formularios, tabla, migracion, cron ni job.

- GET `campaign-workspace/meta-signals?scope=...&account_id=...`: ACL de lectura,
  configuracion guardada e inventario actual de destinos. Solo se consulta al
  abrir/actualizar este dialogo, nunca desde Salud o desde una carga del informe.
- POST `campaign-workspace/meta-signals/check`: ACL de escritura, cuerpo cerrado
  `{ account_id, dataset_id, expected_version }`. Los hitos proceden exclusivamente
  de las preferencias guardadas. No acepta scopes, eventos o permisos del cliente.
- La comprobacion lee `me/permissions`, la identidad `act_<id>` y la lista
  `act_<id>/adspixels`. Exige `ads_management` concedido e inventario completo.
  Pagina con cursor sobre el endpoint original; no sigue URLs `next`. Maximo
  cinco paginas de destinos y tres de permisos, presupuesto temporal 40 s,
  timeout por peticion <= 8 s y sin reintentos. Usa cliente/cuotas/pausa comunes
  y logging sensible para no registrar respuestas crudas o credenciales.
- No escribe en Meta, no crea pixels, no modifica anuncios, no suscribe paginas,
  no emite eventos reales/de prueba ni cambia `activation`. Un destino accesible
  NO demuestra que CAPI vaya a aceptar un evento. Por eso el resultado es
  `access_verified`, no `delivered`, ni una autorizacion de envio.
- Antes de consultar persiste `checking` con version y auditoria dentro de una
  transaccion. Retira la prueba verde anterior inmediatamente. Al finalizar
  relee ACL, miembros del grupo, seleccion, mapping/grant y huella, bloqueando el
  resultado tardio si cambian. Guarda exito o fallo sanitizado con otra version
  y auditoria atomica. El fallo de persistencia revierte esa transaccion.
- Una prueba comprobada caduca exactamente en 24 h; `checking` tiene lease
  de dos minutos. Seleccion, preferencias o reconexion invalidan la huella;
  una rotacion rutinaria del token no. Fechas futuras, formatos inesperados,
  inventario truncado o destino desaparecido nunca se presentan como OK.
  Se preservan las pruebas de otras cuentas y las de Google. Las respuestas son
  `private, no-store`; el navegador no persiste pruebas ni tokens adicionales.
- El dialogo FUSE muestra un selector y el estado. Preselecciona el destino
  guardado si sigue disponible, o el unico destino existente; con varios sin
  seleccion guardada exige elegir. Los hitos/ID quedan en detalle desplegable.
  Guardar requiere clic explicito; error o resultado incierto nunca se reintenta
  automaticamente. Cerrar/reabrir y recargar consultan la evidencia de servidor.

Este paso prepara la futura autorizacion por destino; NO completa esa autorizacion
ni habilita el gate. La recepcion de formularios ya existente se mantiene intacta.

Verificacion: 288 pruebas backend (12 nuevas especificas) y 21 frontend, sin
fallos ni omitidas. Incluye reapertura, inventario paginado/incompleto, errores
sanitizados, CAS, rollback de prueba/auditoria, revocacion y cambios de grupo/grant.
Chromium autenticado: 45 comprobaciones y 11 capturas finales en
`/home/ubuntu/qa-evidence/campaign-meta-preparation-20260910-layout`, a
1440x1080, 390x844, 320x667 y 844x390. Se corrigio el pie recortado en horizontal;
cabecera/acciones quedan fijas y el contenido se desplaza con la rueda real.
Inspeccion manual desktop, movil estrecho y horizontal con scroll. El intento
previo `...-verified` detecto ese fallo y no es evidencia de aprobacion.
Sesion y workspace/configuracion base reales; el endpoint real rechaza la cuenta
no seleccionada. El borrador, inventario Meta y sus cinco comandos son fixtures
interceptados: no prueba un acceso CAPI real ni escribe ajustes de clientes.
Regresion general adicional: 71 comprobaciones y 29 capturas en `...-regression`,
sin cambios en los avisos operativos persistentes. Cero escrituras de negocio y
cero errores JS en ambos recorridos. El login se renovo tras caducar la sesion.

Build final `1ab3968657134dce`, sincronizado con el preview 4203; persiste el aviso
previo de presupuesto del bundle inicial (4,58 MB frente a 3 MB). Un reinicio
solo de backend DEV, PID `1178732`, contador `8539`; staging/gateway/preview
conservan PID. Auditoria SQL antes/despues: gate cerrado, settings=0,
entregas Meta=0, jobs CRM Meta=0. Sin migraciones, emisiones, cobros o promocion.
El objetivo global sigue EN CURSO: autorizacion completa y consumo por emisores,
Meta web/configuracion nativa, Optimiza de ambos proveedores, metricas por anuncio
y ruta canonica siguen pendientes. No habilitar señales por esta preparacion.

## Revision De Senales Y Contrato Por Destino (2026-09-10)

`campaignWorkspaceSignalAuthorization.service` enlaza las pruebas tecnicas
Google/Meta con los destinos que podra autorizar el usuario. La preparacion
expone `signals.accounts`: estado por cuenta seleccionada, caducidad, hitos y
destinos. Es una lectura local `private, no-store`: no consulta al proveedor,
refresca tokens, emite eventos o escribe autorizaciones. La revision completa
incluye ese resultado en su huella para invalidar una confirmacion antigua.

- Todas las cuentas e hitos seleccionados necesitan una prueba completa,
  sin avisos, de la configuracion y grant actuales, con TTL exacto de 24 h.
  Una prueba parcial, caducada, futura, fallida o en curso no autoriza nada.
- Se separa la huella del grant de la huella del borrador. Preferencias o
  seleccion invalidan la prueba que se va a confirmar, pero editar un borrador
  no cambia silenciosamente los destinos de una autorizacion ya concedida.
  El nuevo formato invalida pruebas guardadas con la huella anterior; no hay
  configuraciones de clientes que migrar en esta verificacion.
- El contrato privado contiene clinicas, cuenta, conexion y login Google,
  huella del grant, referencia de la prueba e IDs de destinos por hito.
  No contiene tokens ni contactos. `publicSettings` no publica ese contrato;
  la UI solo recibe el resumen de revision.
- La politica entiende autorizaciones schema 2 y exige destino exacto por
  cuenta/hito, clinica activa en el ambito y el mismo grant actual. La accion
  Google incluye el customer y el action ID; Meta exige el dataset ID exacto.
  Seleccion y autorizacion originales siguen acotando las campañas permitidas.
- Google y Meta vuelven a leer la autorizacion despues de resolver conexion
  y reservar el intento, inmediatamente antes del transporte. Una revocacion
  o cambio deja el intento omitido, no pendiente ni enviado. Salud comprueba
  tambien destino/conexion actuales; Google separa su cache local por accion.
- El vencimiento de la prueba tecnica inicial no revoca por si mismo una
  autorizacion concedida. La conexion vigente, la seleccion y la revocacion
  explicita siguen comprobadas en cada envio; no hay cache de permisos.

La revision FUSE muestra una fila por cuenta, con «Hitos y destinos» desplegable
y acceso al dialogo existente. Cerrar el dialogo vuelve al mismo paso. El reloj
de la UI retira el OK cuando vence la prueba, incluso sin recargar. No añade
pestañas ni vuelve a crear la recepcion de formularios.

**Limite de este cambio:** el servicio construye el futuro contrato y los
emisores ya verifican su version 2, pero la activacion real todavia NO lo
persiste. El activador rechaza señales y mantiene cerrado el gate de despliegue.
Las pruebas montan esa autorizacion explicitamente en modelos aislados, nunca
en clientes. Schema 1 conserva compatibilidad con los consumidores anteriores;
ninguna API permite crear ahora una autorizacion schema 1 con señales activas.
Antes de habilitar clientes deben completarse la persistencia atomica del
mandato, el enrutado por destino y la configuracion Meta nativa/web, retirando
esa compatibilidad del nuevo recorrido. Optimiza de ambos proveedores y el
cambio de ruta canonica siguen pendientes. El objetivo completo NO esta cerrado.

Verificacion backend: 304 pruebas correctas, sin fallos ni omitidas, incluidas
las regresiones del emisor Google, Data Manager y los hitos CRM. Los casos nuevos
usan las preparaciones reales con modelos/transporte aislados: destino distinto,
clinica desactivada, grant cambiado, revocacion durante reserva, borrador editado,
prueba caducada y contrato privado no publicado. Sintaxis y `git diff --check` OK.
Un reinicio solo de DEV, PID `1182884`, contador `8540`; staging, gateway y
preview conservan PID. SQL antes/despues: gate cerrado, settings=0, entregas
Meta=0 y jobs CRM Meta=0. Sin migracion, nueva tarea nocturna, envio o cobro.

## Hitos Nativos Sin Dependencia De La Web (2026-09-10)

`campaignWorkspaceSignalRouting.service` resuelve cuenta, destino y grant desde
el mandato schema 2, no desde los widgets ni el pixel de una instalacion web.
Reutiliza el verificador de destinos y la seleccion original/actual. El contrato
sirve para Google y Meta; en este cambio se conecta al ejecutor nativo Meta de
`QualifiedLead` y `Schedule`. El enrutado de los emisores Google y Meta web debe
completarse antes de habilitar la activacion con señales.

- La clinica debe seguir activa. Si hay mandatos de clinica y grupo, ambos
  limitan el permiso; deben coincidir en destino y conexion. Una mezcla de
  schema 1 y 2 exige migracion, no una eleccion automatica del permiso mas amplio.
  Schema 2 incompleto, revocado o incompatible no cae en el pixel antiguo de
  la web. Si no hay mandatos schema 2 se conserva el recorrido anterior.
- El job existente `campaign_meta_crm_signal` mantiene los controles de lead,
  consentimiento publicitario, cita/cualificacion actuales, identidad verificada
  por Meta y asignacion actual de pagina/cuenta/campaña. Despues resuelve el
  destino autorizado. No necesita `IntakeConfig`, dominios, `locations`, CMP
  web ni un perfil social para emitir esos hitos nativos.
- El emisor repite la resolucion despues de reservar la entrega. Conserva
  deduplicacion, lease, ventana de reintento y el registro de recibos. El token
  procede de la conexion actual; una rotacion normal no duplica el evento.
  Un cambio de grant o revocacion corta el envio, incluso tras la reserva.
- Solo la capacidad interna del CRM y un identificador nativo verificado
  habilitan esta via. No convierte eventos web `Lead`, `Contact` o `ViewContent`
  en hitos nativos ni permite que el navegador evite la preparacion web. No
  añade otro receptor ni emite al recibir el webhook de formulario.
- Salud coteja cuenta, campaña, destino, grant y versiones con las entregas
  persistidas. Puede mostrar estos recibos aunque no exista configuracion web.
  No acredita otra campaña con la misma conexion, ni conserva el OK tras una
  revocacion. Recibido por Meta sigue sin significar atribuido como conversion.
- Las lecturas de ambito/grant se reutilizan solo dentro de una consulta de
  Salud para evitar repetir SQL por cada recibo. La seleccion por campaña se
  evalua siempre. No es una cache persistente de permisos ni la utiliza el
  emisor: la siguiente consulta/envio vuelve a leer los datos actuales.

No se crea tabla, migracion, cron o job nuevo, ni se cambia el horario del job
existente. Las autorizaciones schema 2 de las pruebas siguen siendo fixtures
aislados; el activador real permanece cerrado. Este avance no completa la
activacion atomica, Meta web, el enrutado Google, Optimiza, multipagina,
metricas CRM por anuncio o la sustitucion de la ruta canonica.

Verificacion: 356 pruebas backend correctas, sin fallos ni omitidas. Incluyen
preparacion real con proveedor aislado -> mandato de prueba -> job -> emisor ->
recibo -> Salud, para clinica y grupo sin leer `IntakeConfig`; tambien revocacion
durante reserva, scopes en conflicto, aislamiento por campaña, cache local y
rotacion de token. La lectura MySQL de un ambito Arriaga confirma la consulta
scoped y la ausencia de mandato, no una entrega real a Meta.

Chromium autenticado: 33 comprobaciones y nueve capturas en
`/home/ubuntu/qa-evidence/campaign-native-routing-20260910-health`, a
1440/1024/390 px. La sesion y la lectura inicial son reales; los casos de
recibos se generan con los constructores de evidencia del backend y se
interceptan solo en GET. Se inspeccionaron los detalles desktop/movil, scroll,
contadores y retorno a Salud. Cero escrituras de negocio y errores JS. Los
avisos operativos permanecen pendientes; no se cierran ni ocultan durante QA.

Dos reinicios solo de DEV, PID final `1185873`, contador `8542`; staging,
gateway y preview conservan PID. Frontend sin cambios de UI ni nuevo build
(`b05bce92b41f1b82`). Auditoria SQL antes/despues: gate cerrado, settings=0,
entregas Meta=0 y jobs CRM Meta=0. Objetivo global EN CURSO.

## Google Web Y CRM Desde El Mandato (2026-09-10)

`campaignWorkspaceGoogleConversion.service` conecta los dos puntos de ingesta
web existentes y el emisor de hitos CRM con el mandato schema 2. Reutiliza
`googleAdsConversionUpload`, su deduplicacion, auditoria y el job Diagnostics;
no crea otro receptor, cola, tabla o cron. El recorrido anterior se conserva
cuando el ambito no tiene un mandato nuevo.

- La cuenta y accion de conversion proceden del mandato preparado, no de
  `IntakeConfig.google_ads`. La configuracion publicitaria de Web puede faltar
  o apuntar a otro destino sin reescribirla. No se copia el fan-out anterior.
  La identidad de cuenta/campaña usa el parser canonico; sin cuenta solo se
  admite una seleccion inequivoca compatible con la campaña. Con varias
  posibilidades se devuelve un pendiente, nunca un envio a todas ellas.
- `campaignWorkspaceWebSignalContext` relee la instalacion efectiva y exige
  clinica activa, pertenencia explicita en `locations` para web de grupo y
  Consent Mode habilitado. Rechaza el fallback de grupo, otro registro o un
  contexto agregado sin clinica. Conserva intactos widgets, dominios y ajustes.
- El consentimiento explicito del visitante, los identificadores permitidos,
  la autorizacion documentada de datos mejorados y la capacidad privada CRM
  siguen siendo controles independientes. Una autorizacion del workspace no
  permite inventar una cita desde el navegador ni habilita datos personales
  mejorados para cuentas/eventos no autorizados. No se modifica su alcance.
- La ruta construye solo en memoria el destino del evento. Se releen mandato,
  cuenta, grant, instalacion y politica de datos antes del transporte, despues
  de resolver/refrescar OAuth y reservar la auditoria. Revocacion o cambio
  cancela el intento. La politica se clona para detectar tambien una retirada
  anidada durante la reserva. La rotacion habitual del token no duplica eventos.
- Los intentos guardan `workspace_delivery` schema 2 y una huella de campaña,
  ruta, instalacion y politica, sin token ni contactos. Salud coteja esa huella
  y los Diagnostics persistidos; recibido/procesando no significa procesado ni
  atribuido. No refresca credenciales ni llama a Google desde un GET.
- Salud carga instalaciones en bloque y reutiliza lecturas de ambito/grant
  dentro de la consulta. Cada campaña mantiene su comprobacion de seleccion.
  La siguiente consulta relee permisos; el emisor no comparte esta cache.

Verificacion backend: 369 pruebas correctas, sin fallos ni omitidas. Incluyen
preparacion real con proveedor aislado -> mandato de prueba -> ingesta Google
o hito CRM -> auditoria -> Diagnostics -> Salud, tambien para web de grupo,
revocacion tras reserva, varias cuentas y conservacion del recorrido anterior.
Ocho comprobaciones de sintaxis y `git diff --check` correctos.

Una primera prueba de compatibilidad tenia una dependencia de auditoria sin
aislar: intento insertar su registro ficticio en MySQL y fue rechazada por FK,
antes del transporte. Se corrigio la propagacion del modelo de auditoria y se
añadio una prohibicion de consultas SQL reales en esa suite. La lectura posterior
confirma cero intentos con sus event IDs de QA, cero mandatos/entregas/jobs Meta
y gate cerrado. Las pasadas fallidas no se contabilizan como verificacion.

Este avance completa el enrutado Google para una instalacion web y sus hitos
CRM; no completa Google nativo sin web, Meta web, la configuracion nativa
multipagina, la activacion atomica, Optimiza de ambos proveedores ni las metricas
CRM por anuncio. Las autorizaciones siguen siendo fixtures aislados: ninguna
activacion de cliente ni cambio de ruta canonica. Objetivo global EN CURSO.

Chromium autenticado: 33 comprobaciones y nueve capturas especificas de Salud
en `/home/ubuntu/qa-evidence/campaign-google-web-routing-20260910-health`, mas
71 comprobaciones y 29 capturas de regresion general en
`/home/ubuntu/qa-evidence/campaign-google-web-routing-20260910-regression`.
Ambas a 1440/1024/390 px, sin errores JS ni escrituras de negocio. La sesion y
las lecturas de informes son reales; los casos especificos de recibos son GET
interceptados construidos con el backend. No acreditan una entrega real a Google.
Inspeccion manual de detalle Google desktop, contadores movil, preparacion web
y grafica movil con tooltip. Los avisos operativos siguen pendientes e intactos.

Un reinicio solo de DEV: PID `1187614`, contador `8543`; staging/gateway/preview
conservan PID. Sin cambio de UI ni nuevo build (`b05bce92b41f1b82`). La lectura
MySQL en un ambito Arriaga resuelve el scope sin mandato: no hay autorizaciones
reales que probar. Gate cerrado, settings=0, entregas Meta=0, jobs CRM Meta=0 y
cero auditorias Google con los event IDs de las pruebas. Sin migracion ni cron.

## Meta Web Y CRM Desde El Mandato (2026-09-10)

`campaignWorkspaceMetaWeb.service` conecta la ingesta web existente y el job
`campaign_meta_crm_signal` con el destino preparado schema 2. No crea otro
receptor, tabla, cola o cron. Sin mandato nuevo conserva el emisor anterior.

- La identidad se resuelve contra el inventario persistido, propietarios de
  cuenta y decisiones revisadas. Acepta IDs explicitos `cc_meta_campaign_id`
  o `meta_ads_campaign_id`, tambien en la URL de llegada que ya conserva el
  snippet. La cuenta, si se aporta, debe coincidir. No deduce campañas por nombre,
  UTM ambiguas, placeholders ni pruebas enviadas por el navegador. No añade
  parametros ni modifica anuncios: su preparacion autorizada sigue pendiente.
- Se valida la instalacion efectiva, dominio, clinica activa, pertenencia
  explicita en una web de grupo y consentimiento configurado. Una cuenta
  compartida exige una decision de clinica; no utiliza la sede representativa.
  La auditoria existente guarda solo la identidad construida por el servidor,
  con huellas de instalacion y asignacion. El informe reutiliza esa identidad
  para leads y sus resultados, sin exigir otra campaña local ni simular anuncios.
- Recepcion y atribucion son independientes: si no se puede resolver la
  campaña, el formulario sigue entrando. La recepcion no requiere activar
  señales. Las señales iniciales de una ingesta exigen la identidad persistida
  del lead, evitando reatribuir una reentrega con el contenido de otra peticion.
- El destino publicitario procede del mandato, no del pixel/token guardado en
  Web. Se conservan widgets y ajustes previos. Lead/Contact requieren origen
  web y consentimiento explicito; QualifiedLead/Schedule solo aceptan el hito
  privado del CRM. No habilita ViewContent ni permite citas desde eventos publicos.
- El job de hitos existente admite la identidad web verificada. Guarda IDs y
  huella de autorizacion, no contactos. Relee lead, consentimiento, cita, cuenta,
  instalacion y permiso antes de enviar y despues de reservar. Se mantienen
  deduplicacion, backoff y caducidad. La persistencia atomica existente incluye
  los origenes web: un permiso denegado guarda el CRM sin señal; un fallo al
  guardar el job revierte la unidad. El emisor Google permanece independiente.
- Las entregas web usan un sobre versionado en `MetaSignalDelivery.policy_refs`,
  sin migracion. Salud distingue web y nativo: verifica instalacion/asignacion
  actual solo para web; no exige una web al formulario nativo. Reutiliza lecturas
  en bloque y cache dentro de una consulta, nunca entre envios o consultas.
  Recibido por Meta sigue sin significar conversion atribuida.

Verificacion backend: 383 pruebas correctas, sin fallos ni omitidas; 11
comprobaciones de sintaxis y diff-check. La nueva suite prohíbe SQL real y usa
preparacion, mandato aislado, ingesta, job, recibo y Salud para clinica/grupo.
Incluye revocacion tras reserva, cuenta compartida, auditorias contradictorias,
dominio ajeno, ausencia de atribucion y conservacion de la configuracion Web.
Lectura MySQL adicional comprueba las consultas de inventario y propietarios,
sin imprimir datos ni crear pruebas de recepcion.

El mandato real sigue sin activarse. Faltan guardado atomico y confirmacion de
activacion, Google nativo sin web, configuracion multipagina/mixta, Optimiza de
ambos proveedores, metricas CRM por anuncio y sustitucion de la ruta canonica.
Objetivo global EN CURSO; este avance no es una entrega real a Meta.

Chromium autenticado: 33 comprobaciones/nueve capturas de Salud y 71/29 de
regresion general, en `/home/ubuntu/qa-evidence/campaign-meta-web-20260910-health`
y `...-20260910-regression`. Resoluciones 1440/1024/390 px, cero errores JS y
escrituras de negocio. Sesion e informes iniciales reales; estados de entrega
mediante fixtures GET construidos con el backend. Inspeccion manual del dialogo
desktop/movil, retorno desde campaña y grafica movil con tooltip. Los avisos
operativos quedan pendientes, sin cerrar ni ocultar.

Un reinicio solo DEV: PID `1189960`, contador `8544`. Staging, gateway y preview
conservan PID. Sin cambio de UI ni nuevo build (`b05bce92b41f1b82`). Sin migracion,
cron nuevo, activacion, cambios publicitarios o cobros.
Auditoria SQL antes/despues: gate cerrado, settings=0, entregas Meta=0 y jobs
CRM Meta=0. El ambito Arriaga se resuelve y no tiene un mandato nuevo.

## Confirmacion Atomica De Medicion (2026-09-10)

`PUT campaign-workspace/activation` admite ahora Medicion con o sin señales.
Mantiene `CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED=false`: implementar el comando
no autoriza activaciones de clientes en la BD compartida ni abrir los emisores.

La recepcion de formularios ya existe: se reutilizan `ingestLead`, `LeadIntake`
y las integraciones previas. No se condiciona su entrada a activar este mandato
ni a poder atribuir el lead a una campaña. Comprobar recepcion, resolver atribucion
y autorizar hitos publicitarios son responsabilidades distintas; el nuevo recorrido
no debe pedir reinstalar lo que ya esta preparado y comprobado.

- Exige un borrador guardado, confirmacion explicita, version y revision exactas.
  Los hitos proceden de preferencias; los destinos, de las pruebas privadas de
  cada cuenta. El navegador solo confirma `signals.enabled`, no aporta hitos,
  acciones de conversion, datasets, grants ni optimizacion.
- La revision incluye la autorizacion privada en su huella, pero no la expone.
  Cambiar el grant o la prueba invalida la pantalla aunque los IDs visibles
  sigan iguales. Caducidad y completitud se revisan en servidor al confirmar.
- Bloquea propietario, miembros y setting, comprueba que el grupo mantiene
  exactamente sus clinicas activas y relee el permiso de escritura al entrar,
  antes de guardar y antes de completar. Version/recepcion/destinos vigentes y
  ausencia de gestion u optimizacion incompatibles siguen siendo obligatorios.
- Guarda mandato schema 2, modo y auditoria en una transaccion. Comprueba la
  interseccion efectiva de clinica/grupo para las campañas e hitos antes del
  commit. Un conflicto, permiso retirado o fallo de auditoria revierte la unidad.
  Las lecturas de ambito/grant se reutilizan solo dentro de esa transaccion.
- Conserva ajustes de Web y el historial de onboarding al actualizar un registro
  existente. Si el caso nativo no tiene web, no crea `IntakeConfig` vacio:
  el modo activo se obtiene del mandato, conservando visibles posibles conflictos
  con una gestion anterior. No cambia conversiones, anuncios, pujas ni presupuesto.
- Confirmar sin señales guarda eventos vacios y desautoriza su envio; guardar
  ese borrador no cambia el permiso activo. Una seleccion incluye futuras
  campañas solo cuando se autorizo `include_future`; el emisor sigue exigiendo
  identidad, clinica y consentimiento para cada evento.
- El front usa la misma seleccion revisada, no fuerza `signals.enabled=false`.
  Comprueba vigencia antes de enviar y retira la confirmacion ante cambios o
  conflictos. Tras guardar vuelve al resumen y muestra "Envio de hitos autorizado"
  o "Sin envio de hitos", sin afirmar que Google/Meta hayan recibido nada.

Las cadenas de prueba Google y Meta consumen ahora este comando real con modelos
y proveedores aislados, en lugar de construir manualmente el mandato del emisor.
Las evidencias de recepcion previas son fixtures explicitos. No son activaciones
reales de clientes ni acreditan por si solas el recorrido productivo completo.
Siguen pendientes Google nativo sin web, multipagina/mixto, Optimiza Google/Meta,
preparacion de parametros publicitarios, metricas CRM por anuncio y ruta canonica.

Verificacion: 389 pruebas backend y 61 frontend correctas, ngc, sintaxis y
diff-check sin errores. Build `5b7db07c9dcf100e` publicado en preview DEV;
se mantiene el aviso previo de bundle inicial (4.58 MB frente a 3 MB).
Chromium autenticado: 57 comprobaciones/20 capturas de preferencias y confirmacion
y 71/29 de regresion general. Evidencias en
`/home/ubuntu/qa-evidence/campaign-activation-v2-20260910-polished` y
`...-20260910-final-regression`. Incluye 320/390/1024/1440 px, conflicto de version,
caducidad, recarga y retorno al resumen; cero errores JS y escrituras de negocio.
Datos iniciales reales; guardado y activacion mediante fixtures interceptados.
Inspeccion manual de controles desktop/movil, preparacion web y grafica movil.
Los avisos operativos permanecen pendientes, sin atender ni ocultar.

Un reinicio solo DEV: PID `1192223`, contador `8545`; staging, gateway y preview
sin reinicios. No se abre el gate, ni hay migracion, cron nuevo, señales,
mutaciones publicitarias, cobros o promocion. Objetivo global EN CURSO.

## Recepcion Nativa Google Por API (2026-09-10)

La recepcion de formularios web ya existia y permanece intacta. Este avance
completa una entrada distinta: los formularios enviados dentro de Google Ads.
No crea otro CRM ni exige instalar una web o sustituir el webhook de otro CRM.
El recurso oficial `lead_form_submission_data` de Google Ads v24 permite leer
IDs de cuenta/campaña/formulario/anuncio, fecha y campos basicos. Se consultaron:

- https://developers.google.com/google-ads/api/fields/v24/lead_form_submission_data
- https://developers.google.com/google-ads/api/reference/rpc/v24/LeadFormSubmissionData

`googleLeadReception.service` incorpora esa lectura a `LeadIntake` y
`LeadAttributionAudit`, en una transaccion. Guarda contacto basico e identidad
verificada por el servidor, no respuestas clinicas, tokens ni consentimiento
inventado. Conserva la fecha original del envio para los informes; la auditoria
mantiene aparte la fecha de recepcion. La automatizacion existente conserva su
idempotencia. No se emite otra conversion por recibir el formulario.

- Gate independiente `CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED`, cerrado por defecto.
  El catalogo añade `googleNativeLeadSync`, cron `*/5 * * * *`, configurable con
  `JOBS_GOOGLE_NATIVE_LEADS_SCHEDULE`, zona heredada `Europe/Madrid`. No se mezcla
  con el refresco nocturno de informes. DEV añade 36 callbacks/15 integraciones
  dirigidas/49 tipos background; staging conserva su inventario anterior.
- El dispatcher `campaign_google_leads_poll` solo encola setting y cuenta, sin
  PII ni credenciales. El hijo `campaign_google_leads_sync` exige origen interno
  y usa namespace, deduplicacion, cinco intentos y lease de proveedores existentes.
  El gate cerrado impide incluso encolar el dispatcher del cron.
- Siete dias de solapamiento, paginacion y deadline de 45 s, limite de 10.000
  filas. Truncacion/fallo de proveedor no producen un falso vacio correcto.
  No implementa un backfill historico completo ni llama a Google desde un GET.
- Relee seleccion, grant y miembros despues de la llamada y antes de guardar.
  Rotar el access token conserva el grant; revocarlo o cambiar el principal
  invalida la lectura. Campañas futuras solo entran si `include_future` lo
  autoriza. Una cuenta compartida exige clinica explicitamente asignada; no usa
  nombres ni la sede representativa del grupo. Respeta exclusiones mas estrechas.
- El ID opaco del envio se guarda como hash estable en las columnas historicas,
  sin truncar. Una reentrega no duplica ni mueve un lead entre clinicas/campañas.
  Lead y auditoria confirman juntos; fallo de auditoria revierte ambos. Un fallo
  posterior de automatizacion puede reintentarse sin duplicar la recepcion.
- Valida identidades antes de escribir. Un contacto incompleto no impide recibir
  los otros: queda contado como pendiente y el job no afirma exito total. Una
  asignacion ambigua conserva reintento; los datos de contacto invalidos no
  consumen todos los reintentos, aunque el siguiente sondeo vuelva a comprobarlos.

Verificacion backend: 409 pruebas de campañas/jobs mas 22 de receptores previos,
consentimiento, routing y snippet; todas correctas. Las 18 nuevas de recepcion
Google usan modelos/proveedor aislados y prohiben SQL real. Sintaxis y diff-check
correctos. No hay migracion ni modificacion de los receptores web/Meta.

El gate real permanece cerrado. No se han recuperado ni importado leads de
clientes. Google nativo completo sigue pendiente: identidad para señales CRM,
transporte sin web, comprobacion de todos los destinos y cobertura en Salud.
Tambien siguen abiertos multipagina/mixto, Optimiza Google/Meta, preparacion
autorizada de parametros publicitarios, metricas CRM por anuncio y ruta canonica.
Objetivo global EN CURSO; no confundir este receptor probado con la entrega
completa del mock o una activacion de clientes.

Chromium autenticado: 71 comprobaciones y 29 capturas en
`/home/ubuntu/qa-evidence/campaign-google-native-20260910-regression`, a
1440/1024/390 px. APIs/reportes iniciales reales; pruebas de fallos de proveedor
con fixtures GET, sin escrituras de negocio. Sin errores JS ni del workspace.
Se verifican navegacion/retorno, los seis bloques de Salud sin tabs internas,
preparacion web existente y graficas a ras con tooltip sin recorte. Los avisos
operativos permanecen pendientes, sin cerrar ni ocultar.

Reinicio solo DEV: PID `1195691`, contador `8546`; staging, gateway y preview
conservan sus PID. Sin cambios de UI ni nuevo build: `5b7db07c9dcf100e` sigue en
preview. Auditoria SQL antes/despues: gates cerrados, settings=0, leads nativos
Google=0, jobs nuevos=0 y entregas Meta=0. No hay importaciones, señales,
mutaciones publicitarias, cobros ni promocion. Commits locales en DEV.

## Hitos Google Nativos Sin Web (2026-09-11)

El receptor nativo anterior alimenta ahora el recorrido canonico de cualificacion
y cita del CRM. `googleLeadLifecycleConversion` distingue `google_lead_form`
antes de buscar una instalacion y llama a `campaignWorkspaceGoogleNative`.
El transporte, la auditoria, deduplicacion y Diagnostics Google son los existentes;
no crea otra web, otro CRM ni conversiones al recibir el formulario.

- Resuelve identidad desde la auditoria escrita por el receptor Google. Comprueba
  hash del ID opaco y coincidencia de cuenta, campaña, formulario y clinica.
  Auditorias contradictorias o atribucion procedente del navegador no son validas.
- Cualificacion requiere el estado/hito vigente; Schedule, una cita no provisional
  ni cancelada de ese mismo lead/clinica. IDs canonicos `lead-ID-qualified` y
  `appointment-ID`, fechas no futuras ni de mas de siete dias. Los hooks existentes
  de cambio de estado y enlace de cita llegan al nuevo recorrido sin duplicarlo.
- Reutiliza la asignacion actual de cuentas/campañas del receptor y el mandato
  schema 2. Una cuenta compartida nunca hereda por su nombre ni por la sede
  representativa. Se aplican restricciones simultaneas de clinica/grupo.
- El origen nativo no necesita CMP, pero sigue necesitando consentimiento
  publicitario explicito persistido. Un callback interno, junto a la capacidad
  no serializable del CRM, proporciona ese consentimiento al uploader. Campos
  JSON, flags publicos o un formulario recibido no pueden fabricarlo. La auditoria
  declara `consent_mode_configured=false` y `consent_source=google_ads_native_crm`.
- Las autorizaciones opcionales de datos mejorados ya guardadas se reutilizan
  como politica, sin tratarlas como una instalacion. No se amplian allowlist,
  cuentas/eventos autorizados ni las restricciones documentadas. Sin esa
  autorizacion no envia email/telefono; sin identificadores permitidos no envia.
  No hay audiencias, remarketing, tratamientos ni paginas en el payload.
- Relee lead, contacto, consentimiento, hito, permiso y politica antes del envio
  y despues de OAuth/reserva. Cualquier cambio cancela el transporte. Un recibo
  aceptado se deduplica con el mecanismo existente; no se convierte en atribucion.
- Usa `eventSource=OTHER` para el hito privado del CRM, sin inventar navegador,
  llamada o transaccion en tienda. Fuente:
  https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest#EventSource
- Los intentos guardan `workspace_delivery` schema 3 en el JSON existente, con
  identidad publicitaria y huella de mandato/politica, sin contacto. Salud valida
  clinica, asignacion, grant, destino y politica actuales; no exige web al nativo.
  Los recibos web schema 1/2 siguen su camino anterior. Las lecturas se reutilizan
  solo dentro de cada consulta, nunca entre envios; Salud no lee contactos ni
  refresca tokens. Mantiene recibido/procesando separado de procesado y atribuido.

La nueva suite usa el receptor, preparacion y comando de activacion reales con
modelos/proveedores aislados. La evidencia inicial de recepcion para el comando
es un fixture explicito; no acredita una activacion de cliente. Incluye clinica,
grupo, hooks canonicos, deduplicacion, consentimiento, datos mejorados y revocacion
tras OAuth/reserva. Las pruebas prohiben SQL real. No hay llamadas de envio a Google.

Los hitos nativos usan ahora el outbox descrito debajo. Falta la comprobacion
completa de recepcion/destinos nativos y configuracion mixta/multipagina. Siguen abiertos
Optimiza Google/Meta, parametros publicitarios autorizados, metricas CRM por anuncio
y sustitucion de la ruta canonica. Ambos gates reales permanecen cerrados.
Objetivo global EN CURSO; este avance no habilita señales ni importaciones de clientes.

## Outbox De Hitos Google Nativos (2026-09-11)

`googleLeadLifecycleJob.service` incorpora `campaign_google_crm_signal` al
executor existente. Es un job por hito, no un cron; prioridad normal, ocho
intentos y ventana de siete dias desde el evento. `JobRequest` aporta namespace,
deduplicacion de jobs activos, backoff y recuperacion tras reinicio. No hay nueva
tabla, migracion, calendario paralelo ni receptor de formularios.

- Cualificacion, creacion de cita y enlaces desde aviso/resultado de llamada
  reutilizan `leadCrmSignalPersistence`. El cambio CRM y el job se guardan juntos.
  Las lecturas de origen, identidad, cuenta, clinica, mandato y autorizacion usan
  esa misma transaccion. El hook posterior consume el resultado del commit sin
  duplicar jobs ni llamar a Google. La emision Google web anterior no cambia.
- Fallar SQL revierte el cambio y su job; una denegacion de consentimiento o
  mandato permite guardar el CRM sin emision. El payload conserva solo IDs
  locales, evento, fecha normalizada y huella; nunca contactos, tokens, IDs
  nativos, respuestas de formulario ni payload de conversion.
- El executor exige tipo/origen internos y ausencia de solicitante HTTP. Relee
  el hito, cita, identidad, datos, consentimiento, clinica y mandato. Los cambios
  de fuente/autorizacion invalidan el trabajo; no lo redirigen. Se comprueba
  tambien la huella entre validacion del worker, entrada al uploader, OAuth y
  reserva. El gate cerrado impide tanto encolar como enviar.
- Cuota/timeout/5xx y errores de persistencia reintentan; permisos retirados,
  expiracion, falta de identificadores autorizados y errores permanentes paran.
  Una aceptacion con recibo persistido completa el job; Diagnostics sigue
  comprobando el procesamiento. Salud no confunde job completado con conversion
  atribuida ni exige una web al recibo nativo.
- Si Google acepta pero no se guarda su recibo, el uploader mantiene la reserva
  de cinco minutos. El reintento conserva destino, fecha y `transactionId`.
  Este ultimo deduplica eventos dentro de la misma accion segun el
  [contrato de Google](https://developers.google.com/data-manager/api/devguides/events/send-events).
  No se ofrece garantia de exactly-once de red; se preservan reserva local e
  identidad de conversion en ambos lados.

Verificacion de dominio: pruebas aisladas del receptor y preparacion/mandato
reales, seguida de hooks CRM, `enqueueUniqueJobRequest`, worker, uploader y Salud.
Incluye clinica/grupo, reinicio simulado perdiendo estado de proceso, duplicados,
fallo transitorio/permanente, recibo perdido tras aceptacion, revocacion durante
envio y propagacion de la transaccion a todas las lecturas. Los tests de
persistencia comprueban commit/rollback conjunto para los tres escritores.
No son importaciones, permisos, señales o citas de clientes reales.

El objetivo global permanece abierto: cobertura completa de recepcion/destinos,
configuracion mixta/multipagina, Optimiza Google/Meta, parametros publicitarios
autorizados, metricas CRM por anuncio y ruta canonica. Ambos gates siguen
cerrados; no se activan anuncios, señales, cobros ni se promueve staging/gateway.

Verificacion final de este avance: 454 pruebas backend de campañas, receptores,
autorizacion, persistencia y jobs; tres contratos adicionales de outbox,
Diagnostics y cita/tratamiento. Cero fallos. La suite nativa contiene 24 pruebas,
incluida perdida del recibo tras aceptacion. Sintaxis y diff-check correctos.
El test general del executor crea y elimina unicamente sus jobs de prueba en
namespace propio; no ejecuta integraciones reales.

Chromium autenticado: 71 comprobaciones/29 capturas del recorrido y 36/9 de
Salud, en 1440/1024/390 px. Evidencias:
`/home/ubuntu/qa-evidence/campaign-google-crm-queue-20260911-regression` y
`/home/ubuntu/qa-evidence/campaign-google-crm-queue-20260911-health`.
Los datos iniciales son reales; los estados de proveedor de Salud se prueban
con fixtures GET, no entregas externas. Sin errores JS, escrituras de negocio
ni desbordamientos detectados. Revisados manualmente dialogos de Salud,
preparacion web y grafica movil; los avisos operativos no se cierran ni ocultan.

Un reinicio DEV en este avance: PID `1199799`, contador `8548` (desde `8547`).
Staging `1074087/46`, gateway `1039243/37` y preview `1054768/40` sin cambios.
No se recompila UI: sigue `5b7db07c9dcf100e`. Auditoria SQL antes/despues:
settings, leads Google nativos, jobs Google nativos, señales Google nativas y
entregas Meta a cero; ambos gates cerrados. Sin migraciones ni promocion.

## Destinos Google Y Recepcion Mixta (2026-09-11)

La captura web existente (`intake.controller`, `FormSubmissionEvent` y
`LeadIntake`) se reutiliza. No se introduce un segundo receptor de formularios.
Preparacion y Salud distinguen configuracion pendiente, configuracion preparada
sin recibo reciente y recepcion verificada. La falta de envios o una comprobacion
caducada no constituye por si sola una incidencia critica. El gate de activacion
sigue exigiendo evidencia: esta distincion no inventa una recepcion positiva.

- `GET /campaign-workspace/google-destinations?scope=...&account_id=...&campaign_id=...`
  lee inventario y evidencia persistida. No consulta Google ni renueva OAuth.
- `POST /campaign-workspace/google-destinations/check` requiere escritura sobre
  todo el scope y revision del cache. Consulta metadatos de anuncios, grupos y
  formularios vinculados a cuenta/campana/grupo. PMax incluye URLs de los grupos
  de recursos. No lee respuestas, credenciales webhook ni cambia publicidad.
- Se persiste `destination_detection.workspace_google`, version 1, con TTL
  operativo de 24 h y huella privada de la autorizacion vigente. El refresco
  anterior de URLs observadas conserva esa clave bajo bloqueo de la fila actual:
  no puede restaurar un snapshot previo ni borrar una comprobacion en curso.
  El I/O del job queda fuera de la transaccion; no cambia su cron ni zona horaria.
  Reserva `checking` antes del
  I/O; un fallo deja `failed`, no conserva un verde anterior. Al terminar se
  revalidan permisos, seleccion, destinatario y revision. La huella no sale a UI.
- Los destinos dinamicos no se presentan como exhaustivos. Referencias tecnicas:
  [AssetGroup](https://developers.google.com/google-ads/api/reference/rpc/v24/AssetGroup)
  y [Ad](https://developers.google.com/google-ads/api/reference/rpc/v24/Ad).
- Los recibos Google nativos se consultan por clinica/cuenta/campana/formulario,
  con join CRM obligatorio y sin campos de contacto. Requieren seleccion y
  autorizacion actuales; el gate del receptor deshabilitado nunca aparece listo.
- `mixed` conserva ambos canales. No basta comprobar la web si quedan formularios
  nativos pendientes, ni viceversa. Se mantienen separados privacidad web,
  recepcion web y recepcion nativa. El modal vuelve al mismo paso al cerrarse y
  abre directamente la preparacion web compartida, sin bucle entre dialogos.

Limites abiertos: refresco nocturno automatico del nuevo inventario de destinos,
cobertura adicional de URLs de extensiones/keywords y mecanismos dinamicos,
y excepciones de propiedad compartida. En la lectura real de Arriaga (grupo 28)
hay inventario Google persistido, pero la cuenta tambien tiene un propietario
fuera del grupo y no hay asignaciones revisadas. `visibleCampaigns` lo excluye
correctamente: no se relaja la frontera de acceso para poder probar el modal.
Falta ofrecer una resolucion clara de esta excepcion desde el nuevo recorrido.

Verificacion: 380 tests backend de workspace, Google y diagnostico; 32 tests frontend.
La prueba del recibo perdido fija la reserva al reloj de envio, no a la fecha
historica del hito CRM; el uploader no cambia. Build completo DEV
`3024985cbb25a6c0`, publicado en el preview; solo el aviso CommonJS conocido.
Chromium final: 28 comprobaciones, 11 capturas del dialogo en 1440/1024/390 px,
sin errores JS ni escrituras de negocio. Evidencias en
`/home/ubuntu/qa-evidence/campaign-google-destinations-20260911-confirmed`.
El inventario de cuenta y la denegacion de scope son reales. Los estados del
dialogo y la asignacion visual son fixtures HTTP aislados en Chromium, no una
importacion real ni una recepcion real de Google. La API negativa no se cuenta
como una conexion funcional validada de extremo a extremo.

El intento anterior `campaign-google-destinations-20260911-final` conserva su
fallo de recoleccion asincrona: el test comprobaba antes de terminar de leer la
respuesta. Se corrigio esperando explicitamente a respuesta y cuerpo, sin
relajar el 403 esperado. El pase final tambien comprueba que una denegacion al
recargar elimina formularios y acciones del estado anterior.

Regresion final autenticada: 71 comprobaciones/29 capturas de recorrido y 36/9
de Salud, sin errores JS ni escrituras de negocio, en
`/home/ubuntu/qa-evidence/campaign-destinations-regression-20260911-final` y
`/home/ubuntu/qa-evidence/campaign-destinations-health-20260911-final`.
Revisados manualmente dialogos movil/escritorio, preparacion web, grafica movil
y detalle de Salud. Las notificaciones operativas no se cierran ni se ocultan.

Dos reinicios exclusivamente DEV en este avance, desde contador `8548` hasta
`8550`, PID final `1206206`. Staging `1074087/46`, gateway `1039243/37` y preview
`1054768/40` sin cambios. Auditoria SQL antes/despues: settings, leads Google,
jobs Google de leads/CRM, comprobaciones nuevas de destinos Google y entregas
Meta a cero. Ambos gates cerrados; sin migraciones ni promociones.

El objetivo global sigue EN CURSO, incluida la excepcion anterior, Optimiza en
ambos proveedores, metricas CRM por anuncio y sustitucion de la ruta canonica.

## Revision De Cuentas Compartidas (2026-09-11)

La excepcion de cuenta compartida anterior dispone de un recorrido explicito.
No se relaja `visibleCampaigns`: un grupo parcial sigue sin ver las campanas
no asignadas de una cuenta con propietarios externos.

- `GET /campaign-workspace/shared-account?scope=...&provider=...&account_id=...`
  lee exclusivamente inventario persistido de la cuenta solicitada. Requiere
  permiso de escritura sobre todas las clinicas propietarias, incluidos los
  miembros inactivos de grupos propietarios. Comprueba permisos antes y despues
  de ampliar esa lectura. No consulta Google/Meta ni renueva OAuth.
- Devuelve solo nombre, identificador, estado y revision de campanas pendientes,
  con busqueda sobre toda la cuenta y diez resultados por pagina. Las clinicas
  destino se limitan al ambito solicitado; no expone propietarios externos,
  URLs, contactos, conexiones ni credenciales. Propietarios o grants sin resolver
  fallan cerrados. Los identificadores Google con guiones no ocultan propietarios.
- `POST /campaign-workspace/shared-account/assignment` exige confirmacion,
  revision de cuenta y de cada una de las campanas elegidas, hasta diez por lote.
  Relee y bloquea ambito, permisos, propietarios y configuracion. Cambios de
  conexion, seleccion, miembros o identidad invalidan la confirmacion. Una
  campana nueva no elegida no invalida las identidades ya revisadas.
- Reutiliza `ExternalCampaignAssignment` y su auditoria en una transaccion.
  Nunca sustituye ni mueve una asignacion previa, incluidos aliases historicos;
  un conflicto o fallo de auditoria revierte el lote entero. No crea una segunda
  campana interna ni habilita publicidad, importacion o señales. Asignar una
  campana excluida no la incluye en la configuracion activa.
- La UI mantiene un dialogo con lista y confirmacion de clinica, sin nuevas
  pestañas. No preselecciona campanas; cambiar pagina/busqueda elimina selecciones
  ocultas. Un error de confirmacion elimina la seleccion y pide revisar de nuevo.
  Paginador y acciones permanecen visibles en movil. Un exito recarga solo si
  el usuario sigue en el mismo ambito.

La recepcion de formularios web sigue reutilizando el receptor existente. Esta
asignacion resuelve pertenencia/atribucion en cuentas compartidas; no instala un
receptor nuevo, no es prueba de recepcion ni autoriza señales CRM.

El objetivo global permanece EN CURSO: cobertura completa de URLs/destinos,
refresco nocturno del nuevo inventario, Optimiza Google/Meta, metricas CRM por
anuncio y ruta canonica. No hay nuevos jobs, cron, migraciones ni promociones.

Verificacion de este avance: 394 pruebas backend, tres contratos adicionales de
asignacion/auditoria y 33 frontend, sin fallos. Los tests de escritura usan
modelos aislados y comprueban permisos, rollback del lote y revision de ambos
proveedores; no se escriben asignaciones reales. Build DEV `8ca1f16dcb23f107`,
publicado en el preview, solo aviso CommonJS conocido.

Chromium autenticado, 1440/1024/390 px: cuenta compartida 26 comprobaciones y
11 capturas; Salud 36/9. La lectura de las nueve campanas Google de Arriaga es
real y exige autorizacion completa. La paginacion extensa y los POST de
conflicto/exito usan fixtures HTTP, no decisiones de clientes. Sin errores JS
ni escrituras de negocio. Evidencias en
`/home/ubuntu/qa-evidence/campaign-shared-account-20260911-confirmed` y
`/home/ubuntu/qa-evidence/campaign-shared-health-20260911-confirmed`.
Revisados manualmente lista y confirmacion movil/escritorio y detalle de Salud.
Las notificaciones operativas no se cierran ni se ocultan para estas pruebas.

Regresion final del mismo build: 71 comprobaciones/29 capturas de navegacion,
preparacion web y graficas reales responsive, sin errores JS ni escrituras, en
`/home/ubuntu/qa-evidence/campaign-shared-regression-20260911-confirmed`.
Un reinicio exclusivamente DEV en este avance: PID `1209539`, contador `8551`
(desde `8550`). Staging `1074087/46`, gateway `1039243/37` y preview `1054768/40`
sin cambios. Auditoria SQL antes/despues: 44 asignaciones, 48 auditorias, cero
settings y cero leads Google nativos. Ambos gates de activacion/importacion
siguen cerrados. No se ha hecho ninguna asignacion real para facilitar el QA.

## Compatibilidad De Optimiza (2026-09-11)

La preparacion permite revisar que ajustes admite cada campana seleccionada y
asignada, con Google y Meta. No autoriza ajustes ni activa un ejecutor. Tampoco
cambia recepcion de formularios o senales CRM, que conservan sus contratos.

- `GET /campaign-workspace/optimization` acepta proveedor, cuenta y campana,
  bajo un scope de clinica/grupo. Lee evidencia persistente, sin consultas a
  proveedores ni refresco OAuth. Exige preferencias Optimiza guardadas, cuenta
  elegida, asignacion explicita y acceso actual. Los agregados son de lectura
  de informes, no un scope valido de configuracion.
- `POST /campaign-workspace/optimization/check` exige escritura en todo el
  ambito y `expected_version`. Reserva una comprobacion por 120 segundos,
  consulta solo metadatos y revalida permisos, miembros, seleccion, asignacion
  y grant antes/despues del I/O. No mantiene transacciones abiertas durante la
  consulta externa. Los conflictos no se convierten en autorizaciones.
- Guarda eventos inmutables `optimization_check` en `CampaignWorkspaceEvents`;
  inicio y resultado avanzan la version del workspace. TTL operativo de 24 h,
  ligado a la configuracion y al grant actuales. No necesita migracion ni
  almacenamiento de navegador. Una comprobacion fallida retira el resultado
  positivo anterior; un cambio de cuenta, permiso o limites lo invalida.
- La respuesta solo incluye acciones, conteos, motivos y fechas. Nunca expone
  tokens, huellas privadas ni la lista tecnica de recursos. `authorized` es
  siempre `false`. El detalle interno solo guarda metadatos permitidos, no
  contenido de anuncios, audiencias o datos de pacientes.
- Google admite Search y Performance Max activas y fuera de experimentos.
  Detecta pujas manuales y objetivos CPA/ROAS ya existentes, sin convertir
  estrategias ni inventar objetivos. Excluye estrategias de cartera. La pausa
  individual solo es compatible con grupos Search con otro anuncio activo;
  no representa los grupos de recursos PMax como anuncios individuales.
- Las exclusiones de busquedas se limitan a negativas EXACT de campana, tambien
  para PMax. Los presupuestos Google requieren periodo diario, propietario
  confirmado y no compartido. No se infiere exclusividad de una referencia
  incompleta. No se consultan formularios o respuestas al revisar ajustes.
- Meta exige permiso `ads_management`, cuenta/campana verificadas, estado
  ACTIVE/AUCTION y paginacion completa de anuncios y conjuntos. Reconoce
  COST_CAP, LOWEST_COST_WITH_BID_CAP y MIN_ROAS existentes; mantiene estrategias
  sin limite. Reconoce al propietario real del presupuesto diario (campana o
  conjunto), excluye presupuestos de duracion total y protege el ultimo anuncio.
- El limite mensual actual esta expresado en EUR: una cuenta con otra divisa
  no tiene ajuste presupuestario compatible. Estos limites son decisiones del
  producto, no una afirmacion de que los proveedores no ofrezcan otras opciones.
- El dialogo muestra esta informacion bajo la campana del paso de preparacion,
  sin nuevas pestañas. Permite comprobar de nuevo, elimina estados anteriores
  ante error y conserva el paso al cerrar. La comprobacion y la autorizacion
  se mantienen distintas; el gate de activacion de Optimiza sigue cerrado.

El contrato guided anterior permite `landing_publish`, `campaign_destination`
y `conversion_goal`: no se reutiliza como si autorizara pujas/presupuestos/pausas.
El mandato explicito se implementa en la seccion siguiente. Faltan recomendaciones
con evidencia, ejecutor Google/Meta, aplicacion del limite global mensual,
controles de frecuencia y jobs con recibos/idempotencia.
Antes de cada futura mutacion habra que releer estado y permisos; una lista de
anuncios compatibles no autoriza pausarlos todos ni consumir el ultimo activo.
El TTL de esta comprobacion no sustituye el refresco nocturno de los informes.
Este avance no anade cron ni modifica el horario Europe/Madrid.

Referencias primarias usadas para delimitar los campos existentes:
[Campaign v24](https://developers.google.com/google-ads/api/reference/rpc/v24/Campaign),
[CampaignBudget v24](https://developers.google.com/google-ads/api/reference/rpc/v24/CampaignBudget),
[criterios PMax](https://developers.google.com/google-ads/api/performance-max/create-campaign-criteria)
y [AdSet del SDK oficial Meta](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adset.py).

Verificacion backend: 415 pruebas de workspace, Google y diagnostico, sin fallos.
La suite nueva usa modelos/proveedores aislados y prueba expiracion, conflictos,
revocacion durante el I/O, fallo de auditoria y ausencia de cambios de activacion.
Consulta JSON de eventos verificada contra MySQL real, sin crear registros.
Lectura real de una campana PMax de Arriaga, tras verificar acceso a todas las
clinicas propietarias y grant vigente: negativa y presupuesto compatibles;
sin anuncio individual ni objetivo de puja existente. Solo token vigente, sin
renovarlo ni guardar la comprobacion. Search y Meta se prueban con fixtures,
no se presentan como ejecuciones reales. Sigue pendiente el QA del ejecutor.

## Autorizacion Y Pausa De Optimiza (2026-09-11)

- `PUT /campaign-workspace/activation` admite `mode=optimize`, ademas de
  Medicion. Exige seleccion guardada, recepcion preparada, revision vigente y
  confirmacion explicita. Si se eligen senales CRM, su autorizacion y destinos
  siguen teniendo sus propias comprobaciones. Optimiza puede usarse sin ellas.
- Gate adicional `CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED`, falso por defecto,
  junto con `CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED`. Ambos siguen cerrados.
  No habilitar Optimiza hasta completar ejecutores, recomendaciones y jobs;
  guardar un mandato en pruebas no equivale a una ejecucion publicitaria real.
- El servidor reconstruye el mandato con pruebas Google/Meta de menos de 24 h,
  ligadas a seleccion, clinica y grant actuales. Rechaza pruebas incompletas,
  campos desconocidos, recursos ajenos, duplicados o version modificada.
  Campanas sin asignar, pausadas o sin ajustes compatibles no reciben permiso.
  Debe haber al menos una campana compatible; las pendientes requieren revision.
- Persistencia en `activation.optimization` de `CampaignWorkspaceSettings`,
  con actor, fecha, identidad del mandato y recursos exactos. `include_future`
  permite importar, nunca ampliar autorizacion a campanas o recursos nuevos.
  La API publica solo estado, fechas, limites y numero de campanas; no publica
  grants ni recursos privados. No se anade migracion ni cache del navegador.
- Limites del producto: pujas hasta 10% por ajuste, un ajuste por recurso cada
  24 h y preservacion del ultimo anuncio activo. Presupuesto sin cambios por
  defecto; si se autoriza, hasta 10% y tope mensual conjunto en EUR. El tope no
  es por campana. Estos limites quedan en el mandato, pero su cumplimiento
  operativo debe implementarse y probarse en los ejecutores antes de abrir gate.
- Autorizar bloquea las filas comunes de cuentas y comprueba otros mandatos
  activos para evitar dos workspaces autorizando la misma campana. Mantiene
  tambien el bloqueo ante politicas guided/managed anteriores. La consulta JSON
  se verifica en MySQL; la concurrencia de ejecucion real sigue pendiente.
- Se conserva `connect_only` en el contrato de recepcion existente y se anade
  el mandato independiente. El contrato guided anterior NO autoriza pujas,
  pausas o presupuesto. La pantalla muestra Optimiza sobre su propio contrato
  de recepcion, sin tapar configuraciones managed/guided ajenas.
- `POST /campaign-workspace/optimization/pause` exige permiso de escritura,
  ambito, version y `confirmed=true`. Pausa solo ajustes futuros, no anuncios,
  recepcion ni senales autorizadas. Es idempotente con la version vigente y
  permanece disponible aunque se cierre el gate de activacion. Un fallo de
  auditoria revierte el cambio; evento `optimization_paused` sin mutacion externa.
- El resolvedor interno de autorizacion revalida actor, clinicas, seleccion,
  conexion, recursos y limites, independientemente de un borrador posterior.
  No realiza ninguna mutacion. El futuro ejecutor debe releer el recurso,
  comprobar limites globales y frecuencia, registrar cada intento y gestionar
  idempotencia antes de solicitar un cambio a Google/Meta.
- La revision UI conserva el paso al abrir/cerrar el detalle, pagina diez
  campanas y descarta el verde si caduca la prueba. Confirmacion y pausa son
  acciones distintas. No anade tabs ni cambia interiores del hub/objetivo.

Verificacion de esta fase: 430 tests backend y 68 frontend, build DEV
`fb7af7c01da5f18b`. Sin migraciones, nuevos cron, ejecuciones publicitarias,
senales, imports de leads o cobros. La recepcion web/Meta previa se reutiliza.
Chromium autenticado: 33 comprobaciones y 14 capturas a 1440/1024/390 px,
incluyendo paginacion, caducidad, confirmacion, conflictos, pausa, recarga y
atras del navegador con un dialogo abierto. Lecturas iniciales reales; las
autorizaciones y pausas de exito/conflicto son fixtures HTTP, nunca datos de
clientes. Sin errores JS ni escrituras reales. Revision visual corrigio el
salto del icono en movil y el espacio icono/texto en los botones de este recorrido.
Evidencias: `/home/ubuntu/qa-evidence/campaign-opt-mandate-20260911-verified`.
El objetivo completo sigue EN CURSO: ejecutores y jobs de Optimiza en ambos
proveedores, cobertura/refresco nocturno, metricas CRM por anuncio y ruta canonica.

## Ejecutor De Ajustes: Base Aislada (2026-09-11)

Estado: implementacion parcial, gates cerrados. No se habilita Optimiza ni se
conecta aun un generador automatico de recomendaciones al ejecutor. La recepcion
web y Meta existente permanece independiente e intacta.

- `campaignWorkspaceOptimizationCommand.service` valida comandos de un solo
  recurso autorizado. Google: pausa de anuncio, objetivo de puja existente,
  negativa EXACT y presupuesto diario exclusivo. Meta: pausa de anuncio,
  limite de puja/ROAS existente y presupuesto de su propietario real. No crea
  anuncios, cambia estrategia ni escribe destinos, formularios o conversiones.
- Diferencias de puja/presupuesto limitadas al 10%, con aritmetica decimal
  exacta. La comprobacion previa relee la compatibilidad, propietario, estrategia
  y valor actual; mantiene la proteccion del ultimo anuncio activo. Un mapa
  Meta de restricciones con campos desconocidos no se sobrescribe parcialmente.
- Las mutaciones Google usan una operacion y mascara de campos; Meta permite
  un solo campo, con gate propio en su cliente compartido. Ambos conservan
  control de cuota, timeout acotado y cero reintentos/redirecciones de escritura.
  La respuesta del proveedor por si sola no declara el ajuste verificado.
- Nuevo modelo y migracion `20260911180000-create-campaign-workspace-optimization-runs`:
  `CampaignWorkspaceOptimizationRuns`, con comando/evidencia privados, mandato,
  huella de plan, namespace, job, lease y recibo. Indices de idempotencia,
  cuenta/estado, recurso/fecha y recuperacion. FK a workspace con RESTRICT y a
  job con SET NULL: archivar jobs no borra recibos ni bloquea su retencion normal.
  La migracion es repetible y rechaza esquemas incompatibles; su rollback exige
  tabla vacia. Aplicada individualmente a la base compartida el 2026-09-11,
  registrada en SequelizeMeta y revalidada. Tabla vacia, sin registros QA ni
  ejecuciones publicitarias; no se ejecuta la cola general de migraciones.
- Productor interno `enqueueOptimizationAdjustment`: valida evidencia agregada
  reciente y relacionada con la accion; guarda el plan y `JobRequest` en una
  transaccion. Payload solo con ID de ejecucion y namespace. No hay endpoint
  para enviar operaciones arbitrarias ni recomendador conectado a este productor.
- Handler `campaign_workspace_optimization_apply` en el ejecutor existente,
  con el mismo carril serializado y lease de integraciones. La recuperacion
  periodica se describe en la siguiente seccion.
  Reserva por workspace/cuenta; vuelve a revisar el mandato y permisos,
  incluyendo membresias bajo bloqueo. Recursos nuevos, cuentas ajenas, cambio
  de grant/clinica y mandatos pausados se rechazan. Cooldown de 24 h por recurso,
  tambien entre mandatos distintos. La pausa no altera recepcion ni senales.
- Se persiste `submitted_at` ANTES de llamar al proveedor. Tras una caida o
  respuesta incierta, el mismo job solo relee: nunca repite la mutacion. Una
  confirmacion de commit perdida tampoco borra ese marcador. El lease limita
  workers simultaneos y un trabajador antiguo no puede confirmar otro comando.
- Estados: `queued`, `leased`, `submitted`, `verified`, `observed`, `skipped`,
  `uncertain`, `resolved`. `observed` acredita el estado leido, no que esta ejecucion causara
  el cambio. `uncertain` conserva el intento y bloquea otros ajustes de la
  cuenta/workspace. Errores anteriores al envio pueden reintentarse; los recibos
  solo guardan codigos permitidos, no mensajes/payloads privados del proveedor.

Pendiente antes de abrir gates, no resuelto por estos adaptadores:

1. Recomendador con datos reales, cobertura y criterios de muestras suficientes.
2. Contabilidad del limite mensual conjunto. `adjust_budget` se bloquea con
   `workspace_optimization_budget_accounting_required` mientras no se conecte
   esa comprobacion. Una prueba inyectada no acredita control de presupuesto real.
3. Prueba real de concurrencia MySQL antes de cualquier ejecucion autorizada.
   Los tests de recuperacion/bloqueos usan modelos transaccionales aislados;
   la comprobacion del esquema/consulta en MySQL no sustituye esa prueba.
4. Integracion final del flujo, cobertura/refresco nocturno y CRM por anuncio,
   que siguen formando parte del objetivo global abierto.

Referencias de transporte:
[mutaciones REST de Google Ads](https://developers.google.com/google-ads/api/rest/common/mutate),
[Ad del SDK oficial Meta](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/ad.py)
y [AdSet del SDK oficial Meta](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adset.py).

## Recuperacion, Historial Y Salud De Optimiza (2026-09-11)

- `campaign_workspace_optimization_recover` se incorpora al catalogo existente,
  desactivado mientras este cerrado el gate de Optimiza. Cron por defecto
  `*/15 * * * *`, configurable mediante
  `JOBS_CAMPAIGN_WORKSPACE_OPTIMIZATION_RECOVERY_SCHEDULE`; hereda Europe/Madrid.
  El gestor solo lee/actualiza registros y encola: no consulta proveedores.
  No se ha activado ni promovido el scheduler de staging.
- Examina hasta 100 registros vencidos del namespace actual por pasada. Respeta
  jobs pendientes/en cola/en ejecucion/en espera y leases vigentes; no supone
  que una llamada haya terminado por haber vencido un temporizador local.
  Seis recuperaciones como maximo, con esperas de 15, 30, 60, 240, 720 y 1440
  minutos. El ultimo intento agotado queda visible para revision manual.
- Sin marcador de envio puede reencolar `optimization_apply`, tras comprobar
  de nuevo evidencia y permiso. Con marcador usa exclusivamente
  `campaign_workspace_optimization_check`, de solo lectura, en el carril de
  integraciones. Nunca borra el marcador ni reenvia el ajuste. El chequeo admite
  el mismo mandato pausado, pero exige permisos, asignacion y grant vigentes.
  Un mandato sustituido o acceso revocado no permite usar credenciales antiguas.
- Antes de cada escritura se comprueban tambien conflictos sobrevenidos:
  politicas guided/managed de clinica/grupo, herencia de IntakeConfig y solicitudes
  nativas, y otros mandatos sobre la misma campana. No se cambia el contrato de
  recepcion `connect_only` ni se reclama control de campanas ajenas.
- Historial GET `/marketing/campaign-workspace/optimization/history`, paginado
  en servidor a diez filas, con incidentes pendientes primero. Filtra por
  namespace, asignacion actual, clinica, proveedor/cuenta/campana y permisos.
  Admite agregados en lectura; expone valores antes/despues, fechas y estado,
  nunca tokens, grants, evidencia privada ni comandos publicitarios.
- Salud mantiene los seis bloques aprobados. Pausas inciertas se muestran en
  publicacion; pujas/presupuesto/negativas en coste. Los pendientes no se pintan
  como OK, tampoco al pausar la campana. El detalle abre el historial en un
  dialogo, sin nuevas pestañas y conservando el contexto de navegacion.
- POST `/marketing/campaign-workspace/optimization/history/:runId/resolve`
  exige ambito unico con escritura, `confirmed: true` y `expected_revision`.
  Solo cierra registros inciertos ya enviados, sin worker/lease activo, del
  workspace y namespace actuales. Bloquea scope, setting, registro y job;
  revalida asignacion y permisos. Version y evento `optimization_resolved` se
  guardan atomicos con la resolucion; un fallo de auditoria revierte todo.
- `resolved` significa revision humana cerrada, **no** confirmacion del proveedor
  ni aplicacion del ajuste. La confirmacion explica que se libera el bloqueo de
  ajustes previamente autorizados; no cambia publicidad, recepcion ni senales.
  `observed` tampoco atribuye causalidad a ClinicaClick. Un conflicto exige volver
  a consultar; no se envia otra mutacion como consecuencia de un error de lectura.
- Gates de activacion, Optimiza y descarga de leads Google cerrados. Esquema
  y consultas vacias comprobados en MySQL; escrituras funcionales y fallos se
  prueban con modelos/HTTP aislados, no con clientes ni anuncios reales.
Se conserva la version v24 del cliente Google de DEV.

Verificacion de codigo: 469 tests backend y 68 frontend, sin fallos. Modelos y
transportes aislados para todas las escrituras; se prueban perdida de commit,
timeouts, revocacion, plan alterado, leases, concurrencia, rollback, cooldown y
ausencia de reenvios. No hay ejecuciones Google/Meta reales ni nueva UI/build.
Tambien pasan los dos runners de regresion guided/Web existentes.

Chromium autenticado sobre el backend final: 71 comprobaciones y 29 capturas
del recorrido a 1440/1024/390 px, sin errores JS ni escrituras de negocio.
Salud: otras 36 comprobaciones/9 capturas, con lectura inicial real y casos de
entrega simulados mediante fixtures HTTP. No se presentan esos casos como
conversiones enviadas. Evidencias en
`/home/ubuntu/qa-evidence/campaign-opt-executor-final-20260911` y
`/home/ubuntu/qa-evidence/campaign-opt-executor-health-20260911`.
La primera regresion tambien paso en `campaign-opt-executor-regression-20260911`.
Se revisaron capturas de resumen, preparacion web movil y grafica responsive;
notificaciones operativas intactas. Sigue el build `fb7af7c01da5f18b`.

Dos reinicios exclusivamente DEV: `1216763/8553` a `1220635/8554` y despues
`1221419/8555` al incorporar el carril de integraciones. Staging `1074087/46`,
gateway `1039243/37` y preview `1054768/40` sin cambios. Auditoria SQL conserva
44 asignaciones, 48 eventos, cero settings y cero leads Google nativos; la
tabla nueva no existe aun. Sin migraciones aplicadas, jobs publicitarios,
senales, cobros ni promociones. Los tres gates permanecen cerrados.

## Resultados CRM Por Anuncio (2026-09-11)

El informe reutiliza los leads recibidos y las citas/presupuestos existentes;
no introduce otro receptor ni condiciona formularios a Optimiza. El nuevo
`adAttribution` distingue resultados atribuidos y el resto de la campana:

- Identidad nativa Meta verificada por Graph, o identidad Google guardada por
  la API. Google se enriquece en lote desde el mismo comprobador que el resolvedor
  individual: hash del ID nativo, clinica, cuenta, campana y formulario deben
  coincidir con LeadIntake. Pruebas ausentes, invalidas o contradictorias no
  identifican un anuncio. Solo se seleccionan IDs y JSON de atribucion; no se
  devuelve el payload del formulario ni datos personales en el informe.
- El identificador de fila combina grupo/anuncio cuando el inventario dispone
  del grupo. Un ad ID presente en varios grupos sin evidencia del grupo queda
  sin asignar a anuncio. La atribucion siempre esta limitada a una unica campana,
  cuenta y clinica autorizada; nunca por nombre o `utm_content` libre.
- Leads unicos por intake y fecha de entrada; citas por fecha de creacion,
  vinculadas al lead, misma clinica, no anteriores a su origen y excluyendo
  canceladas, reprogramadas o provisionales. Un lead historico puede originar
  una cita del periodo sin contarse como nuevo lead.
- Presupuestos: importe realmente aceptado en EUR, incluso aceptacion parcial,
  por fecha de respuesta. Se mantiene la asignacion unica a campana. La nueva
  `adAllocations` exige que todos los vinculos validos del paciente coincidan
  tambien en anuncio; nunca reparte el presupuesto ni elige ultimo contacto.
- `adAttribution.unattributed.current/previous` conserva los resultados de la
  campana sin anuncio verificable. Incluye importes aceptados sin identidad de
  anuncio, sin alterar el total economico. La UI lo muestra aparte, sin ocultarlo
  al paginar o filtrar anuncios. Cero en una fila significa cero resultados
  **atribuidos** a ese anuncio, no ausencia demostrada de resultados desconocidos.
  Campanas sin asignacion mantienen los valores CRM en null.
- `currentCpl/previousCpl` solo se calculan con inversion disponible, leads
  positivos y ningun lead de la campana sin anuncio en ese periodo. No se
  sustituyen por conversiones declaradas por las plataformas ni se recalculan
  en el cliente si backend los declara pendientes.
- `comparison` solo destaca `Menor coste por lead` con al menos dos anuncios
  activos, diez leads en **cada** anuncio activo, moneda conocida, inversion
  positiva, atribucion completa y sincronizacion reciente (<36 h). Comprueba
  por separado inventario y metricas del ultimo dia completo del periodo;
  refrescar una entidad o una metrica antigua no rejuvenece esa evidencia.
  Empates al centimo, cobertura parcial o datos viejos no declaran ganador.
  Es una comparacion descriptiva, no una recomendacion de pausar ni promesa.
- Tabla ordenable/paginada a diez filas, filtro de estado y dialogo del anuncio
  con identidad real y cinco metricas/comparacion anterior. Cerrar conserva la
  campana y su origen; cambiar scope/campana destruye solo el dialogo propio.

La ampliacion web descrita abajo aporta identidad de anuncio solo cuando llegan
parametros explicitos y se comprueba su pertenencia al inventario. No reconstruye
atribucion historica ni infiere anuncios de UTMs. Tampoco se ha incorporado
una vista previa de creatividad: el dialogo muestra datos de inventario, no una
imagen simulada. La tabla historica compartida Google conserva su indice previo
(sin adGroupId); este cambio no reconstruye datos antiguos que hubieran
colisionado ni sustituye la migracion/conciliacion de ese contrato.

Referencia de identidad: Google documenta la pareja grupo/anuncio en
[estructura de recursos](https://developers.google.com/google-ads/api/docs/concepts/api-structure)
y la retirada del ad sharing en
[su anuncio oficial](https://ads-developers.googleblog.com/2025/07/ad-sharing-functionality-will-be.html).
Los parametros explicitos de una futura integracion web deben respetar
[ValueTrack](https://support.google.com/google-ads/answer/6305348?hl=en), no usar
un UTM editorial como prueba.

No hay migracion nueva en esta ampliacion de lectura. La migracion de ejecuciones
de Optimiza **ya se aplico en la fase posterior** a la evidencia historica del
apartado precedente; tabla vacia. Este avance no habilita los tres gates, no
promueve staging y no completa aun el objetivo global de integracion.

Verificacion de este contrato: 512 tests backend, incluida atribucion de anuncios,
presupuestos, identidad nativa, scopes y regresion del workspace. Pasan tambien
los runners existentes de guided y de integracion marketing web/campanas.
La comprobacion funcional por anuncio usa datos aislados, nunca inserta leads,
citas o presupuestos de prueba en la base compartida. La bitacora frontend recoge
build, QA autenticado y limites de las lecturas reales frente a fixtures.

## Atribucion Opcional De Anuncios Web (2026-09-11)

Se reutiliza `/api/intake/leads`, su validacion de instalacion/dominio, deduplicado
y auditoria. La recepcion del contacto nunca depende de poder identificar anuncio.
No se duplican receptores ni se habilitan conversiones, CAPI o cambios en anuncios.

- SDK `3.4.8`: conserva parametros explicitos `cc_gads_ad_id`,
  `cc_gads_adgroup_id`, `cc_meta_account_id`, `cc_meta_campaign_id`,
  `cc_meta_ad_id`, `cc_meta_adset_id` junto a la atribucion existente de sesion.
  Una llegada publicitaria nueva sustituye el contexto previo; navegar sin
  parametros conserva la llegada inicial. El formulario generico, chat y modal
  usan el mismo `sendLead`; el formulario nativo no genera otro lead generico.
- El servidor exige cuenta/campana/anuncio numericos explicitos y un solo
  proveedor. Rechaza contradicciones entre campos/URLs, macros sin resolver y
  grupos ambiguos. Revalida clinica asignada, instalacion efectiva y dominio
  HTTPS. Google consulta el cache de anuncios por cuenta/campana/anuncio/grupo;
  Meta comprueba anuncio y adset, y conserva la identidad web v2 existente,
  incluida su instalacion y fingerprint. No hace consultas HTTP a proveedores.
- La auditoria guarda `attribution_steps.web_ad_identity`, version 1,
  `verified_by=workspace_web_ad_inventory`, aparte de `advertising_identity`.
  Es **pertenencia contrastada con inventario**, no prueba criptografica de clic
  ni consentimiento para enviar conversiones. No altera el contrato v2 de CAPI.
  La lectura por anuncio/presupuesto usa esta identidad, sin exponer contactos.
- Plugin preparado `2.0.0-alpha.10`, no instalado en webs de clientes por este
  trabajo. Admite seis campos nativos opcionales adicionales (limite 34) y los
  parametros validos de la URL. Metadatos de anuncio invalidos se omiten sin
  rechazar los datos del formulario; los demas controles siguen siendo estrictos.
- Compatibilidad con alpha.9: el SDK consulta `OPTIONS /_clinicaclick/intake`
  solo si hay formulario nativo same-origin. El receptor nuevo responde
  `{"native_web_ad_attribution":1}` sin secretos ni identificadores de instalacion.
  La consulta no cambia estado, no envia credenciales, no sigue redirecciones,
  no tiene cache persistente y nunca retrasa el envio. Antes de respuesta positiva,
  o con receptor antiguo/error, **no agrega los nuevos hidden fields**. Asi se
  evita que el antiguo parser estricto rechace formularios por campos desconocidos.
  Un envio anticipado puede quedar sin anuncio; el contacto sigue entrando.
- No se alteran artifacts firmados ni sus ETags, y no se instala o actualiza
  automaticamente ningun plugin. El relay JSON existente conserva los campos
  anidados sin necesitar la nueva capacidad del formulario nativo.

No se han reescrito sufijos de Google ni parametros Meta. Una campana sin estos
identificadores seguira contando en su nivel disponible, sin rellenar datos
historicos por nombre. El soporte de cada parametro publicitario y la preparacion
autorizada de URLs siguen siendo un contrato distinto de recibir formularios.
La colision historica del indice Google sin grupo sigue abierta. El detalle de
contenido real se incorpora en el apartado siguiente. Esta ampliacion no cierra
la implementacion global del mock.

Verificacion: 531 pruebas backend workspace/landings/paquete WordPress y 43 PHP
pasan. Chromium recorre seis escenarios con el SDK completo (1366/390 px,
formulario generico y nativo con receptor antiguo/nuevo), usando un relay local
aislado, sin escribir leads de clientes. Tambien pasa la regresion de Consent
Mode/Complianz. La suite ampliada frontend tiene 82/83 pruebas correctas: el
fallo preexistente de `intake_chat_admin_contract` busca textos literales en un
panel ya traducido; ni ese test ni el panel se modifican en esta ampliacion.

## Contenido Real Por Anuncio (2026-09-11)

`GET /api/marketing/campaign-workspace/ad-creative` recibe scope y la tupla
proveedor/cuenta/campana/grupo/anuncio. Comparte la autorizacion de lectura del
workspace (incluidos agregados intersectados con las clinicas autorizadas),
revalida inclusion y pertenencia y no devuelve tokens, formularios ni contactos.
La carga ocurre al abrir el anuncio, separada de los KPI y la salud.

- Google: textos, variantes y URL de `GoogleAdsAdInsightsDaily`, consulta exacta
  por cuenta/campana/grupo/anuncio y snapshot mas reciente. No usa la creatividad
  de otro anuncio o del conjunto ni llama a Google al abrir el dialogo.
- Meta: una lectura de `ad_id` con cuenta, campana y adset, comprobadas contra
  inventario y contra la respuesta Graph. Conexion y grants activos vuelven a
  comprobarse tras la lectura/cache. Se permite inspeccionar una campana sin
  clinica asignada cuando el ambito es dueno autorizado de la cuenta completa;
  no se asigna la campana ni se habilitan permisos de escritura por inspeccionarla.
- El normalizador conserva textos, imagenes/miniaturas, variantes y enlaces
  disponibles. No reconstruye una impresion supuestamente exacta ni usa HTML
  de proveedor/iframes. Un video se identifica como miniatura, no como reproductor.
  Si el contenido no se recupera, los resultados siguen visibles con un estado
  explicito. Las imagenes fallidas no se sustituyen por fotografias genericas.
- URLs HTTPS sin IPs literales (incluidas IPv6), credenciales/puertos/secretos;
  se filtra el hostname, pero no se certifica su resolucion DNS. Imagenes exclusivamente
  en los CDN `fbcdn.net`/`cdninstagram.com`, sin referrer. El cliente usa bindings
  normales, enlaces con noopener/noreferrer y textos escapados, no innerHTML.
- Cache Redis con namespace de entorno y clave derivada de referencia, ambito,
  asignaciones, conexion y revision del anuncio. Persiste entre recargas y
  procesos API, TTL 24h; errores se conservan 60s, salvo una pausa de cuota, que
  se conserva hasta su `retryAt` (maximo 24h). Se valida autorizacion antes
  de leerlo, incluso en hit. No se almacena token ni datos de pacientes. Las
  llamadas simultaneas al mismo recurso en el proceso comparten la promesa.
  Peticiones de recursos distintos esperan tambien la misma conexion inicial
  de Redis; no fallan por estar conectandose otra consulta.
  Si Redis falla, la creatividad queda no disponible, sin provocar un aluvion
  de llamadas Graph ni impedir consultar resultados.
- Este cache de contenido se renueva bajo demanda al caducar: no sustituye el
  job nocturno del informe ni dispara un recorrido de todas las creatividades
  al entrar en Resumen. Google lee su tabla de sincronizacion existente; la
  cobertura nocturna por anuncio sigue pendiente, como se detalla abajo.
- La pausa compartida de Meta (`META_RATE_LIMIT_PAUSED`/`META_RATE_LIMITED`)
  tiene estado propio y fecha de reintento. La UI no pide reconectar; mantiene
  los resultados y bloquea el reintento hasta esa fecha. El temporizador solo
  habilita el boton, no hace polling ni peticiones automaticas al proveedor.

Referencias de campos: SDK oficial Meta para
[Ad](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/ad.py)
y [AdCreative](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adcreative.py).
No se usa la antigua aproximacion de creatividad por adset del detalle de estrategia.

Verificacion del contrato: 509 tests workspace, incluidos catorce de acceso,
pertenencia, normalizacion, cache y revocacion durante lectura. Cache Redis real
verificada entre dos procesos con claves de QA aisladas y borradas al terminar.
81 tests frontend; la prueba del componente tambien cubre pausa, reintento manual y cancelacion del
temporizador al cambiar de contexto o cerrar el dialogo.
No hay migraciones ni cambios en anuncios, conversiones, senales o cobros.

### Cobertura Pendiente Detectada En QA

Lectura de DEV del 2026-09-11: 143 filas en `GoogleAdsAdInsightsDaily`, ultima
fecha de metricas 2026-03-16 y actualizacion 2026-03-23. El inventario de campanas
si tiene filas recientes, pero no prueba sincronizacion de sus anuncios.
`_syncGoogleAdsAccount` del job compartido consulta `ad_group` y `campaign`;
la escritura de `GoogleAdsAdInsightsDaily` solo esta en el analisis bajo demanda
de `campaignOnboarding.controller`. Por eso no hay anuncios Google en el informe
actual de 7/30 dias. No trasladar filas antiguas al periodo actual ni rellenar
ceros para ocultar el fallo. Falta integrar refresco nocturno por anuncio,
separar inventario de rendimiento diario y resolver el indice historico que
omite `adGroupId` antes de ampliar los escritores.

Meta estaba en pausa compartida hasta 2026-09-11 08:45:38 Europe/Madrid durante
la prueba. Se respeta el limite; una captura con el estado de pausa no acredita
que haya cargado una imagen real. Los estados de contenido y variantes se
validan ademas con respuestas aisladas de QA, sin modificar datos de clientes.
