# Credenciales de IA en AWS: corte y diagnóstico por consumidor

> **Tipo:** runbook y contrato técnico del transporte.
> **Fuente de verdad:** operaciones de OpenAI, Gemini y Groq en el broker y su migración; no acredita activación.
> **Última revisión:** 2026-09-18.
> **Estado:** [19](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones). Prioridades: [16](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/16-roadmap.md#seguridad-de-acceso-e-integraciones).

## Recorrido y límites

El consumidor mantiene permisos funcionales, pausas, prompts, modelos,
telemetría y tratamiento de respuesta. `aiBroker.service` firma una operación
por finalidad y entorno. El proceso separado `ai-main.js` verifica firma,
replay, permiso, modelo y esquema; obtiene la clave desde Secrets Manager y
llama a un destino HTTPS fijo. Devuelve la respuesta del proveedor, nunca la
clave. No es un proxy de URL/cabeceras arbitrarias.

| Consumidor | Operación | Finalidad | Respuesta preservada |
| --- | --- | --- | --- |
| `accountingIngestion.service` | `ai.openai.responses.create.v1` | `accounting_ocr` | JSON de extracción, uso y errores operativos |
| `webContentGeneration.service` | misma | `web_content` | Contenido estructurado, estado y consumo |
| `marketingAiVisibility.service` | misma | `visibility_openai` | Texto, citas, fuentes y consumo |
| mismo | `ai.gemini.interactions.create.v1` | `visibility_gemini` | Resultado de búsqueda, fuentes y consumo |
| `groqAudio.service` | `ai.groq.audio.transcribe.v1` | `whatsapp_audio` | Transcripción y uso/duración del proveedor |
| `aiRuntimeMonitoring.service` | `ai.groq.model.check.v1` | `provider_health` | Disponibilidad del modelo; grant separado |

Bedrock tiene su propio consumidor y credenciales AWS. Este transporte no lo
migra ni sustituye sus funciones de texto/imagen. No declarar «IA migrada»
mientras ese consumidor o cualquier escritor siga usando claves locales.
Antes de cambiarlo, cumplir la [matriz de automatizaciones y contexto](automation-ai-migration-acceptance.md):
incluye todas las versiones guardadas, recetas personalizadas, errores y prueba
real del proveedor; la aceptación por el futuro broker todavía está pendiente.

Las claves de IA son de plataforma: los grants usan `platform:dev` o
`platform:staging`, y `ai:<finalidad>`. No representan por sí solos una ACL
clínica. El control de usuario/clínica continúa antes de esta llamada. Una
intrusión en el backend podría abusar de las finalidades que conserve
autorizadas; no afirmar aislamiento por clínica a partir de este grant.

DEV conserva identidad de firma y secretos propios en `/integrations/dev/`.
El CRM público es staging, aunque el namespace histórico AWS se llame
`/integrations/prod/`. No copiar claves públicas a DEV ni cambiar esa distinción
por el nombre de la rama. Los contratos y adaptadores sí se promueven juntos.

## Configuración

El entrypoint aislado recibe un fichero root/service `0600` con
`cohort=ai-providers-v1`, `enabled`, `environment`, `listenAddress`, `port`,
`stateFile`, `tlsCertFile`, `tlsKeyFile`, `policy` y, opcionalmente,
`tlsRenewal.issuerCaFile`. La política fija:

- principals con claves públicas y audiencia propia;
- una conexión por proveedor/entorno, `provider=ai_openai|ai_gemini|ai_groq`,
  ARN exacto y `ai.models` admitidos;
- organización/proyecto OpenAI opcionales en `ai.organization`/`ai.project`,
  obtenidos de la configuración efectiva antes del corte;
- grants de la tabla anterior, sin otras operaciones.

El secreto operativo tiene exactamente `version=1`, `provider`,
`connectionRef` y `accessToken`. Un placeholder no incluye `accessToken` y
siempre falla como `secret_unavailable`. Validar cuenta, ARN, KMS y
`AWSCURRENT`. El buffer de la clave se limpia al terminar; Node puede conservar
copias internas transitorias en memoria. No prometer borrado forense.

En la aplicación, configurar sin valores de proveedor:

```text
AI_BROKER_ENVIRONMENT=staging
AI_BROKER_ORIGIN=https://<destino-verificado>:<puerto>
AI_BROKER_AUDIENCE=<audiencia-de-la-politica>
AI_BROKER_KEY_ID=<identidad-de-firma>
AI_BROKER_KEY_FILE=/ruta/privada/signing.key
AI_BROKER_CA_FILE=/ruta/privada/ca.crt
AI_BROKER_OPENAI_CONNECTION_REF=ai:openai:staging
AI_BROKER_GEMINI_CONNECTION_REF=ai:gemini:staging
AI_BROKER_GROQ_CONNECTION_REF=ai:groq:staging
AI_BROKER_OPENAI_ENABLED=false
AI_BROKER_GEMINI_ENABLED=false
AI_BROKER_GROQ_ENABLED=false
```

Activación independiente por proveedor. Una vez habilitado, cualquier error
del broker termina esa operación: no se utiliza automáticamente una clave
antigua de `.env`. El modo legacy existe solo para la transición anterior al
corte, no como recuperación oculta.

## Compatibilidad de API y tamaño

Los destinos son `api.openai.com/v1/responses`,
`generativelanguage.googleapis.com/v1beta/interactions` y
`api.groq.com/openai/v1/audio/transcriptions`. Se conserva la versión usada por
los consumidores; un cambio de versión es otra modificación que exige QA.

OpenAI/Gemini exigen `store=false`. Se admiten exclusivamente las estructuras
usadas por estos consumidores: búsqueda web, JSON estructurado y referencias
privadas de PDF/imagen para OpenAI; búsqueda Google para Gemini; referencia
privada de audio/video con `verbose_json` para Groq. Los archivos inline/base64,
URLs arbitrarias, streaming, conversaciones almacenadas, MCP y cabeceras
elegidas por el CRM se rechazan. Ampliar funciones exige contrato y pruebas.

El perfil `ai` admite un máximo de 1 MiB de petición y 8 MiB de respuesta.
El presupuesto total de cuerpos admitidos es 1 MiB; cuatro operaciones y ocho
conexiones como máximo. La reserva se obtiene antes de leer el cuerpo y continúa
hasta terminar el trabajo y la respuesta, incluso tras desconexión del cliente.
Los archivos, hasta 32 MiB, viajan por descarga directa proveedor desde el
servicio de transferencias CRM, separado del broker. Los demás transportes
conservan su límite de petición de 32 KiB. El timeout de proveedor llega a 180 s
y el transporte a 190 s. Un exceso de admisión devuelve `rate_limited` sin llamar
al proveedor. El digest canónico se calcula incrementalmente.

AWS usa heap de 512 MiB, MemoryMax de 768 MiB y MemoryHigh de 640 MiB. El auxiliar
CRM usa heap64/MemoryMax256/MemoryHigh192 MiB y 50% CPU. Cuatro archivos ficticios
de32MiB simultáneos se cargaron, descargaron y revocaron: pico RSS71,8MiB,
cgroup160,7MiB incluyendo caché, cero fallos de límite y cero reinicios.
Estos límites y pruebas no garantizan capacidad ilimitada.

No se reintentan llamadas al proveedor automáticamente. Repetir el mismo
`requestId` completado produce `outcome_unknown`, no otra llamada ni una copia
persistente del contenido. Las respuestas IA no quedan en la base del broker;
la aplicación conserva sus resultados según su contrato funcional. No generar
otro identificador para «resolver» un timeout sin comprobar el estado del job.

La auditoría registra operación, finalidad, identidad de servicio, correlación
y resultado. No copia prompts, PDFs, audios, transcripciones o claves. No
equivale al evento de actividad del usuario que inició la operación.

## Corte por proveedor

### Archivos mediante enlaces privados

1. El consumidor conserva ACL y comprueba la pausa IA antes de crear el permiso.
2. Emite por socket Unix una referencia de lectura ligada a archivo, UUID,
   entorno, finalidad, tamaño y SHA256. No existe API pública de emisión.
3. AWS valida origen HTTPS fijo, ruta y contrato, obtiene la clave del vault y
   envía la referencia al endpoint fijo del proveedor. No descarga el archivo.
4. El proveedor descarga directamente desde CRM. El resultado de texto/JSON
   vuelve por el broker al consumidor; no contiene la clave ni el permiso.
5. El consumidor revoca el permiso en `finally`; la caducidad de cinco minutos
   limita el acceso si se interrumpe el proceso o falla esa revocación.

La clave autentica la petición al proveedor, no es una orden separada para que
entregue el resultado a otro servidor. OpenAI Responses admite
[archivos por URL](https://developers.openai.com/api/docs/guides/file-inputs)
y Groq [audio mediante `url`](https://console.groq.com/docs/speech-to-text).

`services/ai-file-transfer` guarda solo hashes de capacidades en metadata,
archivos0600/directorio0700, cuotas8ficheros/128MiB,4descargas,16peticiones y
presupuesto de lectura3veces el tamaño por permiso. Admite HEAD y rangos,
comprueba integridad y recupera/limpia estado al reiniciar. El proxy HTTPS no
registra capacidades ni sigue redirecciones. HTTP las rechaza sin redirigir.
El contrato rechaza sustitución de origen/petición/entorno/finalidad y respuestas
del proveedor que reflejen el permiso antes de entregarlas a app/telemetría.
Ver [servicio de transferencias](../../services/ai-file-transfer/README.md).

Configurar `AI_FILE_TRANSFER_CONFIG_FILE` con el JSON privado del cliente local
junto con los flags del broker. El UID de DEV no debe acceder al emisor staging.
El auxiliar debe estar habilitado y supervisado antes del corte del consumidor.

Estado verificado el18/09: AWS ejecuta1371e7b5, política
`ai-staging-20260918-url-health-v3`, después de renovar SSO. Recorrido privado real
Groq con consumidor exacto: audio ficticio299592bytes, payload531bytes, texto
esperado y salud tipada correcta. Cero transferencias/reserva/spool al terminar;
cuatro recibos externos S3 comprobados por versión/checksum/KMS y sin backlog.
El harness inyecta DB/pausa/telemetría: no es prueba integrada ni visual.
Flags CRM/gateway todavía apagados, claves locales presentes y servicios IA aún
sin habilitación al arranque. OpenAI sigue sin saldo y Gemini403, igual que
antes desde el host original. No repetir operaciones para disimular esos fallos.

### Secuencia operativa

1. Inventariar todos los consumidores y presencia de claves por runtime sin
   imprimir valores. Contrastar modelos, timeout y organización/proyecto.
2. Preparar IAM y placeholders exactos; verificar metadata. No habilitar flags.
3. Publicar release inmutable del broker, identidad propia, estado durable,
   TLS, límites y red solo desde el host autorizado. Probar rechazos de
   firma/entorno/grant y entrega de auditoría.
4. Transferir la credencial al vault por canal protegido sin mostrarla,
   incluirla en comandos SSM, logs o ficheros de evidencia. Verificar versión y
   referencia; no sustituir una credencial ya poblada por un marcador.
5. Probar el proveedor real con contenido ficticio mínimo y sin mensajes a
   pacientes. Verificar respuesta/uso y recibo de auditoría. Los mocks no
   satisfacen este paso.
6. Publicar adaptador y dependencias compartidas primero; habilitar un proveedor
   con el tráfico controlado. Probar cada fila correspondiente de la tabla,
   incluido audio entrante cuando se cambie Groq.
7. Retirar la clave del `.env` y del entorno efectivo de TODOS sus procesos una
   vez demostrado el corte; reiniciar de forma controlada y comprobar solo
   presencia/ausencia. Eliminarla de un fichero no la retira de un proceso vivo.
8. Registrar evidencia saneada y ubicación protegida de respaldos. Los
   respaldos con credenciales también forman parte del inventario pendiente.

No promover solo `src/services`: el cliente carga `ai-limits.js` de
`services/integrations-broker/src`. Promover todo el conjunto de dependencias.
El publicador debe ejecutar comprobaciones con la versión Node del consumidor
(gateway 18, staging 18 en la comprobación del 17/09) y del broker (24).

## Diagnóstico para otra tarea

| Código | Revisar | Evitar |
| --- | --- | --- |
| `provider_disabled` | Flag del proveedor en el proceso correcto | Abrir otros proveedores para probar |
| `broker_configuration_invalid` | Origen/audiencia, identidad, entorno y ficheros privados | Pegar `.env` o claves en el ticket |
| `scope_denied` | Grant, finalidad, modelo y referencia; comparar DEV/staging | Ampliar permisos globalmente |
| `invalid_request` | Contrato de entrada, tamaño, timeout y versión del consumidor | Quitar validación para aceptar URLs |
| `secret_unavailable` | ARN/KMS/versiones, IAM y estado placeholder | Copiar de nuevo una clave al CRM |
| `provider_unauthorized` | Credencial/proyecto/configuración del proveedor en AWS | Revocar otras conexiones |
| `rate_limited` | Concurrencia local o cuota del proveedor | Reintento inmediato en bucle |
| `provider_timeout` / `outcome_unknown` | Correlación y estado del job/proveedor | Duplicar generación o coste a ciegas |

En un ticket interno aportar entorno, servicio, operación, código fijo,
correlación, hora UTC y releases. Nunca incluir contenidos clínicos ni el
error completo del SDK si puede contener la petición.

Rollback: antes de retirar la clave local se puede restaurar el consumidor
anterior mediante cambio explícito y comprobado, sin repetir jobs. Después del
corte completo, preferir reparar/restaurar la release del broker preservando
el vault. Reintroducir claves en el CRM no es un rollback automático autorizado.
Sustitución/revocación y rotación periódica quedan para su fase independiente.

## Pruebas

```sh
# Broker: Node 24, proveedores ficticios y red externa prohibida
cd services/integrations-broker
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/*.test.js

# Aplicación, desde la raíz: funciones reales, sin BD ni proveedores
node --test src/scripts/tests/ai_broker_consumers.test.js
```

Las pruebas cubren archivos/respuestas grandes, TLS real local, firma, replay,
cruce de entorno, modelo, claves que no salen, metadata de auditoría, falta de
fallback, errores/timeout sin retry y conservación de los cinco consumidores.
Añadir pruebas reales de proveedor y revisión visual de las superficies
afectadas antes de acreditar la migración en `19`.

### Evidencia vigente de enlaces y monitor (2026-09-18)

516/516 pruebas del broker; 15/15 del emisor y consumidores; seis de monitor y
consumidores; diez existentes de runtime/Bedrock. HTTP/Unix/HTTPS reales: rangos,
expiración, revocación, corrupción, concurrencia, interrupción, reinicio y
separación de UID. Sin capacidades en seis logs NGINX ni journal del emisor.
La comprobación de Groq solo lee el modelo permitido, limita la respuesta a
16KiB y proyecta disponibilidad. Conserva la caché de cuatro horas, grant propio
`ai:provider_health` y ausencia de fallback. Se ha probado por AWS y Groq reales;
el recorrido autenticado en Ajustes sigue pendiente.

Evidencias bajo `qa-evidence/security-resume-20260917/ai-runtime/`:
`private-groq-consumer-result.json`, `private-url-aws-verified.json`,
`private-url-audit-receipts.json`, `file-transfer-installed-capacity-result.json`,
`file-transfer-isolation.json`, `private-link-qa-result.json` y suites registradas.
La muestra pública ficticia inicial ya retirada y el ensayo de memoria con
base64 fueron prototipos anteriores; no representan el transporte vigente.

Recuperación de AWS: configuración/unidad anteriores bajo
`/var/lib/clinicaclick-ai-deployment-20260918`; conservar ledger y vault.
Release anterior553e9cdf usa contrato binario incompatible con el consumidor
nuevo: no volver a ella con flags del consumidor activos. Preferir restaurar
una release compatible con referencias privadas. Recuperación del proxy:
restaurar `/var/backups/clinicaclick-security/ai-files-20260918/crm.nginx.before`,
validar NGINX y recargar antes de detener el auxiliar, únicamente tras retirar
los consumidores que lo necesiten. No borrar fuentes clínicas. No retirar un
servidor supervisado sin actualizar su destino de certificados.
