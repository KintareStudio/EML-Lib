# Integraci�n de Kintare en EML 2.8

`KintareClient` agrupa autenticaci�n OIDC, perfiles, guardarropas, renderizado y preparaci�n del agente. Cada cliente representa un despliegue y comparte su descubrimiento entre m�dulos. La librer�a no guarda contrase�as ni cuentas en disco.

```ts
import { KintareClient } from '@kintare/eml-lib'

const kintare = new KintareClient({
  issuer: 'https://accounts.example.com/oidc',
  clientId: 'el-client-id-de-este-launcher',
  trustedOrigins: [
    'https://services.example.com',
    'https://sessions.example.com',
    'https://authserver.example.com'
  ],
  // Opcionales: las extensiones no publicadas por el servidor se pueden configurar aqu�.
  endpoints: {
    render: 'https://render.example.com'
  },
  // Opcional: por ejemplo, net.fetch de Electron con la pol�tica TLS de la aplicaci�n.
  fetch: (url, init) => fetch(url, init)
})

const account = await kintare.auth.auth(showDeviceCode, selectMinecraftProfile)
```

El emisor conserva su ruta de montaje. El documento `/.well-known/openid-configuration` relativo al emisor resuelve `device_authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `kintare_services_url`, `kintare_sessions_url` y las entradas de `kintare_yggdrasil`. Se comprueba que su `issuer`, cuando existe, coincida con el configurado. No hay una cach� de endpoints compartida entre despliegues.

Los endpoints expl�citos prevalecen sobre el descubrimiento. En una instalaci�n propia se aceptan el origen del emisor, los or�genes configurados expl�citamente y `trustedOrigins`. Se exige HTTPS; HTTP se admite exclusivamente en loopback para desarrollo. Las URLs con credenciales, query o fragmento se rechazan. En el despliegue predeterminado se permiten los dominios de Kintare `kintarestudio.com` y `kintare.studio`. Un despliegue privado nunca usa producci�n como alternativa para enviar sus credenciales si falla el descubrimiento.

El descubrimiento correcto se conserva una hora; un fallo se conserva un minuto para evitar solicitudes repetidas. Las extensiones opcionales `kintare_render_url` y `kintare_auth_agent_url` se aprovechan cuando est�n presentes. No se necesita cambiarlas en el servidor: `endpoints` permite configurarlas desde el consumidor.

## Guardarropas y perfiles

```ts
const wardrobe = await kintare.wardrobes.get(account, profileId)
const texture = await kintare.wardrobes.upload(account, profileId, 'skin', pngBytes)
const slot = await kintare.wardrobes.save(account, profileId, {
  name: 'Exploraci�n',
  skinTextureId: texture.id,
  skinModel: 'classic',
  capeTextureId: null
})
await kintare.wardrobes.activate(account, profileId, slot.id)
await kintare.wardrobes.duplicate(account, profileId, slot.id)
await kintare.wardrobes.delete(account, profileId, slot.id)
```

Los tipos de guardarropas son p�blicos. `validateTexture` comprueba tama�o, cabecera y dimensiones antes de subir; el servidor valida y decodifica la imagen completa. Abrir un guardarropa es una lectura y no crea conjuntos ni importa texturas. El selector de archivos, sus identificadores temporales y las comprobaciones de cuenta/perfil mientras el di�logo est� abierto pertenecen al host.

`kintare.avatarUrl(nameOrUuid, cacheKey?)` construye la URL p�blica de la cara desde el endpoint de renderizado descubierto o configurado. Codifica la identidad y el par�metro opcional de cach�; no necesita ni devuelve credenciales. Las vistas del launcher usan este m�todo a trav�s de IPC. El host mantiene su pol�tica de im�genes y CSP, que debe permitir los or�genes que haya configurado. El subpath puro `@kintare/eml-lib/profiles` permite compartir `canManageProfiles` con la interfaz sin cargar el punto de entrada de Node.

`selectableProfiles(account, managed)` combina los perfiles propios y los administrados cuando la cuenta tiene autoridad. `reconcileProfiles(account, profiles, 'first')` permite conservar la pol�tica de selecci�n del launcher. Sin ese tercer argumento mantiene el comportamiento previo, que exige selecci�n expl�cita cuando quedan varios perfiles.

`kintare.profiles.lookupManaged(account, nameOrUuid)` y `addManaged(account, profile, existing)` comprueban la autoridad administrativa, normalizan UUID y evitan duplicados. `actions(account)` consulta las acciones pendientes del perfil seleccionado; una cuenta sin perfil devuelve una lista vac�a sin hacer solicitudes.

## Recuperaci�n de cuentas

`kintare.sessions.restore(account, managed, onOffline)` renueva la sesi�n y reconcilia su selecci�n con los perfiles disponibles. Devuelve `ready`, `invalid`, `offline` o `error`, junto con la cuenta y, cuando procede, los perfiles administrados actualizados. Un l�mite de solicitudes no invalida la cuenta. Si falla la consulta de perfiles despu�s de renovar el token, conserva la cuenta renovada.

`kintare.sessions.refreshAccounts(accounts)` devuelve las cuentas actualizadas, los errores por cuenta y el estado de conexi�n. Se detiene cuando detecta una desconexi�n. El host decide cu�ndo ejecutarlo y persiste las actualizaciones; debe comprobar que la cuenta siga guardada y que su credencial no haya cambiado mientras esperaba la respuesta.

### Revocaci�n remota

`kintare.sessions.check(account, signal)` consulta Accounts con el access token OAuth. Devuelve `active`, `revoked`, `expired`, `invalidated`, `invalid_token`, `unsupported` o `unknown`. Usa `active` para confirmar una cuenta antes de seleccionarla. Conserva las cuentas con resultado `unknown`; incluye el error HTTP o de red para que el host pueda reintentar. `KintareAuth.validate()` sigue disponible para comprobar el vencimiento local.

`kintare.sessions.watch(account, { signal, onRefresh })` escucha los eventos de la cuenta activa. La ruta `/auth/session/events` cuelga del origen de Accounts, incluso con un emisor bajo `/oidc`. Si la conexi�n se interrumpe, la librer�a reconecta con espera progresiva. Ante `expired` o `invalidated` comparte una renovaci�n en curso con otros consumidores de la misma credencial y abre la siguiente conexi�n con el token nuevo. El callback `onRefresh(next, previous)` se espera antes de reconectar para que el host pueda guardar ambos tokens.

```ts
const controller = new AbortController()
const result = await kintare.sessions.watch(activeAccount, {
  signal: controller.signal,
  onRefresh: (next, previous) => saveIfCredentialMatches(previous, next)
})
```

El host cancela el observador al cambiar de cuenta, sustituir sus credenciales por otro flujo o cerrar la aplicaci�n. Una renovaci�n ya aceptada por el servidor puede entregar su reemplazo durante la cancelaci�n; el callback lo guarda �nicamente si la cuenta sigue registrada y conserva la credencial anterior. Al terminar, el resultado incluye la �ltima cuenta observada y uno de estos estados:

- `revoked` confirma el cierre remoto de esa sesi�n.
- `reauthenticate` requiere iniciar sesi�n de nuevo, por ejemplo tras `invalid_grant`.
- `unsupported` indica que Accounts respondi� 404. El host puede mantener su revisi�n horaria en ese servidor.
- `aborted` corresponde al cierre solicitado por el host.

Antes de aplicar un resultado terminal, comprueba que la cuenta activa a�n corresponde a la credencial devuelta. `KintareAuth.checkSession()` y `KintareAuth.watchSession()` ofrecen las mismas operaciones si usas la clase de autenticaci�n directamente.

## Sesiones de juego

`ensureSession(account)` comparte las renovaciones concurrentes del mismo refresh token y conserva los datos de selecci�n de cada consumidor. Los tokens renovados siguen siendo credenciales OIDC; su persistencia corresponde al host.

```ts
const session = await kintare.auth.prepareGameSession(account, {
  allowOffline: true,
  onAccount: (updated) => saveAccountEncrypted(updated),
  onOffline: (source) => showOfflineState(source)
})
try {
  const launcher = new Launcher({ root: 'minecraft', account: session.account })
  await launcher.launch()
} finally {
  await session.release()
}
```

La cuenta entregada a Minecraft lleva la credencial de juego; no debe reemplazar la cuenta OIDC persistida. `release()` revoca �nicamente esa sesi�n y es idempotente, incluso con llamadas concurrentes. El `finally` cubre errores de configuraci�n, descarga y arranque adem�s de la salida normal. `allowOffline` permite continuar por fallos de conexi�n; un rechazo expl�cito o un l�mite de solicitudes no se interpreta como desconexi�n.

## Instancias protegidas

`ProfileAccess` recibe URL de AdminTool y un adaptador de credenciales `{ get(slug), set(slug, password) }`. El host puede implementarlo con `safeStorage` u otro almac�n cifrado. Los tokens son temporales, quedan en memoria y se renuevan con margen antes de expirar. Las llamadas concurrentes comparten la autenticaci�n y olvidar una instancia invalida las respuestas pendientes.

`check(slug, renew?)` devuelve estados sin credenciales. Solo un HTTP 401 con la negativa JSON de la aplicaci�n descarta una contrase�a guardada. 403, 404, 429, errores de red, 5xx y respuestas malformadas la conservan. `Profile.metadata(account, token)` consulta metadatos con una credencial gestionada externamente sin autenticar otra vez. `Profile.auth()` conserva su API y publica los errores de EML correspondientes.

`Profile.search(query, account)` busca por identificador, slug o nombre y no hace solicitudes con una consulta vac�a. `Profile.refresh(slug, account, token, previous)` actualiza los metadatos y devuelve `{ profile, tokenRejected }`: ante un bearer rechazado consulta la versi�n p�blica y conserva la direcci�n anterior si la respuesta protegida la oculta. Solo un 401 se�ala que hay que olvidar el bearer; nunca descarta la contrase�a. Ambos m�todos omiten tokens de sus resultados. La persistencia y la comprobaci�n de que siga seleccionada la misma instancia corresponden al host.

## Agente, archivos y configuraci�n

`await kintare.authAgent(cacheDirectory, 'loki.jar')` usa por defecto el �ltimo release estable de `KintareStudio/Loki`. Consulta la API de GitHub y selecciona el �nico JAR cuyo nombre cumple `Loki-<versi�n>.jar`. El transporte sigue las redirecciones y se comprueba que la URL que comunica sea HTTPS y pertenezca a GitHub o sus servidores de archivos. Tambi�n verifica el tama�o y el digest SHA-256 publicado por GitHub, cuando existe. Nunca env�a tokens de Kintare a esas solicitudes.

`ensure(onProgress)` comparte descargas concurrentes y realiza la instalaci�n mediante archivo temporal. Guarda la identidad del release, el digest local y el ETag del documento de GitHub. Un 304 o un digest id�ntico evita descargar otra vez el JAR; antes de reutilizarlo comprueba que el archivo local siga coincidiendo. Una descarga inv�lida conserva la copia anterior. Sin conexi�n o ante un l�mite de GitHub, reutiliza la cach� v�lida, incluida la copia `loki.jar` de versiones anteriores del launcher. Sin una copia v�lida, devuelve `null` y el host bloquea el arranque.

`authAgentRelease` permite elegir otro repositorio o seleccionar un nombre/patr�n de asset. Una instalaci�n que aloje su propio agente puede configurar `authAgentRelease: false` y `endpoints.authAgent`; la clase gen�rica `AuthAgent` tambi�n admite una URL directa y un SHA-256 esperado. La pol�tica TLS la aporta el transporte. `authAgentArguments(jarPath)` prepara la integraci�n de Loki con el host de autenticaci�n configurado, independientemente del origen del JAR.

El argumento `-javaagent` lleva la URL completa de `/authlib-injector`. Si el despliegue publica sus metadatos en otro origen, especifica la URL completa con `authlibInjectorUrl` al crear el cliente.

Las exclusiones conservan el comportamiento de EML oficial: `ignored` reemplaza la lista predeterminada. `ignoredMode: 'extend'` permite ampliarla; `additionalIgnored` a�ade exclusiones sin reemplazarla. `USER_DATA_IGNORED_PATHS` ofrece protecciones adicionales que el consumidor puede activar expl�citamente. `preserveExisting` evita sobrescribir archivos del usuario, sin hacer copias y restauraciones sobre el resultado de una actualizaci�n:

```ts
cleaning: {
  enabled: true,
  preserveExisting: ['options.txt', 'optionsof.txt', 'config/']
}
```

La conservaci�n es optativa. Para que el modpack actualice una configuraci�n, no se debe incluir ese archivo en `preserveExisting`. Los archivos nuevos se descargan normalmente. Los mundos y otros datos del usuario est�n protegidos frente a la limpieza por defecto; las rutas se comparan por componentes y no se recorren enlaces simb�licos.

`normalizeMemory`, `parseMemoryMB`, `javaConfiguration` y las utilidades de direcciones de servidores son p�blicas. Los subpaths `@kintare/eml-lib/configuration` y `@kintare/eml-lib/server-target` son m�dulos puros aptos para la interfaz. Una selecci�n manual de Java debe guardar la ruta real; las marcas antiguas `path`/`custom` exigen volver a elegirla.

`jvmArguments({ optimization, debug }, existing)` compone los argumentos opcionales conservando los argumentos existentes y evitando duplicados. Mantiene las opciones que ya usaba el launcher; no detecta su compatibilidad con una versi�n concreta de Java.

`configureHttp({ fetch })` configura el transporte predeterminado de las clases existentes, incluidos manifiestos y descargas, sin reemplazar `globalThis.fetch`. Los clientes nuevos tambi�n admiten un transporte por instancia. `EMLLibError` expone `status`, `serverCode` y `cause`; `isEmlNetworkError` no trata errores de configuraci�n ni l�mites de solicitudes como desconexiones. `new CrashReport(url, { cooldownMs: 600_000 })` activa el periodo de espera que se consulta con `canSend()`. Sin opciones conserva el comportamiento de EML oficial, sin l�mite local adicional; el consentimiento y su interfaz permanecen en el host.

`Bootstrap.checkForUpdate()`, `download()` y `runUpdate()` comparten la operaci�n pendiente de su mismo tipo. Un timeout de la interfaz no permite iniciar otra descarga o instalaci�n simult�nea; cuando la operaci�n termina o falla, una llamada posterior puede reintentarlo. La inicializaci�n del actualizador tambi�n se comparte. Durante una instalaci�n pendiente prevalece el valor `silent` de la primera llamada.

`Maintenance(url, account?)` admite consultas antes de iniciar sesi�n. `getActiveMaintenance(now?)` aplica la pol�tica que usaba el launcher: devuelve la ventana publicada cuando ya empez� y la cuenta no tiene `canBypass`. Conserva el comportamiento anterior respecto a `endTime`: el servidor determina cu�ndo deja de publicar esa ventana. `getMaintenance()` sigue devolviendo los datos sin aplicar esta pol�tica.

## Responsabilidades del launcher

La aplicaci�n conserva IPC, ventanas, selectores de archivos, almacenamiento cifrado, preferencias, temporizadores, consentimiento de telemetr�a y Discord. El panel ARG conserva su vista y su partici�n de cookies: su intercambio de sesi�n debe usar el mismo `session.fetch` de Electron que la navegaci�n del panel. Estas integraciones pertenecen a la aplicaci�n y no son necesarias para consumir el cliente Kintare desde otro launcher.

## Desarrollo junto al launcher

Desde `Launcher`, `npm run eml:sync` compila la carpeta hermana `EML-Lib`, genera un paquete con identificador de contenido y actualiza la dependencia local y su lockfile. No publica en npm ni crea instaladores. El paquete queda en `Launcher/vendor` para que un `npm ci` posterior consuma exactamente ese contenido.

Validaci�n de la librer�a: `npm run test:unit`. El antiguo `npm test` es una demostraci�n que puede descargar y ejecutar Minecraft y no sustituye las pruebas unitarias.
