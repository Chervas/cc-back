# Google Ads: alta de cuentas desde un ámbito aprobado

Estado 13/09/2026: motor del broker implementado y probado con proveedores
ficticios. La API de ClinicaClick y Ajustes todavía no llaman a estas operaciones.
El alta general de cuentas, de extremo a extremo, sigue pendiente. No hay
configuración instalada, cuentas reales incorporadas ni despliegue.

## Autoridad independiente de las cuentas existentes

Una conexión Ads puede declarar `googleAdsEnrollmentScopes` además de
`googleAdsAccounts`, o sin ninguna cuenta estática. Cada ámbito fija:

| Campo | Contrato |
| --- | --- |
| `assetRef` | `ads-enroll:clinic:<id>` o `ads-enroll:group:<id>` |
| `tenantRef` | Clínica titular; debe coincidir con el ID de un ámbito de clínica |
| `rootCustomerId` | MCC aprobado, canónico de diez dígitos; se rechaza `0000000000` |
| `loginCustomerId` | Gestor fijado o `null` para consultar directamente el MCC raíz |
| `readPrincipalId` | Principal que recibirá las lecturas tipadas declaradas |
| `controlPrincipalId` | Principal que podrá revocar los activos incorporados |
| `readOperations` | Subconjunto cerrado de lecturas Ads; discovery es obligatoria |
| `maxAssets` | Límite de registros durables, entre 1 y 1000, incluidos los retirados |

El grant de alta tiene principal y clave distintos de lectura, revocación y
OAuth. La separación compara las claves públicas reales, incluso si cambian sus
IDs. Se pueden conceder los controles OAuth existentes sobre el ámbito sintético
con su principal independiente; el adaptador OAuth de la aplicación aún necesita
incorporar este ámbito. Nunca se acepta desde el consumidor un grant, una clave,
un gestor, una referencia de secreto ni una consulta GAQL.

La autoridad para gestionar altas no depende de una cuenta que pueda retirarse
al sustituir una selección. Revocar el propio ámbito impide nuevas altas y
lecturas de sus cuentas dinámicas; la revocación de esas cuentas sigue disponible.

## Operaciones internas

Todas usan el protocolo firmado `POST /v1/execute`, con el ámbito sintético como
`assetRef` y el tenant/conexión aprobados. No se añade un endpoint público a la API.

| Operación | Payload exacto | Resultado |
| --- | --- | --- |
| `google.ads.enrollment.discover.v1` | `pageToken` nulo o cursor opaco | `accounts`, `nextPageToken` |
| `google.ads.enrollment.prepare.v1` | `enrollmentId`, `customerId`, `clinicCount`, `clinicSetDigest` | Recibo de preparación |
| `google.ads.enrollment.activate.v1` | Los mismos cuatro campos originales | Recibo de activación |
| `google.ads.enrollment.status.v1` | `enrollmentId` | Estado actual y `accessBlocked` |

`enrollmentId` es UUID v4; `customerId` es canónico; el conjunto original de
clínicas tiene entre 1 y 1000 miembros y un hash SHA-256. El ámbito de clínica
exige un miembro. Los recibos contienen ID, activo, ámbito, número/hash de clínicas
y estado. El broker fija estos datos al preparar y rechaza cambios al activar.
La aplicación deberá comprobar los permisos y calcular el conjunto/hash en el
servidor. El broker no tiene acceso a la BD clínica ni puede acreditar por sí
solo sus membresías, usos compartidos o activos principales.

La búsqueda usa el MCC raíz y una consulta fija de `customer_client`, con clientes
no gestores y nivel positivo. Sus campos y el significado de la jerarquía se
contrastaron con la [referencia oficial v24](https://developers.google.com/google-ads/api/fields/v24/customer_client).
Preparar y activar vuelven a consultar el cliente seleccionado, con filtro fijo
por ID y exactamente un resultado válido. No se modifican cuentas, campañas,
presupuestos, invitaciones ni conversiones en Google.

Se omiten CLOSED/CANCELED; SUSPENDED sigue siendo legible y no acredita capacidad
de publicación. No se devuelve inventario parcial si aparecen errores, filas
malformadas, clientes duplicados, gestores, un cursor del proveedor o más de 1000
clientes. La aplicación no debe presentar el acceso al MCC como prueba de
propiedad clínica de sus cuentas.

## Persistencia, bloqueos y concurrencia

La tabla local SQLite `google_ads_enrollments` registra exclusivamente referencias,
propiedad, gestor, identidad de la solicitud, conjunto de clínicas, estado y
fechas. El activo/cliente y el UUID son únicos. No contiene nombres del proveedor,
respuestas, métricas ni credenciales. No tiene FK que borre el historial al quitar
otro registro. El constructor del store añade tabla e índice en su fichero privado
al iniciar el nuevo broker; no es una migración de la BD compartida.

La preparación permite únicamente discovery al principal de lectura. La
activación habilita las operaciones de lectura expresamente delegadas. La política
estática permanece intacta: cada petición obtiene una concesión exacta a partir
del registro durable y de su ámbito actual. Una cuenta ya estática no se convierte
por este flujo; los cambios de propietario siguen pendientes.

La huella de configuración incluye conexión, sujeto Google, referencias de
secretos, ámbito, MCC, gestor y derechos delegados. Cambiar esos elementos cierra
las lecturas anteriores; cambiar una clave pública conservando la identidad del
principal o una versión de política ajena no cambia la propiedad.

Cualquier revocación histórica del cliente impide un alta, incluso bajo otro
tenant/conexión. Los registros activos y preparados también impiden otra alta del
mismo cliente. El límite por conexión suma cuentas estáticas y registros durables
y no supera 1000. No se borra historia para recuperar capacidad.

Registro/activación, recibo y auditoría técnica se confirman en una transacción
SQLite. La revisión final de conexión, revisión y bloqueos comparte el lock de
escritura, también frente a un segundo proceso. Una baja concurrente, timeout,
fallo del proveedor o de auditoría no deja una activación parcial. Los reintentos
de un comando completado usan su UUID original; se comprueban los bloqueos antes
de devolver el recibo histórico. Si quedó un resultado desconocido, consultar el
estado con un UUID de comando nuevo permite conciliar el mismo `enrollmentId`.

`status` consulta metadata sin secretos/proveedor, también con conexión o ámbito
bloqueados. La baja usa `google.ads.asset.revoke.v1` sobre la cuenta preparada o
activa y conserva el tombstone existente. No revoca OAuth en Google.

## Límites, costes y auditoría

El inventario mantiene hasta 16 snapshots, 16 MiB en total y diez minutos de vida;
entrega hasta 250 resúmenes por página. Los cursores están cifrados/autenticados y
ligados a principal, ámbito, conexión, operación, política y época de credenciales.
Una rotación, invalidación, reinicio o caducidad exige empezar otra búsqueda.
No se guardan páginas ni cursores del proveedor en SQLite.

El runtime conserva su admisión de ocho peticiones simultáneas y timeout de 25 s.
La página inicial consulta Google una vez; las siguientes usan el snapshot y
vuelven a comprobar las credenciales. Preparar y activar consultan Google una vez
cada uno. Status y revocación no consultan secretos ni Google. Esos accesos a
Secrets Manager, consultas y eventos añadirán coste cuando se habiliten; este
bloque no mide gasto ni inventa precios. Costes en Ajustes/Cost Explorer siguen
pendientes.

La auditoría técnica v2 correlaciona operación/ámbito/comando sin contenido del
proveedor. El recibo durable vincula el comando con el activo y la intención.
La auditoría humana de alta, actor/sesión y membresías debe integrarse en la API;
no se declara cubierta por estos eventos de servicio.

## Integración que sigue pendiente

1. Registrar en la aplicación el ámbito aprobado, con identidad Google conocida;
   no derivarlo de una cuenta que se pueda retirar ni aceptarlo del navegador.
2. Añadir intención durable de alta y exclusión global de credenciales antiguas
   aunque desaparezcan bindings, mappings o asignaciones originales.
3. Autorizar el conjunto original de clínicas y todos sus usos/primarios antes y
   después de cada espera; preparar bindings/mappings inactivos bajo transacción.
4. Incorporar conciliación de preparación/activación y pérdida de ACK sin dar
   lecturas ni sustituir cuentas anteriores antes de una confirmación válida.
5. Conectar selección, estado y reautorización en API/Ajustes, auditoría humana y
   pruebas HTTP/MySQL/UI aisladas. Sigue pendiente la primera identidad Google
   sin conexión gestionada y el traslado de propietario.

OPS sigue aplazado. La instalación, configuración de ámbitos/principales,
migraciones compartidas, secretos reales y corte de cohortes requieren su
aprobación acotada. Las migraciones compartidas de los bloques anteriores siguen
sin aplicar. El rollback detiene esta cohorte y conserva SQLite/tombstones; un
broker antiguo no puede servir cuentas dinámicas y no debe habilitar fallback.

Evidencia privada: `qa-evidence/security-migration-20260912/ads-enrollment-*`.
Incluye SQLite propios, HTTPS local con el runtime real, SDK/proveedor/S3
ficticios, reinicio, separación de claves, concurrencia, timeout, rollback de
auditoría y ausencia de carga del índice de modelos clínicos. Los recuentos y
salidas definitivos están en el acta QA; ninguna prueba acredita acceso real AWS.
