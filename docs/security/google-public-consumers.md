# Consumidores Google públicos — candidatas del API, gateway e interfaz

> **Tipo:** runbook de preparación y validación.
> **Fuente de verdad:** alcance de la candidata; no acredita publicación ni aceptación real de Google.
> **Última revisión:** 2026-09-19.
> **Relacionado con:** [contrato backend](../../src/Documentacion/13-backend.md#consumidores-google-publicados-en-dev-con-activación-pendiente), [esquema aplicado](google-clinical-cut.md), [estado central](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).

Manifiesto de revisiones y límites: [google-public-consumers.json](google-public-consumers.json).

## Estado y alcance

Tres candidatas guardadas en remoto, **ninguna publicada**:

| Consumidor | Revisión candidata | Base pública | Rama |
| --- | --- | --- | --- |
| API | `6ee76c4f` | `48d69879` | `security/google-public-candidate-20260919` |
| Gateway | `e6c6a618` | `fdb2636a` | `security/google-gateway-candidate-20260919` |
| Frontend | `4fc44b6c` | `27afa85c` | `security/google-public-front-candidate-20260919` |

El producto API sigue siendo la composición `dc8b80dc`: 164 archivos de producto
y 71 de QA; el commit siguiente solo mejora tres fixtures visuales. Gateway toma
esa selección desde su propia base, conserva su catálogo de errores WhatsApp y
añade la utilidad de calendario que sus lectores necesitan. No reemplaza su
autenticación, transporte TLS, entrada WhatsApp, workers ni configuración con los
del API. Su cierre de dependencias encuentra 444 módulos sin imports relativos
ausentes y verifica 14 archivos críticos intactos.

Frontend selecciona controles de OAuth, altas, retirada, mapping y conversiones.
Conserva las rutas públicas anteriores y añade «Revisar envíos a Google» en el
asistente existente, reutilizando el diálogo de recibos. No necesita publicar el
workspace general. Correcciones desarrolladas primero en DEV: backend `bb2b72cc`
y `0571765e`; frontend `20f16dac`. Sin nuevas DDL, credenciales migradas, grants,
flags, reinicios ni publicaciones. Las dependencias enlazadas son solo para QA.

La composición contiene lectores GBP/SC/GA/Ads, OAuth, altas y revocaciones,
conversiones, recibos y diarios de acciones/destinos. Los archivos compartidos de
OAuth, onboarding y sincronización se concilian por funciones y rutas desde sus
versiones públicas; no se copia íntegramente el desarrollo de campañas de DEV.
Las dependencias de permisos, contexto de conversión y caché sí acompañan a sus
consumidores. Las rutas generales de workspace no se montan. Los endpoints tipados
de acciones, destinos y recibos conservan autenticación, ámbitos y rate limits.

Quince archivos de autenticación/sesiones, aplicación, configuración SQL, flujos,
WhatsApp, colas, TLS y locks de dependencias coinciden exactamente con la base.
El scheduler conserva todas las definiciones de sus **42 tareas anteriores** y
añade solo cinco conciliadores Google. Sus flags siguen siendo requisitos de
ejecución; la candidata no activa ningún trabajo. El catálogo DEV de 52 tareas
pertenece a una composición distinta y no se impone a CRM para hacer pasar QA.

## Evidencia disponible

- **379 casos correctos**, cero fallos/skips/cancelaciones, en 54 archivos de QA.
  Precarga aislada: no lee `.env`, niega sockets ajenos y sustituye colas/SQL de
  producción. Los servidores HTTP propios se permiten expresamente.
- Scheduler probado con la suite de la base pública y las cinco comprobaciones
  de gates Google de DEV. Una comparación adicional verifica cada definición
  anterior completa y permite únicamente esos cinco nombres nuevos. No se
  afirma cobertura de los trabajos DEV que no forman parte de la candidata.
- **Ocho ensayos MySQL, 159 grupos**, todos correctos y con cierre limpio:
  bootstrap, diagnóstico combinado, altas, entrega de conversiones, acciones,
  destinos, leads y revisión de recibos. SQL/SQLite, sesiones persistentes y HTTPS
  son reales y propios del ensayo; Google, Secrets Manager y S3 son ficticios.
  Cubren pérdida de ACK, permisos retirados, reinicio, resultados inciertos y
  ausencia de reenvío, preservación de metadatos Meta y prohibición de leer tokens
  en consumidores gestionados. No se usaron sesiones clínicas ni proveedores reales.
- Preflight de solo lectura con fuente candidata ya commiteada: **49 tablas**,
  sin incidencias ni migraciones de seguridad pendientes; digest clínico
  `4a048c98f80fe991e10cf862b3c4c578df0bd7aebddd85a37ed5581cf02ed2d5`.
- Gateway: **411 casos** en 57 archivos, sin fallos/skips/cancelaciones, incluidos
  los contratos propios de alta WhatsApp. Ocho ensayos MySQL/HTTPS, **159 grupos**,
  con cierre limpio. Se mantiene su TLS distinto del API durante esas pruebas.
- Preflight de gateway ya commiteado `e6c6a618` con las configuraciones efectivas
  de staging y gateway, contra metadata clínica: **49 tablas**
  compatibles, sin migraciones de seguridad pendientes, mismo digest `4a048c98…`.
- Cinco modelos auxiliares contrastados contra `information_schema`: **77 columnas
  y 14 índices declarados, incluidos los primarios**, sin diferencias en tipos,
  nulabilidad, defaults explícitos, autoincremento, orden/unicidad y prefijos de
  índices. No lee filas clínicas ni ejecuta sus migraciones históricas. No acredita
  cardinalidad, planes de consulta o rendimiento bajo carga real.

### Interfaz y pruebas integradas

Frontend: **35 casos**, build de producción correcto `bfdf8ec38c401938`, inicial
4,59 MB (advertencia del presupuesto 3 MB, por debajo del error de 5 MB). Cinco
recorridos Chromium generan **115 capturas**: OAuth, servicios por ámbito, retirada,
alta Ads, planes, permisos y recibos. Los diálogos incluyen 100 comprobaciones,
resultados inciertos, pérdida de respuesta, cambio de ámbito, sesión caducada y
ausencia de reenvío. Son componentes reales con respuestas HTTP ficticias.

Otros cuatro ensayos unen frontend candidato → HTTP → sesión SQL → broker HTTPS y
SQLite propios: **41 grupos y 21 capturas**, sin errores JS/red externa y con cuatro
cierres MySQL limpios. Google/AWS y el titular siguen siendo ficticios. La prueba
de recibos usa el fragmento y métodos reales de entrada del asistente; rechaza
capacidad apagada, modo legacy, ámbito ausente, cuenta ajena y carga pendiente sin
consultas. Después lista recibos retirados, consulta SUCCESS/PARTIAL_SUCCESS y
limpia la pantalla tras revocar la sesión SQL, sin ingestiones adicionales.
No representa todo el asistente autenticado de una clínica real.

Build completo servido en preview propio: dos capturas de login1440/390 contra
el API DEV real, sin respuestas API simuladas. `/auth/me` y estado Google devuelven
401, formulario vacío no hace POST, sin JS/5xx/desbordamiento. El SDK externo Meta
se bloquea expresamente. Preview y navegadores cerrados al terminar. Total de este
corte: **138 capturas**; se inspeccionan estados de alta incierta, recibos, sesión
revocada y pausa Meta. No son 138 pruebas de aceptación clínica.

La aceptación MFA/Google real y la capacidad bajo carga siguen pendientes. Las
136 capturas de componentes no sustituyen los dos del build completo ni
ninguno acredita publicación de estas candidatas.

## Diagnóstico de la preparación

Las primeras composiciones revelaron importaciones faltantes, diferencias de
orden al insertar handlers y dependencias de validación de conversiones anteriores
a los cambios de broker. Se corrigió la selección preservando el middleware de
autenticación y el guard de ámbito; los handlers nuevos quedan después de la
autenticación. La candidata final supera las pruebas HTTP correspondientes.

Siete fallos iniciales también se reproducían en DEV: un fixture GBP no registraba
las rutas Meta compartidas, el ensayo legacy usaba el broker global en lugar de
su dependencia ficticia y la prueba del selector Ads esperaba el handler antiguo.
Los fixtures ahora registran Meta con rechazo explícito a cualquier uso, inspeccionan
la selección antes de credenciales y comprueban inventario, transporte y permisos
después de consultar. No se relajaron guards del producto. El primer MySQL falló
por faltar el almacén ficticio de secretos en la composición de QA; terminó
limpiamente antes de reintentarlo con la dependencia canónica.

Evidencia privada:
`qa-evidence/security-resume-20260917/google-public-candidate-20260919/`.
Incluye selección/hash por archivo, comparación de invariantes, logs de fallos y
correcciones, resultados finales, estado AWS y preflight. Las dependencias Node
del worktree son enlaces de QA: no se deben publicar como dependencias del runtime.

Continuación: `qa-evidence/security-resume-20260917/google-public-ui-gateway-20260919/`.
El primer ensayo gateway falla por faltar el calendario compartido y por un fixture
WhatsApp que empaquetaba errores sin su catálogo auxiliar; ambos se corrigen antes
de los 411 casos finales. El ensayo nuevo de recibos detecta que el montaje del
fixture crea el botón fuera de NgZone: se ejecutan sus cambios sintéticos dentro
de Angular y se espera un estado terminal visible. El producto no pierde guards.
La revisión SQL corrige el serializador ENUM de la herramienta y compara los
defaults numéricos por valor (`0` y `0.000000`), conservando los resultados previos.

## Consumidores que todavía impiden retirar la credencial compartida

El inventario identifica `updateReviewReply`, `deleteReviewReply`, `publishPhoto`
y `updateSpecialHours` en `businessProfileLocal.service.js`. Fuente DEV ya conecta
sus recorridos manuales gestionados al broker, diario SQL, auditoría v25, rutas de
recuperación y UI. Las fichas no migradas conservan `ensureGoogleAccessToken` con
el guard de credenciales legacy. El nodo de horarios también está adaptado en
fuente, con intento estable, comprobación del job vigente y recuperación de recibo
sin reenvío; pasa pruebas aisladas de respuestas tardías y permisos cambiantes.
Faltan resolución operativa de incertidumbres, publicación/DDL y aceptación real.
El sync preparado invalida
lecturas anteriores a otra mutación/observación mediante coordinación SQL por
ubicación y familia; se prueba de forma aislada, aún sin aceptación del proveedor. Las candidatas públicas de este
documento aún no incorporan esa preparación.
Contrato y límites en [escrituras GBP](google-business-profile-writes.md).

Antes del primer marcador de cierre hay que migrar esos consumidores conservando
permisos, validación de activo y automatizaciones; probar pérdida de ACK, resultado
incierto y actualización local sin repetir la mutación. Deshabilitarlos para hacer
pasar el corte no satisface la migración. El censo de búsqueda es parcial: también
deben revisarse OAuth, sync, Ads, propiedades y la cuenta de servicio BigQuery
independiente. Cero cohortes Google reales migradas en este corte.

## Siguiente publicación y recuperación

1. Completar la aceptación real de horarios y la resolución operativa de incertidumbres,
   corte SQL nuevo de tres tablas y compatibilidad de auditoría v25. Promover las
   escrituras Business Profile y su UI a cada candidato que las consuma, con QA.
2. Completar toda la identidad Google compartida y todos sus consumidores antes
   de crear el primer marcador que cierre credenciales legacy. La preparación
   de código no autoriza ampliar ámbitos ni reactivar históricos.
3. Preparar dependencias reales desde locks y un plan de publicación nuevo,
   identificado por revisiones, procesos/configuración actuales, barreras y
   recuperación. No reutilizar el plan SQL consumido ni scripts con PID antiguos.
4. Mantener MFA, DEV clínico apagado, pausas y permisos existentes. Conservar
   esquema aditivo y releases anteriores; no ejecutar down ni restaurar filas
   antiguas sobre actividad posterior.

AWS SSO volvió a comprobarse caducado durante esta continuación; no hay login nuevo iniciado ni
operación AWS pendiente en ejecución. Renovar con el titular disponible para
continuar la configuración remota. Sigue pendiente el objetivo completo de
WhatsApp, Google, Meta, IA, correo, auditoría y certificados. Rotación aplazada;
copias generales al final. Sin recursos AWS nuevos ni recogida CE en este corte;
coste incremental facturado no atribuido.
