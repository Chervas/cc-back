# OAuth Meta: candidato de autorización nuevo

Preparación del 19/09/2026, sobre backend `3a0254e3` y frontend `5f168eb4`.
No desplegada. Contrato canónico primero en
[13-backend](../../src/Documentacion/13-backend.md#oauth-meta-candidato-nuevo-dentro-del-broker-preparado-19092026).

El callback legacy sigue intercambiando y guardando tokens en MySQL. Este corte
prepara el sustituto dentro del broker, pero aún no monta el callback ni activa
el producto. No reutiliza los tokens investigados ni conecta Meta real como QA.

## Flujo y límites

Runtime dedicado `meta-marketing-oauth-v1`; cuatro operaciones
`meta.marketing.oauth.{begin,finish,status,abort}.v1`. Solo claves independientes
`gateway:{dev|staging}:meta-marketing-oauth` y
`control:{dev|staging}:meta-marketing-oauth`; control limitado a status/abort.
Ed25519, TLS con CA, replay/nonce del broker y payload cerrado. Principal20/min;
dos peticiones ordinarias y una admisión de control, operación25 s y HTTP8 s.

Configuración privada estricta: entorno, policy, bind IP/puerto, SQLite, TLS y
renovación opcional. Máximo64 slots, uno por ámbito; cada slot separa secreto de
app y candidato, pins inmutables y lista completa/ordenada de clínicas. Callback
HTTPS exacto `/oauth/meta/marketing/callback`. La aplicación se preconfigura en
vault; no se solicitan ARN, host, permisos o credenciales al navegador.

Begin preflight de slot vacío, KMS, pins y capacidad; captura digest del ámbito,
state hash, UUID y vencimiento≤10 min. Máximo6 intentos/hora por conexión. Finish
intercambia code→token corto→token largo e inspecciona app/USER/scopes/expiraciones
y granular scopes. Sin consultas de perfil/nombre/email, campañas, mensajes o leads.
Permisos cerrados a los del lector Meta; no acepta permisos WhatsApp, escritura ni
scopes extra. No inventa caducidad de60 días si Meta no la aporta.

Guarda `meta-marketing-oauth-candidate` en la versión Secrets identificada por la
UUID, AWSPENDING; AWSCURRENT conserva `meta-marketing-oauth-slot` sin credencial.
La capacidad se vuelve a comprobar antes del canje y del Put; menos90 versiones,
sin paginar un conjunto desconocido. Candidato≤65536 bytes, sin truncar permisos.
No CreateSecret/UpdateSecretVersionStage/DeleteSecret, grants ni lectura de negocio.
Metadata de respuesta siempre `accessBlocked=true`. Solo autoridad futura de
activación podrá dar acceso tras verificar ACL, sesión, activos e historial.

SQLite guarda hashes del state/code y del candidato, metadata y estados; nunca
code, state literal, token o app secret. Auditoría técnica v2: solicitud y
confirmación atómicas con las transiciones. Un error devuelve código cerrado.
Se borran buffers propios/copiados; JavaScript/SDK aún pueden conservar strings
en heap hasta GC, por lo que no se afirma zeroización completa de memoria.

## Incertidumbre y recuperación

- ACK de Put perdido: consultar la misma versión/digest; no repetir code ni Put.
- Fallo al escribir auditoría final: permanece staging, sin declarar éxito.
- Candidato inexistente tras fallo: permanece incierto; abort y autorización nueva.
- Reinicio durante intercambio: mantiene exchanging incierto y prohíbe reenviar
  code; abort explícito. No modifica estados de otros propietarios al arrancar.
- Abort previo a begin deja tombstone. Durante I/O cancela el proceso y evita
  confirmación tardía. Un Put remoto puede dejar candidato inactivo tras abort;
  conservarlo, sin promoción ni borrado automático.
- Cambios de versión/KMS/identidad/conjunto de clínicas o bloqueo durante I/O:
  rechazo. No reparar cambiando el hash ni borrando diarios/bloqueos.
- Una sola instancia posee SQLite. Los límites no reservan CPU/SQL ni detienen una
  dependencia que ignore AbortSignal. Desactivar altas preservando cancelación y
  resolución de candidatos; conservar archivo SQLite y versiones Secrets.

## Validación y recursos

Node24, desde `services/integrations-broker`:

```sh
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/meta-marketing-oauth.test.js test/meta-marketing-oauth-http.test.js test/meta-marketing-oauth-runtime.test.js
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/*.test.js
```

42 pruebas específicas: recorrido de identidad nueva, HTTP real del adaptador con
transporte simulado, TLS/firmas/SQLite reales, reinicio real del servidor, pérdida
de ACK, fallo de auditoría, scope/grants/expiry, KMS/versiones, capacidad, buffers,
cancelación, errores y aislamiento de claves/entorno/proveedor. Red exterior cerrada;
Meta, Secrets y S3 son ficticios. No hay nueva pantalla ni aceptación visual de
OAuth; las siete capturas de la retirada anterior no validan esta alta.

Muestra aislada: begin4 llamadas Secrets, finish28 (15 Describe,10 Get,2 List,1 Put)
y3 Meta (code, extensión, inspección). Status confirmado y abort: cero Secrets/Meta.
Dos eventos técnicos para alta preparada; abort añade uno, más fallos cuando ocurran.
Duraciones exactas/resultados de suite completa en99/evidencia privada; no extrapolar
a AWS. Coste incremental facturado `null`; no se ha consultado Cost Explorer ni
creado/contratado infraestructura. La operación no transporta archivos clínicos.

Evidencia: `qa-evidence/security-resume-20260917/meta-oauth-20260919/`.
El primer ensayo26/27 detectó que capacidad se revisaba demasiado tarde si cambiaba
entre begin y finish; corregido antes de aceptar42/42. Conservar ambos logs.

## Requisitos pendientes para publicación

1. Inicio/callback CRM: sesión gestionada/MFA y permisos del conjunto completo,
   revalidación antes y después de I/O, estado humano durable/auditado y UI real.
2. Selección/discovery y escritor transaccional de bindings/grants; validar
   identidad/propiedad/alias/primarias/shares y toda baja física previa. Una UUID o
   conexión nuevas no permiten borrar historial ni restaurar acceso retirado.
3. Activación independiente, idempotente y recuperable, con aceptación por el titular
   y proveedor; lectores preparados no pueden consumir el envelope candidato.
4. IAM/TLS/slots y servicio de entorno propios, publicación selectiva, lectura
   AWS y verificación de recibos y carga. Autenticación AWS caducada, sin challenge
   nuevo abierto en este corte. No promover toda DEV ni modificar canary v19.
5. Retirar el callback/credenciales legacy solo con consumidores completos y corte
   aceptado. Mantener MFA, pausas, WhatsApp y DEV clínico apagado.

La documentación Meta oficial consultada devolvió429. El patrón de intercambio
está contrastado con el
[SDK oficial archivado de Facebook](https://github.com/facebookarchive/php-graph-sdk/blob/5.x/src/Facebook/Authentication/OAuth2Client.php),
fuente histórica; no acredita la disponibilidad ni permisos vigentes. Revalidar
[flujo manual](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/),
[tokens largos](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/)
y [debug_token](https://developers.facebook.com/docs/graph-api/reference/debug_token/)
antes de aceptar una cohorte real. Copias/restauración permanecen al final.
