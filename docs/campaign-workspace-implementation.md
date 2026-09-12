# Campaign workspace: implementacion en curso

Estado: EN CURSO. El mock aprobado NO se considera implementado por publicar el
contrato de lectura. La ruta canonica se integra solo en el preview DEV; no
promover a staging/produccion ni abrir los gates hasta completar los contratos,
las pruebas de permisos y el QA autenticado. Referencia UX canonica en front:
`src/Documentacion/20.17-marketing-arquitectura-experiencia-objetivos.md`, apartado 19.

## Cache Por Anuncio Aplicada Con Autorizacion (2026-09-12)

El usuario autoriza expresamente la migracion compartida y el refresco exclusivo
de Dental - Parallel Campaign `1851215478`. Este apartado sustituye los pendientes
de autorizacion/migracion/cache de los cortes historicos siguientes, no autoriza
jobs, asignaciones, senales, publicidad, OAuth ni Meta.

- 04:25:08-09 UTC / 06:25:08-09 CEST: ejecutor local
  `/home/ubuntu/scripts/cc-propdental-ad-schema-authorized.js` aplica SOLO
  `20260912010000-add-google-ad-delivery-observation.js` y su entrada SequelizeMeta.
  JSON nullable verificado; no carga app/indice de modelos ni otras migraciones.
  Respaldo previo del esquema y 19 filas de inventario, 670 metricas, 59 dias
  de cobertura de la cuenta/ventana. MySQL DDL tiene commit implicito; no se
  presenta como transaccion reversible automatica.
- 04:25:29-35 UTC / 06:25:29-35 CEST: ejecutor de cache preparado, cinco consultas
  Google Search v24 HTTP200 con token existente, sin renovarlo. Mapping11/grupo5,
  14/07-11/09: 19 anuncios, 688 filas de metricas, 60 dias completos. Conciliacion
  Search de 247 combinaciones campana/dia, 2.892.595.420 micros en ambos lados.
  PMax no se interpreta como inventario ad_group_ad ni se rellena con ceros.
  Respaldo propio y lectura de verificacion antes del commit, resultado
  `committed_and_verified`. Sin cambios de campanas, pujas, presupuesto o leads.
- Evidencia privada: `/home/ubuntu/qa-evidence/propdental-ad-schema-2026-09-12T04-25-08-301Z-89Wr6L/`
  y `/home/ubuntu/qa-evidence/propdental-ad-cache-apply-2026-09-12T04-25-29-461Z-YUzxh5/`.
  before.json/result.json, SHA256 registrados; directorios0700 y respaldos0600.
  No restaurar/repetir sin comprobar nuevas observaciones y nueva autorizacion.
- API y Chromium delegado Carlos, clinica/grupo, 1440/1024/390: 105 comprobaciones,
  16 capturas, sin errores JS/desbordes. Hospitalet Search concilia 99,076192 EUR
  actual y 180,020892 anterior, 30/30 dias en ambos. Aviso antiguo desaparece;
  anuncios 78,44 y 20,63 EUR, un lead sin anuncio identificado: sin CPL por
  anuncio ni ganador inventados. Capturas de anuncios escritorio/movil revisadas.
  `/home/ubuntu/qa-evidence/campaign-authenticated-2026-09-12T04-26-42-543Z/result.json`.
  Nuevo modo QA `--require-refreshed-ad-coverage`; se conserva el modo previo
  para verificar casos incompletos. Sesion aislada cerrada al terminar.
- No build/reinicio/promocion: preview e81492ec0b86bc51 y lectores DEV existentes.
  Nueve flags false revalidados 04:27:48 UTC. DEV1335829/8577, staging1074087/46,
  gateway1039243/37, preview1054768/40 sin cambios. El nuevo escritor se ejecuto
  standalone; su despliegue normal y ciclo nocturno siguen pendientes.

Seguridad, solo revision solicitada: el fallo historico getAssetStats sigue
presente en fuente DEV/staging y vuelve a reproducirse con centinelas ficticios,
sin DB/proveedores. No demuestra explotacion ni origen del incidente. No se
cambia codigo de seguridad, almacenamiento, tokens o permisos en este corte.

## Presupuestos: Contraste Propdental Y Aceptacion Real Aislada (2026-09-12)

Revision READ ONLY de las seis clinicas activas comunicadas por el usuario
(19,35,36,56,58,59), cuenta `1851215478`, 03:46:11 UTC / 05:46:11 CEST.
En `EconomicBudgets` hay un presupuesto `presented` en Sants y uno `rejected`
en Nou Barris; ninguno `accepted/partially_accepted`, tampoco sin fecha.
Ventanas del informe: actual 13/08-11/09, anterior 14/07-12/08, Europe/Madrid.
No se consultan precios, pacientes, contactos, lineas o importes bancarios.
El API real delegado de Carlos devuelve 200 para grupo5/Hospitalet y cero
aceptados en campanas asignadas; las no asignadas conservan null. Los totales
del grupo incluyen otras sedes/cuentas: no extrapolar las seis clinicas a todo
el grupo. Evidencia privada:
`/home/ubuntu/qa-evidence/propdental-workspace-2026-09-12T03-46-11-551Z/result.json`.
Modo reutilizable `cc-propdental-workspace-readonly.js --authorized-carlos-propdental-readonly --budget-trace`.

No existia una aceptacion positiva real para contrastar. Se anade
`src/scripts/tests/campaign_budget_trace_mysql.integration.js`: usa el servicio
productivo `patientEconomics.transitionBudget`, los modelos economicos y el
lector/informe reales sobre MySQL temporal. Aceptacion total 623,45 EUR,
parcial 123,45 EUR; el KPI usa `accepted_amount` del snapshot aceptado, no
consulta el catalogo ni equivale a cobros. Citas repetidas con un lead anterior
al periodo cuentan cada presupuesto una vez. Verifica comparativa, rechazo,
borrador, sustitucion y rollback del importe/estado si falla la auditoria.
Las fechas de comparativa se controlan solo en el fixture, no hay backdating
en la app. No modifica el contrato de atribucion: IDs legacy web suficientes
para contar contactos no son prueba economica por si solos; sin identidad
verificada la aceptacion queda ambigua. El informe solo expone agregados.

56 contratos enfocados y ocho comprobaciones MySQL 8.0.42 correctos; instancia
PID1341124 terminada con codigo0, sin conexiones ajenas. Logs
`/tmp/propdental-budget-trace-{contracts,mysql}-20260912.log` y evidencia
`/tmp/cc-campaign-opt-mysql-eQMDre/result.json`. La prueba positiva es aislada,
no una aceptacion de un paciente de Propdental ni una prueba de firma/cobro/envio.
Sin cambios en codigo productivo, interfaz, schema o datos compartidos; sin
OAuth, Meta, proveedores, reinicios/build/publicacion. La migracion/refresco de
anuncios siguen esperando autorizacion. No se repite Chromium: QA 106/16 previo.

## Ejecutor Acotado De Cache Por Anuncio (2026-09-12)

`src/scripts/repair_propdental_ad_cache.js` esta preparado y probado, NO ejecutado
contra servicios/DB reales. La autorizacion solicitada para migracion y cache
compartida sigue pendiente. Un flag de CLI o una continuacion del objetivo no
sustituyen esa autorizacion. Solo despues de obtenerla y aplicar por separado
la migracion aditiva aprobada, desde `back-dev`:

```bash
node src/scripts/repair_propdental_ad_cache.js --authorized-account-1851215478-ad-cache-write
```

- Fija customer `1851215478`, mapping 11, grupo 5, moneda EUR y calendario
  Europe/Madrid. Rechaza PROPDENTAL normal, cambios de identidad, esquema sin
  JSON nullable, permisos revocados, jobs Google pendientes/en curso y gates
  incidentales abiertos. No carga el indice de modelos, app, workers o cron.
- Solo permite las consultas Search v24 predefinidas para esa cuenta. Captura
  inventario completo y 60 dias cerrados; concilia diariamente el gasto Search
  con campanas antes de escribir. PMax no se compara como `ad_group_ad`.
  Limita peticiones/paginacion, no sigue redirects ni renueva tokens. Errores,
  respuestas parciales, token caducado o captura de mas de cinco minutos detienen
  el proceso sin fabricar ceros o sustituir datos incompletos.
- `before.json` contiene las filas previas de las tres tablas afectadas, solo
  cuenta/ventana; inventario completo de esa cuenta. Directorio 0700, fichero
  exclusivo 0600, fsync y SHA-256 verificado antes de escribir. Incluye contenido
  de anuncios/URLs: es respaldo privado, no adjuntarlo a tickets o prompts.
- El nuevo hook interno `afterReplace` verifica inventario/aprobacion, cada
  metrica y cobertura dentro de la transaccion, antes del commit; tambien vuelve
  a comprobar gates/permisos. Una discordancia revierte las tres tablas. Respeta
  la precision DECIMAL(18,6) de conversiones; importes en micros son exactos.
  No cambia atribucion revisada, otras cuentas, fechas ajenas, leads o publicidad.
- `result.json` registra respaldo, verificacion y estado de escritura. Un fallo
  de confirmacion puede quedar `transaction_attempted_unconfirmed`: contrastar
  DB/evidencia antes de reintentar. No existe restauracion automatica; una
  restauracion aprobada debe acotarse al respaldo y rechazar observaciones nuevas.
  No modifica schema, lastSyncedAt, permisos, OAuth, Meta, senales, pujas o presupuesto.

Verificacion offline: 1.073 tests del runner canonico de Marketing Campanas,
60 tests enfocados, ocho comprobaciones MySQL del ejecutor y once de regresion
de aprobacion/cache. Los conjuntos Node se solapan: no sumar como tests unicos.
MySQL 8.0.42 temporal, sin TCP/proveedores ni sockets ajenos, ambas instancias
terminadas con codigo 0. Primera integracion detecto `0` vs `false` en una
asercion del test raw; se normalizo el booleano, no se cambio la escritura.
Logs `/tmp/propdental-ad-repair-{marketing,focused-final,mysql-final,delivery-regression}-20260912.log`;
evidencias `/tmp/cc-campaign-opt-mysql-qE8Mz5/result.json` y
`/tmp/cc-campaign-opt-mysql-Tr0Y9v/result.json`.

Estado operativo comprobado 03:39:15 UTC / 05:39:15 CEST: DEV PID 1335829,
contador 8577, nueve flags false; staging/gateway/preview sin reinicios. Este
corte solo cambia fuente/pruebas/documentacion, sin consultas a la DB compartida
o proveedores, migracion, refresh real, build o publicacion. El nuevo hook no
esta cargado en DEV; QA Chromium 106/16 y preview e81492ec0b86bc51 son anteriores.

## Permisos Y Respaldo Del Refresco Por Anuncio (2026-09-12)

Preparacion del refresco pendiente de `1851215478`, solo codigo y pruebas
aisladas. NO aplica la migracion ni reemplaza su cache en la DB compartida:
ambas operaciones siguen esperando autorizacion explicita. No se reinicia DEV
en este corte; el runtime mantiene el codigo publicado a las 03:07 UTC.

`googleAdCache.service::persistAdSnapshot` revalida bajo bloqueo la cuenta,
conexion, alcance y clinica/grupo capturados antes de descargar. Exige un unico
permiso vigente; solo hereda del grupo cuando no existe permiso directo de
clinica. Un permiso directo revocado/desconectado no permite esa herencia.
Comprueba pertenencia y asignaciones activas, incluyendo customer con guiones;
rechaza destinos ajenos y conserva decisiones archivadas/ambiguas sin atribuir
por defecto. Un permiso directo de clinica no exige un grupo denormalizado.
Son garantias de persistencia, no una auditoria de todos los lectores legacy.

El callback interno opcional `beforeReplace` recibe transaccion y filtros
exactos de inventario, metricas y cobertura, despues de las validaciones y
antes de escribir. Permite respaldar el conjunto que se va a reemplazar. Un
fallo del respaldo aborta sin cambiar filas ni frescura; los filtros entregados
son copias y no pueden ampliar accidentalmente la escritura. No activa backups
automaticos ni un nuevo job. El runner posterior esta descrito arriba;
su ejecucion sobre la DB compartida sigue pendiente.

Verificado: 906 tests backend offline y 11 comprobaciones MySQL 8.0.42 aislado,
incluidos permiso revocado durante el refresco, reasignacion de cuenta,
asignacion fuera de alcance y fallo de respaldo. Instancia temporal terminada
con codigo 0, sin conexiones rechazadas. Logs:
`/tmp/google-ad-scope-back-final-20260912.log`,
`/tmp/google-ad-scope-mysql-final-20260912.log` y
`/tmp/cc-campaign-opt-mysql-Z2L9iq/result.json`.
El harness legacy separado `google_ad_cache_mysql.integration.js` adapta sus
fixtures al contrato, pero no se ejecuta en este corte.

Comprobacion de runtime 03:23:38 UTC / 05:23:38 CEST: DEV PID 1335829,
contador 8577, nueve flags false tambien en hijos; staging/gateway/preview
sin reinicios. Sin peticiones a proveedores, DB compartida, OAuth, Meta,
senales o cambios publicitarios. La evidencia Chromium 106/16 del apartado
siguiente es anterior: no hubo cambios de interfaz ni nuevo QA visual aqui.

## Conciliacion Del Desglose Por Anuncio (2026-09-12)

Lectura autorizada exclusiva de `1851215478`, cinco Search v24 HTTP 200,
02:55:11-02:55:15 UTC / 04:55 CEST. Las consultas del escritor de anuncios
devuelven 19 identidades y 688 filas segmentadas para 14/07-11/09. Las siete
campanas Search con gasto en esa ventana concilian exactamente anuncios y
campana en ambos periodos de 30 dias. Hospitalet: 78,443794 + 20,632398 =
99,076192 EUR en 13/08-11/09; los dos anuncios constan APPROVED/REVIEWED/ELIGIBLE
en esta observacion. No se usa esa lectura puntual como estado cacheado actual.
PMax no se representa como anuncios `ad_group_ad`; no inferir gasto cero de esa
ausencia. Evidencia restringida, sin URLs/creatividades ni credenciales:
`/home/ubuntu/qa-evidence/propdental-google-readonly-2026-09-12T02-55-11-169Z/result.json`.

El informe ahora entrega `adSpendCoverage` para cada periodo: dias completos de
campana y de cada anuncio, importes y conciliacion diaria. Incluye anuncios
pausados/historicos, deduplica segmentos y distingue cero de ausencia. Conserva
la tolerancia existente de un centimo por dia; diferencias compensadas entre
dias no se validan solo porque el total coincida. El CPL por anuncio requiere
periodo conciliado y leads identificados, y `Menor coste` tambien exige esa
cobertura ademas de muestra y frescura. No altera los importes ni la atribucion.

La UI consume ese resultado, sin sumar de nuevo la tabla filtrada. Si los
importes difieren, la nota existente muestra ambas cifras; sin datos suficientes
explica la actualizacion pendiente. No agrega bloques, pestanas o navegacion.
La cache real por anuncio sigue siendo la anterior: esta fase NO la reemplaza,
no aplica la migracion pendiente, no renueva tokens ni realiza ajustes.

QA real posterior: Hospitalet tiene 29/30 dias por anuncio frente a 30/30 de
campana. Cache actual 79,492099 EUR, diferencia -19,584093 EUR; periodo anterior
30/30 y 180,020892 EUR conciliados. Un lead permanece sin anuncio identificado.
La consulta directa confirma que el proveedor si tiene el gasto faltante, pero
no lo sustituye en el informe hasta una escritura acotada y respaldada.
899 tests backend y 128 frontend correctos. Un test de recomendaciones detecto
la tolerancia diaria existente y se conservo, sin debilitar su comprobacion.
Build final `e81492ec0b86bc51`, publicado solo en preview DEV. QA delegado de
Carlos: 106 comprobaciones/16 capturas en 1440/1024/390 px, cifras exactas del
aviso, filtros, resumen, Salud, detalle y regresos. Sin desbordes ni errores JS;
capturas escritorio/movil inspeccionadas, sesion cerrada y nueve flags false.
`/home/ubuntu/qa-evidence/campaign-authenticated-2026-09-12T03-08-04-828Z/result.json`.
DEV reiniciado `2026-09-12T03:07:35.930Z` / 05:07:35 CEST, PID 1335829,
contador 8577; staging/gateway sin cambios. Ninguna migracion/cola activada.

## Refresco Google Integrado En Los Jobs Existentes (2026-09-12)

El codigo DEV de `google_ads_recent` y `google_ads_backfill` ya utiliza el
colector conciliado de la reparacion de Propdental. No se crea otro cron ni
se cambia su zona Europe/Madrid. Esto NO acredita una ejecucion nocturna real:
DEV conserva los nueve flags false y staging no se ha actualizado.

- Una lectura por customer, aunque tenga varias asignaciones del mismo grupo.
  Los filtros customer/clinica/grupo eligen cuentas, no copias de su cache;
  conserva el propietario de grupo existente y rechaza propietarios ambiguos.
- Ventana nocturna por defecto de al menos 60 dias cerrados, para cubrir dos
  periodos de 30 dias. Calendario de la cuenta, incluyendo cambio de hora;
  una ventana explicita acotada sigue siendo posible. Backfill en snapshots
  consecutivos de como maximo 60 dias, sin transaccion global de todo el job.
- Consultas completas v24 en metricas, inventario, destinos y anuncios. Un error
  no activa el antiguo fallback que omitía el coste. Una cuenta realmente vacia
  solo queda completa tras terminar todas las consultas, nunca tras un error.
- La escritura programada conserva decisiones revisadas y archivadas antes de
  aplicar el modo/delimitador automatico ya configurado en el grupo. Revalida
  permisos y clinicas dentro de la transaccion; incidencias de atribucion
  acotadas a proveedor/customer/entidad. No crea asignaciones manuales nuevas.
  El runner puntual de reparacion mantiene esta atribucion automatica apagada.
- `lastSyncedAt` solo cambia tras completar todas las fases y comprobar que
  la cuenta no se haya reasignado. Un fallo de destinos deja terminar la cache
  independiente de anuncios, pero no acredita sincronizacion completa. El
  resultado conserva el progreso confirmado de cada fase terminada.
- Un lote mixto devuelve `completed_with_errors`; su `SyncLog` queda `failed`
  porque ese enum no admite parcial. Cero cuentas completadas con errores es
  `failed`. La espera por cuota conserva el mecanismo durable existente.

No se ejecutan estos jobs contra la DB compartida durante este corte. Antes de
reactivarlos: coordinar el runtime escritor, API soportada, migracion de
aprobacion de anuncios y exclusividad frente a escritores legacy; luego validar
un refresco acotado de `1851215478`. No reactivar Meta ni abrir gates publicitarios
como parte de esa operacion. Contrato operativo en `11-sistema-jobs.md`.

Verificado: 897 tests backend offline; 12 comprobaciones MySQL 8.0.42 aislado,
incluidas atribucion programada, rollback de incidencias, concurrencia y
revocacion. Scheduler, archivo de asignaciones y fase A tambien correctos.
Logs `/tmp/google-nightly-workspace-closure-suite-20260912.log` y
`/tmp/cc-campaign-opt-mysql-h86tDA/result.json` (instancia terminada, codigo 0).
DEV cargado `2026-09-12T02:50:32.226Z` / 04:50:32 CEST, PID 1333068,
contador 8576; nueve flags false en PM2 y procesos hijos. No reinicia staging,
gateway o preview. Lectura API posterior de grupo/Hospitalet: HTTP 200 y mismas
filas/cifras que antes, sin peticiones al proveedor, migraciones o ajustes.
`/home/ubuntu/qa-evidence/propdental-workspace-2026-09-12T02-50-50-694Z/result.json`.
Sin cambios de interfaz en este corte; no se repite ni se atribuye como nueva
la evidencia Chromium 103/16 del apartado siguiente.

## Metricas Reales De Propdental (2026-09-12)

Supersede la ausencia de inversion de la primera lectura de hoy, exclusivamente
para Dental - Parallel Campaign `1851215478`. No se consulta PROPDENTAL normal
`5992356722` ni Meta. El grupo conserva las otras cuentas y sedes existentes;
su total puede seguir pendiente si incluye plataformas/cuentas sin metricas.

`googleCampaignMetricsCache.service` captura por SELECT v24 dias completos,
con paginacion y conciliacion de segmentos campana/grupo. Conserva el detalle
Search y usa agregado de campana para PMax sin duplicar ambas granularidades.
Solo rellena dias cero tras una lectura completa; rechaza errores parciales,
identidades cambiantes, sumas incongruentes y snapshots caducados. La escritura
valida de nuevo permiso, propietarios y asignaciones bajo bloqueo, protege de
una captura anterior y reemplaza cuenta/ventana en una unica transaccion.
El helper de paginacion compartido tambien rechaza respuestas de error parcial.

Reparacion operativa acotada en DB compartida: 3.985 filas, 27 campanas, del
14/07 al 11/09/2026. Diez lecturas Google HTTP 200, sin renovar credenciales.
Observacion `2026-09-12T02:01:01Z` / 04:01:01 CEST. Copia restringida previa de
1.044 filas; importe almacenado conciliado: 5.614,84236 EUR en 60 dias.
Solo cambia `GoogleAdsInsightsDaily`: no inventario, permisos, asignaciones,
leads, senales, presupuestos, anuncios ni flags/jobs. Evidencia y SHA-256:
`/home/ubuntu/qa-evidence/propdental-metrics-cache-apply-2026-09-12T02-01-00-158Z/result.json`.
`before.json` es el respaldo; `snapshot.json` conserva la captura aplicada.
No restaurar sin comprobar que no existan observaciones posteriores; nunca
reemplazar otras cuentas o fechas al revertir esta reparacion.

Contraste API local 13/08-11/09: 2.000,30354 EUR y 40 leads atribuidos en las
campanas visibles de esta cuenta. Hospitalet Search `21313059516`: 99,076192 EUR,
un lead; PMax `21319497065`: 107,17859 EUR, sin leads atribuidos. El lector usa
el estado de campana Google mas reciente de la cache cuando supera el del
inventario y esta vigente (36 h); empates contradictorios quedan UNKNOWN.
No confunde ese estado con aprobacion del anuncio ni recepcion verificada.
Salud detecta 26,55 EUR sin nuevos leads atribuidos en los dos ultimos dias
completos de Search; no acredita por si solo un fallo tecnico.

El desglose por anuncio sigue con otra fecha de observacion: los 79,49 EUR
guardados de Search no se presentan como reconciliacion de sus 99,08 EUR
actuales. No hay ganador verificado ni identidad de anuncio para su unico lead.
La UI avisa del desglose pendiente sin alterar los datos o la navegacion.

Esta reparacion NO restablece el cron. El runtime nocturno staging mantiene
v21 y fallbacks hasta v15; los jobs examinados terminaban con cero procesados
y errores 404. DEV usa v24. [v21 finalizo el 05/08/2026](https://ads-developers.googleblog.com/2026/06/google-ads-api-v21-sunset-reminder.html).
Pendientes promocion coordinada, version soportada y migracion de observacion
de aprobacion antes de habilitar el escritor de anuncios. No se cambia staging.
El nuevo bloqueo serializa este escritor, no promete exclusion frente a todos
los escritores legacy; el runner exige ausencia de jobs Google en ejecucion.

Verificacion: 879 tests backend offline; nueve comprobaciones en MySQL 8.0.42
aislado (rollback, concurrencia, permisos, snapshot anterior, compatibilidad).
Instancia temporal terminada, resultado `/tmp/cc-campaign-opt-mysql-y6QONS/result.json`.
DEV reiniciado `2026-09-12T02:10:49.383Z` / 04:10:49 CEST, PID 1328656,
contador 8575; los nueve flags de contencion siguen false. Staging/gateway
no reiniciados. Ninguna migracion, publicacion, CAPI o cambio publicitario.

Preview `42091d2965eae001` y 127 tests frontend correctos. QA real con sesion
delegada temporal autorizada de Carlos: 103 comprobaciones, 16 capturas en
1440/1024/390 px; clinica/grupo, buscador, detalle Search, importes exactos,
estado PMax, regreso al listado, Salud por bloques y cobertura por anuncio.
Separacion de cifras y avisos revisada visualmente en escritorio/movil;
sin errores JS ni desbordes. Sesion cerrada y nueve flags false al terminar.
`/home/ubuntu/qa-evidence/campaign-authenticated-2026-09-12T02-19-40-539Z/result.json`.
No se cargan creatividades externas ni se prueban OAuth, formularios o ajustes.

## Leads Web Existentes Y Cobertura Inicial Del Informe (2026-09-12)

Este apartado conserva la primera observacion de hoy; el refresco de metricas
y los importes vigentes estan documentados en el apartado anterior.

El informe acepta los IDs Google ya guardados en contactos pagados con origen
`web` o `call_click`, aunque no tengan UTM. Exige cuenta y campana validas,
coincidencia unica, asignacion explicita y misma clinica; una identidad canonica
conflictiva o IDs explicitos invalidos no se sustituyen por coincidencias UTM.
No duplica leads ni los convierte en identidades verificadas por anuncio.
No relaja atribucion economica, senales o evidencia de Optimiza.

Lectura READ ONLY de Dental - Parallel Campaign: 25 filas de inventario y
19 asignaciones existentes. Entre 13/08 y 09/09 Madrid hay 38 leads web pagados
con esos IDs, 32 en la misma clinica que la campana y seis en otra sede. Hay
cuatro recibos de formularios historicos vinculados a esta cuenta. La recepcion
ya existia; esto corrige su recuento, no implementa ni prueba un nuevo envio.
Los registros cruzados no se borran ni reasignan automaticamente.

No hay filas de `GoogleAdsInsightsDaily` de esta cuenta desde 13/08 en la cache
consultada. Hay metricas guardadas por anuncio en otro contrato; no acreditan
por si solas el agregado completo por campana (en especial PMax).
El informe no rellena la inversion con las lecturas puntuales del diagnostico
ni con ceros. La UI explica la falta de inversion por plataforma y muestra el
resumen de Salud neutral si quedan comprobaciones aplicables pendientes; las
incidencias tienen prioridad. Los seis bloques y la navegacion se conservan.

Despues del fix, API local real para 13/08-11/09 (30 dias) atribuye 40 leads
a las campanas de la cuenta dentro del grupo, uno en Hospitalet. No comparar
ese total directamente con las 27 conversiones Lead de Google en 28 dias:
difieren ventana, fecha de atribucion y deduplicacion. El grupo administrativo
incluye nueve clinicas y mas cuentas; no se reduce automaticamente a las seis
sedes indicadas. Los 55 uploads con estado local `succeeded` y diez omitidos por
consentimiento (13/08-11/09) no acreditan 55 eventos procesados por Google.

Evidencia restringida del contraste posterior:
`/home/ubuntu/qa-evidence/propdental-workspace-2026-09-12T01-34-36-950Z/result.json`.
Runner `/home/ubuntu/scripts/cc-propdental-workspace-readonly.js`, opt-in
`--authorized-carlos-propdental-readonly`. Sin app/ORM para SQL, ni tokens de
proveedores. API local con sesion delegada temporal, sin guardar sus valores.
865 tests backend offline correctos; dos regresiones reproducidas antes.
DEV cargado `2026-09-12T01:25:41.518Z` / 03:25:41 CEST, PID 1324302,
contador 8574; nueve flags false en PM2 y procesos hijos. Staging/gateway sin
reiniciar. Sin migracion compartida, OAuth, envios o ajustes publicitarios.
El refresco acotado de Google y conciliacion por anuncio siguen pendientes.

Preview DEV `4e902356b7d04b54`, 126 tests frontend correctos. QA delegado de
Carlos: 90 comprobaciones y 14 capturas en 1440/1024/390 px, clinica y grupo,
buscador, detalle de Hospitalet Search `21313059516` en la cuenta autorizada,
dos anuncios guardados, remanente de un lead sin anuncio identificado y retorno
al listado. Salud/nota de inversion sin desbordes y sin errores JS. Resultado:
`/home/ubuntu/qa-evidence/campaign-authenticated-2026-09-12T01-39-34-127Z/result.json`.
No valida creatividades externas, frescura de anuncios, recepción nueva o
ejecucion publicitaria. El grupo conserva caches de otras cuentas, incluida Meta;
leerlas localmente no reactiva permisos. Contexto cerrado y nueve flags false.

## Lectura Real Google Y Compatibilidad De Destinos (2026-09-12)

El titular autoriza consultar exclusivamente Dental - Parallel Campaign
`1851215478`. Cuenta verificada, 13 campanas activas de las seis sedes indicadas;
Rubi/Eixample pausadas. PROPDENTAL `5992356722` excluida. No se asignan campanas,
se aplican ajustes ni se consulta Meta. Acceso de lectura NO valida ejecucion.

La prueba directa encontro `campaign.url_expansion_opt_out` retirado de la API.
Corregidos `inspectGoogleDestinations` y `_syncGoogleAdsPublishingState` para
leer `campaign.asset_automation_settings`; el campo nuevo devuelve HTTP 200
en v24. Helper comun en `googleAdsCampaignMeasurementDiagnosis`: solo OPTED_OUT
de FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION prueba expansion desactivada;
datos ausentes, malformados o contradictorios conservan cobertura incompleta.
Se mantiene lectura de snapshots antiguos. No cambia el esquema ni el mandato.
Referencia: [cambio oficial v22](https://developers.google.com/google-ads/api/diff-tool/v22/versus-v21/diffs/resources/campaign).

Google ya registra acciones ClinicaClick en Todas las conversiones, secundarias
y sin inclusion en el unico objetivo personalizado observado. Falta conciliar
recepcion/atribucion CRM y decidir la etapa de puja; no sumarlas como pacientes
unicos ni activar todas como primarias. Francia usa un segundo dominio cuya
cobertura no acredita el plugin de propdental.es. Hay limitaciones de recursos
PMax y volumen insuficiente para pausar automaticamente anuncios Search.
Diagnostico restringido:
`/home/ubuntu/qa-evidence/propdental-google-readonly-2026-09-12T00-58-44-836Z/analysis.md`.

863 tests offline correctos, tres fallos de regresion reproducidos antes;
46 tests enfocados y sintaxis/diff correctos. DEV reiniciado a
`2026-09-12T01:11:17.108Z` (03:11:17 CEST), PID `1322955`, contador `8573`.
Nueve flags permanecen false en PM2 y procesos hijos; error.log sin crecer,
API/proxy anonimos 401, SPA 200. Staging/gateway/preview no reiniciados.
Sin migraciones, OAuth, tokens nuevos, envios ni mutaciones de proveedores.
La migracion compartida, recepcion end-to-end y ejecucion siguen pendientes;
plan gestionado aplazado por el titular. Frontend sin cambios en este corte.

## Revision Visible De Cuentas Compartidas (2026-09-12)

Frontend publicado en DEV: `3993e4dd5c9a629b`. La vista sin campanas y con cuentas
compartidas muestra directamente la pregunta de pertenencia y sus acciones por
proveedor. Con campanas visibles se conserva como ajuste plegable. No se deduce
un contador de pendientes ni se amplian permisos del informe.

Se reutilizan `loadSharedAccountReview` y la confirmacion existente: ninguna
mutacion nueva de backend, OAuth o cambio de pertenencia automatico. La lista
incluye el nombre de la clinica destino; la vista de grupo pide elegirla.
Salud sin campanas incluidas no se presenta como cero incidencias comprobadas.

Diagnostico READ ONLY: Arriaga clinica 1, grupo de dos sedes, mapeos activos a
nivel de grupo, 9 campanas Google en `ExternalCampaignInventories`, 10 Meta en
`SocialAdsEntities` y ninguna asignacion revisada para esas cuentas. La cuenta
Google tiene ademas propiedad fuera del grupo, como documenta la revision
anterior: seleccionar el grupo no elimina esa guarda. Meta se muestra en el
grupo completo, sin duplicar campanas ni atribuir leads/importe a una sede.
La revocacion del token no elimina este inventario; tampoco garantiza su frescura.

QA real delegado con el runner de abajo: 123 comprobaciones y 22 capturas,
1440/1024/390 px. Lee ambas revisiones guardadas, llega a confirmacion y cancela;
cambia a grupo por el selector, abre campana/anuncios, vuelve a Campanas o Salud
segun el origen y entra/sale de configuracion. No guarda ni reasigna campanas.
Sin errores JS ni overflow. Resultado restringido:
`/home/ubuntu/qa-evidence/campaign-authenticated-2026-09-12T00-41-30-055Z/result.json`.
No valida importes reales (KPI sin datos verificables), creatividades externas,
recepcion nativa, OAuth ni ejecucion publicitaria. Nueve flags siguen cerrados.
123 tests frontend y 48 backend de informe, seleccion y cuentas compartidas OK.

## Acceso Real Delegado Para QA (2026-09-12)

Con autorizacion expresa del titular, el QA usa `carlos@clinicaclick.com`
verificado mediante SELECT de identidad/estado, sin leer password ni tokens
de proveedores. Sesion DEV delegada de 20 minutos segun el contrato JWT actual,
con marcador `qa_delegated` y contexto Chromium separado, cerrado al terminar.
No es una prueba de login con contrasena ni genera `ultimo_login` por ese flujo.
La sesion del navegador de VS Code no se comparte con el CDP disponible.

Runner local `/home/ubuntu/scripts/cc-campaign-readonly-session-qa.js`, opt-in
`--authorized-carlos-readonly`: comprueba los nueve flags cerrados, limita GET a
lecturas revisadas, bloquea OAuth, renovacion de sesion, escrituras, socket.io,
SDK Meta y creatividades externas. No persiste JWT ni respuestas completas.
Las lecturas de arranque de notificaciones y conversaciones son necesarias para
el resolver de la app; no abre chats, marca leidos ni recoge su contenido como evidencia.

Pasada real en Arriaga: 23 comprobaciones, seis capturas a 1440/390 px, Resumen,
Campanas y Salud, cinco KPI y seis bloques; sin alertas del workspace, errores JS
ni overflow horizontal. API workspace/configuracion/preparacion HTTP 200.
**El ambito devuelve cero campanas y KPI sin datos**: no acredita detalle de
campana, importes, atribucion ni integraciones reales. Grupos, badge de leads,
WhatsApp y administracion quedaron fuera de la lista de lecturas permitidas.
Evidencia restringida en `/home/ubuntu/qa-evidence/campaign-authenticated-2026-09-12T00-16-32-441Z/result.json`.
No reinicios, cambios de contrasena, OAuth, proveedores, migraciones ni envios.

## Pausa Google: Aprobacion Del Anuncio Alternativo (2026-09-12)

La compatibilidad de pausa y el colector de rendimiento ya no consideran
suficiente `ENABLED`. Exigen campana/grupo/anuncio habilitados, `primary_status`
igual a `ELIGIBLE` y `policy_summary.approval_status` igual a `APPROVED`.
Es una condicion necesaria, no una garantia de impresiones futuras. Los anuncios
limitados pueden servir y siguen activos en el informe, pero no se usan como
alternativa sin restricciones para autorizar una pausa automatica. Su gasto
historico se conserva; las consultas de metricas no cambian.

El ejecutor usa esa misma inspeccion antes del marcador durable de envio. Si
cambia la aprobacion del objetivo o del anuncio de referencia, descarta la
propuesta sin enviar; otro anuncio aprobado no sustituye la referencia del
calculo. Esto protege tambien propuestas pendientes de versiones anteriores.
No cambia esquema, permisos ni gates. La migracion de inventario documentada
abajo sigue pendiente, independiente de estas consultas directas de inspeccion.

Seis regresiones nuevas, incluida revalidacion real del preflight con transportes
ficticios. Suite: 858 tests correctos (840 workspace + 18 cache Google), sockets
externos bloqueados, `/tmp/campaign-google-pause-suite-20260912.log`.
Ocho comprobaciones de sintaxis y `git diff --check` correctos. No cambia el
frontend: siguen como evidencia previa sus 120 tests y Chromium 254/79.
DEV reiniciado a `2026-09-11T23:45:55.590Z` (12/09 01:45:55 CEST), PID
`1318258`, contador `8572`, nueve flags `false`. API/proxy anonimos 401,
SPA 200; error.log sin crecer. No OAuth, tokens, llamadas publicitarias reales,
migraciones compartidas ni reinicios de staging/gateway. QA autenticado pendiente.

## Publicacion Google: Estado Y Aprobacion (2026-09-12)

`ad_group_ad.status=ENABLED` es configuracion, no prueba de aprobacion. El
inventario pide ahora `primary_status`, `primary_status_reasons` y los estados
de aprobacion/revision de `policy_summary`, solo en la consulta de inventario;
las consultas de metricas no cambian. El estado original `adStatus` se conserva.

Contrato contrastado con el [recurso AdGroupAd v24](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v24/resources/ad_group_ad.proto),
[estado primario](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v24/enums/ad_group_ad_primary_status.proto),
[aprobacion](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v24/enums/policy_approval_status.proto)
y [revision](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v24/enums/policy_review_status.proto).
Solo documentacion publica; no se consulto una cuenta publicitaria.

- Migracion aditiva `20260912010000-add-google-ad-delivery-observation.js`:
  `GoogleAdsAdInventory.deliveryObservation`, JSON nullable. Guarda version,
  fecha y enums, no respuestas completas ni secretos. No se rellena el historico
  inventando aprobacion. Se valida junto a la escritura transaccional existente.
- El lector compara la fecha del JSON con `observedAt`: un escritor antiguo no
  puede refrescar evidencia de politica que no ha consultado. Con esquema anterior
  reintenta sin esa columna SOLO ante el error exacto de columna ausente. El resto
  de errores DB se propaga. Sin evidencia, el estado queda por comprobar.
- Rechazo: critico; pendiente/no apto: no activo; limitado: puede publicar con
  limitaciones, aviso independiente. Puede haber rechazo y limitacion en una
  campana y ambos permanecen en el bloque de publicacion. Un rechazo no se infiere
  de una revision en curso ni de una apelacion; manda la aprobacion/estado primario.
- El filtro de anuncios separa activos, no activos y por comprobar. Los limitados
  siguen entre los activos con etiqueta propia; desconocidos no se presentan como
  una parada acreditada. Se conserva la navegacion y los seis bloques aprobados.

**Migracion NO aplicada a la DB compartida.** No restaurar el job de inventario
Google con el nuevo escritor hasta aplicar esa migracion con autorizacion y
coordinar sus runtimes. DEV conserva jobs/gates cerrados; el lector compatible
puede desplegarse antes sin consultar al proveedor. No iniciar una sincronizacion
para rellenar el dato durante el bloqueo de credenciales. Las pruebas usan el
contrato real en una base temporal propia, nunca datos de clinicas.

Prueba MySQL: siete escenarios de esquema anterior, migracion idempotente,
persistencia JSON/precision temporal, informe y Salud, escritor anterior,
rollback transaccional y rollback de esquema sin borrar metricas. La primera
ejecucion detecto `present=1` en lecturas SQL raw; normalizado explicitamente,
sin aceptar strings arbitrarios. Repeticion correcta y apagado limpio del
mysqld temporal: `/tmp/cc-campaign-opt-mysql-rvLh7p/result.json`.
Logs, build, publicacion y capturas finales de este corte en la bitacora front.
No acredita recepcion, llamadas Google reales ni QA con una sesion del usuario.

Suite final: 834 tests workspace + 18 cache Google, 120 frontend y 19 aserciones
de presentacion correctos. Preview `21d89d479dbf9d30`, pasada final Chromium
254 comprobaciones/79 capturas, incluido scroll del dialogo movil hasta la
segunda incidencia. DEV API cargada a `2026-09-11T23:31:35.537Z`,
01:31:35 CEST; PID `1316881`, contador `8571`, nueve overrides `false`.
El lector compatible esta desplegado; migracion y escritor Google no activados.
Staging/gateway sin reiniciar; API/proxy anonimos 401, sin nuevo error.log.

## Salud: Estados De Publicacion (2026-09-12)

Corregido `campaignWorkspaceHealth.service`: antes un inventario reciente sin
rechazos podia aparecer OK aunque todos los anuncios estuvieran en pausa o
tuvieran estado desconocido. Ademas, un anuncio desactualizado ocultaba el
rechazo reciente de otro anuncio de la misma campana.

- Una campana que figura ACTIVE/ENABLED, con todos sus anuncios sincronizados
  recientes y en estados conocidos no activos, genera un aviso en el bloque
  existente `delivery`. No se reactivan anuncios ni se modifica su presupuesto.
- Un anuncio activo con alternativas pausadas no genera ese aviso. Campanas
  pausadas o cuyo estado es desconocido no se presentan como activas.
- UNKNOWN, estados no reconocidos y fechas antiguas/invalidas no son OK. Un
  rechazo reciente si permanece visible aunque la cobertura restante sea parcial.
- Se conservan los seis bloques, las incidencias por campana, su agregacion y
  la cobertura explicita. El aviso describe lo sincronizado, no prueba cobertura
  completa del proveedor ni entrega actual. Revisar una alerta lleva al detalle
  de esa campana y vuelve a Salud; no ejecuta una accion publicitaria.
- Front traduce `PENDING_BILLING_INFO` como `Revisar facturacion` y corrige el
  singular en los recuentos de incidencias y campanas afectadas.

Estados Meta contrastados con el [SDK oficial, Ad.EffectiveStatus](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/ad.py).
No se consultaron cuentas ni tokens. La revision de COST_CAP/minimo ROAS no
implementa una politica nueva: sus campos modificables y las recomendaciones
del SDK no bastan para trasladarles una regla basada solo en leads CRM.

Cinco regresiones fallaban antes; los 22 tests de Salud pasan despues, incluidos
siete casos nuevos. Suite workspace: 824/824; frontend: 119/119 y 16 aserciones
de presentacion. Logs `/tmp/campaign-health-delivery-{before,after,suite,front}-20260912.log`.
QA Chromium aislado: 216 comprobaciones/68 capturas a 1440/1024/390 px,
sesion/APIs ficticias, sin backend/proveedores reales. Frontend publicado solo
en preview DEV, build `5c7cd3ef90520c26`. Evidencias y rollback en bitacora.

Backend DEV reiniciado con autorizacion a `2026-09-11T22:59:36.845Z`, 12/09 a las
00:59:36 CEST, PID `1313029`, contador PM2 `8570`. Conserva en `false` los nueve
overrides del apartado siguiente; staging, gateway y preview sin reiniciar.
API/proxy rechazan consultas anonimas con 401; error.log sin nuevas lineas.
No OAuth, renovacion/sustitucion de tokens, consultas de negocio DB, migraciones
ni activacion de jobs. QA autenticado real y contratos pendientes siguen abiertos.

## Reinicio DEV Autorizado (2026-09-12, 00:25 Europe/Madrid)

El usuario autorizo reiniciar DEV sin restablecer el acceso de Meta. Reiniciado
solo `pm2-back-dev` a las `2026-09-11T22:25:23.522Z` (00:25:23 CEST), PID
`1310023`, reinicios PM2 `8569`. Staging, gateway y preview conservan sus procesos.
La API cargo el codigo local actual; esto no constituye una promocion a staging
ni una validacion autenticada de todas sus funcionalidades.

Overrides verificados tanto en PM2 como en el entorno del proceso, todos `false`:
`JOBS_WORKER_ENABLED`, `JOBS_CRON_LEADER`, `SYSTEM_NOTIFICATIONS_CRON_LEADER`,
`AUTOMATIONS_V2_RESUME_FROM_SOCKET_BUS`, `CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED`,
`CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED`, `CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED`,
`CAMPAIGN_WORKSPACE_DESTINATION_REFRESH_ENABLED` y
`CAMPAIGN_WORKSPACE_META_DESTINATION_REFRESH_ENABLED`.

`JOBS_WORKER_ENABLED=false` evita que el scheduler DEV recupere y ejecute
JobRequests pendientes al arrancar. No desactiva los workers BullMQ de WhatsApp
ni los emisores de otros procesos. La pausa afecta tambien a jobs DEV ajenos a
campanas. No restaurarlos automaticamente durante esta validacion.
Son overrides del runtime PM2: `.env` no se modifico y mantiene
`JOBS_WORKER_ENABLED=true`. No asumir que sobrevivan a una recreacion del proceso
o a restaurar un dump antiguo; mantener explicitamente estos valores al reiniciar.

No se inicio OAuth, renovo/sustituyo un token ni se consulto Meta. El intercambio
Meta revisado requiere callback OAuth; no forma parte del arranque. Los nuevos
logs confirman escucha en 3004, conexion DB y scheduler/cron desactivados, sin
nuevas lineas en error.log. Esto no acredita contencion global del incidente.
68 archivos JS pasan `node --check`. GET anonimo del workspace devuelve 401
en 3004 y proxy 4203; la ruta SPA devuelve 200. No se repitio la suite completa,
no se hicieron consultas de negocio a la DB compartida ni migraciones.

## Contrato HTTP Aislado (2026-09-12)

`src/scripts/tests/campaign_workspace_http.test.js` recorre las 25 rutas
registradas del workspace: carga el router, middleware JWT y exportaciones del
controlador reales, con usuarios, membresias y servicios de datos ficticios.
Las claves JWT se generan solo para su servidor efimero de test; no se usan
credenciales, sesiones, DB ni endpoints del runtime DEV.

Ocho tests, 224 peticiones HTTP: ausencia/expiracion/firma incorrecta, falta de
pertenencia completa, acceso de consulta frente a gestion, actor/ambito resueltos
en servidor, agregados de lectura, cabeceras private/no-store y errores 400/403/
404/409 sin convertirlos en guardados correctos. La activacion usa su validador
y funcion reales con deployment cerrado: incluso un escritor autorizado obtiene
409 sin iniciar una transaccion. Las lecturas de negocio y de creatividades se
sustituyen por fixtures; esto NO verifica recepcion ni acceso a proveedores.

El preload de aislamiento mantiene bloqueados sockets normales, fetch y colas.
Su unica excepcion explicita permite al cliente de test conectar con un servidor
HTTP propio, ya escuchando en loopback; no permite elegir un host/puerto externo.
Hay regresion especifica de esa restriccion y cierre del servidor al terminar.

Suite `campaign_workspace*.test.js`: 817/817 correctos, ejecutada con el preload
de aislamiento. Logs `/tmp/campaign-workspace-http-suite-20260912.log` y
`/tmp/campaign-workspace-http-final-20260912.log`. No se repitieron MySQL ni las
capturas anteriores. Chromium disponible sigue mostrando cuatro pestanas de
app en `/sign-in` a las 22:43 UTC del 11/09; su QA con sesion real sigue pendiente.
Sin cambios de codigo productivo, reinicios adicionales ni apertura de gates.

## Lista De Cierre Vigente (2026-09-12)

Esta lista distingue implementacion, publicacion y validacion. Los apartados
historicos de pendientes mas abajo NO son una lista de trabajo vigente.
El objetivo completo sigue abierto; plan gestionado queda fuera por decision
expresa del usuario, a la espera de mock y validacion independientes.

| Requisito | Evidencia actual | Falta para el cierre |
|---|---|---|
| Navegacion, resumen, campanas/anuncios y Salud | Preview `e81492ec0b86bc51`; QA Propdental real delegado 105 comprobaciones/16 capturas tras reparar cache, con clinica, grupo, importes, cobertura diaria y regresos; QA Arriaga anterior 123/22 | Atribucion por anuncio pendiente de evidencia; creatividades externas fuera del QA |
| Incorporacion sin segunda campana local y excepciones de grupo | `campaignWorkspaceSettings`, `Report` y `SharedAccount`; seleccion futura/pertenencia/conflictos; revision real Google/Meta y confirmacion cancelada | Decision del propietario sobre que campanas son de cada sede; ninguna asignacion real realizada |
| Recepcion web, nativa y Medicion de interesados | Servicios `Preparation`, `NativeReception`, `GoogleReception`, `SignalAuthorization`; historico Propdental confirma formularios y recuento de 40 leads en 30 dias | Conciliacion CRM/proveedor, cobertura Francia y recepcion end-to-end autorizada; no enviar senales en este QA |
| Cinco KPI, presupuestos y comparativa | Inversion/CPL Hospitalet contrastados; EconomicBudgets real de seis sedes sin aceptaciones, API coincide. Aceptacion productiva a SQL/informe positivos probados en MySQL temporal, parcial, fechas, duplicados y rollback | No hay muestra positiva real en Propdental; atribucion por anuncio/identidad economica de leads legacy sigue pendiente de evidencia, nunca estimar desde tratamientos |
| Cache e inventario | Reparacion autorizada de 3.985 filas de campanas y, despues, migracion aditiva +19 anuncios/688 metricas/60 dias; respaldos y verificacion antes del commit. Hospitalet concilia ambos periodos. Jobs DEV integrados en fuente, no reactivados | Promocion coordinada/version soportada y escritor actual para restablecer cron. No hay ciclo nocturno real validado |
| Optimiza implementado | Pausa, CPC/BID_CAP, presupuesto y recomendaciones CPA/ROAS Google cargados en DEV; runner canonico Marketing 1.073 tests, enfocados 60 (solapan); MySQL actual ocho de reparacion y once de cache/aprobacion, mas pruebas historicas | Datos reales Propdental no autorizan una pausa automatica: falta volumen/atribucion y Search usa Smart Bidding; gates cerrados, ejecucion y staging pendientes |
| Exclusiones y objetivos avanzados Meta | Lector de terminos e inspeccion existen; disponibilidad excluye politicas sin motor | Relevancia comercial y politica COST_CAP/minimo ROAS aun no implementadas |

La auditoria de relevancia inspecciono `CampaignWorkspaceSetting`, `Campaign`,
`Tratamiento`, `CampaignDestinationBinding`, `campaignWorkspacePreferences` y
`campaignWorkspaceSearchTerms`. El catalogo de tratamientos y un binding de una
landing no definen por si solos que consultas debe excluir cada campana externa.
Las preferencias no guardan ese criterio y el evaluador no despacha negativas.
Hace falta resolverlo sin reintroducir la segunda campana local obligatoria ni
asumir que ausencia de un servicio en el catalogo significa que no se ofrece.
No se sustituye esa tarea por una lista generica o por cero conversiones.

Preflight historico anterior al reinicio, 18:52 UTC / 20:52 Europe/Madrid: DEV `b63c7b0`, front
`5ba564f1`, cambios locales conservados. Backend DEV online desde 07:41 UTC,
sin watch; worker activo y cron leader desactivado. Staging sigue siendo cron
leader. Los cinco flags nuevos de activacion, optimizacion, Google lead sync y
refresco de destinos general/Meta estan ausentes del entorno de arranque
observado; esto NO demuestra la contencion de otros emisores legacy.
No se reinicio ningun proceso ni se consulto la DB compartida.

Preview: chunk SHA `f9ee3fb53c0dbedcf943ad8ad3214e39a5124e804fc00e97e65118671e826e4f`,
HTTP 200/no-cache, identico a dist. GET anonimo del workspace devolvio 401 en
3004 y 4203; prueba proteccion anonima, no permisos ni datos autenticados.
Las cuatro pestanas de app compartidas siguen en `/sign-in`. No hay prueba
autenticada nueva ni se recuperaron tokens/contrasenas.

Siguiente validacion: contrastar KPI con datos actuales y validar recepcion/ejecucion
en un entorno expresamente autorizado. La causa del cero de Arriaga y el recorrido
real de lectura ya estan comprobados; no asignar campanas a una sede para fabricar
datos de prueba. El login del usuario en su propio localhost no autentica el CDP;
se utiliza la sesion delegada autorizada arriba. `GET /campaign-workspace/ad-creative` de Meta puede llamar Graph
si falla su cache (`campaignAdCreative.service`): no abrir ese preview ni los
botones de comprobacion/OAuth durante el recorrido limitado. Probar formularios,
senales, publicidad o proveedores requiere autorizacion separada. No promocionar
staging, abrir gates ni presentar este preflight como implementacion terminada.

## Compatibilidad Y Politicas Disponibles (2026-09-11)

La mutabilidad tecnica de un recurso no acredita un motor de decision.
`optimizationAvailability` conserva la inspeccion original y su huella, pero
filtra la preparacion publica y los recursos que entran en una nueva autorizacion:
negativas requieren relevancia comercial (`search_relevance_required`); las
pujas Meta que no sean BID_CAP quedan en `bid_policy_not_available`. No crea
esas politicas ni cambia recibos anteriores, recuperacion o permisos.

Una seleccion exclusivamente pendiente no produce mandato. Si existen recursos
compatibles y pendientes, solo autoriza los compatibles, conservando los motivos
del resto. Una inspeccion incompleta o inconsistente no se presenta como valida.
La revision cliente distingue disponible, sin comprobar y sin ajustes disponibles;
el detalle de una campana sin ajustes tambien se puede consultar.

Verificacion local: 810 tests TAP backend, 119 frontend y 79 comprobaciones MySQL
temporal. Incluye persistencia JSON, ausencia de jobs/escrituras al revisar y
conservacion de la inspeccion original. Cuatro regresiones fallaban antes del
cambio. Logs `/tmp/campaign-policy-availability-{suite,front,mysql-final}-20260911.log`
y `/tmp/cc-campaign-opt-mysql-61VNMP/result.json`. Sin DB compartida, proveedores,
reinicio API/workers o apertura de gates. Publicacion/QA frontend en bitacora.
Esta comprobacion no sustituye la validacion completa del contrato REST ni de
los demas requisitos de cada politica. Plan gestionado sigue fuera del alcance,
pendiente de mock y validacion expresa.

## Objetivos CPA/ROAS De Google (2026-09-11)

Implementacion **local y gated**, no validacion con el proveedor ni permiso para
activar ajustes. El evaluador existente despacha `adjust_bids` hacia la politica
`google_target_recommendation` cuando el mandato contiene un objetivo propio de
campana: TARGET_CPA, TARGET_ROAS, MAXIMIZE_CONVERSIONS con CPA o
MAXIMIZE_CONVERSION_VALUE con ROAS. Solo Search/PMax activos BASE, EUR/Madrid,
sin estrategia compartida, overrides activos de grupo o presupuesto compartido.

- Lector paginado `campaignWorkspaceGoogleTargetSnapshot.service.js`: consulta
  configuracion heredada/personalizada, objetivos biddable y acciones primarias
  efectivas; una accion secundaria dentro de un custom goal tambien puede pujar.
  El custom complementa los objetivos estandar. Identidad por cuenta, relacion
  con campana y categoria/origen, sin adivinar enums en resource names. Solo
  conversiones comerciales identificables, no visitas u otros objetivos ambiguos.
  No selecciona nombres, contactos, eventos individuales ni datos clinicos.
- El propietario de conversiones debe ser explicito; si es otro conversion
  customer no se cambia la cuenta publicitaria consultada ni la credencial.
  Si los metadatos no son accesibles desde ese ambito, se omite el ajuste.
  Las propiedades ausentes conservan defaults del protocolo, sin inventar EUR
  en una configuracion de valor que no declare moneda.
- Solo una recomendacion vigente RAISE_TARGET_CPA o LOWER_TARGET_ROAS para esa
  campana, cuyo target medio en micros coincide con el actual. No portfolio ni
  ad group. Multiplicador exacto y variacion maxima 10%; una recomendacion mayor
  no se recorta. Solo redondeo sub-micro hacia el valor original. No interpreta
  el coste por lead CRM como CPA/ROAS, ni promete que mejore el rendimiento.
- Coleccion v3 y evidencia ejecutable v5: huellas, permisos/mandato entre paginas,
  recepcion verificada, 45 s/2.000 filas por consulta, vigencia 15 min y espera
  SQL de 14 dias tras otro ajuste del workspace en esa campana. El mismo job
  nocturno, sin cron nuevo. Revalida configuracion, objetivos, recomendacion y
  presupuesto antes de enviar. Si cambian, descarta. No hay atomicidad entre
  lectura y escritura remotas: persiste la limitacion ante cambios externos.
- No usa `applyRecommendation`: modifica exclusivamente el campo CPA/ROAS ya
  autorizado. No crea conversiones ni cambia estrategia, presupuesto o anuncios.
  Recibo durable previo, dedupe por ciclo y recuperacion sin repetir escrituras
  inciertas. El historial distingue objetivo de conversion de coste por lead.
- La ayuda existente `(?)` diferencia esta politica de la reduccion 5% para CPC/
  BID_CAP. COST_CAP y minimo ROAS de Meta siguen pendientes, igual que el criterio
  de relevancia de negativas. Plan gestionado fuera del alcance actual.

Fuentes de contrato: [TargetAdjustmentInfo](https://developers.google.com/google-ads/api/reference/rpc/v24/Recommendation.TargetAdjustmentInfo),
[objetivos de conversion](https://developers.google.com/google-ads/api/docs/conversions/goals/overview),
[objetivos de campana](https://developers.google.com/google-ads/api/docs/conversions/goals/campaign-goals)
y [campos de conversion](https://developers.google.com/google-ads/api/fields/v24/conversion_action).
La validacion es de configuracion, no una auditoria de calidad/consentimiento de
cada conversion recibida. Antes de activar requiere QA autorizado del contrato
REST (incluidos target medio y conversiones entre cuentas), permisos y despliegue
coordinado. Sin llamadas reales Meta/Google, OAuth ni DB compartida en esta fase.

Verificacion backend: 806 tests TAP (22 del recorrido CPA/ROAS) y 76 comprobaciones
MySQL temporal, nueve conexiones y cero sockets ajenos; apagado 0. Cobertura de
las cuatro estrategias, JSON persistido, permisos revocados entre lecturas,
objetivos cambiantes, propuesta caducada, duplicados, recuperacion concurrente
y respuesta incierta sin reenvio. Logs `/tmp/campaign-target-bid-{suite-final,mysql-final}-20260911.log`
y `/tmp/cc-campaign-opt-mysql-0vzacf/result.json`. Evidencia visual/publicacion
frontend, limites y rollback en la bitacora operativa del front.

## Retirada Del Contrato De Ejecucion Antiguo (2026-09-11)

Cambio backend **solo local**, sin reinicio ni apertura de gates. Las metricas
agregadas v1 de `bid_efficiency`/`budget_efficiency` ya no autorizan una primera
escritura. Productor, worker y recuperador exigen las evidencias actuales v3/v4;
el worker descarta los trabajos antiguos antes de acceder a credenciales o
proveedores. Motivo: `workspace_optimization_current_policy_required`, con
explicacion breve en el historial. No se re-firman, actualizan ni borran pruebas
anteriores. Esta decision sustituye las menciones historicas de v1 ejecutable.

Los recibos ya enviados siguen siendo consultables mediante recuperacion solo
lectura, incluso con Optimiza pausado. Ver el valor deseado no atribuye el cambio
a ClinicaClick; una respuesta incierta nunca permite reenviarlo. Las reglas
actuales de pausa v2, puja v3 y presupuesto v4, sus limites y permisos no cambian.

Verificacion: 12 regresiones fallan antes del fix; 784 tests TAP backend y 117
front pasan despues. MySQL temporal: 66 comprobaciones, cuatro conexiones,
cero sockets ajenos y apagado 0. Incluye propuestas antiguas persistidas,
recuperacion concurrente, recibos inmutables, cambios actuales una sola vez y
contabilidad conjunta. Fixtures antiguas migradas a pruebas actuales: 28 dias,
huella de contexto, reduccion 5%, espera de 14 dias; no excepciones para tests
en el ejecutor. No DB compartida, llamadas Meta/Google, OAuth o publicidad real.

Evidencias: `/tmp/campaign-legacy-policy-{before,focused,suite-final,mysql-final,front}-20260911.log`,
`/tmp/cc-campaign-opt-mysql-XwGPlv/result.json`. Sin cambios de layout/build ni
nuevo QA visual: preview 4203 sigue en `efa760469cb76076`. Plan gestionado sigue
aplazado. Pendientes: estrategias avanzadas con evidencia del objetivo de
conversion, relevancia de negativas, publicacion backend coordinada y recorrido
autenticado. La revision inicial de recomendaciones Google no constituye un
motor implementado ni autorizacion de cambios.

## Carga Independiente Y Recuperacion De Propuestas (2026-09-11)

Frontend publicado **solo en preview DEV 4203**, build `efa760469cb76076`.
Resultados, configuracion y preparacion se resuelven independientemente: los KPI
y Salud no esperan lecturas de preparacion lentas o fallidas. Cambiar clinica,
rol o periodo cancela las lecturas previas; cambiar de subtab no las repite.
Una respuesta inicial de preparacion no puede pisar otra posterior al guardado.
El estado de carga y la revision de version siguen impidiendo activar a medias.

`campaignManagedWorkspace=false` deja fuera la nueva entrada gestionada y sus
consultas cliente, hasta validar su mock. No modifica hubs ni permisos/admin
legacy. El dialogo y su codigo quedan conservados, sin habilitarlo por URL o
localStorage. Su suite visual es opt-in y requiere un build separado habilitado;
el QA por defecto exige ausencia de entrada, consultas cliente y mutaciones.

Backend **solo local**: `recoverOptimizationRun` pasa el cambio persistido al
validador de evidencia. Antes se descartaban propuestas de puja v3/presupuesto
v4 aun estando vigentes, porque faltaba ese argumento. Reproducido con cuatro
tests fallidos antes del fix. La recuperacion conserva JSON/huella y encola una
sola continuacion, tambien con dos recuperadores SQL concurrentes. No renueva
evidencia caducada ni reenvia cambios ya enviados. Si caduca durante la espera,
se descarta y una evaluacion posterior debera aportar evidencia nueva.

Verificacion: 768 TAP backend, 117 front, 50 comprobaciones MySQL temporal
(cuatro conexiones; cero sockets ajenos; apagado 0). Chromium: 148 checks y
46 capturas a 1440/1024/390 px, incluyendo respuestas de preparacion retenidas,
revocacion Meta, retorno desde anuncio y seis bloques de Salud. APIs y sesion
sinteticas; no autenticacion real. Cuatro pestanas de 4203 comprobadas en
`/sign-in`, sin token; no se han extraido ni renovado credenciales.

Publicacion: runtime/main/chunk del workspace verificados por SHA-256 contra
dist, HTTP 200 y `Cache-Control: no-cache`; ruta canonica responde SPA 200.
Rollback exclusivamente frontend:
`/home/ubuntu/scripts/cc-front-preview-sync.sh /home/ubuntu/qa-evidence/front-preview-before-campaign-loading-20260911-FSEUkb/build`.
Sin reiniciar APIs/workers, migrar DB compartida, OAuth, publicidad, senales,
cobros, commits/push ni staging. Siguen pendientes estrategias avanzadas de
Optimiza, relevancia de negativas, publicacion backend coordinada y QA autenticado.

Evidencias: `/tmp/campaign-policy-recovery-{before,focused,workspace,mysql}-20260911.log`,
`/tmp/cc-campaign-opt-mysql-AovgiA/result.json`,
`/tmp/campaign-independent-loading-{tests,build}-20260911.log`,
`/home/ubuntu/qa-evidence/campaign-independent-loading-final-20260911/`.

## Alcance Actual: Plan Gestionado Aplazado (2026-09-11)

Decision posterior del usuario: el plan gestionado requiere un mock y validacion
especifica antes de continuar su implementacion. **No forma parte del cierre
actual de Campanas** ni debe bloquear conexion, Medicion de interesados, Optimiza,
resultados y Salud. No interpretar el objetivo inicial como aprobacion vigente
de ese flujo. Se conserva el trabajo local, sin publicarlo ni activar solicitudes,
aprobaciones, publicidad o cobros de clientes.

La ultima verificacion local del dialogo cubre aislamiento de borradores por
clinica, importes servidos por backend, respuesta incierta sin reintento automatico
y revision explicita del contenido. Son pruebas tecnicas, no aceptacion UX.
107 tests front y build `b7024957f1dc09d5`; Chromium 191 comprobaciones/58 capturas
incluyendo regresion a 1440/1024/390 px, con sesion/APIs sinteticas. Ninguna API de
negocio real ni proveedor. La inspeccion visual detecta que, tras hacer scroll,
el aviso de error puede quedar fuera de la zona visible: registrar para el futuro
mock, no considerar cerrado el dialogo porque los checks de overflow pasen.

Backend sin cambios funcionales en esta verificacion. Preview 4203/API sin
actualizar; Chromium compartido sin sesion autenticada. Evidencia en
`/home/ubuntu/qa-evidence/campaign-managed-lifecycle-20260911/qa-result.json`.
La publicacion DEV futura debe separar esta parte no validada del alcance actual.

## Lectura De Busquedas Y Proteccion De Exclusiones (2026-09-11)

Avance local, **sin desplegar ni activar**. `campaignWorkspaceSearchTerms.service.js`
completa la lectura interna de Google Search/PMax, no el motor de negativas.
Reutiliza `googleAdsSearchRows`: paginacion completa, 45 s y maximo 2.000 terminos/
56.000 filas. Solo campanas activas BASE, EUR/Madrid; 28 dias completos,
excluidos los dos ultimos cerrados.

- Search usa `search_term_view`, identidad campana/grupo y estado de targeting.
  PMax usa `campaign_search_term_view` sin inventar grupo ni campo `status`.
  No selecciona un segmento de targeting PMax: devuelve `UNAVAILABLE`, nunca
  lo interpreta como una busqueda no incluida o no excluida.
- Valida cuenta, campana, recurso codificado, fechas, duplicados, enumeraciones,
  importes exactos y conversiones fraccionarias. No redondea una fraccion a
  cero; rechaza underflow. Revalida permisos/mandato entre paginas, recepcion
  al terminar y plazo tambien tras agregar. Rechazo de acceso terminal.
- `reported_terms_only`: completar paginas no acredita todas las consultas.
  Reconcilia clics/gasto diario con campana (tolerancia de un centimo en coste)
  y explicita la parte no representada, sin atribuir toda la diferencia a
  privacidad. PMax puede incluir otros inventarios. Dias ausentes de un termino
  nunca se reconstruyen como cero. `google_ads_attributed_not_crm` distingue
  conversiones del proveedor de leads CRM. Colector separado v2 con `search_terms`,
  sin `attribution`, consultas de contactos/LeadIntake ni union por texto.
- Filtro sintactico retira URLs/emails/telefonos evidentes, controles y textos
  excesivos. Conserva recuentos y huella, no texto ni recurso base64 retirados.
  **No es anonimizacion**: lenguaje natural puede contener datos sensibles y
  una huella de texto es contrastable por diccionario. Snapshot interno en
  memoria: sin nuevo endpoint, persistencia, payload de job, envio a IA o
  inclusion en Salud. Verificador revalida identidad/forma/periodo/cobertura
  incluso con huella recalculada. No es firma del proveedor ni prueba de relevancia.

**Contrato antiguo corregido:** `search_without_results` v1 aceptaba `leads=0`
sin probar atribucion por termino o irrelevancia. Productor/primera ejecucion
rechazan ahora con `workspace_optimization_search_relevance_required`; recuperacion
omite trabajos antiguos no enviados y el historial explica el motivo. Evidencia
historica intacta, sin re-firmar. Recibos con `submitted_at` conservan solo
observacion/recuperacion de lectura, nunca repetir una exclusion incierta.
Este cierre afecta al workspace, no audita otras herramientas legacy.

El evaluador de las 03:45 **no despacha `negative_keywords`**. Faltan contexto
comercial aprobado, prueba de relevancia, politica, productor y revalidacion
especificos. No sustituirlos por regex de empleo/cursos, confianza de IA o cero
conversiones. Revisar inclusiones/exclusiones actuales antes de futuras negativas
EXACT. No presentar esta automatizacion como operativa al abrir gates. Siguen
pendientes el objetivo completo, otras estrategias y despliegue DEV/QA autorizado.

Referencias primarias: campos de
[Search](https://developers.google.com/google-ads/api/fields/v24/search_term_view)
y [PMax](https://developers.google.com/google-ads/api/fields/v24/campaign_search_term_view).
Google documenta omisiones de consultas de poco volumen en el
[informe de terminos](https://support.google.com/google-ads/answer/2472708?hl=en).
No validan una politica de exclusion.

Verificacion: **758 tests TAP backend** (23 de lectura/verificacion, 5 de seguridad
de negativas), **44 comprobaciones MySQL temporal**: dos conexiones, cero sockets
ajenos, apagado 0. SQL verifica rechazo antes de insertar, omision de trabajo
historico y recuperacion de lectura sin alterar JSON. Proveedores sinteticos.
Sin DB/migraciones compartidas, OAuth, reinicios, anuncios/senales/cobros, push
o staging. Sin cambios de layout ni nuevas capturas; QA visual anterior conserva
su alcance sintetico. Preview 4203/API y build local `9c3f17bda321a4a0` sin actualizar.

Evidencias:
- `/tmp/campaign-search-terms-focused-20260911.log`
- `/tmp/campaign-search-terms-workspace-20260911.log`
- `/tmp/campaign-search-terms-mysql-20260911.log`
- `/tmp/cc-campaign-opt-mysql-97Paog/result.json`

## Decisiones De Presupuesto Diario (2026-09-11)

Ampliacion local, **no desplegada ni activada**. El evaluador de las 03:45 Madrid
ya conecta la accion `adjust_budget` con el colector de rendimiento, una regla
versionada y el productor/ejecutor existentes. No se ejecuta al consultar Salud.

- `budget_efficiency` v1 usa dos ventanas consecutivas de 14 dias completos
  (excluye los dos ultimos cerrados), con al menos 20 leads CRM y 100 clics
  EN CADA ventana, gasto positivo, recepcion verificada y atribucion observada
  completa. EUR/Madrid y todas las filas diarias; los huecos Meta no son cero.
- Propone bajar hasta un 5 % si CPL sube al menos 50 %, o subir hasta un 5 %
  si CPL baja al menos 25 % y el gasto medio reciente alcanza el 90 % del
  presupuesto diario ACTUAL. Redondea hacia el importe anterior, sin cambios
  a cero, estrategia o propietario del presupuesto. Si no hay muestra o
  diferencia suficiente, no propone. Los porcentajes son una politica operativa
  pendiente de validacion, no una garantia estadistica de rendimiento.
- Google Search: presupuesto diario exclusivo de campana. Meta Auction:
  presupuesto diario de campana O conjunto; agrega solo los anuncios de ese
  propietario. No toma prestada la muestra de otros conjuntos. Compartidos,
  duracion total, otras monedas/zonas y PMax no tienen esta regla habilitable.
- Una propuesta por campana/ciclo, reducciones antes que subidas y despues
  mayor gasto reciente. Antes de reservar, exige 14 dias sin ningun ajuste
  enviado por el workspace a esa campana, tambien otro recurso/mandato.
- Evidencia compacta v4, 28 recuentos diarios sin contactos ni IDs de leads,
  direccion/antes/despues y huellas de origen, mandato y recurso. TTL 15 min,
  recogida menor de 60 s, dedupe transaccional y revalidacion antes del envio.
  Un error de permisos es terminal, sin credenciales alternativas ni OAuth.
- **La propuesta no reserva dinero ni acredita el limite.** El ejecutor obtiene
  el gasto actual de TODAS las campanas incluidas y exige su contabilidad
  conjunta existente antes de escribir. Tanto subidas como bajadas se omiten
  si la prevision resultante supera el limite elegido. Una bajada insuficiente
  requiere revision, no permite saltarse el limite ni autoriza una pausa total.
  El recibo contable persiste antes del transporte, incluso si este queda incierto.
- UI: misma ayuda `(?)` de presupuesto en seleccion y revision, ahora con las
  condiciones de ambas direcciones. Historial explica la espera. Sin nuevas
  pestañas, bloques ni cambios en los hubs aprobados.

Limites: gasto/recepcion actuales no prueban disponibilidad historica o cohortes
de clics; la utilizacion se compara con el presupuesto actual, no con un historial
de presupuestos externos. Una espera de 14 dias solo observa nuestros ajustes
persistidos. El limite es una prevision, no un tope de cobro. Google explica que
editar el presupuesto afecta al gasto y a sus limites; esa documentacion no
valida nuestros umbrales. [Efectos de cambiar presupuestos en Google Ads](https://support.google.com/google-ads/answer/10487143?hl=en).
Los propietarios diarios Meta corresponden a los campos de
[Campaign](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/campaign.py)
y [AdSet](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adset.py).

El contrato generico v1 de presupuesto sigue existiendo; la nueva produccion
automatica usa v4. Auditar pendientes v1 antes de abrir gates, sin re-firmarlos
ni reproducirlos. El objetivo completo sigue activo: negativas, otras estrategias/
tipos de campana, validacion de reglas y despliegue DEV/QA final autorizado.
No hay permisos Meta recuperados, actividad publicitaria, senales o cobros reales.

Verificacion: **730 tests TAP backend**, **41 comprobaciones MySQL temporal**
(dos conexiones, cero sockets ajenos, apagado 0), **96 tests front**, build
`9c3f17bda321a4a0`. Aviso CommonJS existente de `socket.io-parser`/`debug`.
Las pruebas nuevas recorren colector, politica, productor y ejecutor reales;
proveedores/recepcion son sinteticos. SQL comprueba evidencia v4, subidas/bajadas,
dedupe concurrente, recibo contable y rechazo por limite/espera entre ajustes.
Se corrigio un nombre de campo en la fixture del propietario Meta antes del
pase final; no era una llamada o una modificacion de datos reales.
Chromium: **128 comprobaciones y 40 capturas** a 1440/1024/390 px. Ayuda completa
con raton/teclado, flujo de configuracion y regreso desde campana/Salud sin
regresiones; capturas inspeccionadas. Sesion y APIs sinteticas; cero acceso a
backend/proveedores, recursos externos bloqueados. No acredita OAuth ni login
real. Servidores de prueba cerrados. Preview 4203/API sin actualizar, sin DB o
migraciones compartidas, reinicios, commits/push ni promociones a staging.

Evidencias:
- `/tmp/campaign-budget-policy-workspace-20260911.log`
- `/tmp/campaign-budget-policy-mysql-20260911.log`, `/tmp/cc-campaign-opt-mysql-YetSv2/result.json`
- `/tmp/campaign-budget-policy-front-tests-20260911.log`, `/tmp/campaign-budget-policy-front-build-20260911.log`
- `/tmp/campaign-budget-policy-visual-20260911.log`
- `/home/ubuntu/qa-evidence/campaign-budget-policy-20260911/qa-result.json`

## Evaluacion De Limites De Puja (2026-09-11)

Ampliacion local, **no desplegada ni activada**, del evaluador descrito debajo.
El mismo job nocturno de las 03:45 Madrid despacha ahora una evaluacion por
accion autorizada. No hay un segundo cron ni un permiso implicito por conectar.

- El colector existente revalida la accion solicitada entre lecturas y obtiene
  controles de puja actuales con los inspectores Google/Meta existentes. No
  inventa objetivos a partir del CPL ni reutiliza autorizaciones guided/managed
  de conversiones como permiso para modificar pujas.
- Regla `bid_efficiency` v1: Google Search `MANUAL_CPC` sobre la puja por defecto
  del grupo y Meta Auction `LOWEST_COST_WITH_BID_CAP` sobre `bid_amount`.
  Compara el mismo grupo/conjunto en dos ventanas consecutivas de 14 dias,
  cada una con al menos 20 leads, 100 clics y gasto positivo. Si el CPL sube
  un 50 % o mas, propone reducir el limite actual un 5 %, redondeando hacia
  el valor anterior. No lo aumenta, no lo lleva a cero ni cambia la estrategia.
- Requiere EUR/Madrid, identidad CRM observada completa, recepcion verificada
  y todas las filas diarias de los anuncios del grupo. Una ausencia Meta es
  desconocida. Una propuesta por campana/ciclo, priorizando gasto reciente.
- La espera de 14 dias se comprueba bajo bloqueo SQL antes de reservar el
  envio: cualquier ajuste previo ENVIADO por este workspace en esa campana,
  incluso otro recurso/mandato, bloquea una nueva puja. No demuestra ausencia
  de modificaciones externas no registradas. Conserva el cooldown de recurso.
- Evidencia compacta `schema_version: 3`, 28 recuentos diarios sin IDs/contactos
  de leads, valor previo/nuevo y huellas de recurso, origen, configuracion y
  ciclo. Caduca en 15 min; recogida menor de 60 s. Productor/ejecutor revalidan
  regla, estrategia, valor actual, recepcion y mandato. Dedupe de ciclo/campana
  transaccional y recuperacion sin repetir escrituras inciertas.
- Payload del hijo version 2 incorpora `action`, solo IDs y ciclo; v1 sigue
  siendo exclusivamente una pausa. Se valida la accion antes de credenciales.
  Error de permisos terminal; no se renueva Meta ni se busca otro token.
- La UI mantiene seleccion/revision y explica el alcance con el mismo `(?)`.
  La espera aparece con un motivo legible en el historial, no un error crudo.

**Limites pendientes:** la regla no cubre target CPA, Meta COST_CAP, ROAS ni
Performance Max. Un lead CRM no equivale necesariamente a la conversion de la
estrategia; faltan evidencia y reglas especificas para esos objetivos. La puja
por defecto de un grupo Google tampoco modifica overrides de sus keywords.
Los umbrales son heuristicas operativas a validar antes de abrir gates, no un
experimento causal: altas CRM no son cohortes de clics y recepcion actual no
acredita disponibilidad historica. No se promete mejora de rendimiento.

El ejecutor conserva el contrato generico antiguo de pujas con evidencia v1;
la nueva produccion automatica usa v3. **Auditar trabajos/planes v1 pendientes
antes de activar**, sin re-firmarlos, migrarlos o reproducirlos automaticamente.
No afirmar que todos los comandos historicos tienen la nueva regla de evidencia.
Presupuesto tiene ahora la regla del apartado anterior; siguen negativas, las otras estrategias,
despliegue DEV coordinado y QA final con acceso autorizado del recorrido completo.

Referencias oficiales consultadas para distinguir limite de puja y objetivo de
conversion, no como validacion de estos umbrales:
[estrategias Google Ads](https://developers.google.com/google-ads/api/docs/campaigns/bidding/strategy-types),
[campos y estrategias de AdSet del SDK Meta](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adset.py).

Verificacion local: **704 tests TAP backend** (workspace y scheduler), **33
comprobaciones MySQL temporal**, **95 tests front**, build DEV
`72bd2a2173bf9a08`. Aviso CommonJS existente de `socket.io-parser`/`debug`.
SQL con dos conexiones sobre instancia propia, cero sockets ajenos y apagado 0;
incluye evidencia v3, dedupe concurrente y espera entre ajustes de campana.
Chromium: **123 comprobaciones y 40 capturas** a 1440/1024/390 px, ayuda con
raton/teclado sin alterar autorizacion, navegacion contextual y seis bloques de
Salud conservados. Capturas de movil/escritorio inspeccionadas, sin recortes.
Sesion/APIs sinteticas, ninguna peticion a backend/proveedores; fuentes/SDK/sockets
externos abortados. No acredita OAuth, autenticacion ni ejecucion externa reales.
Servidor estatico temporal cerrado; preview 4203/API sin actualizar, sin reinicios,
DB/migraciones compartidas, anuncios, senales, cobros, commits/push o staging.

Evidencias de esta ampliacion:
- `/tmp/campaign-bid-workspace-20260911.log`
- `/tmp/campaign-bid-mysql-20260911.log`, `/tmp/cc-campaign-opt-mysql-9sgE2c/result.json`
- `/tmp/campaign-bid-front-tests-20260911.log`, `/tmp/campaign-bid-front-build-20260911.log`
- `/tmp/campaign-bid-visual-20260911.log`
- `/home/ubuntu/qa-evidence/campaign-bid-policy-20260911/qa-result.json`

## Evaluacion Nocturna Y Pausas Autorizadas (2026-09-11)

Implementacion local, **no desplegada ni activada**. El colector del apartado
siguiente ya tiene un consumidor productivo: el evaluador interno obtiene datos
actuales, aplica una regla versionada y entrega propuestas al productor durable
existente. Consultar Salud no ejecuta ese recorrido ni autoriza cambios.

- Job raiz `campaign_workspace_optimization_evaluations`, cron `45 3 * * *`
  (03:45 `Europe/Madrid`, incluidos cambios de horario). Override
  `JOBS_CAMPAIGN_WORKSPACE_OPTIMIZATION_EVALUATION_SCHEDULE`; hereda
  `JOBS_TIMEZONE`. No sustituye el evaluador legacy `campaign_optimization_evaluation`.
  Catalogo, descripcion del job, metodo del scheduler y ejecutor estan enlazados.
- Requiere los DOS gates existentes de activacion y Optimiza. No basta con
  conectar cuentas. Solo mandatos activos, accion de pausa elegida y recursos
  exactos revisados/autorizados. Campanas o anuncios nuevos no heredan permiso
  para modificarlos aunque se importen automaticamente para el informe.
- Despacha 50 configuraciones por pagina con continuacion durable. Cada hijo
  `campaign_workspace_optimization_evaluate` lleva solo IDs, referencia y ciclo;
  usa la cola de integraciones serializada. Conserva la fecha del job raiz al
  reintentar. No guarda credenciales, metricas ni leads en su payload o resultado.
- Regla `ad_underperformance`, version 1: dos periodos consecutivos de 14 dias,
  al menos 10 leads y 100 clics por anuncio EN CADA periodo, coste por lead al
  menos doble frente a otro anuncio activo del MISMO grupo/conjunto en AMBOS.
  EUR, calendario Madrid, atribucion observada completa y recepcion verificada.
  Una propuesta por grupo; maximo una pausa por grupo cada 24 h. No se pausa
  el ultimo anuncio activo. Meta sin alguna fila diaria no produce una pausa.
- Los umbrales son una politica operativa conservadora para validar antes de
  activar, no significacion estadistica ni promesa de mejora. Se comparan altas
  CRM, no cohortes por clic; ni la conciliacion ni recepcion actual demuestran
  disponibilidad historica completa. Los dos dias de margen no garantizan gasto
  o leads definitivos. Insuficiencia significa no actuar, no marcar una mejora.
- Evidencia compacta `schema_version: 2`: 28 pares de recuentos diarios,
  identificadores publicitarios, version y huellas de origen/configuracion.
  Caduca a los 15 minutos; el productor exige recogida menor de 60 s. Valida
  fechas, importes exactos y regla otra vez antes del envio. No incluye IDs ni
  contactos de leads. Nunca usar una comparativa de Salud como comando.
- Dedupe por ciclo/grupo bajo bloqueo SQL, independiente de la nueva hora de
  recogida. El ejecutor vuelve a comprobar el anuncio de referencia activo,
  mandato/permisos y recepcion antes de reservar el envio. Se conserva la
  semantica existente: marcador durable antes de HTTP, sin repetir una escritura
  con resultado incierto. Un cambio concurrente bloquea o exige revision.
- Error de permisos terminal, sin renovar Meta ni intentar otra credencial.
  Otro ciclo de esa cuenta/configuracion requiere una comprobacion explicita
  exitosa, vigente y posterior al fallo registrado; despues se revalida el grant.
- Una pausa antigua con evidencia v1 NO se puede enviar por primera vez. Los
  recibos ya enviados conservan recuperacion de solo lectura y nunca se repiten.
  No hay migracion/re-firma automatica: auditar pendientes antes de abrir gates.
- UI: misma ayuda `(?)` en seleccion y autorizacion; no cambia el checkbox al
  abrirla. El historial explica datos caducados, referencia cambiada o recepcion
  sin verificar mediante textos permitidos, no errores crudos del proveedor.

**Pendiente del objetivo completo:** las estrategias de puja no cubiertas en el
apartados anteriores y negativas; completar su evidencia/criterios por accion, despliegue
DEV coordinado y QA final con acceso autorizado. La infraestructura de ejecucion
y contabilidad no equivale a tener esas decisiones automaticas implementadas.
Ningun avance de este apartado activa anuncios, cobros, OAuth o senales reales.

Verificacion final de este corte: **683 tests workspace y orquestacion del
scheduler** (684 en el resumen TAP), **29 comprobaciones MySQL**, **94 tests
front**, build DEV `b5e7868f29bee34d`. Solo aviso CommonJS ya existente de
`socket.io-parser`/`debug`. MySQL temporal propio, dos conexiones, cero sockets
ajenos y apagado correcto; migration/modelos SQL reales, transport/recepcion
sinteticos. La prueba SQL inicial detecto dos errores de fixture (identidad de
campana y orden canonico tras renombrar anuncio), corregidos antes del pase final.

Chromium: **105 comprobaciones y 35 capturas** a 1440/1024/390 px; ayuda completa
con raton/teclado sin alterar autorizacion, navegacion Salud/campana/regreso,
comparativas y rechazo Meta simulado. Capturas inspeccionadas. Sesion y APIs
sinteticas; cero peticiones a backend/proveedores. El runner bloquea tambien
las cargas externas de fuentes/SDK Meta y sockets; no prueba una conexion real.
Servidor estatico temporal sin proxy, cerrado al terminar. Preview 4203 y API
permanecen sin actualizar; sin reinicios, DB de clientes, migraciones compartidas,
OAuth, commits/push, staging, cobros o senales.

Evidencias:
- `/tmp/campaign-pause-workspace-final-20260911.log`
- `/tmp/campaign-pause-mysql-20260911.log`, `/tmp/cc-campaign-opt-mysql-6JfCCI/result.json`
- `/tmp/campaign-pause-front-tests-20260911.log`, `/tmp/campaign-pause-front-build-20260911.log`
- `/tmp/campaign-pause-visual-final-20260911.log`
- `/home/ubuntu/qa-evidence/campaign-pause-policy-final-20260911/qa-result.json`

## Evidencia De Rendimiento Para Optimiza (2026-09-11)

Implementacion **local, no desplegada**. El nuevo colector interno
`collectOptimizationEvidence` reutiliza el mandato real, permisos, recepcion y
atribucion del CRM. No tiene endpoint publico: lo invoca ahora el evaluador
nocturno descrito arriba. El colector en si no crea comandos, jobs, mutaciones
publicitarias ni senales.
La recomendacion consultable del apartado siguiente sigue usando solo la DB.

- Dos gates existentes, activacion y Optimiza, cerrados: se comprueban antes de
  cargar modelos/credenciales y durante la recogida. Revalida mandato, actor,
  clinica, seleccion, titularidad operativa y grant antes/despues de CADA llamada,
  incluidas paginas Google dentro de una misma consulta. Un rechazo no provoca
  un intento con otra conexion o credencial. No se han renovado tokens reales.
- Se corrigio el autorizador compartido: un mandato de grupo respeta tambien
  la exclusion posterior de una campana en la configuracion de su clinica.
  Lee/bloquea esa seleccion al preparar o ejecutar y en recuperacion de solo
  lectura. MySQL confirma que excluir durante preflight impide el envio.
- `campaignWorkspacePerformanceSnapshot.service` obtiene inventario y gasto/
  clics diarios por campana y anuncio mediante los lectores existentes. Google
  Search BASE y Meta Auction activas, EUR y `Europe/Madrid`; otros tipos quedan
  fuera de esta evidencia para pausa, no de los informes generales.
- Ventana interna: 28 dias completos, omitiendo los dos ultimos dias cerrados
  para dejar margen de llegada. El 11/09 consulta 12/08 a 08/09, ambos incluidos.
  No modifica el filtro 7/30 de la UI. No es garantia de que todos los leads o
  costes sean definitivos. Plazos de 45 s en proveedor y 60 s en la coleccion;
  reloj hacia atras, cruce de dia o resultado tardio invalidan la recogida.
- Exige identidad exacta y paginacion terminada; limita 2.000 anuncios, 56.000
  filas diarias y 10.000 leads de UNA clinica. Duplicados, truncamiento, importe
  invalido o discrepancia entre totales no producen una evidencia utilizable.
  Conciliacion diaria de clics exacta y gasto con tolerancia total de un centimo;
  los micros se conservan como enteros decimales, sin redondear cada segmento.
- Google reconstruye ceros solo tras una consulta segmentada completa, segun
  su contrato de omision. Meta conserva ausencias como desconocidas. No se siguen
  URLs de paginacion con credenciales: solo cursores en el endpoint original.
- El CRM usa su identidad canonica por anuncio, no nombres ni UTMs aproximadas.
  Se proyectan unicamente campos de atribucion, sin contactos. La salida contiene
  recuentos diarios, no IDs de leads ni payloads. `attribution.complete` significa
  que los leads observados potencialmente atribuibles estan identificados, no
  que se hayan recibido todos los formularios posibles. Si hay huecos es `false`.
  La recepcion se exige comprobada antes y despues de leer las metricas.

Las reglas de pausa y limites de puja y sus productores estan conectados como
se detalla arriba; **pendientes** otras estrategias y acciones. `collected: true`
NO equivale a recomendar una pausa ni a autorizarla. La fecha CRM es la de alta,
no una cohorte por clic; recepcion actual no demuestra disponibilidad historica.
Ni una comparativa ni este colector por separado cierran Optimiza. El objetivo
completo sigue activo, incluidos el
despliegue DEV coordinado y QA final autorizado; no ampliar el alcance de gates
ni publicar cambios para cerrar artificialmente esa verificacion.

Verificacion del corte anterior del colector: **654 tests workspace**, incluidos 43 nuevos en esa fase, y
**23 comprobaciones MySQL** en instancia temporal propia, dos conexiones,
cero sockets ajenos y apagado correcto. Los transports, identidades y modelos
de los tests son sinteticos; se ejecutan los lectores, validador de mandato,
atribuidor y transacciones reales. No se ha consultado DB de clientes ni Meta/
Google. La prueba inicial encontro una colision de nombres en la fixture Meta
(campana remota/workspace), corregida antes de la regresion final.

Logs `/tmp/campaign-performance-evidence-regression-final-20260911.log` y
`/tmp/campaign-performance-evidence-mysql-20260911.log`; evidencia SQL privada
`/tmp/cc-campaign-opt-mysql-LPYfCJ/result.json`. Sin cambios visuales ni build/
Chromium nuevo: se conserva la verificacion anterior, no se atribuye a este
cambio backend. Preview 4203 y API sin actualizar; sin reinicios, migraciones
compartidas, commits, push, staging, cobros o senales.

Referencias primarias consultadas para el contrato de lectura:
[Google, metricas cero](https://developers.google.com/google-ads/api/docs/reporting/zero-metrics),
[SDK oficial Meta, insights de campana](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/campaign.py),
[SDK oficial Meta, campos de insights](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adsinsights.py).
La consulta documental no verifica permisos ni disponibilidad de una cuenta real.

## Propuestas Consultables Por Anuncio (2026-09-11)

`campaignWorkspaceRecommendations.service` se integra en el GET existente del
workspace, despues del informe y Salud. **Solo lectura local**: no consulta
proveedores, encola ajustes ni prepara un comando ejecutable. No requiere
Optimiza para consultar la comparativa. Sin nuevos endpoints, tablas o jobs.

- Regla diagnostica versionada `ad_cost_review`: al menos diez leads del CRM en
  cada anuncio activo y una diferencia observada de coste por lead de al menos
  el 50 %. Compara el de mayor y menor coste dentro del MISMO grupo de anuncios
  o conjunto Meta. Una propuesta por grupo, con identidad completa de campana,
  cuenta, proveedor y clinica; no mezcla grupos ni propone un ganador causal.
- Usa el periodo completo seleccionado (7/30 dias de Madrid), EUR, recepcion
  actualmente comprobada, inventario/metricas recientes y atribucion por anuncio
  del informe. Leads pagados sin campana conocida suprimen propuestas en su
  clinica, no en clinicas ajenas. Campanas pausadas/no asignadas, permiso Meta
  rechazado persistido, muestra pequena y moneda desconocida quedan fuera.
- Cada dia requiere filas de campana y de todos los anuncios activos. Las
  observaciones deben ser posteriores al cierre de ese dia y no futuras. El
  gasto diario de todos los anuncios debe cuadrar con el de la campana, con
  tolerancia de un centimo por redondeo. No deduce cero por ausencia de filas;
  los ceros Google solo entran por el lector de respuestas completas existente.
  Deduplica los mismos segmentos que el informe. Una fecha de inventario no
  reemplaza una fecha de metricas explicitamente desconocida.
- Incidencias tecnicas, publicacion o ausencia reciente de leads tienen
  prioridad y suprimen la propuesta en esa campana. La propuesta no aumenta
  `findings`, `affectedCount` ni cambia el tono/OK de los indicadores.
- DTO `report.recommendations` y `healthBlocks[].recommendations`: textos,
  anuncio de mayor/menor coste, leads, inversion, CPL, periodo, regla y origen;
  `automatic: false`, `action: review_ads`. Sin tokens, datos de contactos,
  mandatos, payloads publicitarios ni enlaces a mutaciones.
- UI: contador discreto dentro de Coste por lead; comparativa desplegable en
  su dialogo y en el detalle de campana. Diez propuestas por pagina. Mismas seis
  tarjetas de Salud, sin otro menu. El regreso conserva Salud como origen y
  la comparativa muestra fechas `DD/Mes/YYYY`. Cambio de ambito/periodo cierra
  dialogos y reinicia la paginacion; no muestra propuestas de la campana previa.

**Alcance exacto:** son diagnosticos observacionales sobre filas sincronizadas
y leads registrados en el periodo, no una prueba A/B ni cohortes por fecha del
clic. Diez leads y 50 % son criterios de visualizacion versionados, no umbrales
de significacion estadistica ni autorizacion suficiente para pausar un anuncio.
Conciliar dos caches no demuestra integridad de toda la respuesta del proveedor,
ausencia historica de fallos de recepcion ni gasto final. Por eso esta propuesta
NO alimenta `enqueueOptimizationAdjustment`. La pausa usa el colector y la regla
independientes descritos arriba; siguen pendientes pujas/keywords/presupuesto,
con evidencia adecuada para cada accion, limites y mandato real. No se declara
Optimiza terminado por esta UI.

Codigo/build locales, gates cerrados, tokens Meta sin reconectar. No desplegado
en API ni preview 4203 y sin promocion a staging. El hub y el interior del
objetivo Captar nuevos pacientes no cambian.

Verificacion: **611 tests backend, 93 frontend**, build DEV `e076225b16093967`
(`--configuration development --source-map=false`, heap 6144 MB, dos workers).
Aviso existente CommonJS de `socket.io-parser`/`debug`, sin error de compilacion.
QA Chromium: **87 comprobaciones y 30 capturas** a 1440/1024/390 px, incluidas
lectura de ambos anuncios en el dialogo movil, navegacion Salud/campana/regreso,
dos proveedores agregados, revocacion Meta y regresion del borrador de presupuesto.
Evidencia `/home/ubuntu/qa-evidence/campaign-recommendations-health-final-20260911/`.
Sesion y APIs aisladas: los casos de recomendaciones se generan con los servicios
reales de informe/Salud/reglas a partir de registros sinteticos, no un backend
vivo ni autenticacion real. Cero peticiones a API de negocio/proveedor, un rechazo
Meta simulado, sin errores JS. No demuestra permisos vigentes ni operacion real.

Logs `/tmp/campaign-recommendations-workspace-tests-final.log`,
`/tmp/campaign-recommendations-front-tests-final.log`,
`/tmp/campaign-recommendations-build-final.log` y
`/tmp/campaign-recommendations-health-visual-final.log`.
Runner front `scripts/tests/campaign_meta_failure_visual_qa.js` con
`CC_QA_RECOMMENDATION_BACKEND=/home/ubuntu/wt/back-dev` ejecuta el generador
sintetico en otro proceso sin bootstrap de modelos productivos y con sockets/fetch
bloqueados. Su servidor es solo estatico, sin proxy, y se cierra al terminar.
El primer intento de generacion cargo metadatos de modelos y no produjo JSON
limpio; se corrigio el aislamiento antes de la prueba final. No hubo conexion
a DB/proveedores. Otra fixture inicial colocaba todos los leads del mes al
principio y genero correctamente avisos de ausencia reciente: se corrigio la
distribucion de prueba y se cubrio la prioridad de esas incidencias con un test.

## Vigencia De Resultados Y Salud (2026-09-11)

Correccion local, sin consultas a proveedores ni cambios de interfaz. La fecha
de actualizacion usada para evaluar rendimiento corresponde ahora al ultimo dia
de metricas, no a la fila mas recientemente actualizada de cualquier fecha.
Un backfill antiguo no rejuvenece un dia reciente que siga desactualizado.
Entre segmentos del ultimo dia se conserva la observacion mas antigua; si falta
una fecha o es invalida/futura, la cobertura no se acredita como vigente.

Salud aplica la misma comprobacion a coste, ausencia de leads y estado de anuncios.
Caduca a las 36 h exactas; un agregado parcialmente comprobado queda neutral,
no OK. Se conservan importes, leads y estados historicos: no se convierten datos
incompletos en cero ni se atribuye una averia solo por faltar comprobacion.
No implica cobertura completa de cada dia/segmento ni recepcion demostrada de
todos los leads; ese contrato aun debe exigirse al recomendador.

Verificacion final acumulada: **593 tests workspace**, incluidos seis nuevos
casos de fechas/segmentos/agregados, y orquestacion del scheduler correctos.
Logs `/tmp/campaign-workspace-final-regression-20260911.log` y
`/tmp/campaign-scheduler-final-regression-20260911.log`.
DB/Redis/proveedores bloqueados en esta regresion; las 21 comprobaciones de
MySQL propio del apartado siguiente tambien finalizaron correctamente.
Sin build nuevo ni QA visual adicional: la correccion usa los estados neutrales
ya existentes. No se ha desplegado en preview/API; objetivo aun abierto.

## Concurrencia MySQL Y Persistencia JSON De Optimiza (2026-09-11)

Verificado en una instancia MySQL 8.0.42 **temporal y aislada**, no en la DB
compartida DEV/staging. No se han reiniciado APIs/workers, desplegado codigo ni
abierto gates. Meta sigue bloqueado; ningun transporte real Google/Meta se usa.

- La primera prueba detecto que MySQL reordena claves de columnas JSON: una
  evidencia intacta invalidaba `plan_key` despues de guardarla. Se normalizan
  recursivamente las claves al calcular huellas de compatibilidad, comandos,
  evidencia y recibos de presupuesto. Orden de arrays, tipos y valores siguen
  siendo significativos; no se elimina la comprobacion de integridad.
- `verifyChange` permite leer comandos historicos con la huella anterior,
  reconstruyendo su forma conocida. No recalcula ni acepta automaticamente un
  `plan_key` antiguo. Antes de abrir ejecucion hay que inventariar los registros
  pendientes/enviados y pruebas de compatibilidad de la version anterior.
  No se han consultado ni modificado esos datos de clientes en esta fase.
  Una prueba antigua puede requerir nueva comprobacion; un envio incierto exige
  revision tecnica, nunca borrar el recibo, repetir la mutacion o volver a firmar
  evidencia historica para desbloquearla.
- Runner opt-in `campaign_optimization_mysql.integration.js`: migracion real
  idempotente y rollback protegido, modelos productivos de setting/evento/job/run,
  transacciones, bloqueos, autorizacion, productor, ejecucion y recuperacion reales.
  Inventario/grants son fixtures SQL; las llamadas de proveedor son sinteticas.
  Las perdidas de confirmacion se inyectan alrededor de commits SQL reales, no
  constituyen un ensayo de fallo de red contra Google o Meta.
- 21 comprobaciones: productores/trabajadores duplicados, cuentas compartidas,
  cuentas independientes, pausa y membresia revocada durante comprobacion,
  reserva mensual entre cuentas, lectura de un recibo en el siguiente dia,
  rollback atomico del job, lease vencido, recuperacion concurrente y perdida
  de confirmacion antes/despues de un commit. Ninguna segunda escritura tras un
  envio incierto; no se usa un mutex de JavaScript en lugar de bloqueos MySQL.
- Fixture con directorio privado, `--no-defaults`, `--skip-networking`, X Plugin
  deshabilitado y unico socket permitido dentro de ese directorio. Verifica el
  datadir antes de crear la DB sintetica. Bloquea sockets ajenos y fetch; no carga
  el bootstrap de modelos productivo, Redis ni configuracion DB del despliegue.
  Cierra conexiones con plazo y detiene solo el hijo que crea, tambien al fallar.
  Conserva datos/log/resultado privados para inspeccion; no copia datos clinicos.

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/campaign_optimization_mysql.integration.js
node --require ./src/scripts/tests/fixtures/campaign_offline_runtime.cjs --test src/scripts/tests/campaign_workspace_*.test.js
```

Verificacion final: **587 tests workspace y 21 comprobaciones MySQL**, correctos.
La repeticion final uso dos conexiones SQL distintas, cero intentos de sockets
ajenos y cierre normal del mysqld propio; la repeticion anterior uso seis.
Logs `/tmp/campaign-optimization-mysql-regression.log` y
`/tmp/campaign-optimization-mysql-final.log`; informe final privado
`/tmp/cc-campaign-opt-mysql-qsYwK5/result.json`. La primera reproduccion fallida
se conserva en `/tmp/campaign-optimization-mysql.log`.

Esta verificacion resuelve la prueba aislada de concurrencia, no la operacion
publicitaria real. Siguen pendientes el recomendador con cobertura y muestras
suficientes, la conciliacion operativa de presupuesto y despliegue/QA final
autorizado. No hay cambios visuales en esta fase; se conserva la evidencia
Chromium del apartado siguiente. El objetivo completo continua abierto.

## Prevision Mensual Conjunta De Optimiza (2026-09-11)

Implementacion local DEV, **sin habilitar gates, ejecutar proveedores ni desplegar**.
Sustituye el hook de prueba `verifyBudget` por lectura y reserva reales en el
ejecutor. No representa un limite de facturacion garantizado ni cierra Optimiza.

- `campaignWorkspaceBudgetSnapshot.service` lee configuracion y gasto del mes
  de cada campana seleccionada: Google GAQL y Meta Graph con transports limitados.
  Exige EUR y calendario `Europe/Madrid`, identidad completa y respuesta completa.
  Rechaza moneda/zona distinta, presupuestos Google compartidos y Meta de duracion
  total. En Meta cuenta presupuesto de campana O de conjuntos, nunca ambos.
  Una campana pausada conserva gasto publicado, sin compromiso futuro activo.
- `campaignWorkspaceBudgetAccounting.service` incluye todas las campanas de la
  seleccion, no solo las autorizadas para ajustes; respeta exclusiones de clinica
  sobre grupo. Revalida seleccion, propietarios y grants de todas las cuentas.
  Snapshot y coleccion caducan a los 60 s o al cambiar de dia/mes, tambien si se
  espera por bloqueos de DB. Consultas externas siempre fuera de transaccion.
- Proyeccion en centimos exactos: gasto publicado del mes + suma de presupuestos
  diarios por los dias naturales restantes (incluido hoy) + reserva de la mayor
  cuantia diaria observada hoy si se reduce. Es deliberadamente conservadora y
  puede contar otra vez parte del dia ya gastado. Si supera el limite se omite
  el ajuste, incluso una reduccion que no bastase para quedar dentro: revision
  manual, no promesa de correccion automatica del exceso.
- El recibo `outcome.budget_accounting` se guarda en la misma transaccion que
  `submitted_at`, antes de la mutacion. Incluye version, mes/dia, limite, gasto,
  recursos, proyeccion y huellas de evidencias; no tokens, URLs ni contactos.
  Usa `CampaignWorkspaceOptimizationRuns` existente: sin migracion nueva.
  Finalizacion y recuperacion conservan el recibo, incluso si falla el commit,
  se revocan permisos o queda resultado incierto. Nunca se repite la escritura.
- Los recibos del mismo workspace/mes se consultan sin restringirse al mandato
  o namespace actual. Gasto ya observado no disminuye por una respuesta tardia.
  Quitar una cuenta no libera su ultimo compromiso hasta poder inspeccionarlo
  de nuevo o cambiar de mes. Una lectura completa de una campana pausada puede
  liberar recursos futuros, no borrar gasto. Falta/corrupcion de un recibo de
  presupuesto enviado bloquea el siguiente ajuste: no se sustituye por cero.
- El historial muestra la causa concreta del ajuste omitido, mediante textos
  permitidos; nunca devuelve el ledger ni errores crudos del proveedor.
  Preferencias y revision llaman al campo `Limite previsto` y comparten ayuda
  `(?)`: no es un tope de cobro de Google o Meta.

**Limites de cobertura que siguen abiertos antes de habilitar presupuesto:**
la seleccion parte del inventario local; una campana externa nueva no aparece
hasta sincronizarse. Una respuesta reciente no garantiza que el proveedor haya
publicado todo el gasto, ni cubre modificaciones ajenas. El presupuesto diario
no es una cota dura de gasto diario. Ver [efecto de los cambios de presupuesto
en Google Ads](https://support.google.com/google-ads/answer/10487143?hl=en).
No se aplica esa regla de Google a Meta ni se inventa un factor comun. Un futuro
tope contractual duro requiere otro control explicito, cobertura de inventario
y conciliacion, no renombrar esta prevision ni abrir los gates existentes.

Verificacion offline: 583 tests workspace y orquestacion del scheduler correctos,
sin acceso a DB/Redis compartidos ni proveedores. Incluye ambos adaptadores con
transportes sinteticos y ejecutor/reserva/recuperacion real con modelos de prueba.
Logs `/tmp/campaign-budget-workspace-tests-final.log` y
`/tmp/campaign-budget-scheduler-tests.log`. No acredita concurrencia MySQL real,
permisos actuales de Meta, cron desplegado ni efectos publicitarios en vivo.
La prueba aislada de concurrencia se completo posteriormente, como documenta
el apartado anterior. Quedan recomendador y QA operativo final; el objetivo
completo sigue abierto.

Frontend: build local `da00eb84ab6e9f0a`, 92 tests y 51 comprobaciones Chromium
con 19 capturas. APIs/sesion sinteticas, sin llamadas a backend/proveedores.
Evidencia `/home/ubuntu/qa-evidence/campaign-budget-polished-20260911/`.
Se verificaron ayuda por raton/teclado, ancho movil, borrador sin activacion,
regresion de Meta revocado y navegacion. No se sincroniza preview 4203 ni se
reinician API/workers. Aviso previo de bundle 4,58 MB sobre umbral 3 MB, sin
error de compilacion.

## Refresco Nocturno De Destinos (2026-09-11)

Implementado y probado en codigo DEV, **sin desplegar ni habilitar** durante el
bloqueo de Meta. No se han cambiado `.env`, cron del host, DB, OAuth, permisos,
anuncios, conversiones, suscripciones de paginas, contactos ni cobros.

- Catalogo: `campaignWorkspaceDestinationRefresh`, tipo durable
  `campaign_workspace_destinations_refresh`, horario por defecto `15 3 * * *`.
  Usa `JOBS_TIMEZONE`, por defecto `Europe/Madrid`, incluido cambio de hora;
  override de horario `JOBS_CAMPAIGN_WORKSPACE_DESTINATIONS_SCHEDULE`. No se
  instala un cron del sistema ni se modifica el horario de los jobs anteriores.
- Gate maestro `CAMPAIGN_WORKSPACE_DESTINATION_REFRESH_ENABLED=true`; Meta
  exige ademas `CAMPAIGN_WORKSPACE_META_DESTINATION_REFRESH_ENABLED=true`.
  Ambos cerrados por defecto. Activar solo el maestro permite Google, no Meta.
  La activacion requiere revision operativa posterior al incidente. Estos gates
  solo gobiernan este refresco nuevo, no revocan credenciales ni detienen los
  sincronizadores historicos u otras herramientas.
- El dispatcher pagina configuraciones por ID, 50 por tramo, y encola una
  cadena por cuenta/workspace. Cada `campaign_workspace_destination_check`
  comprueba una campana y guarda una continuacion durable. Comparte el carril
  y lease de integraciones con los sincronizadores: no monopoliza la cola con
  todas las campanas de una cuenta ni limita el resultado a las diez de la UI.
- Payloads: version, ID de configuracion, proveedor, cuenta, inicio del ciclo
  y cursor. Sin tokens, URLs, nombres ni contactos. El inicio se toma de la
  creacion persistida del job raiz, por lo que un reintento no crea otro ciclo.
  Deduplicacion de tareas activas y comprobaciones ya guardadas durante el ciclo;
  los ciclos de mas de 24 h caducan, no se ejecutan indefinidamente.
- Usa inventario sincronizado, asignacion inequivoca y seleccion efectiva.
  `include_future` incorpora las nuevas campanas cuando aparecen en ese
  inventario; no descubre otras cuentas ni asigna sedes a partir de un nombre.
  Las exclusiones de una clinica prevalecen sobre la seleccion del grupo.
  Campanas archivadas se omiten; las sin asignacion se contabilizan pendientes.
- Revalida clinicas activas, miembros del grupo, cuenta/grants, seleccion,
  revision y permisos actuales del ultimo editor de la configuracion, antes de
  consultar y antes de guardar. Si ese usuario ya no esta activo o no puede
  configurar todas las sedes, el refresco falla cerrado; no busca otro admin.
  Un responsable vigente debe actualizar efectivamente la seleccion para
  reautorizarlo; guardar sin cambios conserva el editor anterior. No hay boton
  independiente de reautorizacion automatica en esta fase.
- Reutiliza los detectores completos Google/Meta, sus limites de paginacion,
  plazos y reservas transaccionales. Guarda solo metadatos de destinos y
  formularios. No descarga respuestas, se suscribe a paginas ni cambia medicion.
  Conserva separada la observacion de URLs de `landing_page_view` y la prueba
  de destinos Google. Un destino desconocido/incompleto no acredita recepcion.
- Un fallo invalida la prueba conforme al contrato de cada detector. Permisos
  rechazados detienen la cadena de esa cuenta sin reintento automatico. Un fallo
  de permisos ya persistido exige comprobacion explicita desde la configuracion.
  Errores temporales usan el backoff del scheduler, maximo tres intentos; tras
  agotarlos no se declara actualizada el resto de la cuenta. No se prueban tokens
  alternativos. Esto no es un cortacircuitos global para otros sincronizadores.
- `JobRequests` conserva resultados por tarea: comprobadas, cache reutilizada,
  asignaciones pendientes, continuacion y codigo de error saneado. No se atribuye
  exito del ciclo entero al dispatcher: encolar no equivale a comprobar.
  El informe sigue leyendo DB y aplicando vigencia de 24 h, sin consultas de
  proveedor por navegar/recargar. La creatividad bajo demanda y el mapa local
  conservan sus contratos independientes.

Verificacion: **550 tests workspace** y `scheduled_jobs_orchestration.test.js`
correctos, incluidos recorridos de 37 campanas por proveedor, 103 configuraciones
paginadas, rechazo de credenciales, cambios de permisos/seleccion durante I/O,
continuacion tras error de cola y ambos detectores reales con transportes falsos.
Preload reproducible `src/scripts/tests/fixtures/campaign_offline_runtime.cjs`:
bloquea sockets/fetch y sustituye solo las colas del proceso de pruebas. No utiliza
Redis/DB compartidos ni proveedores. Un primer intento del test historico de
scheduler intento inicializar Redis y fue bloqueado; se repitio aislado con exito.

Comandos desde backend:

```sh
node --require ./src/scripts/tests/fixtures/campaign_offline_runtime.cjs --test src/scripts/tests/campaign_workspace_*.test.js
node --require ./src/scripts/tests/fixtures/campaign_offline_runtime.cjs src/scripts/tests/scheduled_jobs_orchestration.test.js
```

Evidencias: `/tmp/campaign-destination-workspace-tests-final.log` y
`/tmp/campaign-destination-scheduler-offline-tests.log`. Esta fase no cambia
interfaz ni requiere migracion. Falta la prueba operativa del nuevo cron/cola y
proveedores con habilitacion autorizada; no acredita frescura real en produccion.
Siguen abiertos recomendador, contabilidad del limite mensual de Optimiza y
validacion completa del objetivo. Las secciones historicas inferiores que
mencionan el refresco pendiente quedan actualizadas por este apartado.

## Comprobaciones Meta Fallidas (2026-09-11)

El desarrollo se retoma con los permisos Meta bloqueados por el usuario. Este
cambio no reconecta OAuth, no renueva tokens y no habilita jobs, senales, cobros
o ajustes. No confundir esta proteccion del workspace con una solucion del
incidente o una revocacion comprobada de todas las credenciales.

- La comprobacion de destinos invalida la prueba anterior ANTES de consultar
  Meta, bajo bloqueo del propietario y del inventario. Conserva URLs, nombres,
  formularios y fecha de la observacion historica, pero no conserva un OK vigente.
- Una reserva de dos minutos evita comprobaciones simultaneas. Tras una caida
  se puede iniciar otra; la respuesta tardia de la primera no puede sobrescribirla.
  Se vuelven a verificar scope, seleccion, cuenta, token y revision al terminar.
- Los fallos persisten solo codigos permitidos. Un 190/401 durante la lectura de
  formularios detiene la comprobacion, sin continuar con otros formularios ni
  buscar otra credencial. No se consulta contenido de formularios ni se publican
  anuncios. Caducidad desconocida o invalida no demuestra acceso operativo.
- El DTO devuelve `destinationCheck: { status, error }`, nunca el ID de reserva
  ni mensajes/payloads del proveedor. Salud distingue acceso rechazado de una
  comprobacion incompleta o un fallo temporal; estos ultimos quedan sin comprobar,
  no se presentan como una caida demostrada. Recibos historicos no prevalecen
  sobre una comprobacion posterior fallida; los resultados del CRM se conservan.
- El dialogo elimina su estado correcto anterior al fallar y recarga el padre
  al cerrar. Al reabrir muestra el fallo persistido sin consultar Meta. La accion
  Revisar conexion es explicita; no inicia OAuth automaticamente.

Verificacion local: 517 tests `campaign_workspace_*.test.js`, 92 tests front
`campaign_*.test.js`, con conexiones de red prohibidas en las suites. Build
Angular DEV `86092d2f404477e4` (heap 6144 MB, dos workers, sin source maps). El
primer build con heap por defecto agoto memoria; no se cambio angular.json.
QA Chromium: 27 comprobaciones y 9 capturas a 1440/1024/390 px, con app compilada,
contexto nuevo y todas las APIs/sesion sinteticas, servidor estatico sin proxy
y bloqueo previo de SDK/proveedores. Evidencia en
`/home/ubuntu/qa-evidence/campaign-meta-revoked-final-20260911/`.
No es una prueba de autenticacion real, permisos Meta vivos ni concurrencia MySQL.

Estado de despliegue de este cambio: codigo DEV y build local verificados, sin
sincronizar aun el preview 4203. No se ha reiniciado el backend ni sus workers durante esta fase; se evita disparar
trabajos contra proveedores durante el bloqueo. El runtime anterior no incorpora
esta nueva persistencia hasta una recarga controlada. Sin migraciones, cambios
de configuracion de clientes ni promocion a staging. Siguen pendientes el
despliegue y QA operativo del refresco de destinos descrito arriba, el recomendador y la
contabilidad del limite mensual de Optimiza.

## Navegacion Canonica DEV (2026-09-11)

`/marketing/objetivos/captar-nuevos-pacientes/campanas` carga el workspace real.
La URL temporal de integracion redirige mediante el guard existente, preservando
vista, campana, origen, periodo, configuracion/paso y fragmento. Los accesos
anteriores `objective=new_patients` tambien llevan al workspace, sin presentar
el configurador previo ni exigir otra campana local.

Hub y familia conservan sus tarjetas/barras; adaptan solamente cabecera,
ancho y navegacion. Comparten la cabecera contextual con Campanas y Perfil de
Google. El detalle se identifica por nombre y plataforma, vuelve al origen
real y restablece el inicio al cambiar de vista/campana, no solo de fechas.

No hay cambio de receptores web, tablas, jobs, asignaciones, senales o facturacion
por esta integracion. Los gates continuan cerrados. La ruta DEV no acredita el
cierre global: siguen abiertos, entre otros, generacion de recomendaciones,
limite mensual global de Optimiza y cobertura/refresco de destinos.

Verificacion del front: 87 pruebas y build `f0645acdebff5976`. Chromium real:
101 comprobaciones/20 capturas de jerarquia a 1440/1024/390/1920 px en
`/home/ubuntu/qa-evidence/campaign-canonical-navigation-final-20260911`.
Regresion workspace: 71 comprobaciones/29 capturas en
`/home/ubuntu/qa-evidence/campaign-canonical-workspace-20260911`, con lectura
real y un GET aislado de caida de proveedor. Sin errores JS/workspace ni
escrituras de negocio. No se ha reiniciado ni cambiado backend ejecutable.

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
  de tratamientos. El nivel anuncio usa el mismo enlace economico con identidad
  de anuncio unica y verificada; lo no atribuible a anuncio conserva el total
  de campana, sin reparto estimado.
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
2. Prevision mensual conjunta: el hook inicial fue sustituido por lectura y
   reserva reales, descritas en `Prevision Mensual Conjunta De Optimiza` al inicio
   de este documento. No esta desplegada ni garantiza un tope de facturacion.
   Siguen abiertas la cobertura de inventario y conciliacion operativa; una
   prueba inyectada no acredita gasto real ni justifica abrir los gates.
3. Concurrencia MySQL aislada verificada posteriormente con 21 comprobaciones,
   descritas al inicio del documento. No equivale a QA de proveedor ni autoriza
   abrir gates; revisar la compatibilidad de registros previos antes de desplegar.
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

## Cache Nocturna De Anuncios Google (2026-09-11)

`googleAdsSync` y `googleAdsBackfill` reutilizan `googleAdCache.service`, igual
que el refresco manual de analisis. No hay otro cron ni consultas a Google al
abrir el informe. Se mantienen los horarios existentes, `Europe/Madrid`:
`20 0 * * *` diario y `30 5 * * 0` para backfill, configurables por las variables
actuales. El primer refresco de anuncios completa 60 dias para comparar dos
periodos de 30; despues refresca la ventana reciente, salvo huecos de cobertura.

- `GoogleAdsAdInventory`: inventario independiente de las metricas, con identidad
  cuenta/campana/grupo/anuncio, estado y contenido real. La consulta no incluye
  segmentos ni metricas. Los anuncios sin actividad tambien aparecen.
- `GoogleAdsAdSyncDays`: fechas consultadas completamente, por cuenta o campana.
  Google [omite las filas con metricas cero al segmentar por fecha](https://developers.google.com/google-ads/api/docs/reporting/zero-metrics).
  Solo una respuesta completa permite interpretar la ausencia de filas como
  cero. Un inventario recien actualizado, por si solo, nunca prueba gasto cero.
- `GoogleAdsAdInsightsDaily`: sigue siendo la cache historica de metricas.
  El indice ahora incluye campana y grupo; `observedAt` conserva milisegundos.
  No se crean registros diarios ficticios para anuncios sin actividad.
- Se completan todas las paginas y todos los tramos antes de escribir. Error de
  proveedor, cuota, paginacion circular, identidad incorrecta o datos invalidos
  conserva el snapshot anterior. No se degrada una consulta incompleta a exito.
- Inventario, reemplazo del rango exacto y cobertura se guardan en una sola
  transaccion con bloqueo de la cuenta. Una respuesta mas antigua no puede
  sobreescribir otra mas reciente, tampoco entre refresco manual y job. Una
  consulta de campana no elimina otras campanas; cero resultados si limpia el
  rango consultado, sin borrar historia fuera de el.
- La lectura usa el titular real cuando Google no define nombre del anuncio y
  muestra el estado efectivo considerando campana y grupo. No presenta anuncios
  como activos cuando estan detenidos por un padre pausado o retirado.
- El inventario de anuncios tambien observa nombre/estado de su campana. El
  workspace utiliza esa observacion cuando es mas reciente que la cache general,
  conserva el destino y aplica las mismas reglas de acceso/asignacion/seleccion.
  Asi no mezcla una campana pausada en agosto con sus anuncios actuales activos.
  Si la cache general es mas reciente, prevalece esta. Una campana nueva vista
  en el inventario se incorpora solo dentro del ambito y seleccion autorizados.
- Se mantienen las asignaciones existentes: decisiones revisadas prevalecen;
  las cuentas de grupo no se asignan al usuario que solicita un informe.
  No se crean asignaciones ni leads, ni se habilitan conversiones u optimizacion.
- Detalle creativo y atribucion web consultan este inventario. Se conserva la
  lectura historica anterior cuando aun no existe inventario para un anuncio.
  Performance Max conserva su contrato de grupos de recursos; no se inventan
  anuncios `ad_group_ad` para representar recursos de PMAX.

Migracion aplicada individualmente y revalidada:
`20260911190000-create-google-ad-inventory-cache.js`. Conserva los 143 registros
anteriores y admite el escritor previo de staging (grupo y observedAt nullable).
El rollback rechaza colisiones entre grupos antes de retirar el indice nuevo.
Backup privado previo: `/home/ubuntu/backups/campaign-google-ad-cache-20260911/`.
No ejecutar migraciones pendientes ajenas ni promocionar staging por este cambio.

Verificacion real inicial: las consultas de Google devolvieron 19 anuncios y
50 filas de metricas para dos dias, sin escribir cache. El refresco posterior de
esa cuenta guardo 19 anuncios, 694 filas y cobertura completa de 60 dias, sin
mutaciones publicitarias. Esto prueba esa cuenta, no todas las conexiones.
Pruebas MySQL en servidor temporal aislado: migracion idempotente, grupos con
el mismo ID de anuncio, rollback por colision, rollback transaccional, ventanas
vacias, aislamiento por campana, dos refrescos concurrentes y escritor antiguo.
529 tests backend pasan. Chromium real (1440/1024/390): 25 comprobaciones y
seis capturas en `/home/ubuntu/qa-evidence/campaign-google-ad-cache-current-20260911`.
El agregado autorizado muestra 19 anuncios entre 88 campanas Google, con
contenido real y retorno al resumen. Ver bitacora frontend para regresion
completa y primeros intentos fallidos durante el reinicio de API.
No se da por cerrada la integracion global ni la cobertura de todas las cuentas.

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

El inventario debe consultarse sin segmentacion de fechas, separado de las
metricas diarias: Google omite filas cuyos indicadores seleccionados son todos
cero al segmentar. Ver [Zero metrics](https://developers.google.com/google-ads/api/docs/reporting/zero-metrics)
y el [recurso ad_group_ad de v24](https://developers.google.com/google-ads/api/fields/v24/ad_group_ad).
Una respuesta completa sin filas de rendimiento no significa que no existan
anuncios; una respuesta incompleta tampoco autoriza borrar el inventario anterior.

Meta estaba en pausa compartida hasta 2026-09-11 08:45:38 Europe/Madrid durante
la prueba. Se respeta el limite; una captura con el estado de pausa no acredita
que haya cargado una imagen real. Los estados de contenido y variantes se
validan ademas con respuestas aisladas de QA, sin modificar datos de clientes.
Tras caducar la pausa, la lectura autorizada del anuncio de Arriaga devolvio
Graph `190/460`: sesion invalidada por Meta. No se sustituyo la credencial por
otro token administrativo ni se alteraron las asignaciones. La creatividad
real de esa cuenta queda sin verificar hasta renovar su conexion; el dialogo
muestra el fallo de acceso y conserva los resultados del informe.
