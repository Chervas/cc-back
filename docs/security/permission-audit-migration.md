# Auditoría de políticas de acceso y límites de grupo

## Seguimiento 12/09/2026: acceso en tiempo real preparado

La nueva [cohorte de sockets](realtime-access-migration.md) prepara verificación
por paquete y captura v5. Las limitaciones de sockets citadas más abajo son el
estado histórico de este lote; la cobertura nueva tampoco implica despliegue
ni auditoría completa de REST/membresías. Actualizar writer/reader a v5 antes de
habilitar su captura; mantener las puertas de aprobación de ambos contratos.

12/09/2026. Octavo bloque preparado con QA ficticia. **Sin desplegar, activar
captura, modificar permisos reales ni ejecutar migraciones compartidas.**
Sigue abierto el alcance completo del prompt y del runbook de seguridad.

## Comportamiento corregido

El controlador anterior consideraba accesible un grupo si el actor pertenecía
a una sola clínica. Eso permitía consultar asignaciones de otras clínicas del
grupo y, siendo propietario de una sola, cambiar el override compartido.
El controlador preparado exige acceso staff vigente a todas las clínicas
para listar asignaciones del grupo y propiedad vigente de todas para cambiar
su política. Admin técnico global conserva acceso, pero la escritura exige
que exista el ámbito. Se incluyen todas las clínicas del grupo, sin excluir
inactivas o archivadas para aparentar propiedad completa.

Membresía vigente: invitación aceptada o null legacy, según la convención del
evaluador actual. Pendiente/cancelada/rechazada no autoriza. No se concede la
gestión de permisos por ser agencia ni por tener otra capacidad delegada.
Los IDs deben ser enteros positivos dentro del rango INTEGER, sin coerción
de booleanos, arrays, fracciones o ámbitos incompletos. Campos desconocidos
y efectos contradictorios se rechazan. Los errores no contienen SQL ni datos
del error interno. Respuestas de los cuatro endpoints: `private, no-store`.

La lectura de **overrides heredados** del grupo se conserva para quien pertenece
a una de sus clínicas: son configuración de permisos aplicable a esa clínica,
no el listado de usuarios de las demás. El frontend necesita esa configuración
para calcular clínica → grupo → default. La lectura agregada de asignaciones
es la que exige el grupo completo. Antes de preparar sus usuarios, se vuelve
a comprobar que las clínicas obtenidas pertenecen al conjunto autorizado;
una ampliación concurrente del grupo no añade una clínica ajena a la respuesta.

Estos controles de ámbito y las transacciones de escritura se aplican también
con captura apagada. Desactivar la auditoría no restaura la autorización débil.
GET assignments añade `can_manage_scope`; el editor solo habilita cambios si
recibe true para su ámbito actual. Cancela peticiones al cambiar de ámbito y
descarta respuestas antiguas/incoherentes, vaciando usuarios y permisos. Una
autorización puede caducar; PUT siempre la revalida. Sin ese campo, una API
anterior deja el editor en lectura, por lo que backend debe desplegarse primero.

Los defaults efectivos no se cambian: las 43 capacidades y nueve roles se
extraen a `services/platform-audit/src/access-policy-contract.js`, puro y
compartido con el codec. La matriz de defaults continúa en `src/lib/access-policy.js`.

## Cobertura preparada

| Endpoint | Acción de auditoría | Resultado |
|---|---|---|
| GET `/api/access-policies/catalog` | `permission.catalog.read` | Catálogo preparado para actor autenticado, número de capacidades |
| GET `/api/access-policies/overrides` | `permission.overrides.read` | Overrides autorizados, número de filas; sin copiar el listado |
| GET `/api/access-policies/assignments` | `permission.assignments.read` | Asignaciones autorizadas, número total; sin nombres, contactos ni lista de usuarios |
| PUT `/api/access-policies/overrides` | `permission.override.change` | Transición allow/deny/inherit y ámbito/rol/capacidad exactos |

Gate único `PLATFORM_AUDIT_PERMISSIONS_ENABLED`: ausente/false apaga captura;
true la habilita; otro valor falla con 503. No se ha cambiado .env/PM2.
La autenticación sigue en el middleware común. El evento usa actor verificado
y referencia de sesión persistente si existe; en JWT legacy queda null.
JWT rechazado antes del controlador no se incluye en esta captura semántica.

No hay proxy genérico de auditoría HTTP: el adaptador solo admite estas cuatro
acciones y proyecta un esquema cerrado. El controlador prepara su respuesta
en memoria; solo se envía después de registrar el resultado. Un resultado
exitoso acredita respuesta preparada/commit confirmado, no recepción del cliente.

Con captura activa, intento durable antes de leer/mutar el dominio y resultado
antes de responder. Cola ≥10000 o antigüedad ≥1 h impiden comenzar la operación.
Si falla la captura inicial, no se consultan asignaciones ni se cambia la política.
Si falla el resultado de una lectura, no se entrega su payload. Una caída puede
dejar el intento sin resultado; el monitor existente conserva esa incertidumbre.
Las denegaciones registran motivos enumerados, sin copiar campos inválidos.

## Atomicidad y concurrencia

PUT usa transacción SERIALIZABLE. Bloquea grupo y después clínica(s); vuelve a
leer/bloquear las membresías de propietario y el override dentro de la misma
transacción. El primer lookup de clínica solo localiza el grupo, no autoriza:
su relación se contrasta tras adquirir los locks. Un ámbito inexistente o que
cambie durante esa adquisición falla cerrado.

La fila del ámbito serializa también la creación del primer override ausente.
La escritura y su evento de resultado comparten el commit; el intento es anterior.
Fallar al insertar el resultado revierte el cambio en las pruebas de SQL. Si
la conexión se pierde durante el commit, la API puede desconocer su resultado:
devuelve error y no sustituye un resultado ya persistido por una historia distinta.
`operation_unconfirmed` no afirma que el cambio se haya revertido.

Cada transición registra `previousEffect` y `requestedEffect` (`inherit` expresa
ausencia de override, no ausencia de permiso efectivo). Repetir el mismo valor
produce `override_unchanged`, resultado 0, y sigue auditado; cambiarlo produce
`override_changed`, resultado 1. No incorpora idempotency key ni elimina el
modelo de última escritura confirmada. Un cliente que reintenta tras timeout
debe releer la política; no interpretar la repetición como un segundo cambio.

No hay retry automático de deadlocks/lock timeout. Se conserva el intento y
se devuelve fallo cerrado. Medir el impacto de locks con volumen/grupos reales
en el corte: un grupo grande bloquea sus filas de clínica mientras confirma
la operación. La topología/FK/índices efectivos y escritores SQL externos
requieren verificación con acceso autorizado; el fixture no prueba su estado real.

## Evento v4 y visor

`app/platform/v4/fechaUTC/eventId-digest.json`, mismo bucket/KMS reportados y
outbox existente. Esquemas v1/v2/v3 conservados. Actor, sesión, acción, etapa,
resultado, motivo, scope y sus conteos; para cambios, capacidad/rol/efectos.
`authorizationBasis`: authenticated, global_admin, scope_staff, scope_owner,
scope_denied o not_evaluated, según la etapa/decisión. Scope staff en lectura
de overrides incluye la herencia de configuración descrita arriba.

`capturePolicy=permissions-durable-v1`; `authorizationPolicyVersion` identifica
el catálogo y la revisión del contrato de autorización con SHA256. Snapshot
sin datos personales en [permission-policy-catalog.json](permission-policy-catalog.json):
`d7599ba1e6fa20eb47f7695593fb8e429d0d6c1c5413fe0fc5256c434224e9ef`.
Preservar snapshots anteriores al cambiar defaults. Este digest no es una
copia de las membresías históricas ni acredita por sí solo todas las decisiones
de autorización; hay que completar la auditoría de sus escritores restantes.

No se almacena body/query crudo, email, nombre, teléfono, contraseña/hash, JWT,
cookie, IP ni contenido clínico. Sí IDs internos y alcance: siguen sujetos a
la política de acceso/retención pendiente. Conteos no sustituyen un inventario
completo de afectados por cada autorización.

Writer/reader admiten v4; el visor filtra las cuatro acciones nuevas, muestra
clínica/grupo, capacidad, rol y transición confirmada. Intento o denegación
muestran el efecto **solicitado**, sin presentarlo como aplicado. La proyección
`permission` incluye esos campos más base/versión de autorización y conteo de
clínicas. Continúa exigiendo comprobar cada versión S3 y omite contenido personal.
Las limitaciones de índice local, journal local, retención e inmutabilidad del
[contrato de lectura](audit-reader-view-migration.md) siguen vigentes.

## Inventario y pendientes de cobertura

El inventario estático de rutas sigue en 60 archivos/874 declaraciones. Cuatro
rutas de políticas ahora figuran preparadas/apagadas, además de las cohortes
anteriores. No equivale a cobertura runtime ni a toda la gestión de permisos.

| Escritor/superficie | Estado |
|---|---|
| AccessPolicyOverride en accessPolicy.controller | Único escritor directo encontrado en el controlador; cuatro endpoints de esta cohorte preparados |
| personal.controller y altas/reclamaciones auth | Cambios de membresía/rol e invitaciones requieren su auditoría de dominio; sesiones ya tienen su cohorte separada |
| patientDirection.service y whatsapp-embedded.routes | Perfiles/asignaciones y settings que afectan al acceso pendientes; no ejecutar WhatsApp |
| accountingFirms.service | Alta/retirada de membresías de gestoría pendientes |
| Scripts cliniccloud_set_bs_roles, normalize_bs_resources, backfill_agenda_resources, seed_patient_direction_demo | Detectados por lectura estática, no ejecutados; escrituras/instance.save/SQL manual requieren revisión |
| Evaluador REST, caché frontend y rooms Socket.IO | REST consulta políticas en BD; no se añade una política global de invalidación ni refresco de permisos en sockets por este bloque |
| Otros endpoints clínicos, lecturas/exportaciones, APIs de administración, OPS/SQL fuera del repo | Pendientes; auditoría genérica de request no sustituye semántica de dominio |

No se han revocado sesiones reales ni alterado asignaciones para probar el cambio.
Los sockets existentes aún conservan autorización de rooms calculada al conectar;
completar esa cohorte antes de afirmar propagación general de permisos. Ningún
consumidor real de Meta/Google/WhatsApp queda migrado con esta instrumentación.

## Corte pendiente y rollback

No se añade una migración nueva. Se reutilizan AccessPolicyOverrides existente
y outbox `20260912210000`. El monitor y visor mantienen dependencias previas
`20260912213000`, sesiones `20260912220000` e índice `20260912230000`, todas
pendientes en BD compartida dentro de sus lotes respectivos. Costes mantiene
`20260912180000` igualmente pendiente. No aplicar todas las migraciones del repo.

Lote a aprobar: versiones backend/writer/reader/front, runtimes afectados,
respaldo y restore de políticas/outbox, esquema/índices/locks verificados,
capacidad/alertas del outbox, ventana y operador. Instalar soporte v4 en writer
y reader **antes** de habilitar captura. Validar eventos ficticios y recuperación,
luego activar solo este gate sin reactivar cron/proveedores pausados. El frontend
del visor requiere API compatible. IAM/TLS/topología/SSO/DPD conservan las puertas
del runbook; no se han verificado ni modificado desde este bloque.

Dos eventos por operación instrumentada añaden almacenamiento/entrega y coste
variable S3/KMS; las consultas al visor añaden sus lecturas. Sin precio o volumen
real acreditado. No se crean recursos ni cambia Budget; CE/tags y conciliación
del Budget reportado de 60 USD siguen pendientes. No llamar cero a gasto ausente.

Rollback: apagar captura del lote aprobado, conservar outbox/recibos/snapshots y
el control de ámbito completo. No volver al controlador vulnerable ni al writer
anterior a v4 mientras existan eventos v4 pendientes. No borrar registros ni
deshacer el hotfix de estadísticas. Push selectivo no implica despliegue.

## QA y publicación

54 pruebas de paquete/backend/componentes, dos regresiones de catálogo/asignaciones,
nueve comprobaciones MySQL de esta cohorte y ocho de regresión del visor. SQL,
HTTP, JWT y locks se prueban en proceso propio; tablas de dominio ficticias mínimas,
migraciones outbox/overrides reales sobre ese fixture; S3/STS son dobles.
Chromium desktop/móvil: ocho capturas del visor y seis del editor de permisos
(con traductor ficticio basado en el diccionario del repo); controles y scope
usan los componentes reales. Build desarrollo `b273f80d3a48d459`.

Evidencia privada `permissions-offline-qa.json` y acta de SHAs remotos
`permissions-publication.json` en
`/home/ubuntu/qa-evidence/security-migration-20260912/`. Base limpia tras fetch:
backend `a474672917ff0abebfd485f94980c1d4f5e06ab8`, front
`c662058a258514c41d44415b6916ff357f48e49a`. No contiene credenciales reales ni
validación AWS. Revisar todo el rango a origin/dev antes de publicar los commits propios.
