import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const npm = process.env.npm_execpath
if (!npm) throw Error('Run through npm run test:package')
const temporary = await mkdtemp(path.join(tmpdir(), 'eml-package-'))
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) throw Error(`${result.stdout}\n${result.stderr}`)
  return result.stdout
}
try {
  const packed = JSON.parse(run([npm, 'pack', '--json', '--pack-destination', temporary]))
  const archive = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
  assert.ok(!archive.files.some((file) => file.path.endsWith('/errors.ts')))
  assert.ok(!archive.files.some((file) => file.path.startsWith('dist/test/')))
  await writeFile(
    path.join(temporary, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { 'eml-lib': `file:${path.join(temporary, archive.filename).replaceAll('\\', '/')}` }
    })
  )
  run([npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], temporary)
  run(
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict'; import EML, { Profile, KintareClient } from 'eml-lib'; import index from 'eml-lib/index.js'; import DeepProfile from 'eml-lib/lib/profile/profile.js'; import { ErrorType } from 'eml-lib/types/errors.js'; assert.equal(EML,index); assert.equal(EML.Profiles,Profile); assert.equal(Profile,DeepProfile); assert.equal(EML.Bootstraps,EML.Bootstrap); assert.equal(typeof KintareClient,'function'); assert.equal(ErrorType.AUTH_ERROR,'AUTH_ERROR');`
    ],
    temporary
  )
  await writeFile(
    path.join(temporary, 'consumer.mts'),
    `
import EML, { type Account, type Config, type IProfile, KintareClient, EMLLibError, ErrorType } from 'eml-lib'
import DeepProfile from 'eml-lib/lib/profile/profile.js'
import index from 'eml-lib/index.js'
import { normalizeMemory } from 'eml-lib/configuration'
import { canManageProfiles } from 'eml-lib/profiles'
declare const account: Account
const config: Config = { root: 'fixture', account, minecraft: { version: '1.21.1' }, cleaning: { ignored: ['custom/'] } }
const launcher = new EML.Launcher(config)
const profiles: Promise<IProfile[]> = new DeepProfile('https://fixture.invalid', account).getProfiles(account)
const token: Promise<{ slug: string; token: string }> = new EML.Profiles('https://fixture.invalid').auth('pack', 'password')
new EML.Maintenance('https://fixture.invalid', account)
new EML.Bootstraps('https://fixture.invalid')
new EML.CrashReport('https://fixture.invalid')
new EMLLibError(ErrorType.AUTH_ERROR, 'Fixture')
new index.News('https://fixture.invalid')
const avatar: Promise<string> = new KintareClient().avatarUrl('Fixture')
void [launcher, profiles, token, avatar, normalizeMemory(), canManageProfiles('admin')]
`
  )
  await writeFile(
    path.join(temporary, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2021',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        typeRoots: [path.join(root, 'node_modules/@types')]
      },
      files: ['consumer.mts']
    })
  )
  run([path.join(root, 'node_modules/typescript/bin/tsc'), '--project', path.join(temporary, 'tsconfig.json')])
  const installed = JSON.parse(await readFile(path.join(temporary, 'node_modules/eml-lib/package.json'), 'utf8'))
  assert.equal(installed.name, '@kintare/eml-lib')
  console.log('PASS: tarball installs as eml-lib; upstream aliases, deep imports, optional Kintare imports and external TypeScript consumer work.')
} finally {
  const target = await realpath(temporary)
  const parent = await realpath(tmpdir())
  if (path.dirname(target) !== parent || !path.basename(target).startsWith('eml-package-'))
    throw Error('Unexpected temporary directory; cleanup refused')
  await rm(target, { recursive: true, force: true })
}
