# Campanas: criterios de cierre y evidencia vigente

Estado al 28/09/2026: **EN CURSO**. No equivale a activacion publicitaria.
Contrato UX: front `src/Documentacion/20.17-marketing-arquitectura-experiencia-objetivos.md`,
apartado 19 y sus revisiones. El Plan Gestionado queda **aplazado por el titular**,
no implementado ni aprobado por arrastrar su codigo anterior.

## Lo instalado

- API DEV aislada: `7285c6f6526978e4145777b405e4b813af39ad0f`, unidad
  `clinicaclick-back-dev.service`, BD ficticia `clinicaclick_dev_isolated`.
- Front DEV: fuente `8f06408df`, build `46666b9cf5e19833`, main
  `main.2662a192537bcec1.js`, servido en `http://localhost:4203`.
- Preflight de seguridad compatible. Tablas Settings/OptimizationRuns/Events:
  presencia, campos JSON requeridos, estado resolved e indices unicos comprobados
  mediante information_schema READ ONLY; no lectura/escritura de datos de app.
- MFA/sesiones enforce, workers/cron de negocio apagados y gates de campanas sin
  activar. El escritor AWS y sus grants nuevos **no estan instalados/habilitados**.
- Sin publicacion en staging/gateway, OAuth, pruebas con pacientes, senales,
  cambios de anuncios/presupuestos ni cobros.

## Matriz de aceptacion

Una prueba de contrato no acredita por si sola el recorrido integrado. Una
lectura cacheada no acredita recepcion real ni entrega a un proveedor.

| Requisito | Fuente / evidencia disponible | Lo necesario antes de cerrarlo |
|---|---|---|
| Hub y objetivo conservados, breadcrumb unico y retorno al origen | Rutas/componentes productivos; `campaign_canonical_navigation.test.js`; QA anterior documentada | Repetir navegacion autenticada del build instalado, Atras/Adelante, reload y tres anchos |
| Inicio simple: conectar, preparar, revisar | `campaign-workspace.component` y endpoints configuration/preparation/activation; tests de comandos/lifecycle | Recorrido integrado desde cuenta vacia hasta resumen con fixtures DEV, cancelar/volver sin perder origen |
| Google/Meta, cuentas e incorporacion | WorkspaceSettings/SharedAccount/Assignment; tests de seleccion, scope y cuentas compartidas. Google: descubrimiento tipado Search/PMax -> inventario -> seleccion real probado con fixtures; nueva campana -> lead CRM sin campana local ni emparejado | Repetir el recorrido integrado con sesion DEV y comprobar la excepcion compartida en UI. Las pruebas aisladas no acreditan sincronizacion/recepcion del proveedor real. OAuth real no se ejecuta en DEV ni reactiva Meta |
| Web, privacidad y formularios | Preparacion web reutilizable; WorkspaceReception/GoogleDestination/NativeReception; tests web/reception/destinos | Recorrer instalar/comprobar/cancelar y recibir un formulario sintetico por el circuito autorizado. Un check de metadata no prueba entrega |
| Medicion de interesados y senales separadas de ajustes | WorkspacePreferences/SignalAuthorization/Activation; dialogos Google/Meta y tests de autorizacion | Confirmacion por destino/hito, retirada y recibo trazable en entorno autorizado; sin envios reales durante QA visual |
| Optimiza conserva permiso, limite y responsabilidad | Ejecutor, evidencia, contabilidad mensual, escritor/cliente aislados; 1.302 backend y 883 broker en el corte anterior | Instalar cohorte/grants solo con corte aprobado; validar recepcion y cuenta correctas antes de cualquier ejecucion real |
| Incertidumbre sin reenvio ni falso exito | Revision manual CRM/broker, firma/SQLite/HTTPS; 18 capturas con API ficticia y CSS publicado | Revisar comandos started abandonados, recursos no verificables e identidades cambiadas sin desbloqueo por tiempo. QA autenticada del historial |
| Cinco KPI, comparativa y presupuestos aceptados | WorkspaceReport y CampaignEconomicAttribution; tests de atribucion y rendimiento, QA anterior de Propdental | HTTP/UX del candidato instalado sin sustituir informe. No confundir presupuestos aceptados con ingresos cobrados |
| Campanas y anuncios comparables, creatividad y ganador prudente | campaign-report y contrato por anuncio; tests de resultados/creatividad | Tabla/filtros/paginacion/retorno y anuncio sin evidencia a tres anchos; no inventar ganador ni conversiones de plataforma como leads CRM |
| Salud en seis bloques, agregado honesto | WorkspaceHealth/SignalEvidence; tests de deduplicacion, cobertura, estados y permisos | Abrir cada bloque, todas sus incidencias y retorno; ambito clinica/grupo sin falso OK por falta de datos |
| No usar datos de demo en producto | Servicio HTTP productivo, informe backend; prototipo sigue aislado | Aceptacion integrada sin sustituir APIs. Reutilizar estilos/navegacion del prototipo no implica usar sus snapshots |
| Plan Gestionado | Entrada apagada por feature flag; peticion posterior del titular | Fuera del cierre actual; requiere mock y aprobacion propios, sin cobros ni automatismos |

## Evidencia de este corte

- Indice y nueve referencias JS/CSS (incluidas duplicadas del HTML) coinciden
  por bytes con la release, HTTP200 y Cache-Control no-cache. Auth/me e informe
  responden 401 sin sesion tanto en API3004 como a traves del preview4203.
- Chromium en pestana propia del VNC confirma redireccion a sign-in sin errores
  JS/desborde: **no hay aceptacion autenticada nueva**. La prueba bloquea salida
  ajena al origen local, incluido el intento de carga del SDK publico de Facebook;
  no autentica ni solicita permisos Meta. Acceso humano solicitado, sin obtener
  cookies/tokens, cambiar contrasenas, desactivar MFA o fabricar sesiones.
- QA aislada de destinos e historial: componentes/HTTP/Fuse reales, API ficticia
  loopback, 33 capturas a 1440/1024/390 sin cortes, errores o trafico externo.
  CSS exacto `styles.e77c00ef9cab99ee.css`, seleccionado desde index.html mediante
  el parser HTML del toolchain, no buscando el primer asset antiguo del directorio.
- 138 tests frontend correctos; cuatro nuevos cubren seleccion CSS, duplicados
  noscript, ambiguedad y rutas ajenas. Evidencia privada temporal:
  `/tmp/cc-campaign-dev-release-20260928/`, logs
  `/tmp/cc-campaign-dev-{build,review-qa,destinations-qa,frontend-regression}-20260928.log`.

## Incorporacion Automatica: Revision Aislada

Revision adicional de incorporacion (28/09): `google_ads_sync_pipeline.test.js`
encadena los metodos reales de sync reciente/backfill, persistencia de inventario
y seleccion del workspace con dependencias de proveedor/BD ficticias. Search y
PMax no requieren anuncios ni filas de metricas para aparecer. `include_future`
incluye ambas; quitarlo o retirar la cuenta respeta la seleccion explicita.
El contrato del broker verifica que el descubrimiento no filtre por actividad
ni fecha. `campaign_google_lead_reception.test.js` comprueba dos campanas
sucesivas, recepcion sin duplicado local, deduplicacion y exclusion posterior.
La suite canonica de campanas incluye ahora tambien el pipeline Google, antes
fuera de su seleccion de archivos. Sin cambios en codigo productivo ni runtime.
Los contratos de autorizacion existentes rechazan nuevas campanas en Optimiza
aunque la cuenta permita incorporacion automatica: recibir/medir no amplian el
mandato de ajustes. Regresion ejecutada con `campaign_offline_runtime.cjs`, que
bloquea sockets de proveedor/BD y colas; las filas y contactos son ficticios.
La prueba real en pestana propia del VNC vuelve a `/sign-in`; el acceso CRM no
acredita una sesion DEV. No se extraen cookies ni se fabrica autenticacion.
Logs de este corte: `/tmp/cc-campaign-incorporation-regression-20260928.log`
y `/tmp/cc-campaign-incorporation-broker-20260928.log`.
Resultado: 1.295 pruebas de la suite canonica de campanas y 8 del contrato
broker de sincronizacion, todas correctas. Estos conteos describen los archivos
ejecutados en este corte, no sustituyen el alcance mas amplio del corte previo.

## Siguiente validacion

1. Sesion humana en localhost:4203, sin exportarla desde CRM. Repetir recorrido
   instalado con sus APIs reales; registrar vacios y gates cerrados como tales.
2. Completar pruebas integradas con datos ficticios DEV, sin abrir proveedores.
   Las pruebas que sustituyan respuestas se rotulan como aisladas, no E2E real.
3. Resolver los contratos pendientes senalados en la matriz. Para contrastar
   Google real, Dental - Parallel Campaign `1851215478`, en su entorno y grant
   autorizados; no cargar credenciales clinicas en DEV ni usar Propdental normal.
4. Publicacion/lecturas/escrituras de proveedor, recepcion real y entrega de
   senales requieren su corte y evidencia separados. Nunca reactivar Meta para
   conseguir un test verde. No marcar el objetivo completo antes de esta matriz.

Rollback DEV: conservar BD, datos, claves y pausas. API anterior
`/opt/clinicaclick-dev/release-e3fb71c31d9accb4cd01e39e6ad12d5972d947a1`;
frontend anterior `/home/ubuntu/www/front-multiarea-history-20260927-kmOIhV`.
El nuevo destino conserva los assets anteriores. No restaurar el PM2/BD
compartidos ni credenciales historicas. Procedimientos operativos front 25/30/31.
