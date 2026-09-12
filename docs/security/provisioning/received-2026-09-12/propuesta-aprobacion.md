# Propuesta de aprovisionamiento AWS - ClinicaClick integraciones

Fecha: 2026-09-12

## Alcance

Preparar solo la base AWS para que otro Codex implemente despues el broker/migracion de integraciones. Esta entrega no implementa codigo de aplicacion, no migra credenciales, no toca Meta, Google Cloud, servidores Clinicaclick, bases de datos, repositorios, PM2 ni archivos `.env`.

## Cuenta y region observadas

- Cuenta AWS visible en consola: `137819318729`.
- Usuario/identidad visible en consola: `Carlos Hervas`.
- Region de trabajo solicitada y abierta: `eu-west-3` (Europa, Paris).
- CloudShell `aws sts get-caller-identity` ejecutado inicialmente el 2026-09-12 desde root devolvio:
  - `UserId`: `137819318729`
  - `Account`: `137819318729`
  - `Arn`: `arn:aws:iam::137819318729:root`

Actualizacion 2026-09-12: con autorizacion expresa del usuario se creo el rol temporal `arn:aws:iam::137819318729:role/codex-clinicaclick-provisioner-temp` y se intento asumirlo desde CloudShell root. AWS rechazo la operacion con `AccessDenied`: las cuentas root no pueden asumir roles. No se creo infraestructura. Despues, con autorizacion expresa, se desadjunto `AdministratorAccess`, se elimino el rol temporal y se verifico `NoSuchEntity`.

Actualizacion 2026-09-12: se habilito IAM Identity Center como instancia de organizacion en `eu-west-3`, se creo el usuario temporal `carlos@clinicaclick.com`, el permission set `codex-clinicaclick-prov-temp` con `AdministratorAccess` y duracion de sesion de 1 hora, y se asigno a la cuenta `137819318729`. CloudShell desde esa sesion SSO devolvio:
  - `UserId`: `AROASAFVL5HEU5T7HYJAG:carlos@clinicaclick.com`
  - `Account`: `137819318729`
  - `Arn`: `arn:aws:sts::137819318729:assumed-role/AWSReservedSSO_codex-clinicaclick-prov-temp_9e033df24a055d21/carlos@clinicaclick.com`

ARN IAM estable del operador para `OperatorPrincipalArn`:

```text
arn:aws:iam::137819318729:role/aws-reserved/sso.amazonaws.com/eu-west-3/AWSReservedSSO_codex-clinicaclick-prov-temp_9e033df24a055d21
```

## Stack propuesto

Nombre sugerido: `clinicaclick-integrations-prod-foundation`

Plantilla:

```text
/Users/modmarketing/Documents/New project/clinicaclick-aws-provisioning-2026-09-12/clinicaclick-integrations-infra.yaml
```

Parametros previstos:

```text
Application=clinicaclick
Component=integrations
Environment=prod
CostCenter=clinicaclick
Region=eu-west-3
InstanceType=t3.small
MonthlyBudgetUsd=60
NotificationEmail=carlos@clinicaclick.com
OperatorPrincipalArn=arn:aws:iam::137819318729:role/aws-reserved/sso.amazonaws.com/eu-west-3/AWSReservedSSO_codex-clinicaclick-prov-temp_9e033df24a055d21
```

## Recursos que se crearan

- Una VPC nueva `/24` y una subnet publica `/28`, separadas de Clinicaclick existente.
- Internet Gateway y ruta de salida.
- Un Security Group sin entradas y con salida TCP/443.
- Una instancia EC2 Linux `t3.small`, Amazon Linux 2023, EBS gp3 de 20 GiB cifrado, IMDSv2 obligatorio, CPU credits en `standard`.
- Una Elastic IP asociada a la instancia para salida fija.
- Administracion por AWS Systems Manager Session Manager mediante `AmazonSSMManagedInstanceCore`, sin SSH publico ni par de claves.
- Rol de instancia limitado al prefijo de secretos `/clinicaclick/integrations/prod/`, a dos KMS concretas y escritura de logs de runtime.
- Rol de despliegue futuro y rol lector de costes, ambos confiados solo al `OperatorPrincipalArn` aprobado.
- Dos claves KMS simetricas:
  - `alias/clinicaclick/integrations/prod/secrets`
  - `alias/clinicaclick/integrations/prod/payload`
- Una clave KMS simetrica separada para auditoria:
  - `alias/clinicaclick/audit/prod/logs`
- Un unico secreto de prueba ficticio generado por AWS:
  - `/clinicaclick/integrations/prod/fictitious-smoke-test`
- Log group de aplicacion:
  - `/clinicaclick/integrations/prod/app`
- Un bucket S3 privado y separado para registros de auditoria de aplicacion, con versionado, cifrado KMS, bloqueo de acceso publico y lifecycle configurable.
- Roles separados de auditoria:
  - writer: solo escritura de objetos bajo `app/`, sin lectura ni borrado;
  - reader: lectura/listado bajo `app/`, sin escritura ni borrado;
  - retention-admin: administracion de lifecycle/encryption/public-access/policy, sin borrar objetos ni desactivar KMS.
- CloudTrail regional hacia S3 con validacion de logs, bucket privado, cifrado SSE-S3, bloqueo publico y retencion/lifecycle de 365 dias.
- SNS topic y suscripcion de email para alarmas.
- Alarmas CloudWatch:
  - status check EC2 fallido;
  - recovery automatico ante fallo de sistema compatible;
  - CPU credits bajos.
- AWS Budget mensual con alertas efectivas verificadas al 80% real, 100% real y 100% forecasted.

## Coste mensual previsto

Precios consultados el 2026-09-12 en fuentes oficiales/publicas de AWS para `eu-west-3`, salvo donde se indique que depende de uso:

- EC2 `t3.small` Linux On-Demand: `0.0236 USD/h` x 730 h = `17.23 USD/mes`.
- EBS gp3 20 GiB: `0.0928 USD/GB-mes` x 20 = `1.86 USD/mes`.
- IPv4 publica/Elastic IP en uso: `0.005 USD/h` x 730 h = `3.65 USD/mes`.
- KMS integraciones: 2 customer managed keys x `1.00 USD/mes` = `2.00 USD/mes`, mas llamadas si superan capa gratuita/aplican.
- KMS auditoria: 1 customer managed key x `1.00 USD/mes` = `1.00 USD/mes`, mas llamadas.
- Secrets Manager inicial: 1 secreto x `0.40 USD/mes` = `0.40 USD/mes`, mas llamadas.
- Secrets Manager futuro con 20 secretos: 20 x `0.40 USD/mes` = `8.00 USD/mes`, mas llamadas.
- S3 auditoria: coste variable por GB-mes, PUT/GET y KMS requests. Con volumen bajo de logs ficticios/iniciales deberia ser bajo, pero no se fija como cero.
- CloudWatch alarms/logs: probablemente dentro de free tier si la cuenta no lo consume ya; los logs cobran por ingestion/almacenamiento si hay volumen.
- CloudTrail regional a S3: eventos de gestion y almacenamiento S3 bajo volumen; coste variable bajo, no cero garantizado.
- Cost Explorer API: `0.01 USD` por peticion en billing view primaria; vistas compuestas pueden costar mas por fuente.
- AWS Budgets: depende de cuotas/free tier de la cuenta y numero de budgets existentes.
- Transferencia de datos saliente, llamadas KMS/Secrets, CloudWatch Logs Insights, S3, snapshots y CPU credits extra no estan incluidos si el uso crece.

Base inicial estimada sin trafico relevante, con un secreto ficticio y auditoria preparada: alrededor de `26-32 USD/mes` antes de impuestos y costes variables.

Proyeccion con 20 secretos: alrededor de `34-40 USD/mes` antes de impuestos y costes variables.

La ampliacion de auditoria anade aproximadamente `1 USD/mes` fijo por la tercera KMS, mas S3/KMS requests variables segun volumen. Queda por debajo del presupuesto adicional autorizado de `60 USD/mes` antes de impuestos, bajo los supuestos anteriores.

No incluye NAT Gateway, Load Balancer, RDS, HSM, Savings Plans, reservas, soporte de pago, colas ni endpoints privados.

## Rollback y retirada

- Borrar el stack retirara la instancia, EIP, SG, VPC, alarmas, log group, SNS y budget segun dependencias de CloudFormation.
- El bucket de CloudTrail esta marcado `Retain` para no borrar evidencias accidentalmente. Su borrado debe ser manual y aprobado.
- Las KMS tienen ventana de borrado de 30 dias. La retirada definitiva requiere programar borrado de claves tras confirmar que no cifran datos necesarios.
- El secreto ficticio debe eliminarse tras la validacion si no se quiere mantener coste de Secrets Manager.
- El bucket de auditoria tambien esta marcado `Retain` para proteger evidencias. No se activa Object Lock Compliance ni retencion irreversible sin aprobacion explicita.

## Auditoria de aplicacion y requisito DPD

La infraestructura prepara destino y permisos para que otro Codex conecte despues eventos de actividad de ClinicaClick. No se accede a la base de datos, no se cambia su cifrado y no se reconstruyen historicos.

Configuracion propuesta:

- Bucket S3 privado separado de la instancia, secretos y CloudTrail.
- Versionado habilitado.
- Cifrado por defecto con KMS propia de auditoria.
- Bloqueo de acceso publico habilitado.
- Politica que deniega transporte no TLS y objetos subidos sin KMS.
- Lifecycle parametrizado con `AuditRetentionDays=183` como placeholder operativo para aproximadamente 6 meses. El DPD debe confirmar si el requisito es 6 meses naturales, 183/186 dias, fin de mes, excepciones legales o retenciones por incidente.

Opciones pendientes de aprobacion DPD para proteccion contra alteracion/borrado:

- Versionado + permisos sin `DeleteObject` para writer/reader: configurado.
- S3 Object Lock Governance: recomendable si se aprueba una retencion formal y se acepta que administradores con permiso especial puedan levantarla.
- S3 Object Lock Compliance: no configurado; irreversible durante la retencion y requiere aprobacion explicita.
- Replicacion cross-account/cross-region: no configurada; aumenta coste y complejidad.

CloudTrail regional se conserva en S3 para auditoria de infraestructura AWS mas alla del historial de eventos predeterminado. No sustituye los registros de actividad de ClinicaClick.

## Confirmacion requerida antes de aprovisionar

Para crear el stack necesito confirmacion explicita con:

```text
Autorizo crear el stack AWS `clinicaclick-integrations-prod-foundation` en la cuenta `137819318729`, region `eu-west-3`, usando la plantilla local indicada.
Presupuesto mensual de alerta aprobado: 60 USD.
Email aprobado para SNS/Budget: carlos@clinicaclick.com
OperatorPrincipalArn aprobado: arn:aws:iam::137819318729:role/aws-reserved/sso.amazonaws.com/eu-west-3/AWSReservedSSO_codex-clinicaclick-prov-temp_9e033df24a055d21
Acepto que se creen recursos facturables EC2, EBS, IPv4 publica, KMS, Secrets Manager, CloudWatch, CloudTrail/S3, SNS y AWS Budgets.
```

Estado de comprobacion previo al aprovisionamiento: ejecutada desde IAM Identity Center/SSO; ya no es root. La identidad activa es `arn:aws:sts::137819318729:assumed-role/AWSReservedSSO_codex-clinicaclick-prov-temp_9e033df24a055d21/carlos@clinicaclick.com`.

Estado del rol temporal root fallido: retirado. El acceso temporal vigente es el permission set SSO `codex-clinicaclick-prov-temp`; debe eliminarse tras finalizar y verificar el aprovisionamiento.

## Estado final tras aprovisionamiento

Stack creado el 2026-09-12 en `eu-west-3` bajo identidad SSO no-root:

```text
arn:aws:sts::137819318729:assumed-role/AWSReservedSSO_codex-clinicaclick-prov-temp_9e033df24a055d21/carlos@clinicaclick.com
```

El stack base `clinicaclick-integrations-prod-foundation` se creo correctamente. Su estado final observado es `UPDATE_ROLLBACK_COMPLETE` porque una actualizacion posterior intento anadir el aviso `ACTUAL 100%` al recurso `AWS::Budgets::Budget`; AWS Budgets rechazo recrear el presupuesto con el mismo nombre por `different internalId`. La actualizacion se revirtio y los recursos base quedaron conservados. El aviso `ACTUAL 100%` se anadio despues directamente con Budgets API y se verificaron estos avisos:

```text
ACTUAL > 80%
ACTUAL > 100%
FORECASTED > 100%
```

Salidas principales verificadas:

```text
InstanceId=i-0cf40cfe823f160fa
FixedEgressPublicIp=13.39.100.55
AuditLogBucketName=clinicaclick-integrations-prod-foun-auditlogbucket-3fmfqc6v8ktu
AuditKmsAlias=alias/clinicaclick/audit/prod/logs
AuditKmsKeyArn=arn:aws:kms:eu-west-3:137819318729:key/9be75437-51b7-4462-80e1-36ac6c6f6e8a
AuditWriterRoleArn=arn:aws:iam::137819318729:role/clinicaclick-audit-prod-writer-role
AuditReaderRoleArn=arn:aws:iam::137819318729:role/clinicaclick-audit-prod-reader-role
AuditRetentionAdminRoleArn=arn:aws:iam::137819318729:role/clinicaclick-audit-prod-retention-admin-role
CloudTrailBucketName=clinicaclick-integrations-prod-fo-cloudtrailbucket-hpys0qkunpro
RegionalTrailArn=arn:aws:cloudtrail:eu-west-3:137819318729:trail/clinicaclick-integrations-prod-regional-trail
AlertsTopicArn=arn:aws:sns:eu-west-3:137819318729:clinicaclick-integrations-prod-alerts
SecretPrefix=/clinicaclick/integrations/prod/
FictitiousSmokeTestSecretArn=arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-smoke-test-srwORo
ApplicationLogGroupName=/clinicaclick/integrations/prod/app
```

Controles verificados con AWS CLI:

- Bucket de auditoria con bloqueo publico total: `BlockPublicAcls`, `IgnorePublicAcls`, `BlockPublicPolicy` y `RestrictPublicBuckets` en `true`.
- Versionado del bucket de auditoria: `Enabled`.
- Cifrado por defecto del bucket de auditoria: `aws:kms` con `arn:aws:kms:eu-west-3:137819318729:key/9be75437-51b7-4462-80e1-36ac6c6f6e8a`.
- Lifecycle del bucket de auditoria: `retain-current-audit-objects` habilitado con `NoncurrentDays=183` y `abort-incomplete-multipart-uploads` a 7 dias.
- KMS de auditoria: customer-managed, `Enabled`; rotacion automatica no habilitada.
- CloudTrail regional: logging activo, validacion de logs habilitada, sin errores de entrega observados.
- Log group de aplicacion: `/clinicaclick/integrations/prod/app`, retencion 30 dias.
- Se comprobo solo metadata del secreto ficticio; no se leyo ningun valor de secreto.

Pruebas con datos ficticios:

- Se escribio un JSON no clinico bajo `app/smoke-test/` usando `clinicaclick-audit-prod-writer-role`.
- La escritura uso SSE-KMS y genero version `DXgS.YmnWsTqnlKst08fnF0usUO2D0yt`.
- Se comprobo `head-object` con `clinicaclick-audit-prod-reader-role`; tamano 191 bytes, `application/json`, `aws:kms`.
- Simulacion IAM para `s3:DeleteObject` con el writer: `implicitDeny`.

Pendiente de retirada:

- Quitar la asignacion SSO temporal del usuario `carlos@clinicaclick.com` sobre la cuenta `137819318729`.
- Retirar el permission set temporal `codex-clinicaclick-prov-temp` cuando ya no haga falta.
- Decidir con DPD si `183` dias expresa correctamente el requisito de 6 meses y si procede Object Lock Governance.
- Si se quiere que CloudFormation sea fuente unica de verdad para notificaciones de Budget, reconciliar la notificacion `ACTUAL 100%` creada por API o recrear/importar el Budget de forma planificada.

Infraestructura de auditoria preparada; registro de actividad de ClinicaClick y revision del cifrado de su BD pendientes del Codex responsable de la aplicacion.

## Entrega para el Codex de implementacion

Artefactos de entrega:

```text
/Users/modmarketing/Documents/New project/clinicaclick-aws-provisioning-2026-09-12/propuesta-aprobacion.md
/Users/modmarketing/Documents/New project/clinicaclick-aws-provisioning-2026-09-12/clinicaclick-integrations-infra.yaml
/Users/modmarketing/Documents/New project/clinicaclick-aws-provisioning-2026-09-12/manifest.final.json
```

Roles de ejecucion y operacion creados:

- `arn:aws:iam::137819318729:role/clinicaclick-integrations-prod-ec2-role`: rol de instancia EC2, confiado a `ec2.amazonaws.com`. Incluye `AmazonSSMManagedInstanceCore` para SSM. Politica inline limitada a leer secretos bajo `/clinicaclick/integrations/prod/*`, usar solo las KMS de integraciones para decrypt/data key y escribir logs en `/clinicaclick/integrations/prod/app`.
- `arn:aws:iam::137819318729:role/clinicaclick-integrations-prod-deployment-role`: confiado solo al principal SSO temporal de aprovisionamiento `arn:aws:iam::137819318729:role/aws-reserved/sso.amazonaws.com/eu-west-3/AWSReservedSSO_codex-clinicaclick-prov-temp_9e033df24a055d21`. Puede leer/inventariar EC2/IAM/KMS/Logs/Secrets metadata/SSM status y gestionar change sets/updates solo del stack `clinicaclick-integrations-prod-foundation`.
- `arn:aws:iam::137819318729:role/clinicaclick-integrations-prod-cost-reader-role`: confiado al mismo principal SSO temporal de aprovisionamiento. Permite `ce:GetCostAndUsage`, `ce:GetCostForecast`, `ce:GetDimensionValues`, `ce:GetTags`, `ce:GetUsageForecast`, `ce:ListCostCategoryDefinitions` y `budgets:ViewBudget`.
- `arn:aws:iam::137819318729:role/clinicaclick-audit-prod-writer-role`: confiado al principal SSO temporal de aprovisionamiento. Permite `s3:PutObject` solo bajo `app/*` del bucket de auditoria y uso de la KMS de auditoria para cifrar/generar data keys. No puede leer ni borrar.
- `arn:aws:iam::137819318729:role/clinicaclick-audit-prod-reader-role`: confiado al principal SSO temporal de aprovisionamiento. Permite listar/leer bajo `app/*` y descifrar con la KMS de auditoria. No puede escribir ni borrar.
- `arn:aws:iam::137819318729:role/clinicaclick-audit-prod-retention-admin-role`: confiado al principal SSO temporal de aprovisionamiento. Permite administrar lifecycle, cifrado, public access block y bucket policy del bucket de auditoria, y describir/leer policy/rotacion de la KMS de auditoria. No concede borrado de objetos ni desactivacion/borrado de KMS.

Claves KMS:

- Integraciones/secrets: `alias/clinicaclick/integrations/prod/secrets`; ARN observado desde metadata del secreto ficticio: `arn:aws:kms:eu-west-3:137819318729:key/15864f4f-2db5-485b-a49f-303c57eedc59`.
- Integraciones/payload: `alias/clinicaclick/integrations/prod/payload`; ARN exacto no capturado despues de expirar la sesion. Recuperar con `PayloadKmsKeyArn` en salidas CloudFormation o `aws kms list-aliases --region eu-west-3`.
- Auditoria/logs: `alias/clinicaclick/audit/prod/logs`; `arn:aws:kms:eu-west-3:137819318729:key/9be75437-51b7-4462-80e1-36ac6c6f6e8a`.

Instancia, red y SSM:

- Instancia: `i-0cf40cfe823f160fa`, `t3.small`, Amazon Linux 2023, volumen root gp3 de 20 GiB cifrado, IMDSv2 obligatorio, CPU credits `standard`.
- IP publica fija de salida: `13.39.100.55`.
- VPC dedicada `10.74.0.0/24`; Subnet publica `10.74.0.0/28`; los IDs `VpcId`, `SubnetId` y `SecurityGroupId` no quedaron capturados antes de expirar la sesion, pero estan en las salidas del stack.
- Security group: sin reglas de entrada; salida TCP/443 a `0.0.0.0/0`.
- SSM: gestion por `AmazonSSMManagedInstanceCore`; no hay SSH key pair en la plantilla.

Retencion y auditoria efectiva:

- Bucket auditoria: `clinicaclick-integrations-prod-foun-auditlogbucket-3fmfqc6v8ktu`.
- Public Access Block: `BlockPublicAcls=true`, `IgnorePublicAcls=true`, `BlockPublicPolicy=true`, `RestrictPublicBuckets=true`.
- Versionado: `Enabled`.
- Cifrado: SSE-KMS por defecto con la KMS de auditoria y bucket keys.
- Lifecycle: regla `retain-current-audit-objects` habilitada. La plantilla define `ExpirationInDays=183` y `NoncurrentVersionExpiration.NoncurrentDays=183`; se verifico `NoncurrentDays=183`. Regla adicional de abortar multipart incompletos a 7 dias.
- Object Lock: no habilitado.
- CloudTrail regional: `arn:aws:cloudtrail:eu-west-3:137819318729:trail/clinicaclick-integrations-prod-regional-trail`, bucket `clinicaclick-integrations-prod-fo-cloudtrailbucket-hpys0qkunpro`, logging activo, validacion de logs habilitada, eventos de gestion read/write, no multi-region, sin errores de entrega observados.
- Budget efectivo: `clinicaclick-integrations-prod-monthly-budget`, limite `60 USD`, avisos efectivos verificados `ACTUAL > 80%`, `ACTUAL > 100%`, `FORECASTED > 100%`.
- Diferencia respecto a CloudFormation: la plantilla local incluye los tres avisos de Budget, pero el stack vivo puede no reflejar el aviso `ACTUAL > 100%` dentro del recurso CloudFormation porque la actualizacion fallo y se hizo rollback. Ese aviso se creo fuera de CloudFormation con Budgets API.
- SNS confirmado: `arn:aws:sns:eu-west-3:137819318729:clinicaclick-integrations-prod-alerts:dca7e56a-a724-4c1c-a0fa-ff8d772e63e4`.

Cost Explorer y etiquetas:

- La plantilla etiqueta recursos compatibles con `application=clinicaclick`, `component=integrations` o `audit`, `environment=prod`, `cost-center=clinicaclick`.
- El Budget usa filtro `TagKeyValue=user:application$clinicaclick`.
- Se creo rol lector de costes, pero no se pudo verificar despues del rollback si Cost Explorer esta activado y si las etiquetas de asignacion de costes (`application`, `component`, `environment`, `cost-center`) estan activas en Billing/Cost Management. Debe confirmarse antes de confiar en informes o budgets filtrados por etiqueta.

Acceso temporal recomendado para el Codex de implementacion:

Usar IAM Identity Center/SSO con un permission set nuevo, temporal y minimo, no el permission set administrativo `codex-clinicaclick-prov-temp`. La recomendacion oficial de AWS es usar federacion/credenciales temporales para usuarios humanos y aplicar minimo privilegio.

Cambio concreto pendiente de aprobacion:

```text
Crear permission set SSO temporal:
Nombre: codex-clinicaclick-impl-readonly-temp
Sesion: 1 hora
Cuenta: 137819318729
Asignar a: usuario/grupo SSO del Codex de implementacion

Permitir solo lectura de infraestructura:
- sts:GetCallerIdentity
- cloudformation:DescribeStacks, DescribeStackResources, DescribeStackEvents, GetTemplate, ListStackResources
- ec2:DescribeInstances, DescribeVpcs, DescribeSubnets, DescribeSecurityGroups, DescribeAddresses, DescribeRouteTables, DescribeInternetGateways, DescribeVolumes, DescribeTags
- iam:GetRole, iam:GetRolePolicy, iam:ListRolePolicies, iam:ListAttachedRolePolicies, iam:GetInstanceProfile
- kms:DescribeKey, kms:ListAliases, kms:GetKeyRotationStatus
- secretsmanager:DescribeSecret sobre /clinicaclick/integrations/prod/*
- s3:GetBucketLocation, GetBucketVersioning, GetBucketEncryption, GetBucketLifecycleConfiguration, GetBucketPublicAccessBlock, GetBucketPolicy sobre buckets de auditoria y CloudTrail
- logs:DescribeLogGroups, logs:DescribeLogStreams
- cloudtrail:DescribeTrails, cloudtrail:GetTrailStatus, cloudtrail:GetEventSelectors
- budgets:ViewBudget
- ce:GetCostAndUsage, ce:GetCostForecast, ce:GetDimensionValues, ce:GetTags, ce:ListCostAllocationTags

Denegar/no conceder:
- secretsmanager:GetSecretValue
- ssm:StartSession
- ssm:SendCommand
- s3:GetObject sobre logs de auditoria por defecto
- cualquier Put*, Update*, Delete*, Create* fuera del propio permission set aprobado
- access keys permanentes
- permisos AdministratorAccess
```

Texto de aprobacion sugerido:

```text
Autorizo crear el permission set SSO temporal `codex-clinicaclick-impl-readonly-temp` y asignarlo al usuario/grupo SSO del Codex de implementacion en la cuenta `137819318729`, con la politica minima de lectura indicada en `propuesta-aprobacion.md`.
No autorizo access keys permanentes, permisos administrativos, `secretsmanager:GetSecretValue`, `ssm:StartSession`, `ssm:SendCommand`, lectura de objetos de auditoria ni cambios de infraestructura.
```

Faltantes expresos:

- No se capturaron `VpcId`, `SubnetId`, `SecurityGroupId`, `InstancePrivateIp`, `InstanceProfileArn`, `DeploymentRoleArn`, `CostReaderRoleArn` ni `PayloadKmsKeyArn` antes de expirar la sesion de navegador/CloudShell; estan disponibles como salidas CloudFormation o por `describe-*`.
- No se verifico activacion efectiva de Cost Explorer ni tags de asignacion de costes tras el rollback.
- No se hizo import/reconciliacion CloudFormation del aviso Budget `ACTUAL > 100%` creado por API.
- No se reviso ni cambio cifrado de la BD de ClinicaClick.
- No se conecto la aplicacion ClinicaClick al writer de auditoria.
