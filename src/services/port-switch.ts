export interface PanelConfig {
  username: string
  password: string
  panelPort: number
  webBasePath: string
  accessUrl: string
  apiToken: string
  server: string
}

export interface InboundSummary {
  id: number
  remark: string
  protocol: string
  port: number
  enable: boolean
}

export interface ProfileCandidate {
  uid: string
  type: string
  name: string
  text: string
  current: boolean
}

const ENV_KEYS = {
  username: 'XUI_USERNAME',
  password: 'XUI_PASSWORD',
  panelPort: 'XUI_PANEL_PORT',
  webBasePath: 'XUI_WEB_BASE_PATH',
  accessUrl: 'XUI_ACCESS_URL',
  apiToken: 'XUI_API_TOKEN',
} as const

const unquote = (value: string) => {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const parseEnvMap = (text: string) => {
  const map = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    map.set(trimmed.slice(0, index).trim(), unquote(trimmed.slice(index + 1)))
  }
  return map
}

const withSlash = (value: string) => {
  const trimmed = value.trim() || '/'
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return prefixed.endsWith('/') ? prefixed : `${prefixed}/`
}

export const parseInstallResult = (text: string): PanelConfig => {
  const map = parseEnvMap(text)
  const accessUrl = map.get(ENV_KEYS.accessUrl) ?? ''
  const apiToken = map.get(ENV_KEYS.apiToken) ?? ''
  if (!accessUrl || !apiToken) {
    throw new Error('install-result.env 里缺少面板地址或 API Token')
  }

  let parsed: URL
  try {
    parsed = new URL(accessUrl)
  } catch {
    throw new Error('面板地址无法解析')
  }
  const server = parsed.hostname
  if (!server) {
    throw new Error('面板地址里没有服务器')
  }

  const panelPort = Number(map.get(ENV_KEYS.panelPort) ?? parsed.port)
  return {
    username: map.get(ENV_KEYS.username) ?? '',
    password: map.get(ENV_KEYS.password) ?? '',
    panelPort: Number.isInteger(panelPort) ? panelPort : 0,
    webBasePath: withSlash(map.get(ENV_KEYS.webBasePath) ?? parsed.pathname),
    accessUrl,
    apiToken,
    server,
  }
}

export const panelApiBases = (panel: PanelConfig) => {
  const origin = new URL(panel.accessUrl).origin
  const fromBasePath = `${origin}${withSlash(panel.webBasePath)}`
  const fromAccess = panel.accessUrl.endsWith('/')
    ? panel.accessUrl
    : `${panel.accessUrl}/`
  return fromBasePath === fromAccess
    ? [fromBasePath]
    : [fromBasePath, fromAccess]
}

/** Inbound ports that must not be switched away from. */
export const LOCKED_INBOUND_PORTS = [443] as const

export const isInboundPortLocked = (port: number) =>
  LOCKED_INBOUND_PORTS.includes(port as (typeof LOCKED_INBOUND_PORTS)[number])

/** True when every enabled inbound is on 443, so a second port has to be created. */
export const needsExtraInbound = (
  inbounds: { port: number; enable: boolean }[],
) => {
  const enabled = inbounds.filter((item) => item.enable)
  return enabled.length > 0 && enabled.every((item) => item.port === 443)
}

export const selectCloneSource = (inbounds: InboundSummary[]) => {
  const on443 = inbounds.filter((item) => item.enable && item.port === 443)
  return (
    on443.find((item) => item.protocol.toLowerCase() === 'vless') ??
    on443[0] ??
    null
  )
}

/** Same file `gen_3xui_config.py` splices into. */
export const CLASH_PROFILE_TEMPLATE =
  '/Users/jack/IdeaProjects/ops-tool/deploy-bwh/3xui-example.yaml'

export const validateNextPort = (
  value: number,
  currentPort: number,
  panelPort: number,
) => {
  if (isInboundPortLocked(currentPort)) {
    throw new Error(`${currentPort} 端口不可更改`)
  }
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('端口需要是 1 到 65535 的整数')
  }
  if (panelPort > 0 && value === panelPort) {
    throw new Error('这个端口是面板端口，不能用作入站')
  }
  if (isInboundPortLocked(value)) {
    throw new Error(`${value} 端口不可更改`)
  }
  if (value === currentPort) {
    throw new Error('新端口和当前入站端口相同')
  }
}

const RANDOM_PORT_MIN = 10000
const RANDOM_PORT_MAX = 65000

/** Pick an unused inbound port outside locked / panel / existing ports. */
export const pickRandomPort = (
  panelPort: number,
  occupiedPorts: number[],
  random: () => number = Math.random,
) => {
  const blocked = new Set<number>([
    ...LOCKED_INBOUND_PORTS,
    ...occupiedPorts.filter((port) => Number.isInteger(port)),
  ])
  if (panelPort > 0) blocked.add(panelPort)

  for (let attempt = 0; attempt < 64; attempt += 1) {
    const span = RANDOM_PORT_MAX - RANDOM_PORT_MIN + 1
    const value = RANDOM_PORT_MIN + Math.floor(random() * span)
    if (!blocked.has(value)) return value
  }
  throw new Error('没有可用的随机端口')
}

/** Classify probe errors: true means the TCP path almost certainly failed. */
export const isPortProbeFailureMessage = (message: string) => {
  const msg = message.toLowerCase()
  return (
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('connection refused') ||
    msg.includes('connect failed') ||
    msg.includes('could not connect') ||
    msg.includes('failed to connect') ||
    msg.includes('os error 61') ||
    msg.includes('os error 111') ||
    msg.includes('os error 10061') ||
    msg.includes('network is unreachable')
  )
}

export const summarizeInbounds = (value: unknown): InboundSummary[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const id = Number(record.id)
    const port = Number(record.port)
    if (!Number.isInteger(id) || !Number.isInteger(port)) return []
    return [
      {
        id,
        remark: String(record.remark ?? record.tag ?? `入站 ${id}`),
        protocol: String(record.protocol ?? ''),
        port,
        enable: record.enable !== false,
      },
    ]
  })
}

export const selectUpdateBody = (
  inbound: Record<string, unknown>,
  port: number,
) => {
  const body: Record<string, unknown> = { ...inbound, port }
  delete body.clientStats
  return body
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const profileHasServer = (text: string, server: string) => {
  const pattern = new RegExp(
    `server:\\s*['"]?${escapeRegExp(server)}['"]?(?:\\s|,|}|$)`,
  )
  return pattern.test(text)
}

const proxyItems = (yaml: string) => {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => /^proxies:\s*$/.test(line))
  if (start < 0) return []

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index])) {
      end = index
      break
    }
  }

  const items: { start: number; end: number }[] = []
  let itemStart = -1
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*-\s+/.test(lines[index])) {
      if (itemStart >= 0) items.push({ start: itemStart, end: index })
      itemStart = index
    }
  }
  if (itemStart >= 0) items.push({ start: itemStart, end })
  return items.map((item) => ({ ...item, lines }))
}

const readProxyName = (text: string) => {
  const flow = text.match(/\bname:\s*['"]([^'"]+)['"]/)
  if (flow?.[1]) return flow[1]
  const plain = text.match(/\bname:\s*([^,}\n]+)/)
  return plain?.[1]?.trim() ?? ''
}

const writeProxyName = (text: string, nextName: string) => {
  const quoted = yamlScalar(nextName)
  if (/\bname:\s*['"][^'"]+['"]/.test(text)) {
    return text.replace(/\bname:\s*['"][^'"]+['"]/, `name: ${quoted}`)
  }
  return text.replace(/\bname:\s*[^,}\n]+/, `name: ${quoted}`)
}

const nextProxyName = (
  currentName: string,
  currentPort: number | undefined,
  nextPort: number,
) => {
  if (!currentName) return `proxy-${nextPort}`
  if (currentPort !== undefined && currentName.endsWith(`-${currentPort}`)) {
    return `${currentName.slice(0, -(String(currentPort).length + 1))}-${nextPort}`
  }
  if (currentName.endsWith(`-${nextPort}`)) return currentName
  return `${currentName}-${nextPort}`
}

const itemHasPort = (text: string, port: number) =>
  new RegExp(`port:\\s*${port}(?:\\s|,|}|$)`).test(text)

const insertProxyNameInGroups = (
  yaml: string,
  oldName: string,
  nextName: string,
) => {
  if (!oldName || !nextName || oldName === nextName) return yaml
  const escaped = escapeRegExp(oldName)
  const already = new RegExp(
    `proxies:\\s*\\[[^\\]]*\\b${escapeRegExp(nextName)}\\b`,
  )
  if (already.test(yaml)) return yaml

  // Flow-style: proxies: [..., oldName, ...]
  let next = yaml.replace(
    new RegExp(`(proxies:\\s*\\[[^\\]]*?)(\\b${escaped}\\b)([^\\]]*?\\])`, 'g'),
    (full, before: string, name: string, after: string) => {
      if (after.includes(nextName) || before.includes(nextName)) return full
      return `${before}${name}, ${nextName}${after}`
    },
  )

  // Block-style list item under proxies:
  next = next.replace(
    new RegExp(`^([ \\t]*-\\s+)${escaped}\\s*$`, 'gm'),
    (full, prefix: string) => `${full}\n${prefix}${nextName}`,
  )
  return next
}

/** Keep the old proxy entry and append a clone with the new port. */
export const replaceProxyPort = (
  yaml: string,
  server: string,
  nextPort: number,
  currentPort?: number,
) => {
  const items = proxyItems(yaml).filter((item) =>
    profileHasServer(item.lines.slice(item.start, item.end).join('\n'), server),
  )
  if (
    items.some((item) =>
      itemHasPort(item.lines.slice(item.start, item.end).join('\n'), nextPort),
    )
  ) {
    return { yaml, replaced: true }
  }

  const matched =
    currentPort === undefined
      ? items
      : items.filter((item) =>
          itemHasPort(
            item.lines.slice(item.start, item.end).join('\n'),
            currentPort,
          ),
        )
  const target = (matched.length > 0 ? matched : items).slice(0, 1)
  if (target.length === 0) {
    return { yaml, replaced: false }
  }

  const item = target[0]
  const chunk = item.lines.slice(item.start, item.end)
  const sourceText = chunk.join('\n')
  const oldName = readProxyName(sourceText)
  const newName = nextProxyName(oldName, currentPort, nextPort)

  const cloned = chunk.map((line) => {
    let next = line
    if (/port:\s*\d+/.test(next)) {
      next = next.replace(/port:\s*\d+/, `port: ${nextPort}`)
    }
    if (/\bname:\s*/.test(next) && oldName) {
      next = writeProxyName(next, newName)
    }
    return next
  })

  const lines = yaml.split('\n')
  lines.splice(item.end, 0, ...cloned)
  const withProxy = lines.join('\n')
  const withGroups = insertProxyNameInGroups(withProxy, oldName, newName)
  return { yaml: withGroups, replaced: true }
}

export const chooseProfile = (profiles: ProfileCandidate[], server: string) => {
  const matched = profiles.filter((item) => profileHasServer(item.text, server))
  const rank = (item: ProfileCandidate) => {
    if (item.current && item.type === 'local') return 0
    if (item.type === 'local') return 1
    if (item.current) return 2
    return 3
  }
  return matched.sort((a, b) => rank(a) - rank(b))[0] ?? null
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
    return null
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

const yamlScalar = (value: string) => {
  if (/^[A-Za-z0-9_.:@/-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "''")}'`
}

const jsonField = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value ?? {})

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * Copy an inbound onto a new port. Client UUIDs stay the same so existing
 * users keep working. Emails get a port suffix because the panel requires
 * them to be unique across inbounds.
 */
export const cloneInboundForPort = (
  source: Record<string, unknown>,
  port: number,
) => {
  const settings = asRecord(source.settings) ?? {}
  const rawClients = Array.isArray(settings.clients) ? settings.clients : []
  const clients = rawClients.flatMap((item, index) => {
    const client = asRecord(item)
    if (!client) return []
    const id = firstString(client.id, client.password)
    if (!id) return []
    const email = firstString(client.email)
    return [
      {
        id,
        email: email ? `${email}-${port}` : `client-${port}-${index + 1}`,
        flow: firstString(client.flow),
        enable: client.enable !== false,
        limitIp: client.limitIp ?? 0,
        totalGB: client.totalGB ?? 0,
        expiryTime: client.expiryTime ?? 0,
        tgId: client.tgId ?? 0,
        comment: firstString(client.comment),
      },
    ]
  })
  if (clients.length === 0) {
    throw new Error('现有入站没有客户端，无法新增端口')
  }
  const remark = firstString(source.remark, 'vless')
  return {
    enable: true,
    remark: `${remark}-${port}`,
    listen: typeof source.listen === 'string' ? source.listen : '',
    port,
    protocol: firstString(source.protocol, 'vless'),
    expiryTime: source.expiryTime ?? 0,
    total: source.total ?? 0,
    settings: JSON.stringify({ ...settings, clients }),
    streamSettings: jsonField(source.streamSettings),
    sniffing: jsonField(source.sniffing),
  }
}

export const buildClashProxy = (
  inbound: Record<string, unknown>,
  server: string,
  port: number,
) => {
  const settings = asRecord(inbound.settings)
  const clients = Array.isArray(settings?.clients) ? settings.clients : []
  const client = asRecord(clients[0]) ?? {}
  const uuid = firstString(client.id, client.password)
  if (!uuid) {
    throw new Error('入站里没有客户端 ID，无法生成 Clash 配置')
  }

  const stream = asRecord(inbound.streamSettings)
  const reality = asRecord(stream?.realitySettings)
  const realitySettings = asRecord(reality?.settings) ?? {}
  const publicKey = firstString(realitySettings.publicKey, reality?.publicKey)
  const shortIds = Array.isArray(reality?.shortIds) ? reality.shortIds : []
  const serverNames = Array.isArray(reality?.serverNames)
    ? reality.serverNames
    : []
  const shortId = firstString(
    realitySettings.shortId,
    shortIds[0],
    reality?.shortId,
  )
  const serverName = firstString(
    realitySettings.serverName,
    serverNames[0],
    reality?.serverName,
  )
  const fingerprint = firstString(realitySettings.fingerprint, 'chrome')
  const flow = firstString(client.flow)
  const network = firstString(stream?.network, 'tcp')
  const remark = firstString(inbound.remark, inbound.tag, `vless-${server}`)
  const baseName = remark.replace(/[,[\]{}]/g, '-').trim() || `vless-${server}`
  const clientTag = firstString(client.email, client.remark)
  // Always include port so multi-port nodes never collide (mihomo rejects
  // duplicate proxy names across the enhanced/runtime config).
  const name = (
    clientTag ? `${baseName}-${clientTag}-${port}` : `${baseName}-${port}`
  )
    .replace(/[,[\]{}]/g, '-')
    .trim()

  const parts = [
    `name: ${yamlScalar(name)}`,
    'type: vless',
    `server: ${yamlScalar(server)}`,
    `port: ${port}`,
    `uuid: ${yamlScalar(uuid)}`,
    'udp: true',
    'encryption: none',
    `network: ${yamlScalar(network)}`,
    `client-fingerprint: ${yamlScalar(fingerprint)}`,
  ]
  if (flow) parts.splice(6, 0, `flow: ${yamlScalar(flow)}`)
  if (stream?.security === 'reality' || serverName) {
    parts.push('tls: true', 'skip-cert-verify: false')
  }
  if (serverName) parts.push(`servername: ${yamlScalar(serverName)}`)
  if (publicKey || shortId) {
    const realityParts = [
      `public-key: ${yamlScalar(publicKey)}`,
      `short-id: ${yamlScalar(shortId)}`,
      'support-x25519mlkem768: true',
    ]
    const spiderX = firstString(realitySettings.spiderX)
    if (spiderX) realityParts.push(`spider-x: ${yamlScalar(spiderX)}`)
    parts.push(`reality-opts: { ${realityParts.join(', ')} }`)
  }

  return {
    name,
    line: `  - { ${parts.join(', ')} }`,
  }
}

const withProxyName = (line: string, name: string) => writeProxyName(line, name)

const rewriteFlowGroupMembers = (
  yaml: string,
  removeNames: string[],
  addNames: string[],
) => {
  const remove = new Set(removeNames.filter(Boolean))
  if (remove.size === 0 && addNames.length === 0) return yaml
  return yaml.replace(/proxies:\s*\[([^\]]*)\]/g, (_full, inner: string) => {
    const parts = inner
      .split(',')
      .map((part: string) => part.trim())
      .filter(Boolean)
    const hadRemoved = parts.some((part) => remove.has(part))
    if (!hadRemoved) return `proxies: [${parts.join(', ')}]`
    const kept = parts.filter((part) => !remove.has(part))
    for (const name of addNames) {
      if (name && !kept.includes(name)) kept.push(name)
    }
    return `proxies: [${kept.join(', ')}]`
  })
}

const rewriteBlockGroupMembers = (
  yaml: string,
  removeNames: string[],
  addNames: string[],
) => {
  const remove = new Set(removeNames.filter(Boolean))
  if (remove.size === 0) return yaml
  const lines = yaml.split('\n')
  const result: string[] = []
  let inGroupProxies = false
  let proxiesIndent = ''
  let inserted = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // Only proxy-group member lists are indented; top-level `proxies:` is not.
    if (/^\s{2,}proxies:\s*$/.test(line)) {
      inGroupProxies = true
      proxiesIndent = `${line.match(/^\s*/)?.[0] ?? ''}  `
      inserted = false
      result.push(line)
      continue
    }
    if (inGroupProxies) {
      if (/^\S/.test(line) || (/^\s*\S/.test(line) && !/^\s*-\s+/.test(line))) {
        if (!inserted) {
          for (const name of addNames) {
            if (name) result.push(`${proxiesIndent}- ${name}`)
          }
          inserted = true
        }
        inGroupProxies = false
        result.push(line)
        continue
      }
      const member = line.match(/^\s*-\s+(.+?)\s*$/)?.[1]
      if (member && remove.has(member)) {
        if (!inserted) {
          for (const name of addNames) {
            if (name) result.push(`${proxiesIndent}- ${name}`)
          }
          inserted = true
        }
        continue
      }
      result.push(line)
      continue
    }
    result.push(line)
  }
  if (inGroupProxies && !inserted) {
    for (const name of addNames) {
      if (name) result.push(`${proxiesIndent}- ${name}`)
    }
  }
  return result.join('\n')
}

/**
 * Replace every Clash proxy for `server` with nodes built from the live
 * panel inbound list. Old ports / stale Reality keys are dropped.
 */
export const syncServerProxies = (
  yaml: string,
  server: string,
  inbounds: Record<string, unknown>[],
) => {
  const built: { name: string; line: string }[] = []
  const usedNames = new Set<string>()
  for (const inbound of inbounds) {
    if (inbound.enable === false) continue
    const port = Number(inbound.port)
    if (!Number.isInteger(port) || port < 1) continue
    try {
      let proxy = buildClashProxy(inbound, server, port)
      if (usedNames.has(proxy.name)) {
        const unique = `${proxy.name}-${built.length + 1}`
        proxy = { name: unique, line: withProxyName(proxy.line, unique) }
      }
      usedNames.add(proxy.name)
      built.push(proxy)
    } catch {
      // Skip inbounds without a usable client / Reality payload.
    }
  }

  const items = proxyItems(yaml)
  const serverItems = items.filter((item) =>
    profileHasServer(item.lines.slice(item.start, item.end).join('\n'), server),
  )
  const oldNames = serverItems
    .map((item) =>
      readProxyName(item.lines.slice(item.start, item.end).join('\n')),
    )
    .filter(Boolean)
  const newNames = built.map((item) => item.name)

  const lines = yaml.split('\n')
  for (const item of [...serverItems].reverse()) {
    lines.splice(item.start, item.end - item.start)
  }

  let nextLines = lines
  const proxiesStart = nextLines.findIndex((row) => /^proxies:\s*$/.test(row))
  if (proxiesStart < 0) {
    return { yaml, names: newNames, updated: false }
  }
  let insertAt = proxiesStart + 1
  for (let index = proxiesStart + 1; index < nextLines.length; index += 1) {
    if (/^\S/.test(nextLines[index])) break
    insertAt = index + 1
  }
  nextLines = [
    ...nextLines.slice(0, insertAt),
    ...built.map((item) => item.line),
    ...nextLines.slice(insertAt),
  ]

  let next = nextLines.join('\n')
  next = rewriteFlowGroupMembers(next, oldNames, newNames)
  next = rewriteBlockGroupMembers(next, oldNames, newNames)
  return { yaml: next, names: newNames, updated: true }
}

const collectClashProxies = (
  inbounds: Record<string, unknown>[],
  server: string,
) => {
  const built: { name: string; line: string }[] = []
  const usedNames = new Set<string>()
  for (const inbound of inbounds) {
    if (inbound.enable === false) continue
    const port = Number(inbound.port)
    if (!Number.isInteger(port) || port < 1) continue
    try {
      let proxy = buildClashProxy(inbound, server, port)
      if (usedNames.has(proxy.name)) {
        const unique = `${proxy.name}-${built.length + 1}`
        proxy = { name: unique, line: withProxyName(proxy.line, unique) }
      }
      usedNames.add(proxy.name)
      built.push(proxy)
    } catch {
      continue
    }
  }
  return built
}

export const splitClashTemplate = (text: string) => {
  const proxies = text.search(/^proxies:\s*$/m)
  const rules = text.search(/^rules:\s*$/m)
  if (proxies < 0 || rules <= proxies) {
    throw new Error('配置模板缺少 proxies 或 rules')
  }
  return {
    header: text.slice(0, proxies),
    rules: text.slice(rules),
  }
}

/** Same splice as gen_3xui_config.py: template header + rules, one proxy per inbound. */
export const buildProfileFromTemplate = (
  template: string,
  inbounds: Record<string, unknown>[],
  server: string,
) => {
  const built = collectClashProxies(inbounds, server)
  if (built.length === 0) {
    throw new Error('面板入站里没有可同步的客户端')
  }
  const { header, rules } = splitClashTemplate(template)
  const list = built.map((item) => yamlScalar(item.name)).join(', ')
  const groups = [
    'proxy-groups:',
    `  - { name: 牛掰, type: select, proxies: [自动选择, 故障转移, DIRECT, ${list}] }`,
    `  - { name: 自动选择, type: url-test, proxies: [${list}], url: 'https://www.gstatic.com/generate_204', interval: 300, tolerance: 50 }`,
    `  - { name: 故障转移, type: fallback, proxies: [${list}], url: 'https://www.gstatic.com/generate_204', interval: 300 }`,
    '',
  ].join('\n')
  return `${header}proxies:\n${built.map((item) => item.line).join('\n')}\n${groups}${rules}`
}

export const buildClashProfileFromInbounds = (
  inbounds: Record<string, unknown>[],
  server: string,
) => {
  const built = collectClashProxies(inbounds, server)
  if (built.length === 0) {
    throw new Error('面板入站里没有可同步的客户端')
  }
  const names = built.map((item) => item.name)
  return [
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'ipv6: false',
    'proxies:',
    ...built.map((item) => item.line),
    'proxy-groups:',
    `  - { name: Proxy, type: select, proxies: [${names.map(yamlScalar).join(', ')}] }`,
    'rules:',
    '  - MATCH,Proxy',
    '',
  ].join('\n')
}

export const buildClashProfile = (
  inbound: Record<string, unknown>,
  server: string,
  port: number,
) => buildClashProfileFromInbounds([{ ...inbound, port, enable: true }], server)
