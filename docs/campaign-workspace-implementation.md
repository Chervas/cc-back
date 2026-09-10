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
- Presupuestos aceptados: `null` hasta disponer de una relacion canonica y
  verificable presupuesto -> paciente -> interesado -> campana. `EconomicBudget`
  tiene importe aceptado real, pero no la atribucion publicitaria. No usar precios
  del catalogo, facturas, cobros ni repartos estimados.
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
- Optimiza: auditar y conectar capacidades efectivas de ambos proveedores. El
  onboarding actual solo admite Google para guided_improvement. Nunca anunciar
  ajustes Meta como activos si el ejecutor no los soporta.
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
