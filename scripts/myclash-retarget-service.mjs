import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const destination = join(root, 'myclash', 'clash-verge-service-ipc')
const sourceFlag = process.argv.indexOf('--from')
const source = sourceFlag === -1 ? '' : process.argv[sourceFlag + 1]

if (source) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  execFileSync('rsync', [
    '-a',
    '--exclude',
    'target',
    '--exclude',
    '.git',
    `${source}/`,
    `${destination}/`,
  ])
}

const ipcToken = '__MYCLASH_KEEP_SERVICE_IPC__'
const crateToken = '__MYCLASH_KEEP_SERVICE_CRATE__'
const replacements = [
  ['clash-verge-service-ipc', ipcToken],
  ['clash_verge_service_ipc', crateToken],
  ['verge-mihomo-alpha', 'myclash-mihomo-alpha'],
  ['verge-mihomo-al', 'myclash-mihomo-'],
  ['verge-mihomo', 'myclash-mihomo'],
  [
    'io.github.clash-verge-rev.clash-verge-rev.dev.service',
    'io.myclash.app.dev.service',
  ],
  ['io.github.clash-verge-rev.clash-verge-rev.dev', 'io.myclash.app.dev'],
  [
    'io.github.clash-verge-rev.clash-verge-rev.service',
    'io.myclash.app.service',
  ],
  ['io.github.clash-verge-rev.clash-verge-rev', 'io.myclash.app'],
  ['clash-verge-service-dev', 'myclash-service-dev'],
  ['clash-verge-service-install', 'myclash-service-install'],
  ['clash-verge-service-uninstall', 'myclash-service-uninstall'],
  ['clash-verge-service', 'myclash-service'],
  ['clash_verge_service_dev', 'myclash_service_dev'],
  ['clash_verge_service', 'myclash_service'],
  ['clash-verge-ser', 'myclash-service'],
  ['Clash Verge Development Service', 'MyClash Development Service'],
  ['Clash Verge Service', 'MyClash Service'],
  [ipcToken, 'clash-verge-service-ipc'],
  [crateToken, 'clash_verge_service_ipc'],
  ['["myclash-service", "myclash-service"]', '["myclash-service"]'],
]

const textExtensions = new Set([
  '.rs',
  '.toml',
  '.md',
  '.json',
  '.yml',
  '.yaml',
  '.nsi',
  '.plist',
  '.tmpl',
])

function visit(directory) {
  for (const name of readdirSync(directory)) {
    if (name === 'target' || name === '.git' || name === 'Cargo.lock') continue
    const path = join(directory, name)
    const info = statSync(path)
    if (info.isDirectory()) {
      visit(path)
      continue
    }
    if (![...textExtensions].some((extension) => name.endsWith(extension)))
      continue
    const original = readFileSync(path, 'utf8')
    let next = original
    for (const [from, to] of replacements) next = next.replaceAll(from, to)
    if (next !== original) writeFileSync(path, next)
  }
}

visit(destination)
console.log(`retargeted ${destination}`)
