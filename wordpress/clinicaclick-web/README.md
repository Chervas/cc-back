# ClinicaClick WordPress plugin v2

> Estado: implementación aislada de W5, **no instalada ni desplegada**. El
> contrato debe validarse de extremo a extremo en un WordPress desechable antes
> de cualquier instalación real.

Este paquete añade el publicador web mantenido junto al plugin de medición
`clinicaclick` `1.1.7`. Usa el slug independiente `clinicaclick-web/`: instalarlo
no sobrescribe, actualiza ni desactiva el plugin legado. Tampoco lee, copia o
reutiliza su token ni su HMAC; el alta del publicador recibe credenciales
propias y separa dos responsabilidades:

- la medición estable (`loader.js`) se configura mediante un documento
  estructurado y firmado;
- las landings se descargan como artefactos inmutables, se verifican y se
  sirven desde caché local bajo `/cita/`.

El plugin no consulta el CRM durante una visita, no evalúa PHP, no acepta HTML
o JavaScript remoto como configuración y no toca Complianz, Site Kit, el CMP,
JoinChat ni ningún otro plugin.

Cuando la medición y Consent Mode están activos, WordPress emite antes del
loader asíncrono un bootstrap inline mínimo: conserva cualquier señal previa de
Google, establece `default denied` con `wait_for_update` y activa
`ads_data_redaction`, sin credenciales, HMAC ni datos de pacientes. Con
`external_cmp` no oculta ni toma control de Complianz. Con `clinicaclick` puede
marcar temporalmente la interfaz propia; un temporizador de seguridad siempre
retira esa marca si el loader no llega a cargar.

## Compatibilidad y límites de esta versión

- WordPress 5.8 o posterior; PHP 7.4 o posterior; extensión Sodium obligatoria.
- Activación por sitio. La activación de red multisite falla cerrada en esta
  primera versión.
- Artefactos v1: HTML sin código arbitrario, CSS, TXT/XML, imágenes raster y
  fuentes WOFF/WOFF2. `.php`, ficheros `.js`, SVG, iframes y event handlers se
  rechazan aunque estén firmados. En cada HTML solo se permiten JSON-LD y un
  único loader externo que coincida con el runtime firmado.
- Solo artefactos `environment=production`.
- El renderer actual genera HTML/CSS/robots/sitemap y encaja en esta allowlist.
- No incluye updater binario propio. Actualizar el plugin y actualizar el
  contenido siguen siendo operaciones distintas.

## Instalación/configuración

El ZIP provisionado debe contener la carpeta `clinicaclick-web/` y mantener
`clinicaclick-web/clinicaclick.php`. Ya lleva la instalación, el token y el ancla
pública: se instala y activa sin copiar códigos ni abrir la configuración
avanzada. La activación envía un heartbeat autenticado que convierte la
instalación `pending` en `connected`, incluso aunque todavía no exista ninguna
landing. Solo después se permite activar una publicación para ese WordPress.

El ZIP genérico solo se usa en desarrollo o recuperación manual. Tras
activarlo:

1. abre `Ajustes > ClinicaClick Web`;
2. indica `installation_id`, token opaco y `API base` HTTPS;
3. pega el descriptor **público** Ed25519 entregado por un canal autenticado;
4. pulsa `Sincronizar ahora`.

En instalaciones gestionadas se recomiendan constantes fuera de Git:

```php
define('CLINICACLICK_WEB_INSTALLATION_ID', 'uuid');
define('CLINICACLICK_WEB_TOKEN', 'token-opaco');
define('CLINICACLICK_WEB_API_BASE', 'https://crm.clinicaclick.com');
define('CLINICACLICK_WEB_TRUST_DESCRIPTOR_JSON', '{...descriptor publico...}');
// Preferible fuera del document root si el hosting lo permite.
define('CLINICACLICK_WEB_CACHE_DIR', '/ruta/privada/clinicaclick-web-cache');
```

Para una recuperación o migración ya publicada, el backend puede añadir al ZIP
provisionado `clinicaclick-web/config/installation.php`, siguiendo
`config/installation.php.example`. El fichero empieza por `exit` y
`__halt_compiler`; el plugin lee el JSON posterior como datos y **nunca ejecuta
el fichero**. Incluye las tres credenciales, el descriptor público y un runtime
de medición firmado de bootstrap. No se añade al ZIP genérico ni se versiona
con valores reales.

Cuando se incluyen los campos opcionales de runtime, el provisionador debe
copiar **literalmente** el runtime/envelope ya emitidos por el estado deseado de
esa instalación; no debe reconstruirlos ni cambiar su `sequence`. En el alta
normal se omiten para evitar el ciclo publicación -> instalación ->
publicación. Formato exacto del fichero incluido en el ZIP:

```php
<?php http_response_code(404); exit; __halt_compiler(); ?>
{
  "installation_id": "<UUID de WebWordpressInstallation>",
  "api_base": "https://crm.clinicaclick.com",
  "token": "<token ccw_ mostrado una sola vez>",
  "trust_descriptor": {
    "schema_version": 1,
    "algorithm": "Ed25519",
    "key_id": "ed25519-...",
    "public_key_base64": "<32 bytes Ed25519 en base64>"
  },
  "bootstrap_runtime_configuration": {"...": "desired_state.runtime_configuration"},
  "bootstrap_runtime_envelope": {"...": "desired_state.runtime_configuration_envelope"}
}
```

Las dos últimas propiedades son objetos JSON, no strings. Si todavía no existe
un desired state firmado, se omiten ambas y la medición empieza tras la primera
sincronización. No se debe inventar un runtime con la misma secuencia: el
plugin lo bloquearía correctamente como conflicto de replay.

El ZIP provisionado contiene exactamente:

```text
clinicaclick-web/clinicaclick.php
clinicaclick-web/uninstall.php
clinicaclick-web/readme.txt
clinicaclick-web/README.md
clinicaclick-web/includes/class-ccw-admin.php
clinicaclick-web/includes/class-ccw-cache.php
clinicaclick-web/includes/class-ccw-config.php
clinicaclick-web/includes/class-ccw-error.php
clinicaclick-web/includes/class-ccw-http.php
clinicaclick-web/includes/class-ccw-intake-bridge.php
clinicaclick-web/includes/class-ccw-json.php
clinicaclick-web/includes/class-ccw-manifest.php
clinicaclick-web/includes/class-ccw-plugin.php
clinicaclick-web/includes/class-ccw-router.php
clinicaclick-web/includes/class-ccw-sync.php
clinicaclick-web/includes/class-ccw-trust-store.php
clinicaclick-web/config/installation.php
```

El ZIP genérico es igual pero no incluye `config/installation.php`. Fixtures,
tests, tools, claves privadas y `.env` nunca entran en el paquete.

Variables del backend/control plane necesarias fuera de Git:

- `MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM` (secreto Ed25519) y
  `MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM` (su pública correspondiente);
- `MARKETING_WEB_ARTIFACT_STORE_MODE=authenticated_db|s3`; si no se declara,
  usa S3 únicamente cuando bucket y base URL están configurados y, en caso
  contrario, `authenticated_db`;
- con `s3`: `MARKETING_WEB_ARTIFACT_BUCKET`,
  `MARKETING_WEB_ARTIFACT_BASE_URL`, `MARKETING_WEB_ARTIFACT_REGION` y
  `MARKETING_WEB_ARTIFACT_PREFIX`, más credenciales mediante role de instancia
  recomendado o secretos AWS;
- `MARKETING_WEB_API_BASE_URL=https://crm.clinicaclick.com` (config pública);
- `MARKETING_WEB_EDITOR_ENABLED` y `MARKETING_WEB_PUBLISHING_ENABLED` solo al
  abrir su gate operativo.

El HMAC de intake vive en el `IntakeConfig` del scope y se copia al runtime
firmado **solo para uso server-side del plugin**. No forma parte del HTML, del
manifest, del loader ni de ningún atributo visible en el navegador; tampoco es
una variable global ni se imprime en logs. El token `ccw_...` se genera por
instalación, se persiste solo hasheado en backend y se inserta una sola vez en
el ZIP/configuración provisionada.

La descarga autenticada del ZIP provisionado es
`POST /api/marketing/web-installations/{installation_id}/plugin-package`, con
JWT de usuario y `download_ticket` opaco en el body. El ticket AES-256-GCM dura
15 minutos, queda ligado a actor, instalación y token, y la respuesta es
`private, no-store`. El token no se devuelve en JSON ni queda almacenado en
claro en backend.

La clave privada nunca entra en WordPress. El primer descriptor se ancla por
configuración local. Una nueva clave solo se admite si su descriptor viene
firmado por una clave ya confiada. `key_id` es
`ed25519-` + los 16 primeros hexadecimales de SHA-256 del SPKI DER, igual que
`webArtifactSignature.js`.

El token se guarda como opción `autoload=false`, no se refleja en el formulario
y solo se envía a los endpoints de control y artefactos cuyo origen HTTPS
coincide exactamente con el `API base`. Nunca se envía al CDN/S3 externo ni se
incluye en logs/reportes.

## Ciclo de sincronización

1. WP-Cron consulta estado deseado cada 15 minutos, con `ETag`/`304`.
2. Verifica la rotación de clave y la configuración de runtime firmada.
3. Bloquea replays mediante un `sequence` firmado y monótono. Un rollback del
   backend es una secuencia nueva que puede apuntar a un hash anterior.
4. Descarga manifest y envelope Ed25519 desde el origen HTTPS indicado.
5. Verifica firma, hash esperado, rutas, allowlist, tamaños, cabeceras, CSP,
   formularios y loader externo.
6. Descarga a staging y verifica SHA-256/tamaño/contenido. Solo añade el bearer
   si el origen coincide exactamente con el API; un origen S3 externo nunca lo
   recibe.
7. Renombra staging a un release inmutable y conmuta `active.json` mediante
   `rename` atómico.
8. Conserva release, manifest y runtime anterior como `last_known_good` y
   reporta el resultado.

Si la API o el CDN fallan, `active.json` no cambia. La landing activa continúa
sirviéndose. `Rollback local` intercambia activo/LKG y activa `manual_hold` para
que un cron no deshaga la recuperación; `Reanudar y sincronizar` vuelve a
aplicar el estado firmado. Un estado `retired` responde 410 pero conserva los
ficheros para recuperación/retención.

WP-Cron depende de tráfico. En sitios con `DISABLE_WP_CRON`, operación debe
invocar `wp-cron.php` con el scheduler del hosting; no se añade un cron backend
paralelo.

## Rutas públicas

- `/cita/` -> `index.html`
- `/cita/<slug>/` -> `<slug>/index.html`
- `/cita/assets/<fichero>` y `/cita/robots.txt|sitemap.xml` -> fichero firmado
- `POST /_clinicaclick/intake` -> puente same-origin de formularios firmados
- `POST /_clinicaclick/events` -> relay same-origin de chat, teléfono,
  WhatsApp y eventos; valida el artefacto cuando la petición procede de una
  landing y firma hacia el API únicamente dentro de WordPress

Cuando hay una publicación activa, el filtro `robots_txt` de WordPress añade
el sitemap complementario `/cita/sitemap.xml` al `robots.txt` raíz.

El plugin usa `readfile`; nunca `include`, `require` o `eval` sobre contenido.
Aplica los headers firmados desde una allowlist, `nosniff`, ETag y caché
inmutable para assets. En Nginx conviene situar `CLINICACLICK_WEB_CACHE_DIR`
fuera del document root. Los artefactos son públicos, pero el acceso directo a
la caché podría omitir headers; el plugin escribe además defensas para Apache e
IIS.

## Compatibilidad con la medición 1.1.7

El publicador conserva la carga de `/assets/loader.js`, pero deja de aceptar un
snippet HTML generado. El backend entrega `measurement` dentro de
`runtime_configuration`, que está firmado. El plugin conserva el HMAC dentro
de WordPress y construye para el navegador únicamente:

- `data-clinic-id` o `data-group-id`;
- `data-api-url`;
- `data-event-bridge-url=/_clinicaclick/events`;
- `data-consent-mode-enabled=true|false` y
  `data-consent-provider=clinicaclick|external_cmp`.

La URL del loader siempre es `<API base>/assets/loader.js`. En páginas normales
de WordPress, si Consent Mode está habilitado, el plugin antepone el bootstrap
inline mínimo descrito arriba. `external_cmp` solo recibe el default temprano y
mantiene el control de su interfaz; `clinicaclick` puede ocultar temporalmente
el banner externo, con liberación automática a los ocho segundos y también en
el manejador de error del loader.

En landings, el
renderer incluye la misma etiqueta dentro del HTML firmado; el plugin exige
exactamente `src`, `async`, `data-api-url`, el bridge same-origin, un único
scope, los IDs canónicos de proyecto/revisión/página y los dos atributos de
consentimiento, sin extras. CSP de header y meta solo puede
autorizar ese origen externo para `script-src`/`connect-src` (además de hashes
JSON-LD y `'self'` para conexiones). El secreto permanece en el runtime firmado
guardado por el plugin y nunca aparece en el panel, el bootstrap ni el
artefacto. El ZIP final
de migración debe venir ya provisionado con
`installation_id`/token/descriptor/runtime firmado para evitar una ventana sin
medición; esta fuente genérica deliberadamente no contiene credenciales.

## Puente de formularios de landings

El HTML de producción publica formularios
`application/x-www-form-urlencoded` contra
`POST /_clinicaclick/intake`. No hay JavaScript de envío obligatorio. Cada
formulario lleva `data-cc-native-intake="true"` para que el loader no duplique
el lead. El browser solo puede enviar esta allowlist; cualquier otro campo,
duplicado o array falla cerrado:

- datos opcionales presentes en el `WebDocument`: `first_name`, `last_name`,
  `email`, `phone`, `message`, `preferred_contact`;
- `privacy_consent=1`, obligatorio;
- honeypot `_cc_company`;
- dos hidden opcionales que el loader añade justo antes del POST nativo:
  `_cc_ad_user_data` y `_cc_ad_personalization`, exclusivamente
  `granted|denied`;
- cuatro identidades ocultas: `web_project_id`, `web_revision_id`,
  `web_page_id`, `web_form_id`.

Debe existir `email` o `phone`. Límites: body 16 KiB, nombre/apellidos 100
caracteres, email 254, mensaje 2.000 y teléfono normalizado a 7-15 dígitos. El
manifest firmado contiene `intake_forms[form_id]` con `page_path`, `page_id`,
`success_anchor=cc-<formId>-success` y `error_anchor=cc-<formId>-error`. El
inspector contrasta además el form nativo, sus identidades ocultas y anclas. El
plugin compara las cuatro identidades y el path del `Referer` HTTPS same-origin
con el manifest; nunca confía en scope, API, page URL o redirect recibidos del
visitante.

Solo se conservan de la query del `Referer`: `gclid`, `gbraid`, `wbraid`,
`fbclid`, `ttclid` y `utm_source|medium|campaign|content|term`. Esos valores se
añaden a una `page_url` reconstruida desde `home_url`; el host del visitante no
se refleja. `Origin`, cuando viene, también debe ser same-origin.

Tras validar, el plugin toma scope y HMAC exclusivamente del runtime firmado
que acompaña al release activo y reenvía JSON a la URL fija
`<API base>/api/intake/leads` con:

```http
Content-Type: application/json
Accept: application/json
X-CC-Signature: <HMAC-SHA256 hexadecimal del body exacto>
X-CC-Event-Id: ccw_<64 hex>
X-Clinicaclick-Web-Artifact: <hash activo>
X-Clinicaclick-Plugin-Version: 2.0.0-alpha.3
```

No envía el bearer de instalación. El payload fija server-side
`external_source/source_detail=clinicaclick_web_landing`, scope, atribución,
identidades web, `lead_data`, `form_submission`, IP remota, user-agent y
consentimiento de contacto auditado. No envía el honeypot. Un `200/201` con
`id`, o un `409` deduplicado con `id`, produce `303` a la URL canónica y el
ancla de éxito firmada. `202`, body sin `id`, red, firma o backend inválidos se
tratan como fallo genérico; nunca se refleja PII, body ni error del backend.

Si el loader aporta los dos estados publicitarios válidos, se copian a
`consent.ad_user_data`/`consent.ad_personalization`. Si no están presentes, el
plugin no inventa permisos. `contact=granted` procede únicamente del checkbox
obligatorio de privacidad.

La protección local admite 8 intentos/10 minutos por un digest de IP con clave
server-side y 120/hora por instalación. El fichero solo guarda hashes/timestamps con permisos `0600`. Un
honeypot devuelve el mismo 303 de éxito sin consumir API ni rate-limit. Un
rollback restaura manifest y runtime LKG juntos; si un LKG legacy no tiene
runtime emparejado, la página sigue sirviéndose pero intake falla cerrado.

## Contrato HTTP congelado para el backend

### Autenticación de control

Solo los endpoints de control de la instalación reciben:

```http
Authorization: Bearer <installation token>
X-Clinicaclick-Plugin-Version: 2.0.0-alpha.3
Accept: application/json
```

El backend resuelve instalación y scope de control exclusivamente desde el token y debe
fallar cerrado si el `installation_id` de la ruta no coincide. Nunca devuelve
el token. En modo `authenticated_db`, manifest, envelope y ficheros usan el
mismo bearer y versión del plugin porque sus URLs son same-origin. En modo S3
son URLs externas públicas inmutables y el plugin omite Authorization.
El puente público de formularios tampoco usa este bearer: el plugin firma
server-side con el HMAC del runtime según la sección anterior; el navegador no
recibe ni calcula esa firma.

Las rutas de artefacto autenticado son:

```http
GET /api/marketing/web-installations/{installation_id}/artifacts/{artifact_hash}/manifest
GET /api/marketing/web-installations/{installation_id}/artifacts/{artifact_hash}/envelope
GET /api/marketing/web-installations/{installation_id}/artifacts/{artifact_hash}/files/{path_token}
```

Aunque son rutas sin JWT de usuario, no son anónimas: requieren bearer de la
instalación y `X-Clinicaclick-Plugin-Version`. El backend vuelve a resolver el
estado deseado y solo sirve el hash exacto y el conjunto de ficheros firmado de
esa instalación; un hash anterior, de otra instalación o una ruta manipulada
responde 404.

### Estado deseado

```http
GET /api/marketing/web-installations/{installation_id}/desired-state
If-None-Match: "desired-version"
```

Respuestas: `200`, `304`, `401/403`, `404`, `409` o `503`. Un `200` sigue
`fixtures/desired-state.published.json` o `desired-state.retired.json`.

Campos obligatorios:

- raíz: `schema_version=1`, `request_id`, `installation_id`, `desired_state`;
- `status=published`: `artifact_hash`, `manifest_url`, `envelope_url` y `files`
  con exactamente las mismas rutas que el manifest;
- siempre: descriptor de la clave del artefacto, envelope de rotación (puede ser
  `{}` si la clave ya es confiada), runtime y envelope del runtime;
- URLs de manifest, firma y ficheros: HTTPS, mismo origen, sin credenciales;
- `runtime_configuration.sequence`: entero monótono por instalación;
- `desired_artifact_hash`: hash publicado o `null` cuando `retired`;
- `route_prefix`: exactamente `/cita`.
- manifest con formularios: `project_id`/`revision_id` UUIDv4 e
  `intake_forms` con el contrato exacto descrito arriba.
- `runtime_config_hash`: SHA-256 del runtime normalizado usado al compilar; debe
  coincidir con el runtime firmado del desired state. Rotar HMAC/scope/consent
  exige recompilar, no reutilizar silenciosamente el HTML anterior.

`runtime_configuration` y el manifest se serializan con JSON canónico: claves
de objetos ordenadas recursivamente, arrays en orden, UTF-8 y sin espacios. El
contrato de control/manifest v1 usa valores ASCII (el contenido humano vive en
ficheros hasheados). Si una versión futura firma texto Unicode, PHP necesita
`ext-intl` para reproducir la normalización NFC canónica de Node. El
envelope es compatible con `webArtifactSignature.js`:

```json
{
  "signature_version": 1,
  "algorithm": "Ed25519",
  "key_id": "ed25519-...",
  "manifest_sha256": "sha256-del-json-canonico",
  "signature": "base64-ed25519"
}
```

La firma cubre el manifest completo, incluido `artifact_hash`. La firma del
runtime cubre toda su configuración, incluidos scope de medición y el HMAC
server-side,
secuencia, estado y hash deseado. Una rotación cubre el descriptor normalizado
de la nueva clave y está firmada por la clave anterior (`envelope.key_id`).

### Reportes/heartbeat

```http
POST /api/marketing/web-installations/{installation_id}/reports
Content-Type: application/json
```

Eventos: `sync_result`, `sync_failed`, `heartbeat`, `local_rollback`. El payload
incluye versiones, hash del sitio, artefactos activo/deseado, duración,
`request_id`, resultado y un código de error estable. No incluye token, body de
respuesta, rutas locales, contenido, datos de pacientes ni el HMAC server-side.
El endpoint responde `200`, `202` o `204`; un fallo de reporte nunca desmonta la
última publicación válida.

## Runbook

1. Verificar PHP/Sodium: `php -m | grep sodium`.
2. Construir y auditar ZIP: `./tools/build-zip.sh`.
3. Ejecutar harness: `./tests/run.sh`. Incluye los contratos Node/PHP de firma
   y compilador, y genera un ZIP provisionado real que se extrae, carga y
   activa desde sus propios PHP empaquetados.
4. En un WordPress desechable, instalar el ZIP y guardar configuración de test.
5. Sincronizar y comprobar HTML, asset, ETag/304, HEAD, 404 y 410.
6. Cortar API/CDN y confirmar que `/cita/` sigue respondiendo.
7. Probar firma/hash/path malos: el hash activo no debe cambiar.
8. Publicar una revisión nueva; comprobar activo/LKG y rollback.
9. Confirmar que el sitio solo tiene el loader de Clinicaclick esperado y que
   el CMP/otros plugins no han cambiado.
10. Enviar un formulario válido y comprobar 303/lead; repetir con Origin,
    Referer, IDs manipulados, firma server-side inválida, campo extra,
    duplicado, honeypot, 202 y rate-limit
    adversariales.
11. No instalar en Propdental hasta que los endpoints, jobs y gate W5 estén
    desplegados y las pruebas anteriores tengan evidencia.

## Desinstalación

Desactivar elimina el evento WP-Cron y refresca rewrites, pero mantiene caché y
configuración. Desinstalar también conserva todo por defecto. El borrado solo
se ejecuta con `CLINICACLICK_WEB_PURGE_ON_UNINSTALL === true` o la opción
explícita `ccw_purge_on_uninstall=true`.

## Desarrollo y paquete determinista

```bash
./tests/run.sh
./tools/build-zip.sh
sha256sum dist/clinicaclick-web-2.0.0-alpha.3.zip
```

El builder copia una allowlist, ordena entradas, fija un timestamp DOS y
escribe un ZIP `store` sin metadatos variables; dos ejecuciones sobre la misma
fuente producen el mismo SHA-256.
