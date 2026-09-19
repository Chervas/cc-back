# Consumidores Google públicos — candidata del API

> **Tipo:** runbook de preparación y validación.
> **Fuente de verdad:** alcance de la candidata; no acredita publicación ni aceptación real de Google.
> **Última revisión:** 2026-09-19.
> **Relacionado con:** [contrato backend](../../src/Documentacion/13-backend.md#consumidores-google-publicados-en-dev-con-activación-pendiente), [esquema aplicado](google-clinical-cut.md), [estado central](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).

## Estado y alcance

Candidata **no publicada** `dc8b80dcfd22d9068703210faec5861d83366d08`, rama
`security/google-public-candidate-20260919`, sobre API público `48d69879`.
164 archivos de producto y 71 de QA seleccionados desde DEV; correcciones de
fixtures desarrolladas/pusheadas primero en `7c88991f`. Se preservan los cambios
del API que no pertenecen a esta composición. No se ha actualizado staging,
gateway, frontend ni ninguna release ejecutada; no hay nuevas DDL aplicadas,
credenciales migradas, grants o flags activados.

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
- Cinco modelos adicionales contrastados solo contra `information_schema`:
  inventario/días/estadísticas de anuncios y configuración/eventos de workspace.
  Sus columnas existen. Se incluyen sus cinco migraciones históricas como fuente,
  sin ejecutarlas. Esta comprobación de columnas no acredita todos sus índices,
  permisos ni comportamiento con cardinalidad clínica real.

No se han realizado pruebas visuales de una composición pública nueva en este
corte: frontend y gateway todavía requieren sus propias candidatas. El login
publicado verificado en el [corte de esquema](google-clinical-cut.md) es anónimo
y corresponde al código público anterior. La aceptación MFA/Google real y la
capacidad con carga real siguen pendientes.

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

## Siguiente publicación y recuperación

1. Componer gateway desde su propia base y frontend desde el build público;
   verificar sus dependencias, contratos e interfaz con las candidatas finales.
2. Revisar toda la identidad Google compartida y todos sus consumidores antes
   de crear el primer marcador que cierre credenciales legacy. La preparación
   de código no autoriza ampliar ámbitos ni reactivar históricos.
3. Preparar dependencias reales desde locks y un plan de publicación nuevo,
   identificado por revisiones, procesos/configuración actuales, barreras y
   recuperación. No reutilizar el plan SQL consumido ni scripts con PID antiguos.
4. Mantener MFA, DEV clínico apagado, pausas y permisos existentes. Conservar
   esquema aditivo y releases anteriores; no ejecutar down ni restaurar filas
   antiguas sobre actividad posterior.

AWS SSO se comprobó caducado a las 18:36 UTC; no hay login nuevo iniciado ni
operación AWS pendiente en ejecución. Renovar con el titular disponible para
continuar la configuración remota. Sigue pendiente el objetivo completo de
WhatsApp, Google, Meta, IA, correo, auditoría y certificados. Rotación aplazada;
copias generales al final. Sin recursos AWS nuevos ni recogida CE en este corte;
coste incremental facturado no atribuido.
