# Credenciales de IA en AWS: corte y diagnóstico por consumidor

> **Tipo:** runbook y contrato técnico del transporte.
> **Fuente de verdad:** operaciones de OpenAI, Gemini y Groq en el broker y su migración; no acredita activación.
> **Última revisión:** 2026-09-17.
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

Bedrock tiene su propio consumidor y credenciales AWS. Este transporte no lo
migra ni sustituye sus funciones de texto/imagen. No declarar «IA migrada»
mientras ese consumidor o cualquier escritor siga usando claves locales.

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
que usan estos consumidores: búsqueda web, JSON estructurado y entrada local
PDF/imagen para OpenAI; búsqueda Google para Gemini; archivo de audio/video
con `verbose_json` para Groq. No se admiten URLs de archivos, streaming,
conversaciones almacenadas, herramientas MCP ni cabeceras elegidas por el CRM.
Para añadir una función legítima, ampliar el contrato con su consumidor y
pruebas; no convertirlo en un proxy general ni silenciar el rechazo.

El perfil `ai` permite 32 MiB decodificados de archivos, aproximadamente
44 MiB de petición y 8 MiB de respuesta. Es un techo de transporte, no una
garantía de admisión del proveedor. Los límites de los demás brokers permanecen
en 32 KiB. Tiempo de proveedor hasta 180 s y presupuesto de transporte hasta
190 s. El runtime limita a cuatro operaciones simultáneas y ocho conexiones.
Antes de recibir el cuerpo exige una longitud explícita y reserva un presupuesto
total equivalente a una petición máxima. Varias peticiones pequeñas pueden
coincidir; una subida máxima ocupa ese presupuesto completo. La reserva se
mantiene hasta terminar el trabajo y entregar o cerrar la respuesta; desconectar
el cliente no libera capacidad mientras el proveedor sigue trabajando. Un exceso
devuelve `rate_limited` antes de leer el archivo y sin llamar al proveedor.
Verificar además memoria y concurrencia de la instancia antes del corte.
El digest de idempotencia del perfil IA se calcula de forma incremental, con
los mismos bytes canónicos, para evitar copias del archivo en cada nivel JSON.
En el ensayo aislado del 17/09, Node 24 con heap de 512 MiB admitió archivos de
32 MiB y cuatro de 8 MiB simultáneos, con respuestas de unos 7,94 MiB. El pico
RSS fue 422,4 MiB. Es evidencia local con proveedor inyectado; no sustituye la
prueba real en AWS ni acredita capacidad ilimitada. Conservar el informe de
capacidad y aplicar un límite de memoria al servicio antes de habilitarlo.

No se reintentan llamadas al proveedor automáticamente. Repetir el mismo
`requestId` completado produce `outcome_unknown`, no otra llamada ni una copia
persistente del contenido. Las respuestas IA no quedan en la base del broker;
la aplicación conserva sus resultados según su contrato funcional. No generar
otro identificador para «resolver» un timeout sin comprobar el estado del job.

La auditoría registra operación, finalidad, identidad de servicio, correlación
y resultado. No copia prompts, PDFs, audios, transcripciones o claves. No
equivale al evento de actividad del usuario que inició la operación.

## Corte por proveedor

### Revisión de transporte solicitada por el titular el 17/09

La activación de consumidores queda pendiente de resolver el transporte de
archivos grandes. Los límites y ensayos de memoria acreditan el comportamiento
del prototipo, pero no deciden por sí solos la arquitectura de producción.
El servicio AWS se ha preparado para QA; no se han habilitado sus flags en CRM
ni gateway ni retirado las claves locales.

Se propone mantener la autenticación y operaciones en el broker y entregar los
archivos directamente al proveedor mediante referencias temporales:

1. El consumidor comprueba permisos, ámbito del documento y pausa de la función.
2. Crea una referencia de lectura limitada a ese archivo, petición y entorno.
3. El broker valida esa referencia y llama al endpoint fijo del proveedor con
   su clave y una URL temporal de un origen permitido.
4. El proveedor obtiene el archivo directamente; texto/JSON de respuesta sigue
   el circuito normal proveedor → broker → consumidor.

La clave autentica la petición HTTP; no se envía por separado para que el
proveedor redirija automáticamente su respuesta al CRM. Una entrega directa de
resultados requiere un contrato asíncrono específico, cuando exista, y no forma
parte de esta propuesta.

Capacidad confirmada en documentación oficial: OpenAI Responses acepta
[archivos por URL](https://developers.openai.com/api/docs/guides/file-inputs)
y Groq admite [audio mediante `url`](https://console.groq.com/docs/speech-to-text).
Prueba real Groq del 17/09: audio ficticio de 299592 bytes servido temporalmente
desde CRM; petición desde AWS de 395 bytes, respuesta 200 y transcripción
esperada. Se retiró el archivo y se verificó que ya no se servía. Esa prueba
empleó una muestra pública temporal: demuestra la descarga directa del
proveedor, **no** acredita el contrato privado ni cambia consumidores reales.

`clinicalPrivateStorage.service` actualmente solo implementa almacenamiento
local privado. No tiene URLs de proveedor con caducidad. El audio WhatsApp llega
como buffer después de la descarga autenticada a Meta. Falta implementar y probar:

- Emisión interna después del control funcional, vinculada a archivo, trabajo,
  finalidad y entorno; sin API pública para emitir permisos ni claves IA en CRM.
- Caducidad, revocación al terminar y limpieza tras timeout/reinicio. La descarga
  puede necesitar HEAD/Range y lecturas repetidas del mismo archivo; no consumir
  el permiso irrevocablemente con el primer HEAD.
- Origen y ruta cerrados, sin URLs arbitrarias, redirecciones, recorridos de
  directorios ni posibilidad de leer otro archivo cambiando un identificador.
- Transferencia por streaming con tamaño y concurrencia limitados. Reutilizar
  el documento privado existente; resolver por separado la vida temporal del
  buffer de audio, sin convertir carpetas clínicas en contenido público.
- Ausencia de referencias con acceso en logs, auditoría y navegador. El permiso
  temporal también es una credencial de lectura, aunque no sea la clave IA.
- Pruebas de expiración, archivo alterado, firma/ámbito ajeno, cancelación,
  limpieza y proveedor real; después, recorridos integrados y visuales.

El contrato actual rechaza URLs externas. No quitar esa validación para hacer
pasar una prueba: sustituirla por un contrato acotado y promover juntos emisor,
descarga y consumidor. Bedrock y el resto de integraciones conservan su fase.

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
