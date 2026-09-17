# Preparación automática de conexiones WhatsApp

> **Tipo:** contrato técnico y runbook.
> **Fuente de verdad:** alta de almacenes vacíos, compatibilidad y diagnóstico; estado de despliegue en [19](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).
> **Última revisión:** 2026-09-17.
> **Relacionado con:** [alta del broker](whatsapp-onboarding-broker.md), [gateway](whatsapp-onboarding-gateway.md), [manual central](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/00-README.md).

## Responsabilidades

Al iniciar una autorización para un ámbito sin binding estático, el gateway
solicita `meta.whatsapp.onboarding.prepare.v1` por el transporte firmado y TLS.
Solo lo hace después de que el flujo normal compruebe sesión, MFA, permisos y
el conjunto completo de clínicas. El navegador no decide rutas AWS, permisos
Meta, principal, app ni configuración de Embedded Signup.

AWS prepara un único almacén vacío por ámbito, bajo
`/clinicaclick/integrations/prod/whatsapp/automatic/clinic-<id>/candidate`
o `group-<id>/candidate`. La referencia es
`whatsapp-auto-clinic-<id>-v1` / `whatsapp-auto-group-<id>-v1`.
Los bindings estáticos y sus versiones continúan intactos: nunca se migran
implícitamente a otro almacén ni se usa una credencial antigua como fallback.

Preparar el almacén **no autoriza envíos**. Después siguen el consentimiento Meta,
el canje único, la comprobación de pertenencia al WABA/número y el registro
operativo. El lector operativo reconoce bindings preparados dinámicamente, pero
exige también una autorización operativa explícita que coincida con el recibo.
Este mecanismo no añade aprobación local de plantillas ni consultas de su estado
antes de cada envío. No cambia las retenciones de comunicaciones importadas,
pausas clínicas ni suscripciones de recepción.

## Configuración compatible

En el broker de alta, `provisioning` es opcional y tiene exactamente:

```json
{
  "appId": "ID_DE_APP_EXISTENTE",
  "configId": "ID_DE_CONFIGURACION_EXISTENTE",
  "redirectUri": "https://dominio-autorizado.example/whatsapp/callback",
  "scopes": ["whatsapp_business_management", "whatsapp_business_messaging"],
  "appVersionId": "VERSION_INMUTABLE_DEL_SECRETO_DE_APP",
  "clientSecretArn": "ARN_DEL_SECRETO_DE_APP_EXISTENTE",
  "maxConnections": 1000
}
```

Los valores de ejemplo no son una configuración ejecutable. Copiar la identidad
de aplicación ya validada, con los permisos exactos que utiliza el ajuste. El
modo seleccionado mantiene `customer.selectionOnly=true`; los únicos permisos
opcionales permitidos siguen siendo `public_profile` y
`whatsapp_business_manage_events` según el contrato de alta. No ampliar a Ads,
páginas, leads ni `business_management`.

En el fichero privado del gateway, `automatic` contiene únicamente `appId`,
`configId`, `redirectUri` y `scopes` iguales. No contiene ARN, versión ni secreto.
Conserva `bindings` para todas las conexiones existentes. El listado de Ajustes
descubre también los ámbitos con recibos de autorización y aplica la ACL actual
antes y después de consultar el broker. Consultar el listado no crea almacenes.

El campo opcional del gateway `automaticPreparationEnabled: false` pausa nuevos
inicios automáticos conservando `automatic` para leer y finalizar intentos ya
preparados. Por defecto se permite preparar si existe `automatic`. Este campo
no pausa los envíos ni afecta a los bindings estáticos.

`maxConnections` limita el número total de almacenes automáticos. Aumentarlo no
invalida los existentes. Cambiar la identidad de app/config/versión/URI/permisos
sí interrumpe su resolución; no hacerlo para corregir una cuota ni una caída.
Un cambio en los miembros de un grupo exige conciliar su autorización, nunca
extender el acceso silenciosamente a la nueva clínica.

## Persistencia e interrupciones

Las tablas `whatsapp_provisioned_slots` y `whatsapp_preparation_requests` viven
en el SQLite de alta, junto a sus bloqueos durables. Antes de llamar a AWS se
registran nombre, UUID de versión, ámbito y huella de configuración. La versión
inicial `AWSCURRENT` contiene solo el placeholder, nunca un token. La candidata
posterior conserva la escritura inmutable por flow UUID con `AWSPENDING`.

Si se pierde la respuesta de `CreateSecret`, el siguiente intento observa el
mismo nombre, versión, KMS, etiquetas y placeholder. Solo acredita éxito si
coinciden todos. No sobrescribe un secreto encontrado, no restaura eliminados
ni inventa una autorización ante un timeout. Dos procesos comparten el mismo
registro y no generan dos versiones independientes. Se vuelven a comprobar
caducidad y bloqueos después de esperar a AWS.

La respuesta pública contiene metadata de configuración y
`status=prepared, connected=false`. No contiene ARN, token, código OAuth ni
secreto de aplicación. La auditoría registra solicitud y preparación terminada,
con correlación; un replay confirmado no genera otro evento de éxito.

## Permiso AWS y despliegue

La política complementaria está en
`services/integrations-broker/deploy/whatsapp-provisioning-policy.json`.
Se aplica exclusivamente como inline policy
`clinicaclick-whatsapp-auto-provision-v1` del rol
`clinicaclick-integrations-prod-ec2-role`.

- Permite crear/etiquetar únicamente los candidatos del prefijo automático,
  en la cuenta/región existentes, con el KMS de secretos y etiquetas obligatorias.
- Añade `ListSecretVersionIds` y `PutSecretValue` solo en esos candidatos.
- Lectura de secretos y uso del KMS ya dependen de la política runtime existente;
  este lote no los amplía ni da permisos al servidor CRM o a DEV.
- No concede borrado, restauración, rotación, movimiento de etapas, IAM, SSO,
  replicación ni cambios de red. Las etiquetas no sustituyen la autorización
  por clínica/número del servicio.

Antes del corte: comprobar identidad AWS, política existente y validar el JSON
con Access Analyzer; si existe otra política con el mismo nombre y distinto
contenido, detener la aplicación del lote. No sustituir otras políticas.
Publicar primero código compatible del broker de alta y de sus lectores
operativos, manteniendo la configuración estática; después habilitar los dos
bloques privados coincidentes. No publicar solo el gateway.

Probar una preparación sintética sin código Meta y comprobar versión, KMS,
etiquetas, recibo firmado y cero envíos. Después validar una nueva autorización
real, su aparición en Ajustes y el registro operativo/recepción. Las pruebas
offline o el permiso aplicado por sí solos no cierran esa validación.

## Diagnóstico para otra tarea/Codex

| Síntoma | Comprobación | No hacer |
| --- | --- | --- |
| `whatsapp_onboarding_preparation_unavailable` antes del popup | Perfil de ejecución EC2, inline policy, KMS, alcance del prefijo y auditoría; el error externo oculta detalles AWS | Añadir tokens a `.env` o ampliar IAM a `*` |
| Fila `preparing` después de timeout | Consultar metadata de la versión exacta; reintentar la misma preparación autenticada | Borrar SQLite, recrear el secreto o cambiar UUID a mano |
| `idempotency_conflict` | Ámbito, miembros del grupo, identidad de configuración y UUID de petición | Reutilizar la petición para otra clínica |
| `asset_revoked` / `connection_blocked` | Bloqueos persistentes y autorización vigente | Limpiar bloqueos como parte de un reinicio |
| `staged` pero sin envíos | Registro operativo y enlace local del activo, recepción y pausas existentes | Presentar `prepared` o `staged` como canal operativo |
| Conexión invisible en Ajustes | Recibo `claimed`, ACL actual, contrato compatible y estado de broker | Recrear la autorización sin revisar el intento existente |

Para QA usar Node 24 y el guard offline del paquete. Casos focales:
`test/whatsapp-provisioning*.test.js`, `test/whatsapp-authorized*.test.js`,
`src/scripts/tests/whatsapp_authorization_listing.test.js`,
`src/scripts/tests/whatsapp_onboarding_{broker_client,gateway_tls}.test.js`.
No usar credenciales reales ni datos de pacientes en fixtures. El gateway publica
el contrato de aprovisionamiento y `canonical.js` junto con sus dependencias de
contrato existentes; estos módulos no cargan el runtime AWS ni `node:sqlite`.
Comprobar su carga con el Node real del gateway antes de cambiar la configuración.

Rollback: fijar `automaticPreparationEnabled: false` en gateway y conservar código capaz
de leer las conexiones automáticas ya existentes. Retirar el permiso de creación
si procede, preservando permisos de uso de candidatos que ya estén operativos.
No borrar secretos, tablas, reservas ni auditoría; volver a un lector que solo
reconoce bindings estáticos puede interrumpir conexiones automáticas.

Referencias de permisos: [CreateSecret](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_CreateSecret.html)
y [acciones/condiciones Secrets Manager](https://docs.aws.amazon.com/service-authorization/latest/reference/list_secretsmanager.html).
