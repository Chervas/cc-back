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

## Verificacion Inicial 2026-09-10

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
