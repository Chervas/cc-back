# Reautorización Google por servicio: API, SQL y Ajustes

Preparada el 13/09/2026 sobre backend 53a3b212 y frontend 7410ada6. Este bloque
conecta el [motor OAuth ya preparado](google-property-oauth-broker.md) con la API
y Ajustes para Business Profile, Search Console y Analytics. La ampliación
[OAuth Ads](google-ads-oauth-migration.md) añade ahora el cuarto servicio. Código y pruebas
aisladas: **cero conexiones migradas/reautorizadas en runtime**. Sin AWS, proveedor
real, BD compartida, despliegue ni cambio de pausas. OPS aplazado; apagado EC2
anunciado por el usuario, sin verificar.

## Identidad, consumidores y autorización

GoogleOAuthBrokerBindings admite una fila por (google_user_id, cohort), con
unicidad de (google_connection_id, cohort) y (connection_ref, cohort). Servicios
cerrados: business_profile, search_console, analytics y ads. Cada fila conserva el
subject Google, conexión SQL, referencia de credencial, activo de control y su
clínica. No hay alta libre, descubrimiento de identidades ni copia de tokens.

La política nueva google-oauth-cohorts-v1 fija scope_key=connection:ID. La
solicitud guarda además request_scope_key=clinic:ID o group:ID y clinic_ids con
el conjunto autorizado, ordenado y sin duplicados. La política histórica
google-oauth-pinned-v1 mantiene su autorización GBP estricta y su digest original
de siete campos; añadir cohort=business_profile no invalida solicitudes antiguas.
La migración no convierte automáticamente esos bindings a la nueva política.

La nueva autorización exige sesión gestionada vigente y permiso write tanto en
el ámbito solicitado como sobre todos los consumidores afectados del servicio.
La conexión se comprueba por ID y subject únicos mediante metadata y el predicado
SQL de credenciales NULL; nunca selecciona su contenido. Revalida la asignación
actual con herencia de grupo y respeta un override disconnected/revoked. No
permite iniciar desde un ámbito sin uso activo del servicio seleccionado.

Inspecciona registros y mappings de las cuatro verticales. Un consumidor activo
sin registro independiente, una identidad/referencia incoherente o un mapping ID
reutilizado impiden la autorización. Google Ads gestionado puede coexistir; sus
consumidores sin registrar siguen bloqueando el flujo. Los otros servicios
gestionados pueden coexistir. El activo de control necesita mapping activo y
no revocado. Credenciales nuevas conservan todos los bloqueos del broker y SQL;
una revocación de otra vertical no se borra para autorizar la seleccionada.

El conjunto afectado incluye propietarios originales, GroupAssetClinicAssignments
y miembros de grupos cuyo primario apunta al mapping, incluso de otro grupo.
Conserva de forma restrictiva la autoridad de registros huérfanos no revocados:
requieren permiso sobre su clínica original, pero no constituyen un uso activo
desde el que iniciar OAuth. Asignaciones residuales pueden requerir conciliación;
no se eliminan ni se reinterpretan automáticamente. Máximo 1.000 filas por
consulta/conjunto; consultas de revocaciones por lote de claves originales.

Sesión, identidad, permisos y conjunto se vuelven a comprobar después de begin
y después de finish, antes de guardar la intención de activación. Si aparece
otra clínica durante el callback, se cancela incluso si el actor tiene permiso
allí. La captura SQL, intentos de auditoría y transición son transaccionales.
No se llama al proveedor dentro de una transacción SQL.

## API y estado

GET /oauth/google/connect y /oauth/google/connection-status aceptan google_service
con uno de los cuatro valores anteriores. Arrays, valores desconocidos o selección
sin binding fallan con error fijo, sin entrar en OAuth legacy. Se conservan los
parámetros de ámbito explícito y las comprobaciones de permisos existentes.

Sin selector, un único binding histórico GBP conserva mode=broker. Si hay varios
bindings o una política nueva, connect devuelve 409 google_oauth_service_required.
Status devuelve el índice {mode:broker_services, connected:false, services:[...]}
tras comprobar sesión/asignación/metadata del ámbito. El índice solo enumera
servicios configurados; no concede autorización para reautorizarlos. Cada estado
seleccionado realiza la comprobación completa de sus consumidores.

El estado individual conserva mode=broker, authorization_status, pending,
activation_confirmed, enabled y connected:false; añade google_service. Busca
la solicitud de esa conexión, servicio y digest de binding. Una confirmación
histórica de otra referencia no confirma un binding reemplazado. Actualizar
credenciales no demuestra acceso al recurso, ni desbloquea activos.

Callback identifica servicio y política exclusivamente mediante la solicitud
persistida y el state hash. Conserva intercambio de código una vez, conciliación
por status tras respuesta perdida y activación con UUID estable. Los flujos
pendientes se excluyen por conexión/servicio; dos verticales pueden autorizarse
independientemente. La intención de activación ya autorizada es durable: el
worker comprueba identidad/digest y lease, confirma su binding concreto y
auditoría conjuntamente. No vuelve a ejecutar el código OAuth ni borra bloqueos.
El control de permisos anterior a la intención no es una transacción distribuida
con Google; cambios posteriores de baja conservan sus controles durables propios.

Errores nuevos: google_oauth_service_invalid (400), service_required y
service_unconfigured con el mismo prefijo (409). Conflicto de identidad/ámbito
409, falta de permiso 403; dependencias/gates/auditoría no disponibles 503.
Respuestas sin caché; errores saneados, sin respuestas crudas del proveedor.

## Interfaz y auditoría

Ajustes muestra controles separados por servicio configurado, con refresco,
reautorización y estados pendiente, actualizado, deshabilitado o error. Un 403
explica que se necesita permiso sobre todas las clínicas usuarias. Cada respuesta
debe coincidir con el servicio y ámbito actuales; cambios de clínica cancelan
peticiones anteriores. El modo gestionado no dispara cargas legacy de métricas
o publicidad. El flujo GBP histórico conserva su componente y contrato.

Auditoría v10 para la política nueva, acciones integration.oauth.authorize y
integration.oauth.activate. Conserva actor humano/job, usuario iniciador, sesión,
ámbito original y correlaciones durables. Incluye proveedor y referencias, sin
URL de Search Console, código, state, tokens o contenido clínico. clinicCount y
clinicSetDigest comprometen el conjunto completo conservado en la solicitud SQL:
SHA256 del JSON de sus IDs como strings, ordenados numéricamente. Esta captura
cabe en el límite externo de 4 KiB incluso con 1.000 clínicas. El visor verifica
la versión S3 concreta y proyecta recuento/huella. V8 GBP sigue sin cambios de
formato. La auditoría completa de plataforma y de todos los rechazos sigue
pendiente; confirmar SQL no demuestra entrega real a S3.

## DDL, configuración y corte pendiente

Migración nueva 20260913070000-scope-google-oauth-by-service.js, después de
20260913020000. Requiere el resto de esquemas de sesiones, outbox, registros GBP,
SC/GA y revocaciones del runbook para ejecutar los flujos completos. Añade cohort
a bindings/requests, policy_version y request_scope_key a requests y amplía las
claves únicas. Conserva registros antiguos con defaults GBP; no lee/mueve secretos.
Valida los índices originales antes de la primera DDL. MySQL DDL no es una
transacción multisentencia: un fallo intermedio exige inspección y reparación
del esquema en la ventana aprobada, no repetir ciegamente up/down.

**DDL antes de este código, incluso con gates apagados.** Modelos y guards de
OAuth/legacy consultan los registros. Writer/reader v10 antes de emitir v10.
Down solo admite ambas tablas vacías; no borrar historia para permitirlo. No
volver a un worker o API que ignore la separación por servicio. Rollback seguro
conserva solicitudes, bindings, outbox, revocaciones y SQLite/WAL; deshabilitar
el lote o corregir hacia delante en vez de restaurar tokens SQL.

GOOGLE_OAUTH_BROKER_ENABLED y GOOGLE_OAUTH_BROKER_WORKER_ENABLED siguen apagados
por defecto. Cada servicio requiere además su GOOGLE_*_BROKER_ENABLED. El worker
selecciona solo los servicios habilitados y conserva 10 intenciones por ciclo,
30 segundos cooperativos y lease de 120 segundos; SQL pendiente no se cancela
por ese presupuesto temporal.

| Servicio | Cliente OAuth de la API |
|---|---|
| GBP | INTEGRATIONS_BROKER_ORIGIN/AUDIENCE/CA_FILE y GOOGLE_OAUTH_BROKER_KEY_ID/KEY_FILE históricos |
| SC | GOOGLE_SEARCH_CONSOLE_BROKER_ORIGIN/AUDIENCE/CA_FILE y GOOGLE_SEARCH_CONSOLE_BROKER_OAUTH_KEY_ID/KEY_FILE |
| GA | GOOGLE_ANALYTICS_BROKER_ORIGIN/AUDIENCE/CA_FILE y GOOGLE_ANALYTICS_BROKER_OAUTH_KEY_ID/KEY_FILE |
| Ads | GOOGLE_ADS_BROKER_ORIGIN/AUDIENCE/CA_FILE y GOOGLE_ADS_BROKER_OAUTH_KEY_ID/KEY_FILE |

Ads requiere además la DDL 20260913100000, sus registros 080000/090000 y el
writer/reader v10 actualizado. El contrato Ads contiene su QA posterior; los
recuentos de validación originales de este documento son históricos.

No fallback entre clientes. Claves/CA son archivos privados canónicos, regulares,
hasta 64 KiB. El broker exige principal/clave OAuth independientes de lectura y
revocación y grants explícitos por operación/tupla, conforme al bloque anterior.
La instalación y convivencia de runtimes (una cohorte por configuración) sigue
pendiente del lote real; esta API permite orígenes distintos y no prueba un
único proceso desplegado. No se ha instalado configuración ni cambiado .env.

El lote real deberá concretar referencias/secrets/subjects por servicio, todos
sus consumidores/grants, IAM, DDL exacta con respaldo, ventana, monitorización,
canary y rollback. Es independiente del push. OPS está aplazado: no se solicita
esa aprobación en este bloque local. Altas/remapeo generales, otras integraciones,
auditoría completa, retención DPD, permisos AWS, Budget/CloudFormation, Cost Explorer
y cifrado/restauración/corte real de BD siguen abiertos.

## QA y costes

180 tests Node: 133 backend, 41 auditoría y seis frontend. 92 comprobaciones
MySQL 8.0.42 en siete bases temporales propias (79 regresiones y 13 nuevas),
todas con shutdown 0. DDL con solicitudes GBP existentes, claves por servicio,
cancelación por cambios de consumidor/permisos, revocaciones, rollback de outbox,
ACK perdido, referencias sustituidas, vista SQL v10 y ausencia de secretos.

Build Angular de desarrollo correcto; advertencia CommonJS de socket.io-parser
ya existente. Chromium nuevo con HTTP ficticio, componentes reales y padre
OnPush: 24 capturas desktop/móvil de los flujos por servicio y GBP histórico,
estados/selección/asíncronía/cambio de ámbito, sin desbordamiento ni errores JS.
Inspección visual de los nuevos estados en móvil y permisos en desktop. Cuatro
contratos de regresión correctos, incluido scheduler de 47 jobs. No se repite
el motor broker sin cambios; sus 123 tests pertenecen al bloque previo.

Las primeras ejecuciones corrigieron expectativas del orden ENUM y el evento
adicional de sesión en QA. La revisión detectó y corrigió el tratamiento HTTP
del cierre legacy, el tamaño de auditoría para 1.000 clínicas y la asociación
del estado a su digest actual. Suites afectadas repetidas antes del cierre.

Coste incremental: índices/columnas SQL, consultas de autorización y cuatro
eventos de plataforma en un ciclo satisfactorio, además de las operaciones ya
descritas del broker, Secrets Manager, S3/KMS y proveedor. Replays conservan
correlaciones/UUID. Sin coste AWS medido ni ahorro inventado; Ajustes mantiene
su caché/estados pendientes y Budget no es un límite duro de gasto. Evidencias
privadas bajo qa-evidence/security-migration-20260912/oauth-cohorts-*.
