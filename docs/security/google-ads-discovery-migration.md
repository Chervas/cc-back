# Google Ads: inventario registrado y estado por broker

## Contrato posterior: selección y baja gestionadas

[El bloque de mappings](google-ads-mapping-migration.md) incorpora preparación
staged, selección con auditoría v12, consulta por metadata y baja individual
que conserva el historial. Las notas históricas inferiores describen el bloque
anterior. Alta general/grants y corte real siguen pendientes; OPS aplazado.

Preparado el 13/09/2026 sobre backend 59064134484b y frontend 598a3ff87486.
OPS aplazado. Código y pruebas ficticias; ninguna cuenta real migrada,
credencial trasladada, configuración instalada o modificación de la BD compartida.

## Contrato de lectura

Se añade google.ads.discovery.read.v1 al motor google-ads-read-v1. Requiere
payload vacío y grant explícito de principal/tenant/conexión/activo. Lee una
cuenta fijada en googleAdsAccounts, con su loginCustomerId fijado. No permite
buscar libremente por la jerarquía del gestor ni elegir GAQL, cabeceras o campos.

La consulta cerrada selecciona customer.id, descriptive_name, manager,
currency_code, time_zone y status, FROM customer LIMIT 2. Exige exactamente una
fila de la cuenta esperada, sin página siguiente. Proyecta únicamente esos
campos: nombre de hasta 1.024 bytes, moneda de tres letras mayúsculas, zona horaria
válida y estado ENABLED/CANCELED/CLOSED/SUSPENDED/UNKNOWN/UNSPECIFIED. Admite
manager=true para identificar gestores; la lectura account usada por los jobs
conserva su requisito manager=false.

Campos y estados contrastados con la documentación oficial de
[Customer v24](https://developers.google.com/google-ads/api/fields/v24/customer)
y [CustomerStatus](https://developers.google.com/google-ads/api/reference/rpc/v24/CustomerStatusEnum.CustomerStatus).
No se ha hecho una consulta real a Google Ads. CANCELED/CLOSED se omiten de la
selección y se cuentan si el proveedor permite leer su resumen; cualquier error
de lectura no tratado expresamente impide devolver el inventario completo.

## API y autorización

GET /oauth/google/ads/accounts, con o sin view=selection, devuelve en modo
gestionado {success:true, accounts, unavailableAccountCount,
inventory_mode:broker_grants}. Cada cuenta incluye customerId/formattedCustomerId,
descriptiveName, currencyCode, timeZone, accountStatus, isManager y loginCustomerId.
No devuelve subject, referencias privadas, tokens, nombres de clínicas o estados
de invitación/MCC que no se hayan verificado. El selector existente consume estos
campos sin cambios de componentes.

GET /oauth/google/ads/connection-status también requiere ahora ámbito explícito
y write, igual que el listado. La lectura correcta devuelve connected:true,
hasAccessibleAccounts, scope, source, inventory_mode:broker_grants y
verification:registered_accounts_read. Esto acredita la lectura de las cuentas
registradas seleccionadas; no acredita toda la identidad OAuth, la jerarquía,
invitaciones o permiso para publicar. Sin conexión devuelve connected:false,
reason:no_connection; el listado devuelve 404. Respuestas privadas sin caché.

Ambas rutas resuelven primero metadata y exigen sesión gestionada vigente para
la cohorte. Revalidan usuario, write, conexión y conjunto de clínicas alrededor
de las llamadas. Un cambio de grupo, sesión o permisos impide la respuesta.
El estado de conexión no utiliza el permiso read general para saltarse write.

El repositorio limita consultas a 1.000 filas y selecciona registros por conexión,
ámbitos de clínica/grupo y asignaciones explícitas. Un snapshot incluye miembros,
registros, mappings y asignaciones. Comprueba su huella al finalizar y después
de revalidar los contextos originales de todas las cuentas, incluidas las leídas
antes de otras llamadas. No basta con preparar un contexto nuevo que acepte un
cambio producido durante la operación.

La cuenta de grupo usa su registro de grupo frente a sus aliases de clínica:
una única lectura por customer canónico y el tenant original del broker. La
clínica representativa del mapping no define su propiedad. Se conservan las
comprobaciones del [lector Ads](google-ads-backend-migration.md): aliases,
asignaciones activas, overrides, ancla de tenant, gestores y ausencia de tokens
SQL. El alcance admitido por ese lector permanece; usos incompatibles de una
misma cuenta entre ámbitos requieren conciliación antes del corte.

Registros vacíos/incoherentes, mappings borrados, gate apagado o historia de
revocación no permiten fallback. Una baja durante una consulta descarta todo el
resultado y bloquea la siguiente lectura antes de acceder al proveedor.
Se admiten cuatro inventarios simultáneos, hasta 20 cuentas distintas, presupuesto
cooperativo de 60 segundos y resultado máximo de 1 MiB. El exceso falla sin
truncar cuentas. Las consultas SQL en vuelo no se cancelan por ese presupuesto.

## Recorrido anterior al corte

Solo con los registros globales todavía vacíos puede seleccionarse legacy.
La carga de tokens usa googleLegacyCredentials y su exclusión SQL en la misma
sentencia; cada petición/refresh revalida ámbito, identidad y cierre global antes
y después. Un marcador nuevo impide persistir el refresh o devolver resultados.
Se conservan los reasons insufficient_scope/token_expired/config_missing/token_error
que consume el selector anterior; una marca gestionada tiene prioridad sobre esos
estados. No se vuelve a OAuth legacy desde un error del broker.

El transporte del inventario anterior queda limitado a 100 peticiones, 60 segundos
cooperativos y hasta ocho segundos por petición, sin reintentos automáticos. Los
errores se guardan como códigos cerrados y un fallo impide una respuesta parcial,
aunque un helper antiguo lo capture. view=selection conserva el caso documentado
CUSTOMER_NOT_ENABLED: solo se reconstruye ese código fijo, tras volver a validar
credenciales y ámbito; nunca se devuelve el mensaje original del proveedor.

## Dependencias, auditoría y costes

No hay nueva migración ni variables. Siguen siendo obligatorias las tablas de
los registros y revocaciones Google, incluidas Ads 080000/090000 y las dependencias
OAuth vigentes, antes de desplegar código que las consulte, incluso con gates
apagados. No ejecutar el conjunto de migraciones pendientes de la BD compartida.
El gate sigue siendo GOOGLE_ADS_BROKER_ENABLED; añadir el grant de discovery
requiere el lote aprobado de configuración del broker. No se instala ese grant.

La lectura genera la auditoría técnica v2 ya existente; la entrega ficticia
comprueba operación sin nombre de cuenta, respuestas o credenciales. No añade
versión de auditoría de plataforma, job, almacenamiento o recursos AWS. El
catálogo sigue en 48. Cada cuenta supone una operación del broker y sus consultas
a Secrets Manager/auditoría; no se han medido facturación ni latencia reales.
Costes verificados en Ajustes, IAM, retención y Budget/CloudFormation pendientes.

## Evidencia y trabajo restante

Evidencia privada en /home/ubuntu/qa-evidence/security-migration-20260912, prefijo
ads-discovery: 367 tests backend, 163 broker y 8 del modelo frontend correctos
(538 en total). El runtime TLS Ads se repitió con la operación discovery y
comprobación de su auditoría. Los siete tests HTTP finales ejecutan rutas,
middleware y resolvers reales con dependencias ficticias y transporte aislado.

15 comprobaciones en MySQL 8.0.42 propio, sin networking ni arranque de la
aplicación clínica, cierre 0 y cero conexiones rechazadas. Cubren el repositorio
real, grupo/clínica heredada, aliases, uso compartido nuevo, revocación en vuelo,
ausencia de tokens y las comprobaciones anteriores de esquema/legacy. No se
presentan las demás suites SQL históricas como repetidas.

La primera prueba HTTP detectó que el estado Ads todavía pasaba por el guard de
read; se incorporó al inventario que exige write/ámbito explícito. La regresión
posterior pasó. No se modifican componentes, estilos o pantallas; no se repite
build ni Chromium por esta ampliación del contrato backend.

Este listado es una dependencia del alta/remapeo, que sigue pendiente. No crea
bindings, registros OAuth, grants, mappings o invitaciones; map-accounts conserva
su cierre legacy al detectar una conexión gestionada. El alta de nuevos activos,
otros consumidores, recepción, escrituras/conversiones, auditoría completa,
verificación AWS y cifrado/restauración/corte BD mantienen el objetivo abierto.
