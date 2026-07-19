# ClinicaClick WordPress plugin v2

> Estado 2026-07-19: la fuente y los ZIP deterministas corresponden a
> `2.0.0-alpha.8`. Este corte añade registro firmado multi-route, rotación
> staged del token y reconciliación del runtime de intake. Backend/plugin
> `1cdfaa1` se promovió a staging mediante `aa8bc4c`; el WordPress público de
> Propdental ya ejecuta `2.0.0-alpha.8`, instalado y activo junto al plugin de medición
> `clinicaclick` `1.1.7`; WP-CLI y la fila DB están alineados. La instalación
> está `connected` en `https://www.propdental.es`. `/cita/` sirve ya renderer
> `1.7.0`; la primera republicación usó deployment `18fa50be…`, secuencia 11,
> artefacto `aa05cb59-b27f-4d83-b8fb-f6ef0d4d5cb9`, hash `648cf766…` y HTML
> `153275eb…`, con `200/304`, `warnings=[]`, dirección/horario Schema y sin
> imagen insegura.
> El handshake schema 2, el claim de
> sitio y la promoción del token staged terminaron correctamente;
> desired/reported coincidían en secuencia 8 antes del E2E de rutas. El E2E
> público multi-route terminó con rollback, formulario, limpieza y tombstone
> desired=reported sequence 12; `/cita/` conservó su body/artefacto durante esa
> prueba y después evolucionó hasta renderer `1.7.0`. La rotación HMAC de
> generación 2 y su readback final terminaron. El E2E campaña -> ruta publicó,
> leyó y verificó en Chromium la landing Hospitalet, creó un binding auditable
> y demostró el guard de cero mutaciones en `connect_only`; el intake posterior
> quedó verificado y limpiado sin escrituras externas. Hosted/custom quedan
> fuera del rollout validado. El ciclo real `1.6 -> rollback 1.5 -> 1.6` quedó
> acreditado en secuencias `8`, `9` y `10`. Relay atribuible, limpieza,
> rollback y monitor del piloto WordPress ya están cerrados. La revisión QA de
> globales+galería descrita debajo se publicó, verificó y retiró con tombstone
> `410`; no es contenido live actual. Actualizar
> el binario por sí solo no cambia contenido. `alpha.6`/`alpha.5` quedan como evidencia histórica; después de
> schema 2 el rollback operativo mantiene `alpha.8` + last-known-good.

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

## Cierre funcional globales + galería (candidato 2026-07-19)

El renderer permanece en `clinicaclick-web-renderer/1.7.0` y el plugin en
`2.0.0-alpha.8`. El candidato actual publica una revisión que ejerce cabecera y
pie globales y una galería real con assets congelados; conserva desired-state
multi-ruta, hashes/manifest, ETag, CSP, formulario, last-known-good y rollback.
No introduce HTML, CSS ni JavaScript aportado por el usuario.

Pruebas del candidato: backend Marketing Web **361/361**, este plugin
**40/40** e interoperabilidad backend-plugin **3/3**. El frontend asociado pasa
**263/263**, sus focales editor/CMS **88/88** y TypeScript. Los totales 320/320
y 354/354 citados después pertenecen a publicaciones anteriores.

La prueba pública final se cerró con:

- publicación `77d0f7a9-b42e-4844-83d6-cc71d46d14fb`;
- revisión `b841dead-f9a7-4d6b-937c-bf7117521559`;
- deployment `262d7091-0ff4-441c-979b-0db4cb3aead6`;
- artefacto `f2e6f7f7-e08f-408c-9b80-d10d910bc08f`;
- hash
  `f922298aeb6e1e7a5ca25fc3640c38b1d3874f0987427cee6274d97c24e6cdda`;
- `/cita/qa-globales-galeria-20260719/`, renderer 1.7 y aserciones públicas y
  Chromium desktop/móvil verdes;
- Schema 1 objeto, 0 errores y 0 avisos;
- Lighthouse: rendimiento 88, accesibilidad 100, buenas prácticas 100 y SEO
  69 (`noindex` deliberado); FCP 1,0 s, LCP 3,9 s, CLS 0 y TBT 0.

Al terminar se archivó el proyecto y se retiró la publicación. El router sirve
ahora **410 Gone** intencionalmente; no es una caída ni debe esperarse 404.
El QA admin autenticado directo contra `https://crm.clinicaclick.com` recorrió
Proyectos y Contenidos a `1440` y `390`: cuatro HTTP 200, sin overflow, page
errors, requests fallidas ni errores HTTP. Evidencia en
`/home/ubuntu/qa-evidence/marketing-web-editor/staging-admin-overflow/`.

Esta evidencia provisional no amplía el rollout. Hosted/custom y mutaciones de
proveedor siguen apagados; Propdental continúa en `connect_only` (**Mide y
entiende**). `guided_improvement` se presenta como **Mejora**,
`managed_service` como **Piloto** y `managed_self` solo se conserva para leer
histórico: no admite edición/transiciones en la UI y el backend responde
`409 legacy_mode_read_only` ante cualquier actualización.

Cuando la medición y Consent Mode están activos, WordPress emite antes del
loader asíncrono un bootstrap inline mínimo: conserva cualquier señal previa de
Google, establece `default denied` con `wait_for_update` y activa
`ads_data_redaction`, sin credenciales, HMAC ni datos de pacientes. Con
`external_cmp` no oculta ni toma control de Complianz. Con `clinicaclick` puede
marcar temporalmente la interfaz propia; un temporizador de seguridad siempre
retira esa marca si el loader no llega a cargar.

## Cierre público renderer 1.7 (2026-07-19)

La primera republicación 1.7 creó deployment
`18fa50be-270f-4d70-96cb-95880ed0c68e`, secuencia `11`, y artefacto
`aa05cb59-b27f-4d83-b8fb-f6ef0d4d5cb9`. El readback de `/cita/` acredita:

- `200` normal y `304` con `If-None-Match`;
- renderer `clinicaclick-web-renderer/1.7.0` determinista, `warnings=[]` y
  ausencia de código ejecutable aportado por el usuario;
- `PostalAddress` y `OpeningHoursSpecification` presentes, sin imagen clínica
  insegura;
- hash de artefacto `648cf766…` y SHA-256 HTML `153275eb…`.

El ciclo `1.6 -> 1.5 -> 1.6`, secuencias 8–10, se conserva como evidencia
histórica. Tras aparecer un HMAC en una salida diagnóstica se rotó sin
reproducirlo: reconciliación `889cc3a4-7d09-4cb0-accb-65acbdbfbb61`, generación
2, deployment target `ae350f06-3325-4b88-9a46-3c37f2e627dc` y artefacto
`2a2abd9a-9249-44a2-926c-92656084725b`, verificados. Accepted keys pasó 2→1 y
los envelopes source/target se eliminaron. El readback final de `/cita/`
acredita hash `cd4119d…`, HTML `a34a993…`, condicional `304`, renderer 1.7,
WebSite/Dentist/WebPage, dirección, diez horarios, ausencia de imagen Schema y
CSP correcto.

La fase campaña -> ruta detectó que un `IntakeConfig` local incompleto podía
ocultar el consentimiento grupal válido. El backend
`88b16c6`/staging `d8b8938` separa ahora ambas procedencias: conserva intake,
chat, teléfono e integraciones de clínica y solo toma el consentimiento del
grupo si la membresía coincide, la clínica figura explícitamente en
`group.config.locations`, el consentimiento local no está listo y el grupal
sí. El proyecto `4df293bd-98b9-4dd7-a601-3c557048925c` resolvió intake `81` y
consentimiento `24`. La publicación
`fe4dece6-36a8-47f2-86a0-70235f8e11d6`, deployment
`e5156f84-7977-4c4d-b626-42acd33f7bff` y artefacto
`dafc020d-03a0-4c6a-9c7f-e4d93fe18376` están verificados para
`https://www.propdental.es/cita/primera-visita-hospitalet/`.

El bridge exporta explícitamente `stableHttpsDestination` desde
`6fdd153`/staging `f9c3049`. Job `32462` completó tras retry natural 4/8 y creó
binding final `8a056617-7072-4e2a-9a84-e6438a303175` para estrategia `10`. Al ser
`connect_only`, quedó bloqueado con `measure_mode_never_changes_destinations`;
job `32468` completó y no existe ningún
`marketing_campaign.destination_apply.v1` desde las 18:25. El readback de la
landing devuelve `200/304`, hash `3a8aff…`, renderer 1.7, formulario, JSON-LD,
dirección/horarios y `warnings=[]`. Chromium `1440/390` confirma overflow 0,
contacto/consentimiento/chat y cero errores. Evidencia
`campaign-landing17-live/` y `campaign-landing17-e2e-evidence.json`. Este cierre
demuestra **cero mutaciones de proveedor**.

El E2E controlado posterior creó temporalmente `LeadIntake #7272` para clínica
`59`/grupo `5`, con `google_ads/clinicaclick_web_landing`, la publicación
anterior, asignación Google Ads `28`, customer `1851215478`, campaña
`21313059516`; el binding conserva `targetKind=general` y el resolver Ads
devuelve estrategia `10`, request `24`, `target_kind=generic`.
El snapshot inmutable `web_landing` schema `1` validó publicación, proyecto,
revisión, página, artefacto, formulario, scope, asignación y estrategia. La
revisión exacta es `fc244f6e-b0b5-46cf-af72-05041a70c3a3`, con deployment
`e5156f84-7977-4c4d-b626-42acd33f7bff`, artefacto
`dafc020d-03a0-4c6a-9c7f-e4d93fe18376` y hash
`3a8aff298c3768acbb6564ab4cc2c63ed6009abb614a29a549483422ea762dc4`. La
conversión terminó `skipped/no_permitted_identifiers`, con
`provider_request_id=null` y cero escrituras externas. El cleanup confirmó
cero restos de lead/form/audit/attempt/eventos y eliminó ocho eventos de
preflight. Evidencia saneada:
`campaign-landing17-lead-e2e-evidence.json`.

El hardening `8c4fdeb`/staging `55a34d7` protege el binding; el corte vigente
`3f0c0e0`/staging `a22b773` añade el snapshot y el E2E final del intake. El
binding conserva snapshot digest de modo/estado/scope/mandato/cohorte, identidad exacta
de destino+operación y revalidaciones request/worker antes y después de mutate
y readback. Un binding antiguo sin snapshot exige refresh; cambio de estrategia,
revocación managed o campaña fuera del target bloquean antes del proveedor. El
rollback de seguridad sigue permitido tras un downgrade únicamente para
restaurar el `beforeState` capturado por una operación antes autorizada; nunca
recibe una URL libre ni aplica un destino nuevo. El cierre pasa Marketing Web
354/354 Node, WordPress 40/40 y Campañas 81/81, con auditor independiente GO.

El QA Chromium de 1.6 se conserva como baseline histórica: contextos separados
desktop/móvil recibieron HTTP
`200`, sirven el mismo artefacto, aceptan el consentimiento, ocultan el banner,
muestran un único candidato visible del widget de chat y conservan overflow
`0`. Evidencia `wordpress-renderer16-live/result.json`, SHA-256
`2b7e024f3fb586faf593732a54c40868e5b4d03c87ccda98f7852297ffc0701d`.
Solo persiste el warning benigno porque `frame-ancestors` no se aplica desde
meta CSP; el header CSP real sí lo incluye.

El canal WordPress queda acreditado. El origen alojado por Clinicaclick y el
dominio propio continúan bloqueados por sus requisitos externos de DNS, TLS,
proveedor y E2E; este cierre no los habilita.

El resolver backend posterior admite que una clínica consuma la instalación
activa propiedad de su propio grupo, con `inherited_from_group=true` y
`source_scope`. No admite cross-group ni que el grupo herede una instalación
propiedad de clínica. Proyecto/publicación mantienen scope de clínica y el
grupo administra plugin, token e instalación. El E2E Hospitalet ya acreditó
esta herencia en una campaña `connect_only`; no exige cambios en el binario
WordPress ni permite a una clínica rotar el token compartido. Crear una
publicación desde proyecto de grupo bloquea con `UPDATE` la clínica de
`configuration.clinic_id` y revalida activa+miembro en la misma transacción,
cerrando la carrera con un movimiento/baja concurrente; focos 26/26. La
membresía se
revalida en backend en cada operación: antes de mover o desactivar una clínica
deben retirarse sus rutas heredadas —también las publicaciones `scope=group`
materializadas para ella mediante `configuration.clinic_id`— y WordPress debe
confirmar el tombstone; una publicación antigua no conserva acceso durable al
grupo.

El editor bulk de grupos no constituye una vía alternativa: el backend
centraliza las transiciones mediante
`groupAssets.updateGroupConfig`/`applyClinicMembershipSelection`, toma locks de
`Clinica` en orden estable y ejecuta los mismos preflights de retiro+ACK y
reconciliación antes de mutar. El controller conserva el `409` y el código de
dominio. Este hardening está desplegado y pendiente de E2E; la regresión
`web_group_membership_transition_guard` pasa 4/4 y la focal ampliada 76/76. El
registry, ACK y artefacto revalidan publicaciones `scope=group` por
`configuration.clinic_id`; si la clínica falta, está inactiva o se movió, la
ruta se excluye fail-closed. Los locks clinic/group se ordenan por
`effectiveClinicId`.
Revocar la instalación examina hasta 200 publicaciones históricas, aunque el
tope activo sea 20, y exige retiro+tombstone ACK de todas; la prueba de 21
tombstones bloquea con uno pendiente y revoca al confirmar los 21.

El renderer 1.7 y la migración `20260719170000` están desplegados.
Añaden `clinic_snapshot_hash` al marker/manifest/caché/DB para que un artefacto
no se reutilice entre clínicas y para recompilar si cambia dirección u horario
efectivo. El renderer puede proyectar dirección/horario desde una ubicación
verificada. No selecciona GBP por `last_synced_at`: usa la primaria del grupo
o una única asignación explícita; sin selección exige una única ficha directa
activa, verificada y no suspendida. Si hay dos candidatas, omite los datos de
Google. La regresión de primaria frente a reciente y doble ambigüedad pasa
21/21 focales. Nunca descarga ni reutiliza una foto GBP/`googleUrl`: solo usa
la imagen canónica pública y no-tiny de Clinicaclick. La tanda focal pasa
43/43; el plugin público sirve 1.7 y tanto el readback final post-rotación como
el E2E campaña -> ruta Hospitalet están acreditados. El lead/intake controlado
`#7272` y su cleanup también están cerrados, con postcheck final a cero y sin
escrituras externas.

El corte promovido anterior pasó Marketing Web 354/354 Node, WordPress 40/40, Campañas
81/81, reviewer 96/96 con GO sin high/medium, frontend Marketing 302/302 y
TypeScript app/spec exit `0`. Ng-serve compiló en desarrollo con hash
`fa3f6c6dfda1977c`; no es un deploy estático. Renderer 1.7 y la herencia de publicación ya
tienen E2E público; los gates destructivos de cambio/revocación conservan sus
pruebas negativas y su validación operativa independiente.

Una sincronización manual (`ccw_sync_event` o activación mediante WP-CLI) debe
ejecutarse como el usuario OS del sitio `propdental.es`, no como `root`. El
primer intento 1.7 como root dejó la caché privada ilegible; se reparó ownership
y se repitió como el usuario del sitio. El cron conserva el usuario correcto.

## Compatibilidad y límites de esta versión

- WordPress 5.8 o posterior; PHP 7.4 o posterior; extensión Sodium obligatoria.
- Activación por sitio. La activación de red multisite falla cerrada en esta
  primera versión.
- `alpha.8` admite hasta 20 rutas activas por instalación mediante desired
  state schema 2. El piloto histórico conserva `/cita/`; las adicionales usan
  `/cita/<slug>/` y el router elige el prefijo firmado más largo. La capacidad
  y el historial son conceptos distintos: un tombstone confirmado libera un
  slot, pero la ruta retirada nunca se reasigna. El historial queda acotado a
  200 filas por instalación. Este contrato está cerrado en código y pruebas y
  ya está desplegado en el WordPress público. El E2E desechable de dos rutas
  quedó cerrado con aislamiento, rollback, formulario, cleanup y tombstone. El rollback local del piloto
  restaura conjuntamente artefacto, manifest y runtime en `active.json` y
  `routes.json`; durante los dos renames el resolver solo acepta el runtime
  cuyo hash corresponde al artefacto activo, por lo que intake y eventos no
  pueden mezclar releases.
- Artefactos v1: HTML sin código arbitrario, CSS, TXT/XML, imágenes raster y
  fuentes WOFF/WOFF2. `.php`, ficheros `.js`, SVG, iframes y event handlers se
  rechazan aunque estén firmados. En cada HTML solo se permiten JSON-LD y un
  único loader externo que coincida con el runtime firmado.
- Solo artefactos `environment=production`.
- El renderer actual genera HTML/CSS/robots/sitemap y encaja en esta allowlist.
- Desde renderer `1.3.0`, cabecera y pie globales se renderizan en cada página.
  Un formulario global se firma como `scope=global` y aporta
  `page_contracts[page_id]`; `alpha.7` exige cobertura de cada ruta firmada y
  campos equivalentes antes de aceptar el release. No reduce el aislamiento
  por página ni permite que el navegador elija scope o contrato.
- No incluye updater binario propio. Actualizar el plugin y actualizar el
  contenido siguen siendo operaciones distintas.

## Instalación/configuración

El ZIP provisionado debe contener la carpeta `clinicaclick-web/` y mantener
`clinicaclick-web/clinicaclick.php`. Ya lleva la instalación, el token y el ancla
pública, además de un challenge de control del sitio independiente: se instala
y activa sin copiar códigos ni abrir la configuración avanzada. La activación
registra la ruta temporal de claim y envía un reporte autenticado, pero el
heartbeat por sí solo **no** convierte la instalación `pending` en `connected`.
Antes de promoverla, el backend debe recuperar por HTTPS la prueba temporal del
propio dominio y verificar que coincide con el challenge provisionado. Solo
después del claim y su ACK se permite leer el estado deseado o activar una
publicación para ese WordPress.

El ZIP genérico solo se usa en desarrollo o recuperación manual. Tras
activarlo:

1. abre `Ajustes > ClinicaClick Web`;
2. indica `installation_id`, token opaco y `API base` HTTPS;
3. pega el descriptor **público** Ed25519 entregado por un canal autenticado;
4. si es un alta `pending`, define fuera de Git el challenge de claim emitido
   para esa instalación; una recuperación ya reclamada no debe inventar otro;
5. pulsa `Sincronizar ahora`.

En instalaciones gestionadas se recomiendan constantes fuera de Git:

```php
define('CLINICACLICK_WEB_INSTALLATION_ID', 'uuid');
define('CLINICACLICK_WEB_TOKEN', 'token-opaco');
define('CLINICACLICK_WEB_API_BASE', 'https://crm.clinicaclick.com');
define('CLINICACLICK_WEB_TRUST_DESCRIPTOR_JSON', '{...descriptor publico...}');
// Solo durante un alta/reclaim manual; secreto independiente del token/HMAC.
define('CLINICACLICK_WEB_SITE_CLAIM_TOKEN', 'challenge-base64url-de-32-bytes');
// Obligatorio fuera del document root en toda instalación gestionada.
define('CLINICACLICK_WEB_CACHE_DIR', '/ruta/privada/clinicaclick-web-cache');
```

En toda instalación gestionada o provisionada, el plugin falla cerrado si la
caché efectiva queda bajo el `document root`, incluso si se definió la
constante: no sincroniza, no
sirve landings ni activa el runtime y muestra el diagnóstico
`ccw_managed_cache_directory_public` en Ajustes y Salud del sitio. La regla se
aplica también bajo WP-CLI, donde no siempre existe `SERVER_SOFTWARE`; las
defensas de Apache/IIS no sustituyen el almacenamiento privado portable. El
plugin no mueve ni copia una caché existente automáticamente; el operador debe
definir primero la constante fuera del árbol público, sincronizar, bloquear o
retirar manualmente la antigua caché pública y comprobar que una petición HTTP
directa a sus `active.json`/`routes.json` devuelve `404` antes de promover el
runtime.

Para una recuperación o migración ya publicada, el backend puede añadir al ZIP
provisionado `clinicaclick-web/config/installation.php`, siguiendo
`config/installation.php.example`. El fichero empieza por `exit` y
`__halt_compiler`; el plugin lee el JSON posterior como datos y **nunca ejecuta
el fichero**. Incluye identidad, token, challenge de claim, descriptor público
y, cuando corresponde, un runtime de medición firmado de bootstrap. No se añade
al ZIP genérico ni se versiona con valores reales.

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
  "site_claim_token": "<challenge base64url de 32 bytes mostrado una sola vez>",
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
clinicaclick-web/includes/class-ccw-site-claim.php
clinicaclick-web/includes/class-ccw-sync.php
clinicaclick-web/includes/class-ccw-trust-store.php
clinicaclick-web/config/installation.php
```

La allowlist fuente actual de `alpha.8` contiene 17 ficheros en el ZIP genérico
y 18 en el provisionado; el único fichero adicional es
`config/installation.php`. Estos recuentos se han contrastado con los 13
includes presentes y con ambos builders actuales. Fixtures, tests, tools,
claves privadas y `.env` nunca entran en el paquete. El provisionado histórico
de `alpha.7` tenía 17 ficheros porque todavía no incluía
`class-ccw-site-claim.php`; ese recuento histórico no describe el corte vigente
`alpha.8`.

Evidencia del paquete final instalado: el ZIP genérico de 17 entradas tiene
SHA-256
`126e0fb6f77ad08e1c2ed53b673ed094dd25de8ebd99e28d0f167e8439409bc7`.
El provisionado final de 18 entradas tiene SHA-256
`86792a2ebf69cd9c36f529f98b1528e2ed5b08c9fe5d33216ea33b348695479f`.

Variables del backend/control plane necesarias fuera de Git:

- `MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM` (secreto Ed25519) y
  `MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM` (su pública correspondiente);
- solo durante una rotación online, `MARKETING_WEB_SIGNING_ROTATION_FROM_KEY_ID`
  declara de forma explícita el `key_id` anterior y
  `MARKETING_WEB_SIGNING_PREVIOUS_PRIVATE_KEY_PEM` conserva temporalmente su
  privada. No se admite una instalación con otra ancla ni una transición hacia
  una clave registrada como retirada;
- `MARKETING_WEB_ARTIFACT_STORE_MODE=authenticated_db|s3`; si no se declara,
  usa S3 únicamente cuando bucket y base URL están configurados y, en caso
  contrario, `authenticated_db`;
- con `s3`: `MARKETING_WEB_ARTIFACT_BUCKET`,
  `MARKETING_WEB_ARTIFACT_BASE_URL`, `MARKETING_WEB_ARTIFACT_REGION` y
  `MARKETING_WEB_ARTIFACT_PREFIX`, más credenciales mediante role de instancia
  recomendado o secretos AWS;
- `MARKETING_WEB_API_BASE_URL=https://crm.clinicaclick.com` (config pública);
- `MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY` (32 bytes, hex o base64url) cifra los
  tickets de bootstrap y actúa como IKM para una subclave HKDF exclusiva de
  reconciliaciones; opcionalmente `MARKETING_WEB_RUNTIME_ENVELOPE_KEY` (32
  bytes) y `MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID` separan también el material
  raíz de esos envelopes AES-256-GCM;
- `MARKETING_WEB_EDITOR_ENABLED` y `MARKETING_WEB_PUBLISHING_ENABLED` solo al
  abrir su gate operativo;
- `MARKETING_WEB_ENABLED_SCOPES` limita el editor y
  `MARKETING_WEB_PUBLISHING_SCOPES` limita de forma independiente la
  publicación. En el piloto staging, publicación solo incluye `group:5`.

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

Una instalación nueva queda `pending` sin reservar globalmente `site_url`.
El mismo ZIP contiene además un challenge independiente de 256 bits; el
backend persiste solo su SHA-256 y caducidad. Mientras no exista ACK, el plugin
expone temporalmente
`GET /.well-known/clinicaclick-wordpress-claim` con `installation_id`, el
digest del challenge y el `home_url` canónico, nunca el valor raw. Antes de
promover a `connected`, el backend hace ese GET por HTTPS/443 con DNS público
revalidado, socket fijado a las IP validadas, redirects/proxy/descompresión
bloqueados y límites estrictos. La promoción y el `claimed_site_hash` único se
escriben bajo transacción; el perdedor de una carrera recibe 409. El ACK del
reporte oculta el endpoint. `revoked` libera el claim, pero cualquier nueva
instalación debe publicar su propio challenge. `pending` tampoco puede leer
desired-state ni artefactos.

La clave privada nunca entra en WordPress. El primer descriptor se ancla por
configuración local. Una nueva clave solo se admite si su descriptor viene
firmado por una clave ya confiada. `key_id` es
`ed25519-` + los 16 primeros hexadecimales de SHA-256 del SPKI DER, igual que
`webArtifactSignature.js`.

La rotación online es una transición de confianza en dos fases. Mientras la
instalación conserva la clave anterior, desired-state entrega el descriptor
actual firmado por la privada anterior, pero firma runtime/registro y los
envelopes `authenticated_db` con la clave actual. WordPress guarda la nueva
clave como pendiente, aplica y verifica el estado completo, y solo entonces la
promueve localmente y emite `sync_result` con `signing_key_id` y
`configuration_sequence`. El backend vuelve a comprobar bajo lock token, sitio,
schema 2, secuencia y conjunto exacto de rutas/artefactos antes de cambiar
`public_key_id`. Una ruta `pending`, `manual_hold`, parcial o fallida no promueve
la clave. El historial de claves retiradas impide reactivar una clave anterior;
las copias públicas pueden conservarse únicamente para verificar artefactos
inmutables históricos. Cada runtime, registro y manifest descargado queda
ligado además al `key_id` del descriptor aceptado en esa misma respuesta: una
clave retirada no puede firmar estado nuevo aunque siga presente en el almacén
para inspeccionar historia local.

El token se guarda como opción `autoload=false`, no se refleja en el formulario
y solo se envía a los endpoints de control y artefactos cuyo origen HTTPS
coincide exactamente con el `API base`. Nunca se envía al CDN/S3 externo ni se
incluye en logs/reportes.

La rotación de una instalación conectada es staged: el ZIP nuevo lleva un
token candidato con caducidad por defecto de 24 horas, mientras el token activo
continúa autorizando el servicio. Solo un reporte schema 2 válido de
`alpha.8` promueve el candidato bajo lock; desde ese instante el token anterior
falla. Reemitir otro candidato invalida el staged previo. En una instalación
todavía `pending`, reemitir reemplaza el token primario inmediatamente porque
no existe tráfico que preservar. Revocar elimina ambos slots.

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
7. En schema 2 valida el registro completo antes de descargar: máximo 20 rutas,
   400 ficheros únicos, 500 peticiones de descarga en total y 768 KiB para la
   respuesta de control emitida por backend. Los releases inmutables se
   comparten por hash;
   la versión actual puede repetir descarga y verificación cuando varias rutas
   apuntan al mismo artefacto, antes de conmutar cada puntero bajo lock.
8. Renombra staging a un release inmutable y conmuta el puntero mediante
   `rename` atómico.
9. Conserva release, manifest y runtime anterior como `last_known_good` y
   reporta secuencia, ruta y hash. Un reporte perdido se reintenta sin volver a
   promover; un `routes.json` ausente/corrupto se reconstruye de forma cerrada.

Si la API o el CDN fallan, `active.json` no cambia. La landing activa continúa
sirviéndose. `Rollback local` intercambia activo/LKG y activa `manual_hold` para
que un cron no deshaga la recuperación; `Reanudar y sincronizar` vuelve a
aplicar el estado firmado. Un estado `retired` responde 410 pero conserva los
ficheros para recuperación/retención.
`POST /api/marketing/web-publications/{id}/retire` marca el tombstone bajo
autorización y locks; solo el ACK estable de WordPress libera su slot, nunca su
ruta histórica.

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
inmutable para assets. En cualquier runtime gestionado,
`CLINICACLICK_WEB_CACHE_DIR` debe estar fuera del document root porque
`active.json` y `routes.json` incluyen el runtime server-side; el arranque
operativo falla cerrado si detecta el default público, incluso desde CLI. Los
artefactos son públicos, pero el acceso directo a la caché podría omitir
headers; el plugin escribe defensas adicionales para Apache e IIS sin tratarlas
como frontera principal.

## Compatibilidad con la medición 1.1.7

Si `clinicaclick/clinicaclick.php` continúa activo, v2 retira únicamente el
callback global de loader registrado por el legado durante ese request. No
desactiva, sobrescribe ni borra el plugin anterior y no interfiere con su ruta
específica `/cita/`. Así la home no recibe dos loaders/bootstrap. Si el legado
se desactiva, v2 vuelve a ser propietario del loader global en el siguiente
request.

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
- cinco identidades ocultas en renderers nuevos: `web_project_id`,
  `web_revision_id`, `web_page_id`, `web_form_id` y
  `web_artifact_input_hash`. En un artefacto legacy `1.2.1`, `alpha.7` obtiene
  esta última identidad del manifest firmado y la añade server-side; si el
  navegador aporta una distinta, el POST se rechaza.

Debe existir `email` o `phone`. Límites: body 16 KiB, nombre/apellidos 100
caracteres, email 254, mensaje 2.000 y teléfono normalizado a 7-15 dígitos. El
manifest firmado contiene `intake_forms[form_id]`. Un formulario local lleva
`page_path`, `page_id`, `success_anchor=cc-<formId>-success` y
`error_anchor=cc-<formId>-error`; uno global lleva `scope=global` y un
`page_contracts[page_id]` equivalente por cada página firmada que lo muestra.
El inspector selecciona primero el contrato de la ruta actual y contrasta el
form nativo, sus identidades ocultas, campos y anclas. El plugin compara las
cinco identidades y el path del `Referer` HTTPS same-origin con el manifest;
nunca confía en scope, API, page URL, formulario global o redirect recibidos
del visitante.

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
X-Clinicaclick-Plugin-Version: 2.0.0-alpha.8
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
X-Clinicaclick-Plugin-Version: 2.0.0-alpha.8
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

El límite efectivo de cualquier bundle publicable es 8 MiB, incluyendo el
manifest canónico y los cuerpos declarados; se comprueba antes de publicar y de
servir desde `authenticated_db`. Para no materializar columnas grandes en cada
petición, la autorización consulta primero solo metadatos y la carga completa
usa singleflight con un máximo de cuatro lecturas concurrentes. La caché de
proceso es LRU, dura como máximo dos minutos y queda acotada a 64 entradas,
8 MiB por entrada y 32 MiB en total. No es una caché HTTP: manifest, envelope y
ficheros autenticados siguen respondiendo como contenido privado y no exponen
las columnas completas `WebArtifact.files` ni `WebArtifact.qaReport` en las
proyecciones públicas de metadatos.

### Estado deseado

```http
GET /api/marketing/web-installations/{installation_id}/desired-state
If-None-Match: "desired-version"
```

Respuestas: `200`, `304`, `401/403`, `404`, `409` o `503`. Un `200` sigue
`fixtures/desired-state.published.json` o `desired-state.retired.json`.
Aunque admita ETag/304, el backend responde `private, no-store, max-age=0` y
`Pragma: no-cache`: el registro deseado, bearer y runtime nunca se almacenan en
cachés intermedias o compartidas.

En schema 1, conservado para el piloto `alpha.7`, los campos obligatorios son:

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

En schema 2, usado por `alpha.8`, la raíz declara `schema_version=2` y
`desired_state.status=multi`. El estado incluye el descriptor y su envelope,
un `registry_configuration` firmado y un mapa `artifacts` indexado por hash.
El registro liga instalación, medición, secuencia monótona y como máximo 20
rutas con prefijos canónicos `/cita/` o `/cita/<slug>/`; cada ruta activa apunta
a un hash presente exactamente una vez en `artifacts`. El backend rechaza antes
de responder si se superan en conjunto 400 ficheros únicos, 500 descargas o
768 KiB de control. Los reportes schema 2 deben devolver la misma secuencia y
el conjunto exacto de rutas para poder promover token o clave.

### Reportes/heartbeat

```http
POST /api/marketing/web-installations/{installation_id}/reports
Content-Type: application/json
```

Eventos: `sync_result`, `sync_failed`, `heartbeat`, `local_rollback`. El payload
incluye versiones, hash del sitio, artefactos activo/deseado, duración,
`request_id`, resultado y un código de error estable. Un `sync_result` correcto
incluye además `signing_key_id` y `configuration_sequence`; en schema 2 esta
última debe coincidir exactamente con `registry_sequence`. No incluye token, body de
respuesta, rutas locales, contenido, datos de pacientes ni el HMAC server-side.
El endpoint responde `200`, `202` o `204`; cuando el claim ya quedó promovido,
añade `site_claim_acknowledged=true` para que WordPress deje de exponer la
prueba temporal. Un fallo de reporte nunca desmonta la última publicación
válida.

## Runbook genérico

1. Verificar PHP/Sodium: `php -m | grep sodium`.
2. Construir y auditar ZIP: `./tools/build-zip.sh`.
3. Desde la raíz del backend, ejecutar `npm run test:marketing-web`; ese runner
   lanza los contratos Node y después `./wordpress/clinicaclick-web/tests/run.sh`.
   El harness PHP genera además un ZIP provisionado real que se extrae, carga y
   activa desde sus propios ficheros empaquetados. El corte actual acredita
   **320/320** contratos Node, **40/40** PHP y **3/3** pruebas de
   interoperabilidad/compilador/paquete provisionado.
4. En un WordPress desechable, definir una caché privada fuera del document
   root, instalar el ZIP provisionado y activar el plugin.
5. Antes de aceptar el alta, comprobar que el endpoint temporal de claim expone
   solo el digest esperado. Enviar el reporte y exigir que la prueba HTTPS del
   backend promueva a `connected`; un heartbeat sin esa prueba debe conservar
   `pending`. Confirmar después que el ACK oculta el endpoint.
6. Sincronizar y comprobar HTML, asset, ETag/304, HEAD, 404 y 410.
7. Cortar API/CDN y confirmar que `/cita/` sigue respondiendo.
8. Probar firma, clave, hash y path malos: el hash activo no debe cambiar.
9. Publicar una revisión nueva y comprobar activo/LKG y rollback.
10. Confirmar que el sitio solo tiene el loader de Clinicaclick esperado y que
    el CMP/otros plugins no han cambiado.
11. Enviar un formulario válido y comprobar 303/lead; repetir con Origin,
    Referer, IDs manipulados, firma server-side inválida, campo extra,
    duplicado, honeypot, 202 y rate-limit adversariales.

La validación histórica del corte `alpha.7` quedó cerrada con **34/34**
contratos PHP y **3/3** de interoperabilidad. En Propdental ese corte acredita
instalación, cron, handshake y loader único; el artefacto estable `1.2.1`
conserva publicación/readback, relay atribuible con limpieza, rollback y
monitor de `/cita/` ya probados antes del upgrade. No se debe reinterpretar esa
evidencia histórica como despliegue de `alpha.8`.

### Rollout controlado a `alpha.8` en Propdental

1. Las siete migraciones `20260718230000`, `20260718233000`,
   `20260719090000`, `20260719091500`, `20260719093000`, `20260719094500` y
   `20260719100000` están aplicadas en staging.
2. WP-CLI y la fila de instalación reportan `2.0.0-alpha.8`; la instalación
   sigue `connected` y el plugin de medición legado continúa activo sin un
   segundo loader.
3. El handshake schema 2 confirmó el claim del origen, promocionó el token
   staged y dejó desired/reported en secuencia de registro 8 antes de iniciar
   el E2E de dos rutas. El endpoint temporal de claim quedó oculto tras el ACK.
4. La caché gestionada está fuera del document root. Sus rutas privadas y las
   antiguas rutas públicas de caché responden `404`.
5. El upgrade binario no cambió inicialmente el body ni el artefacto servido
   por `/cita/`; el E2E multi-route se cerró todavía sobre ese LKG.
6. El E2E público multi-route quedó cerrado sobre el proyecto desechable
   `f758cce8…` y la publicación `69f06cf0…`: A
   `e2de500c…`/artefacto `831177bc…`, B
   `4c1f3005…`/artefacto `0b9a41a2…` y rollback A verificados. El formulario
   devolvió `303` y creó `LeadIntake #7269`, `FormSubmissionEvent #24` y
   `WebEvent #38157` con atribución exacta a clínica `59`/grupo `5` y sin click
   IDs ni intentos Ads.
7. Cleanup `dry-run -> simulate -> apply` dejó cero en 11 categorías. El
   proyecto quedó archivado, la publicación/ruta retirada y el tombstone en
   desired=reported sequence `12`. La ruta respondió `410` mientras el
   tombstone estuvo activo; después de liberarlo, el readback live final
   devuelve `404` y solo queda activa la ruta piloto. `/cita/` conservó el body
   SHA `f3ddf142…` y su artefacto.
8. La rotación HMAC terminó mediante reconciliación
   `889cc3a4-7d09-4cb0-accb-65acbdbfbb61`, generación 1, `completed`.
   `JobRequest #32179` finalizó el `2026-07-19T07:24:30Z`, con dos intentos y
   sin error. Target y source se aceptaron durante la gracia; después se
   eliminaron ambos envelopes, quedó `accepted_key_count=1`, se restauró
   `86400000` ms y staging continuó online.
9. Los fixes que preservan el source durante la rotación son
   `aacd01b`/staging `4769283` (plainification de publicación bloqueada) y
   `29e0179`/staging `93c45f4` (contrato de medición WordPress).
10. El router elimina el magic-quotes aplicado por WordPress a
    `HTTP_IF_NONE_MATCH`. El fix `5d11cf8`/staging `e562936` está live;
    Cloudflare y origen devuelven `304` con `If-None-Match` exacto.
11. Después se recompiló deliberadamente el mismo proyecto/revisión piloto a
    renderer `1.5.0` y finalmente a `1.6.0`. El cierre `1.6` tiene los hashes
    completos del apartado anterior y verificó el ciclo `1.6 -> 1.5 -> 1.6`
    mediante secuencias `8`, `9` y `10`.
12. Chromium real a `390px` acreditó `scrollWidth=390`; solo el honeypot queda
    fuera de pantalla. **Aceptar todo** ocupa todo el ancho, el aviso desaparece
    al aceptar, `cc_consent_v2` persiste y el formulario conserva 11 campos, sin
    excepciones ni fallos de red.

El renderer `1.6.0` cerró la incoherencia semántica de email/contacto y añadió
la metadata Social/Schema comprobada en el readback. Cualquier cambio editorial
posterior sigue requiriendo una revisión nueva y aprobada; nunca se reescribe
silenciosamente un artefacto congelado.

La comprobación **Guardar** de Consent fue solo de harness: un diagnóstico
saneado probó que el handler persistía el estado, retiraba el banner,
inicializaba el runtime y no generaba `pageerror`. No sustituye una prueba
pública.

### Rotación online Ed25519

1. Desplegar primero el plugin/backend que entiende ACK de clave sin cambiar la
   pareja vigente. Confirmar que todas las instalaciones objetivo reportan
   schema 2/`alpha.8` y que no hay rutas pendientes ni `manual_hold`.
2. Generar la nueva pareja fuera de Git. Conservar la pareja actual como
   anterior, configurar `MARKETING_WEB_SIGNING_ROTATION_FROM_KEY_ID` con su
   `key_id` y `MARKETING_WEB_SIGNING_PREVIOUS_PRIVATE_KEY_PEM` con su privada;
   configurar la pareja nueva en las dos variables vigentes. Nunca intercambiar
   los sentidos de la transición.
3. Reiniciar de forma escalonada y comprobar dos instalaciones: una ya actual
   recibe envelope de descriptor vacío; una anterior recibe descriptor nuevo
   firmado por `ROTATION_FROM_KEY_ID`, y runtime/registro firmados por la nueva.
4. Esperar los `sync_result` aceptados. Solo cuentan instalaciones cuyo
   `public_key_id` ya coincide con la clave nueva; heartbeats, schema 1, reportes
   parciales o secuencias antiguas no cuentan.
5. Cuando no quede ninguna instalación activa con la clave anterior, retirar
   inmediatamente las dos variables temporales y destruir la privada anterior
   según la política de secretos. Los ZIP nuevos siempre contienen el descriptor
   público vigente, incluso durante la ventana de ACK.

Si la privada anterior se pierde o se sospecha comprometida, no se fabrica una
cross-signature ni se activa un fallback remoto. Se congela publicación, se rota
el token, se instala por canal autenticado un ZIP con el descriptor actual y un
administrador reancla ese descriptor **localmente** (en instalaciones no
gestionadas, mediante el formulario; en gestionadas, con una intervención
WP-CLI auditada que invoque `CCW_Trust_Store::import_configured_descriptor()`
con el descriptor público provisionado). Después un operador debe reconciliar
de forma explícita y auditada `public_key_id` en el control plane antes de
reanudar desired-state. Es un procedimiento de incidente por instalación, no un
env global ni un self-bootstrap automático.

### Actualización segura a `alpha.7`

`alpha.7` debe llegar al WordPress **antes** que cualquier artefacto renderer
`1.3.0` que use un formulario global:

1. ejecutar `./tests/run.sh` y auditar el ZIP provisionado `alpha.7`;
2. guardar un rollback real de `alpha.6`, incluido
   `clinicaclick-web/config/installation.php`, y conservar configuración,
   descriptor de confianza, runtime y caché/LKG; no instalar un ZIP genérico
   sobre una instalación gestionada;
3. instalar el ZIP provisionado `alpha.7` sin perder la identidad de la
   instalación;
4. ejecutar `CCW_Plugin::activate(false)` como el usuario propietario del sitio
   `propdental.es`, no como `root`, para emitir heartbeat inmediato; el ciclo
   ordinario puede dejar la versión en DB atrasada hasta 24 horas;
5. exigir que backend mantenga `connected` y que la DB reporte exactamente
   `2.0.0-alpha.7`; sincronizar sin cambiar todavía el artefacto activo;
6. comprobar `/cita/`, loader único y que el rollback real `alpha.6` conserva
   su `config/installation.php`;
7. solo entonces publicar una revisión `1.3.0` con formulario global y validar **cada**
   permalink, `data-cc-global`, formulario por página, atribución y rollback.

Los pasos 1-6 se completaron en Propdental el 2026-07-18. WP-CLI y DB reportan
`2.0.0-alpha.7`, la instalación continúa `connected` y `/cita/` responde `200`
sin cambiar el artefacto activo. El paso 7 sigue pendiente hasta disponer de
una revisión aprobada que deba publicarse; no se crea contenido sintético solo
para cerrar la comprobación. Si otra instalación sigue reportando `alpha.5` o
`alpha.6`, la publicación con formulario global se pospone. No se
fuerza ese manifest sobre el plugin anterior y no se usa esta actualización
para abrir multi-route, hosted o custom domain.

El mínimo no bloquea ni altera publicaciones legacy ni una revisión que solo
use cabecera/pie globales. El rollout operativo sigue promoviendo `alpha.7`
antes de estrenar cualquier artefacto `1.3.0` para mantener una única tanda
reversible, pero la barrera fail-closed se limita al formulario global. El
backend expresa el bloqueo como `409 web_wordpress_global_intake_plugin_outdated`
con versiones actual/requerida y no encola una publicación parcial.

### Evidencia del piloto Propdental

- ZIP provisionado instalado con slug `clinicaclick-web` y versión
  `2.0.0-alpha.7`;
- WP-CLI y la instalación
  `524c2f73-6b69-42f2-8cb0-c8d171575d94` reportan
  `2.0.0-alpha.7`; backend conserva `connected` y
  `last_seen=2026-07-18T15:09:14Z`;
- ZIP genérico fuente SHA-256
  `427ceab2fc97f58ad99912bb26fa5c1d1adafbe3a21f3cdb4a4fae15f6d36930`;
  el ZIP provisionado root-only tiene SHA-256
  `e03629fade0abbd2c3757ad707507efa64b467ca5477efcf4fdc41b83390a391`;
- rollback operativo real `alpha.6` en
  `/furanet/sites/propdental.es/web/.clinicaclick-web-rollbacks/clinicaclick-web-alpha6-20260718T150905Z`,
  con `config/installation.php`; el provisionado de 17 ficheros se conserva
  root-only fuera del docroot en
  `/furanet/sites/propdental.es/web/.clinicaclick-web-rollbacks/clinicaclick-web-alpha7-20260718T150905Z-provisioned.zip`;
- PHP lint verde y `ccw_sync_event` programado cada 15 minutos;
- plugin legado `clinicaclick` `1.1.7` permanece activo;
- home y landing pública: exactamente un `/assets/loader.js`; el legado no se
  desactiva y el publicador no duplica el bootstrap;
- instalación conectada sobre la URL canónica
  `https://www.propdental.es`; runtime y heartbeat están alineados en
  `2.0.0-alpha.7`;
- proyecto `edd77d09-6ac5-4944-98e3-084d5285594c`, revisión
  `ead78c6d-f28f-478d-9058-bc189c846421` y publicación
  `5d55b1ef-c6fa-4e73-8aa8-2fd9ff41a526`;
- renderer `clinicaclick-web-renderer/1.2.1` y artefacto activo/LKG
  `a43e7c4a-9ef3-4aef-aad3-70f12f927c31` (hash público `be4d5f3c…`);
- `https://www.propdental.es/cita/` responde 200 con marker, formulario nativo
  firmado e indexación; Chromium desktop/móvil confirmó cero bloqueos CSP,
  consentimiento/chat con estilos, un loader y ningún HMAC/token en HTML/JS;
- lead E2E ejecutado dos veces; el final `#7261` quedó atribuido a clínica
  `59`/grupo `5`, con consentimiento, `FormSubmissionEvent` y
  `LeadAttributionAudit`, sin click IDs ni conversiones externas, y después fue
  eliminado por simulación + cleanup con marker final `0`;
- revisión temporal 3 `c01c20ec…` publicada por deployment `9c53ec42…`
  (secuencia 5, job `31698`, artefacto `545c1672…`) y rollback verificado por
  `48df4e4e…` (secuencia 6, job `31699`) a revisión 2/LKG `a43e7c4a…`;
- la reprovisión temporal dejó el fallo explícito `583dc38f…` (secuencia 3) y
  la recuperación limpia `a944709d…` (secuencia 4, job `31696`);
- el E2E posterior de `alpha.6` confirmó
  `source_detail=clinicaclick_web_publication`, eliminó leads/eventos/filas
  WhatsApp sintéticos y dejó cero intentos Google;
- el monitor controlado comprobó una publicación y terminó `1 healthy`,
  `0 degraded` a `2026-07-18T13:01:04.689Z`;
- el paquete de evidencia está fuera de Git y no se documentan token, ticket,
  HMAC ni claves privadas.

Al ejecutar `ccw_sync_event` manualmente se debe usar el usuario del sitio
WordPress, no `root`; el piloto corrigió ownership de la caché después de una
ejecución administrativa. El cron normal de WordPress conserva el usuario
correcto.

El primer handshake puede canonicalizar `apex <-> www` únicamente si la
instalación está verdaderamente virgen: `pending`, sin `last_seen`, versión ni
publicaciones. Después la identidad vuelve a ser estricta; no es una regla de
equivalencia general entre hosts.

Durante una diagnosis privada se imprimió accidentalmente el HMAC de intake.
La rotación posterior quedó cerrada por el reconciliador two-phase: target
aceptado, source aceptado durante la gracia, finalizer completado, envelopes
retirados y una única clave aceptada. La revisión del HTML/JS público tampoco
encontró el secreto. No imprimir nunca el runtime completo como técnica de
diagnóstico ni copiar el valor a esta documentación, commits o logs.

Un paquete genérico sobrescribió temporalmente la configuración del piloto en
una recuperación histórica. Se
rotó el token, se reprovisionó el ZIP `alpha.5` y el handshake volvió a quedar
`connected`; no se conservó ni documentó el token sustituido. El defecto CSP
detectado durante esta recuperación se corrigió elevando el renderer a `1.2.1`
y limitando las allowances del validador a las emitidas por ese renderer. Ese
fue el paso de recuperación histórico; después se actualizó de forma
incremental a `alpha.6` y finalmente al provisionado `alpha.7`. `alpha.6` es el
rollback operativo actual; `alpha.5` queda como recuperación histórica.

## Desinstalación

Desactivar elimina el evento WP-Cron y refresca rewrites, pero mantiene caché y
configuración. Desinstalar también conserva todo por defecto. El borrado solo
se ejecuta con `CLINICACLICK_WEB_PURGE_ON_UNINSTALL === true` o la opción
explícita `ccw_purge_on_uninstall=true`.

## Desarrollo y paquete determinista

```bash
./tests/run.sh
./tools/build-zip.sh
sha256sum dist/clinicaclick-web-2.0.0-alpha.8.zip
```

El builder copia una allowlist, ordena entradas, fija un timestamp DOS y
escribe un ZIP `store` sin metadatos variables; dos ejecuciones sobre la misma
fuente producen el mismo SHA-256.
