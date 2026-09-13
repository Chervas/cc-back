# Cierre de credenciales Google Ads antiguas

Preparado el 13/09/2026 sobre backend `b72fe8106f76320afe7ce940dfb4aa4e366bcb1b`
y frontend `9aec1f6dd091994161a2ed919834164bb1c28a88`. Implementación y QA aislada;
cero consumidores migrados en runtime. OPS aplazado por el usuario. El apagado
de EC2 sigue comunicado, sin verificar. No se han usado proveedores reales.

## Comportamiento preparado

Las lecturas de conexión en preparación, recepción, señales web/nativas y
onboarding pasan por `googleAdsLegacyConnection`. Primero selecciona ID/subject
con las opciones de transacción y bloqueo del ámbito. Después comprueba la
identidad capturada y los registros de seguridad antes de seleccionar tokens.
El SELECT de credenciales incluye su propia exclusión SQL; solo añade `scopes`
a la proyección cerrada del loader existente. Las comprobaciones de seguridad
usan el estado actual fuera de una transacción de ámbito que podría conservar
una instantánea antigua. Los bloqueos del ámbito permanecen en esa transacción.
No se debe renovar un token mientras se mantiene un bloqueo SQL propio sobre
su fila: la escritura condicional necesita su propia conexión SQL.

Se consultan GoogleOAuthBrokerBindings, SearchConsoleBrokerBindings,
AnalyticsBrokerBindings y GooglePropertyBrokerRevocations por ID o subject.
Un marcador persistente, incluso huérfano o de un subject duplicado en otra
conexión, cierra el recorrido. Falta de tabla, fallo SQL o identidad cambiada
también lo cierran. Los flags del broker no desactivan este control.
Esto reutiliza esos registros; no crea todavía un registro independiente Ads.

El runtime scoped conserva la preferencia de clínica sobre grupo y el rechazo
de grants ambiguos antes de cargar credenciales. Runtime y onboarding comprueban
la identidad incluso cuando el token no necesita renovación. La respuesta OAuth
se revalida y se guarda con UPDATE condicional; una respuesta tardía no puede
reponer credenciales excluidas por un marcador confirmado. Se eliminan las
escrituras mediante instance.update, se limita el refresh a ocho segundos y no
se siguen redirecciones. Una fecha de expiración inválida no se considera vigente.
Los errores de proveedor/SQL pasan por códigos y mensajes fijos.

Los dos listados de cuentas de sync/backfill incluyen solo metadata de conexión.
El job recarga el token mediante el loader y revalida cada petición/página de
métricas, inventario, destinos y caché de anuncios. Las comprobaciones posteriores
descartan respuestas si observan una baja concurrente. Diagnostics conserva
conexión y token en su caché local, revalida alrededor de cada consulta de estado
y expulsa la entrada ante un error. No confirma como éxito una respuesta que
observa un bloqueo. Health revalida las conexiones reutilizadas antes de devolver
la evidencia; sigue sin renovar tokens ni consultar Google desde ese informe.

## Límites que siguen abiertos

Este cierre prepara la retirada de credenciales, pero **Ads todavía no está
aislado en el broker**. Las identidades legacy sin marcador siguen cargando
tokens en la API general. El resultado final requerido exige operaciones Ads
tipadas, registro por cuenta/ámbito, OAuth y revocación de esa cohorte, migración
real y retirada comprobada de todas las lecturas SQL.

`scopeConnectionResolver` conserva recorridos genéricos que pueden materializar
la conexión antes de los guards de un consumidor. Onboarding/optimización,
recepción y uploads también mantienen consumidores que aceptan un token ya
cargado; no todas sus llamadas tienen revalidación por operación. Sus operaciones
deberán pasar por adaptadores tipados. El cliente Google Ads genérico y GAQL
arbitrario no son un contrato válido de broker. Inventario acotado y hashes en
[google-ads-legacy-consumers.json](google-ads-legacy-consumers.json).

No hay atomicidad distribuida con Google: una petición ya recibida no se puede
deshacer. Las comprobaciones después de await reducen carreras observables; no
revierten escrituras de caché ya confirmadas ni sustituyen el corte por cohortes.
Esta fase tampoco revoca un token OAuth en el proveedor.

## QA y evidencia

238 pruebas Node correctas en 25 archivos, con red/colas bloqueadas y modelos
ficticios instalados antes de importar módulos. Incluyen el nuevo límite Ads,
contratos de preparación/recepción/señales/destinos, selección multigrant,
scheduler, Google SC/GA/OAuth y el hotfix de getAssetStats. El contrato de
desconexión se ejecuta además por separado con su propia frontera de modelos.

11 comprobaciones en MySQL 8.0.42 efímero: SELECT/UPDATE reales con NOT EXISTS,
ID/subject, borrado/recreación, respuesta y escritura concurrentes, tabla ausente,
proyección de scopes, identidad inesperada, instantánea antigua frente a un
marcador nuevo y conservación del bloqueo SQL del caller. Socket exclusivo sin
TCP, cero conexiones rechazadas y cierre del mysqld propio con código 0.

Evidencia privada: `/home/ubuntu/qa-evidence/security-migration-20260912/ads-legacy-*`.
Las primeras ejecuciones conservan los fallos de adaptación de fixtures y del
preload de desconexión; `ads-legacy-final-backend.log`,
`ads-legacy-final-disconnect.log` y `ads-legacy-mysql.log` son las comprobaciones
finales. No hubo cambio de UI ni nueva build/QA visual. No se presenta esta QA
como recepción, conversión ni ejecución publicitaria real.

## Dependencias, costes y publicación

Sin nueva DDL, flag, secreto o permiso. Se requieren las tablas y migraciones
Google ya documentadas, hasta `20260913070000` y sus dependencias, antes de este
código incluso con gates apagados. No se han aplicado a la BD compartida.
Su ausencia bloquea también estos consumidores Ads, por lo que el despliegue
requiere el lote de esquema exacto, respaldo y canary aprobado.

El guard añade lecturas SQL: nominalmente cinco por comprobación de identidad y
diez por petición revalidada antes/después, más la resolución y carga del ámbito.
La latencia/capacidad y el coste real requieren medición en el canary. Sin nuevos
recursos AWS ni consultas Cost Explorer; Ajustes conserva su caché y estado
pendiente existentes. Retención DPD, IAM, Cost Explorer/tags, Budget frente a
CloudFormation y cifrado/restauración/corte BD siguen pendientes.

La publicación contiene solo hunks de seguridad y sus pruebas/documentación.
No modifica consultas de negocio, atribución, presupuestos o pausas. Verificar
el rango completo contra origin/dev y el hash del hotfix antes del push. Push a
DEV no despliega, reinicia ni activa jobs. Un rollback debe conservar los
marcadores y el cierre de credenciales; nunca borrar bloqueos ni restaurar tokens.
