import { expect, it } from 'vitest'

import {
  buildClashProfile,
  buildProfileFromTemplate,
  chooseProfile,
  cloneInboundForPort,
  isPortProbeFailureMessage,
  needsExtraInbound,
  parseInstallResult,
  pickRandomPort,
  profileHasServer,
  selectCloneSource,
  selectUpdateBody,
  summarizeInbounds,
  syncServerProxies,
  validateNextPort,
} from './port-switch'

const envText = `
# comment
XUI_USERNAME=admin
XUI_PASSWORD=secret
XUI_PANEL_PORT=2053
XUI_WEB_BASE_PATH=/panel/
XUI_ACCESS_URL=http://203.0.113.10:2053/panel/
XUI_API_TOKEN=token-1
XUI_DB_TYPE=sqlite
登录后可在面板创建 VLESS Reality 入站
`

const realityInbound = (
  remark: string,
  port: number,
  publicKey: string,
  shortId: string,
  email = 'zhilian',
) => ({
  remark,
  port,
  enable: true,
  settings: {
    clients: [{ id: 'uuid-1', email, flow: 'xtls-rprx-vision' }],
  },
  streamSettings: {
    network: 'tcp',
    security: 'reality',
    realitySettings: {
      serverNames: ['www.cloudflare.com'],
      shortIds: [shortId],
      settings: {
        publicKey,
        fingerprint: 'chrome',
        spiderX: '/spx',
      },
    },
  },
})

it('parses install-result.env and ignores extra lines', () => {
  const panel = parseInstallResult(envText)
  expect(panel.server).toBe('203.0.113.10')
  expect(panel.panelPort).toBe(2053)
  expect(panel.webBasePath).toBe('/panel/')
  expect(panel.apiToken).toBe('token-1')
})

it('rejects a port that is empty, the same, locked, or the panel port', () => {
  expect(() => validateNextPort(8443, 443, 2053)).toThrow(/443 端口不可更改/)
  expect(() => validateNextPort(443, 1001, 2053)).toThrow(/443 端口不可更改/)
  expect(() => validateNextPort(0, 1001, 2053)).toThrow(/1 到 65535/)
  expect(() => validateNextPort(1001, 1001, 2053)).toThrow(/相同/)
  expect(() => validateNextPort(2053, 1001, 2053)).toThrow(/面板端口/)
  expect(() => validateNextPort(8443, 1001, 2053)).not.toThrow()
})

it('picks a random port outside occupied and locked ports', () => {
  const values = [0.0, 0.5, 0.999]
  let index = 0
  const port = pickRandomPort(2053, [1001, 443], () => values[index++] ?? 0)
  expect(port).toBeGreaterThanOrEqual(10000)
  expect(port).toBeLessThanOrEqual(65000)
  expect(port).not.toBe(2053)
  expect(port).not.toBe(443)
  expect(port).not.toBe(1001)
})

it('detects hard TCP probe failures', () => {
  expect(isPortProbeFailureMessage('connection timed out')).toBe(true)
  expect(isPortProbeFailureMessage('Connection refused')).toBe(true)
  expect(isPortProbeFailureMessage('connection reset by peer')).toBe(false)
})

it('summarizes inbounds and builds an update body without traffic stats', () => {
  const inbounds = summarizeInbounds([
    {
      id: 3,
      port: 443,
      protocol: 'vless',
      remark: 'sg',
      enable: true,
      clientStats: [],
    },
  ])
  expect(inbounds).toEqual([
    { id: 3, remark: 'sg', protocol: 'vless', port: 443, enable: true },
  ])

  const body = selectUpdateBody(
    { id: 3, port: 443, protocol: 'vless', clientStats: [{ email: 'a' }] },
    8443,
  )
  expect(body).toEqual({ id: 3, port: 8443, protocol: 'vless' })
})

it('mirrors panel inbounds and drops stale ports for the same server', () => {
  const yaml = [
    'mixed-port: 7890',
    'proxies:',
    '  - { name: stale-1000, server: 203.0.113.10, port: 1000, uuid: u }',
    '  - { name: other, server: 198.51.100.8, port: 443, uuid: u }',
    'proxy-groups:',
    '  - { name: Proxy, type: select, proxies: [stale-1000, other] }',
  ].join('\n')

  const result = syncServerProxies(yaml, '203.0.113.10', [
    realityInbound('sg-xy', 1001, 'pk-a', 'b7'),
    realityInbound('sg-xy-2', 443, 'pk-b', 'a4'),
  ])

  expect(result.updated).toBe(true)
  expect(result.yaml).not.toContain('port: 1000')
  expect(result.yaml).not.toContain('stale-1000')
  expect(result.yaml).toContain('port: 1001')
  expect(result.yaml).toContain('port: 443')
  expect(result.yaml).toContain('public-key: pk-a')
  expect(result.yaml).toContain('public-key: pk-b')
  expect(result.yaml).toContain('server: 198.51.100.8, port: 443')
  expect(result.yaml).toContain('sg-xy-zhilian-1001')
  expect(result.yaml).toContain('sg-xy-2-zhilian-443')
  expect(result.yaml).toContain('other')
  expect(result.yaml).not.toMatch(/proxies: \[[^\]]*stale-1000/)
})

it('prefers the current local profile for the same server', () => {
  const chosen = chooseProfile(
    [
      {
        uid: 'remote',
        type: 'remote',
        name: 'sub',
        text: 'server: 203.0.113.10',
        current: true,
      },
      {
        uid: 'local',
        type: 'local',
        name: '3xui',
        text: 'server: 203.0.113.10',
        current: false,
      },
    ],
    '203.0.113.10',
  )
  expect(chosen?.uid).toBe('local')
  expect(profileHasServer('servername: example.com', 'example.com')).toBe(false)
})

it('builds a clash profile from a vless reality inbound', () => {
  const yaml = buildClashProfile(
    {
      remark: 'sg-1',
      settings: {
        clients: [{ id: 'uuid-1', flow: 'xtls-rprx-vision' }],
      },
      streamSettings: {
        network: 'tcp',
        security: 'reality',
        realitySettings: {
          serverNames: ['www.cloudflare.com'],
          shortIds: ['abcd'],
          settings: { publicKey: 'pk', fingerprint: 'chrome' },
        },
      },
    },
    '203.0.113.10',
    8443,
  )

  expect(yaml).toContain('server: 203.0.113.10')
  expect(yaml).toContain('port: 8443')
  expect(yaml).toContain('uuid: uuid-1')
  expect(yaml).toContain('public-key: pk')
  expect(yaml).toContain('short-id: abcd')
  expect(yaml).toContain('support-x25519mlkem768: true')
  expect(yaml).toContain('MATCH,Proxy')
})

it('creates another inbound only when 443 is the only enabled port', () => {
  const only443 = [
    { id: 1, remark: 'a', protocol: 'vless', port: 443, enable: true },
    { id: 2, remark: 'b', protocol: 'vless', port: 8443, enable: false },
  ]
  expect(needsExtraInbound(only443)).toBe(true)
  expect(selectCloneSource(only443)?.id).toBe(1)
  expect(
    needsExtraInbound([
      { port: 443, enable: true },
      { port: 2053, enable: true },
    ]),
  ).toBe(false)
  expect(needsExtraInbound([])).toBe(false)
})

it('clones an inbound onto a new port and keeps the existing client uuid', () => {
  const cloned = cloneInboundForPort(
    {
      remark: 'sg-1',
      protocol: 'vless',
      listen: '',
      settings: {
        clients: [
          { id: 'uuid-1', email: 'alice', flow: 'xtls-rprx-vision' },
          { id: 'uuid-2', email: 'bob', flow: '' },
        ],
        decryption: 'none',
      },
      streamSettings: { network: 'tcp', security: 'reality' },
      sniffing: { enabled: true },
    },
    18443,
  )
  const settings = JSON.parse(String(cloned.settings)) as {
    decryption: string
    clients: { id: string; email: string; flow: string }[]
  }
  expect(cloned.port).toBe(18443)
  expect(cloned.protocol).toBe('vless')
  expect(settings.decryption).toBe('none')
  expect(settings.clients.map((item) => item.id)).toEqual(['uuid-1', 'uuid-2'])
  expect(settings.clients.map((item) => item.email)).toEqual([
    'alice-18443',
    'bob-18443',
  ])
  expect(settings.clients[0]?.flow).toBe('xtls-rprx-vision')
  expect(JSON.parse(String(cloned.streamSettings))).toEqual({
    network: 'tcp',
    security: 'reality',
  })
})

it('splices panel nodes into the gen_3xui template groups and rules', () => {
  const template = [
    'mixed-port: 7890',
    'proxies:',
    '  - { name: old, type: vless, server: 1.1.1.1, port: 443 }',
    'proxy-groups:',
    '  - { name: 牛掰, type: select, proxies: [old] }',
    'rules:',
    '  - MATCH,牛掰',
    '',
  ].join('\n')
  const yaml = buildProfileFromTemplate(
    template,
    [
      realityInbound('sg-1', 443, 'pk', 'abcd'),
      realityInbound('sg-1', 18443, 'pk', 'abcd'),
    ],
    '203.0.113.10',
  )
  expect(yaml.startsWith('mixed-port: 7890\nproxies:\n')).toBe(true)
  expect(yaml).toContain('port: 443')
  expect(yaml).toContain('port: 18443')
  expect(yaml).toContain('uuid: uuid-1')
  expect(yaml).not.toContain('name: old')
  expect(yaml).toContain('name: 牛掰')
  expect(yaml).toContain('name: 自动选择')
  expect(yaml).toContain('name: 故障转移')
  expect(yaml.trimEnd().endsWith('MATCH,牛掰')).toBe(true)
})
