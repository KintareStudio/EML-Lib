# Integración de Kintare en EML 2.8

`KintareClient` agrupa autenticación OIDC, perfiles, guardarropas, renderizado y preparación del agente. Cada cliente representa un despliegue y comparte su descubrimiento entre módulos. La librería no guarda contraseñas ni cuentas en disco.

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
  // Opcionales: las extensiones no publicadas por el servidor se pueden configurar aquí.
  endpoints: {
    render: 'https://render.example.com'
  },
  // Opcional: por ejemplo, net.fetch de Electron con la política TLS de la aplicación.
  fetch: (url, init) => fetch(url, init)
})

const account = await kintare.auth.auth(showDeviceCode, selectMinecraftProfile)
```

El emisor conserva su ruta de montaje. El documento `/.well-known/openid-configuration` relativo al emisor resuelve `device_authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `kintare_services_url`, `kintare_sessions_url` y las entradas de `kintare_yggdrasil`. Se comprueba que su `issuer`, cuando existe, coincida con el configurado. No hay una caché de endpoints compartida entre despliegues.

Los endpoints explícitos prevalecen sobre el descubrimiento. En una instalación propia se aceptan el origen del emisor, los orígenes configurados explícitamente y `trustedOrigins`. Se exige HTTPS; HTTP se admite exclusivamente en loopback para desarrollo. Las URLs con credenciales, query o fragmento se rechazan. En el despliegue predeterminado se permiten los dominios de Kintare `kintarestudio.com` y `kintare.studio`. Un despliegue privado nunca usa producción como alternativa para enviar sus credenciales si falla el descubrimiento.

El descubrimiento correcto se conserva una hora; un fallo se conserva un minuto para evitar solicitudes repetidas. Las extensiones opcionales `kintare_render_url` y `kintare_auth_agent_url` se aprovechan cuando están presentes. No se necesita cambiarlas en el servidor: `endpoints` permite configurarlas desde el consumidor.

## Guardarropas y perfiles

```ts
const wardrobe = await kintare.wardrobes.get(account, profileId)
const texture = await kintare.wardrobes.upload(account, profileId, 'skin', pngBytes)
const slot = await kintare.wardrobes.save(account, profileId, {
  name: 'Exploración',
  skinTextureId: texture.id,
  skinModel: 'classic',
  capeTextureId: null
})
await kintare.wardrobes.activate(account, profileId, slot.id)
await kintare.wardrobes.duplicate(account, profileId, slot.id)
await kintare.wardrobes.delete(account, profileId, slot.id)
```

Los tipos de guardarropas son públicos. `validateTexture` comprueba tamaño, cabecera y dimensiones antes de subir; el servidor valida y decodifica la imagen completa. Abrir un guardarropa es una lectura y no crea conjuntos ni importa texturas. El selector de archivos, sus identificadores temporales y las comprobaciones de cuenta/perfil mientras el diálogo está abierto pertenecen al host.

`kintare.avatarUrl(nameOrUuid, cacheKey?)` construye la URL pública de la cara desde el endpoint de renderizado descubierto o configurado. Codifica la identidad y el parámetro opcional de caché; no necesita ni devuelve credenciales. Las vistas del launcher usan este método a través de IPC. El host mantiene su política de imágenes y CSP, que debe permitir los orígenes que haya configurado. El subpath puro `@kintare/eml-lib/profiles` permite compartir `canManageProfiles` con la interfaz sin cargar el punto de entrada de Node.

`selectableProfiles(account, managed)` combina los perfiles propios y los administrados cuando la cuenta tiene autoridad. `reconcileProfiles(account, profiles, 'first')` permite conservar la política de selección del launcher. Sin ese tercer argumento mantiene el comportamiento previo, que exige selección explícita cuando quedan varios perfiles.

`kintare.profiles.lookupManaged(account, nameOrUuid)` y `addManaged(account, profile, existing)` comprueban la autoridad administrativa, normalizan UUID y evitan duplicados. `actions(account)` consulta las acciones pendientes del perfil seleccionado; una cuenta sin perfil devuelve una lista vacía sin hacer solicitudes.

## Recuperación de cuentas

`kintare.sessions.restore(account, managed, onOffline)` renueva la sesión y reconcilia su selección con los perfiles disponibles. Devuelve `ready`, `invalid`, `offline` o `error`, junto con la cuenta y, cuando procede, los perfiles administrados actualizados. Un límite de solicitudes no invalida la cuenta. Si falla la consulta de perfiles después de renovar el token, conserva la cuenta renovada.

`kintare.sessions.refreshAccounts(accounts)` devuelve las cuentas actualizadas, los errores por cuenta y el estado de conexión. Se detiene cuando detecta una desconexión. El host decide cuándo ejecutarlo y persiste las actualizaciones; debe comprobar que la cuenta siga guardada y que su credencial no haya cambiado mientras esperaba la respuesta.

## Sesiones de juego

`ensureSession(account)` comparte las renovaciones concurrentes del mismo refresh token y conserva los datos de selección de cada consumidor. Los tokens renovados siguen siendo credenciales OIDC; su persistencia corresponde al host.

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

La cuenta entregada a Minecraft lleva la credencial de juego; no debe reemplazar la cuenta OIDC persistida. `release()` revoca únicamente esa sesión y es idempotente, incluso con llamadas concurrentes. El `finally` cubre errores de configuración, descarga y arranque además de la salida normal. `allowOffline` permite continuar por fallos de conexión; un rechazo explícito o un límite de solicitudes no se interpreta como desconexión.

## Instancias protegidas

`ProfileAccess` recibe URL de AdminTool y un adaptador de credenciales `{ get(slug), set(slug, password) }`. El host puede implementarlo con `safeStorage` u otro almacén cifrado. Los tokens son temporales, quedan en memoria y se renuevan con margen antes de expirar. Las llamadas concurrentes comparten la autenticación y olvidar una instancia invalida las respuestas pendientes.

`check(slug, renew?)` devuelve estados sin credenciales. Solo un HTTP 401 con la negativa JSON de la aplicación descarta una contraseña guardada. 403, 404, 429, errores de red, 5xx y respuestas malformadas la conservan. `Profile.metadata(account, token)` consulta metadatos con una credencial gestionada externamente sin autenticar otra vez. `Profile.auth()` conserva su API y publica los errores de EML correspondientes.

`Profile.search(query, account)` busca por identificador, slug o nombre y no hace solicitudes con una consulta vacía. `Profile.refresh(slug, account, token, previous)` actualiza los metadatos y devuelve `{ profile, tokenRejected }`: ante un bearer rechazado consulta la versión pública y conserva la dirección anterior si la respuesta protegida la oculta. Solo un 401 señala que hay que olvidar el bearer; nunca descarta la contraseña. Ambos métodos omiten tokens de sus resultados. La persistencia y la comprobación de que siga seleccionada la misma instancia corresponden al host.

## Agente, archivos y configuración

`await kintare.authAgent(cacheDirectory, 'loki.jar')` usa por defecto el último release estable de `KintareStudio/Loki`. Consulta la API de GitHub y selecciona el único JAR cuyo nombre cumple `Loki-<versión>.jar`. El transporte sigue las redirecciones y se comprueba que la URL que comunica sea HTTPS y pertenezca a GitHub o sus servidores de archivos. También verifica el tamaño y el digest SHA-256 publicado por GitHub, cuando existe. Nunca envía tokens de Kintare a esas solicitudes.

`ensure(onProgress)` comparte descargas concurrentes y realiza la instalación mediante archivo temporal. Guarda la identidad del release, el digest local y el ETag del documento de GitHub. Un 304 o un digest idéntico evita descargar otra vez el JAR; antes de reutilizarlo comprueba que el archivo local siga coincidiendo. Una descarga inválida conserva la copia anterior. Sin conexión o ante un límite de GitHub, reutiliza la caché válida, incluida la copia `loki.jar` de versiones anteriores del launcher. Sin una copia válida, devuelve `null` y el host bloquea el arranque.

`authAgentRelease` permite elegir otro repositorio o seleccionar un nombre/patrón de asset. Una instalación que aloje su propio agente puede configurar `authAgentRelease: false` y `endpoints.authAgent`; la clase genérica `AuthAgent` también admite una URL directa y un SHA-256 esperado. La política TLS la aporta el transporte. `authAgentArguments(jarPath)` prepara la integración de Loki con el host de autenticación configurado, independientemente del origen del JAR.

Las exclusiones conservan el comportamiento de EML oficial: `ignored` reemplaza la lista predeterminada. `ignoredMode: 'extend'` permite ampliarla; `additionalIgnored` añade exclusiones sin reemplazarla. `USER_DATA_IGNORED_PATHS` ofrece protecciones adicionales que el consumidor puede activar explícitamente. `preserveExisting` evita sobrescribir archivos del usuario, sin hacer copias y restauraciones sobre el resultado de una actualización:

```ts
cleaning: {
  enabled: true,
  preserveExisting: ['options.txt', 'optionsof.txt', 'config/']
}
```

La conservación es optativa. Para que el modpack actualice una configuración, no se debe incluir ese archivo en `preserveExisting`. Los archivos nuevos se descargan normalmente. Los mundos y otros datos del usuario están protegidos frente a la limpieza por defecto; las rutas se comparan por componentes y no se recorren enlaces simbólicos.

`normalizeMemory`, `parseMemoryMB`, `javaConfiguration` y las utilidades de direcciones de servidores son públicas. Los subpaths `@kintare/eml-lib/configuration` y `@kintare/eml-lib/server-target` son módulos puros aptos para la interfaz. Una selección manual de Java debe guardar la ruta real; las marcas antiguas `path`/`custom` exigen volver a elegirla.

`jvmArguments({ optimization, debug }, existing)` compone los argumentos opcionales conservando los argumentos existentes y evitando duplicados. Mantiene las opciones que ya usaba el launcher; no detecta su compatibilidad con una versión concreta de Java.

`configureHttp({ fetch })` configura el transporte predeterminado de las clases existentes, incluidos manifiestos y descargas, sin reemplazar `globalThis.fetch`. Los clientes nuevos también admiten un transporte por instancia. `EMLLibError` expone `status`, `serverCode` y `cause`; `isEmlNetworkError` no trata errores de configuración ni límites de solicitudes como desconexiones. `new CrashReport(url, { cooldownMs: 600_000 })` activa el periodo de espera que se consulta con `canSend()`. Sin opciones conserva el comportamiento de EML oficial, sin límite local adicional; el consentimiento y su interfaz permanecen en el host.

`Bootstrap.checkForUpdate()`, `download()` y `runUpdate()` comparten la operación pendiente de su mismo tipo. Un timeout de la interfaz no permite iniciar otra descarga o instalación simultánea; cuando la operación termina o falla, una llamada posterior puede reintentarlo. La inicialización del actualizador también se comparte. Durante una instalación pendiente prevalece el valor `silent` de la primera llamada.

`Maintenance(url, account?)` admite consultas antes de iniciar sesión. `getActiveMaintenance(now?)` aplica la política que usaba el launcher: devuelve la ventana publicada cuando ya empezó y la cuenta no tiene `canBypass`. Conserva el comportamiento anterior respecto a `endTime`: el servidor determina cuándo deja de publicar esa ventana. `getMaintenance()` sigue devolviendo los datos sin aplicar esta política.

## Responsabilidades del launcher

La aplicación conserva IPC, ventanas, selectores de archivos, almacenamiento cifrado, preferencias, temporizadores, consentimiento de telemetría y Discord. El panel ARG conserva su vista y su partición de cookies: su intercambio de sesión debe usar el mismo `session.fetch` de Electron que la navegación del panel. Estas integraciones pertenecen a la aplicación y no son necesarias para consumir el cliente Kintare desde otro launcher.

## Desarrollo junto al launcher

Desde `Launcher`, `npm run eml:sync` compila la carpeta hermana `EML-Lib`, genera un paquete con identificador de contenido y actualiza la dependencia local y su lockfile. No publica en npm ni crea instaladores. El paquete queda en `Launcher/vendor` para que un `npm ci` posterior consuma exactamente ese contenido.

Validación de la librería: `npm run test:unit`. El antiguo `npm test` es una demostración que puede descargar y ejecutar Minecraft y no sustituye las pruebas unitarias.
