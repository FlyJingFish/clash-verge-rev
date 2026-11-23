import { open } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { fetch } from '@tauri-apps/plugin-http'
import { extractErrorMessage } from 'foxts/extract-error-message'
import { getBaseConfig } from 'tauri-plugin-mihomo-api'

import {
  createProfile,
  deleteProfile,
  enhanceProfiles,
  getAppDir,
  getProfiles,
  patchProfilesConfig,
  readProfileFile,
  saveProfileFile,
} from '@/services/cmds'

import {
  buildClashProfileFromInbounds,
  buildProfileFromTemplate,
  chooseProfile,
  CLASH_PROFILE_TEMPLATE,
  cloneInboundForPort,
  type InboundSummary,
  type PanelConfig,
  isPortProbeFailureMessage,
  needsExtraInbound,
  panelApiBases,
  parseInstallResult,
  pickRandomPort,
  profileHasServer,
  selectCloneSource,
  selectUpdateBody,
  summarizeInbounds,
  syncServerProxies,
  validateNextPort,
} from './port-switch'

const STORE_NAME = 'port-switch.json'

export interface PortSwitchState {
  panel: PanelConfig
  inboundId: number | null
}

export interface SwitchPortResult {
  port: number
  profileName: string
  createdProfile: boolean
  remoteProfile: boolean
  nodeCount: number
  inbounds: InboundSummary[]
}

export interface SyncPanelResult {
  profileName: string
  createdProfile: boolean
  remoteProfile: boolean
  nodeCount: number
  inbounds: InboundSummary[]
}

export interface ImportProfileResult {
  profileName: string
  createdProfile: boolean
  createdPort: number | null
  nodeCount: number
  inbounds: InboundSummary[]
}

interface PanelEnvelope {
  success?: boolean
  msg?: string
  obj?: unknown
}

const storePath = (dir: string) =>
  dir.endsWith('/') || dir.endsWith('\\')
    ? `${dir}${STORE_NAME}`
    : `${dir}/${STORE_NAME}`

const readState = async (): Promise<PortSwitchState | null> => {
  try {
    const dir = await getAppDir()
    const text = await readTextFile(storePath(dir))
    const parsed = JSON.parse(text) as PortSwitchState
    if (!parsed?.panel?.accessUrl || !parsed.panel.apiToken) return null
    return parsed
  } catch {
    return null
  }
}

const writeState = async (state: PortSwitchState) => {
  const dir = await getAppDir()
  await writeTextFile(storePath(dir), JSON.stringify(state))
}

const panelError = (payload: PanelEnvelope, status: number) => {
  if (payload.success === false) return payload.msg || '面板请求失败'
  if (status >= 400) return payload.msg || `面板返回 ${status}`
  return ''
}

const asErrorMessage = (error: unknown) =>
  extractErrorMessage(error) ||
  (typeof error === 'string' ? error : '') ||
  '无法连接面板'

type PanelProxy = {
  all:
    | string
    | {
        url: string
        basicAuth?: { username: string; password: string }
        noProxy?: string
      }
}

/**
 * plugin-http uses the OS system proxy when `proxy` is omitted, so a "direct"
 * retry still goes through Clash and comes back as an empty 502. A dummy proxy
 * with `noProxy: *` disables that and dials the panel directly.
 */
const DIRECT_PANEL_PROXY: PanelProxy = {
  all: { url: 'http://127.0.0.1:9', noProxy: '*' },
}

const resolveMixedProxy = async (): Promise<PanelProxy | undefined> => {
  try {
    const { mixedPort, authentication } = await getBaseConfig()
    if (!Number.isInteger(mixedPort) || mixedPort < 1) return undefined
    const proxyUrl = `http://127.0.0.1:${mixedPort}`
    const proxyAuthentication = authentication?.[0]
    if (proxyAuthentication === undefined) return { all: proxyUrl }
    const authSeparator = proxyAuthentication.indexOf(':')
    if (authSeparator < 0) return { all: proxyUrl }
    return {
      all: {
        url: proxyUrl,
        basicAuth: {
          username: proxyAuthentication.slice(0, authSeparator),
          password: proxyAuthentication.slice(authSeparator + 1),
        },
      },
    }
  } catch {
    return undefined
  }
}

const readPanelPayload = async (response: Response) => {
  const text = await response.text()
  if (!text.trim()) {
    throw new Error(
      response.status
        ? `面板返回空响应 (${response.status})`
        : '面板返回空响应',
    )
  }
  try {
    return JSON.parse(text) as PanelEnvelope
  } catch {
    throw new Error(
      `面板返回的不是 JSON (${response.status}): ${text.slice(0, 120)}`,
    )
  }
}

const requestPanel = async (
  panel: PanelConfig,
  path: string,
  init?: { method?: string; body?: string },
) => {
  let lastError = '无法连接面板'
  const proxy = await resolveMixedProxy()
  // Prefer Clash mixed-port first when available: direct paths from CN are flaky.
  // Always follow with a real direct attempt. Omitting `proxy` is not direct.
  const proxyModes: PanelProxy[] = proxy
    ? [proxy, DIRECT_PANEL_PROXY]
    : [DIRECT_PANEL_PROXY]

  for (const base of panelApiBases(panel)) {
    for (const proxyOption of proxyModes) {
      try {
        const response = await fetch(`${base}${path.replace(/^\//, '')}`, {
          method: init?.method ?? 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${panel.apiToken}`,
            ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: init?.body,
          connectTimeout: 15000,
          ...(proxyOption ? { proxy: proxyOption } : {}),
        })
        const payload = await readPanelPayload(response)
        const message = panelError(payload, response.status)
        if (message) {
          lastError = message
          continue
        }
        return payload
      } catch (error) {
        lastError = asErrorMessage(error)
      }
    }
  }
  throw new Error(lastError)
}

export const loadPortSwitchState = readState

export const importInstallResultFromPath = async (path: string) => {
  const panel = parseInstallResult(await readTextFile(path))
  const state = { panel, inboundId: null }
  await writeState(state)
  return state
}

export const importInstallResult = async () => {
  const selected = await open({
    multiple: false,
    title: '选择 install-result.env',
    filters: [{ name: 'env', extensions: ['env', 'txt'] }],
  })
  if (typeof selected !== 'string') return null
  return importInstallResultFromPath(selected)
}

/** Drop the generated local profile and the saved panel, back to an empty page. */
export const clearImportedConfig = async (panel: PanelConfig) => {
  const name = `3xui-${panel.server}`
  const profiles = await getProfiles()
  const existing = profiles.items?.find(
    (item) => item.type === 'local' && item.name === name && item.uid,
  )
  if (existing?.uid) await deleteProfile(existing.uid)
  const dir = await getAppDir()
  await writeTextFile(storePath(dir), '{}')
}

const asInboundRecords = (value: unknown) => {
  if (!Array.isArray(value)) return [] as Record<string, unknown>[]
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    return [item as Record<string, unknown>]
  })
}

export const loadInboundRecords = async (panel: PanelConfig) => {
  const payload = await requestPanel(panel, 'panel/api/inbounds/list')
  return asInboundRecords(payload.obj)
}

export const loadInbounds = async (panel: PanelConfig) => {
  return summarizeInbounds(await loadInboundRecords(panel))
}

const readInbound = async (panel: PanelConfig, inboundId: number) => {
  const payload = await requestPanel(
    panel,
    `panel/api/inbounds/get/${inboundId}`,
  )
  if (
    !payload.obj ||
    typeof payload.obj !== 'object' ||
    Array.isArray(payload.obj)
  ) {
    throw new Error('没有读到这条入站')
  }
  return payload.obj as Record<string, unknown>
}

const saveGeneratedProfile = async (panel: PanelConfig, yaml: string) => {
  const name = `3xui-${panel.server}`
  const profiles = await getProfiles()
  const existing = profiles.items?.find(
    (item) => item.type === 'local' && item.name === name && item.uid,
  )
  if (existing?.uid) {
    const saved = await saveProfileFile(existing.uid, yaml)
    if (!saved) throw new Error('Clash 配置没有保存成功')
    await patchProfilesConfig({ current: existing.uid })
    return { profileName: name, createdProfile: false }
  }
  await createProfile({ type: 'local', name }, yaml)
  const created = (await getProfiles()).items?.find(
    (item) => item.type === 'local' && item.name === name && item.uid,
  )
  if (!created?.uid) throw new Error('新的 Clash 配置没有创建成功')
  await patchProfilesConfig({ current: created.uid })
  return { profileName: name, createdProfile: true }
}

export const importGeneratedProfile = async (
  panel: PanelConfig,
): Promise<ImportProfileResult> => {
  let records = await loadInboundRecords(panel)
  let createdPort: number | null = null
  const summaries = summarizeInbounds(records)
  if (needsExtraInbound(summaries)) {
    const source = selectCloneSource(summaries)
    if (!source) throw new Error('没有可复制的 443 入站')
    const full = await readInbound(panel, source.id)
    const port = pickRandomPort(
      panel.panelPort,
      summaries.map((item) => item.port),
    )
    await requestPanel(panel, 'panel/api/inbounds/add', {
      method: 'POST',
      body: JSON.stringify(cloneInboundForPort(full, port)),
    })
    createdPort = port
    records = await loadInboundRecords(panel)
    if (!summarizeInbounds(records).some((item) => item.port === port)) {
      throw new Error(`面板没有出现新端口 ${port}`)
    }
  }

  let template: string
  try {
    template = await readTextFile(CLASH_PROFILE_TEMPLATE)
  } catch (error) {
    const message = createdPort
      ? `已新增入站端口 ${createdPort}，但找不到配置模板`
      : '找不到配置模板'
    throw new Error(message, { cause: error })
  }

  let yaml: string
  try {
    yaml = buildProfileFromTemplate(template, records, panel.server)
  } catch (error) {
    if (!createdPort) throw error
    const detail = error instanceof Error ? error.message : '配置没有生成'
    throw new Error(`已新增入站端口 ${createdPort}。${detail}`, {
      cause: error,
    })
  }

  try {
    const saved = await saveGeneratedProfile(panel, yaml)
    const enhanced = await enhanceProfiles()
    if (!enhanced) throw new Error('Clash 内核没有重新加载')
    return {
      ...saved,
      createdPort,
      nodeCount: summarizeInbounds(records).filter((item) => item.enable)
        .length,
      inbounds: summarizeInbounds(records),
    }
  } catch (error) {
    if (!createdPort) throw error
    const detail = error instanceof Error ? error.message : '配置没有导入'
    throw new Error(`已新增入站端口 ${createdPort}。${detail}`, {
      cause: error,
    })
  }
}

const findServerProfiles = async (panel: PanelConfig) => {
  const profiles = await getProfiles()
  const current = profiles.current ?? null
  const candidates = []
  for (const item of profiles.items ?? []) {
    if (!item.uid || (item.type !== 'local' && item.type !== 'remote')) continue
    try {
      const text = await readProfileFile(item.uid)
      if (!text || !profileHasServer(text, panel.server)) continue
      candidates.push({
        uid: item.uid,
        type: item.type,
        name: item.name || item.uid,
        text,
        current: item.uid === current,
      })
    } catch {
      continue
    }
  }
  return { profiles, current, chosen: chooseProfile(candidates, panel.server) }
}

const applyServerSync = async (
  panel: PanelConfig,
  records: Record<string, unknown>[],
) => {
  const { chosen } = await findServerProfiles(panel)
  if (chosen) {
    const synced = syncServerProxies(chosen.text, panel.server, records)
    if (!synced.updated) {
      throw new Error('配置里找到了这台服务器，但没有同步成功')
    }
    const saved = await saveProfileFile(chosen.uid, synced.yaml)
    if (!saved) throw new Error('Clash 配置没有保存成功')
    if (!chosen.current) await patchProfilesConfig({ current: chosen.uid })
    return {
      profileName: chosen.name,
      createdProfile: false,
      remoteProfile: chosen.type === 'remote',
      nodeCount: synced.names.length,
    }
  }

  const yaml = buildClashProfileFromInbounds(records, panel.server)
  const name = `3xui-${panel.server}`
  await createProfile({ type: 'local', name }, yaml)
  const created = (await getProfiles()).items?.find(
    (item) => item.type === 'local' && item.name === name && item.uid,
  )
  if (!created?.uid) throw new Error('新的 Clash 配置没有创建成功')
  await patchProfilesConfig({ current: created.uid })
  return {
    profileName: name,
    createdProfile: true,
    remoteProfile: false,
    nodeCount: summarizeInbounds(records).filter((item) => item.enable).length,
  }
}

/** Pull panel inbounds and rewrite local Clash proxies for that server to match. */
export const syncPanelProxies = async (
  panel: PanelConfig,
): Promise<SyncPanelResult> => {
  const records = await loadInboundRecords(panel)
  const inbounds = summarizeInbounds(records)
  const profile = await applyServerSync(panel, records)
  const enhanced = await enhanceProfiles()
  if (!enhanced) {
    throw new Error('Clash 内核没有重新加载')
  }
  return { ...profile, inbounds }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Probe whether host:port accepts TCP (same path a VLESS client needs). */
export const probeServerPort = async (server: string, port: number) => {
  const url = `http://${server}:${port}/`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fetch(url, {
        method: 'GET',
        connectTimeout: 5000,
      })
      return true
    } catch (error) {
      const message = asErrorMessage(error)
      if (!isPortProbeFailureMessage(message)) {
        // Connected enough to fail at HTTP/TLS — port is reachable.
        return true
      }
      if (attempt < 2) await sleep(900)
    }
  }
  return false
}

const updateInboundPort = async (
  panel: PanelConfig,
  inboundId: number,
  full: Record<string, unknown>,
  nextPort: number,
) => {
  const payload = await requestPanel(
    panel,
    `panel/api/inbounds/update/${inboundId}`,
    {
      method: 'POST',
      body: JSON.stringify(selectUpdateBody(full, nextPort)),
    },
  )
  if (payload.success === false) {
    throw new Error(payload.msg || '面板没有改端口')
  }
}

export const switchInboundPort = async (
  panel: PanelConfig,
  inbound: InboundSummary,
  nextPort: number,
  options?: { verifyBeforeSync?: boolean },
): Promise<SwitchPortResult> => {
  validateNextPort(nextPort, inbound.port, panel.panelPort)
  const full = await readInbound(panel, inbound.id)
  const previousPort = inbound.port
  await updateInboundPort(panel, inbound.id, full, nextPort)

  if (options?.verifyBeforeSync) {
    const reachable = await probeServerPort(panel.server, nextPort)
    if (!reachable) {
      try {
        await updateInboundPort(panel, inbound.id, full, previousPort)
      } catch (rollbackError) {
        throw new Error(
          `端口 ${nextPort} 无法连通，且恢复 ${previousPort} 失败：${asErrorMessage(rollbackError)}`,
          { cause: rollbackError },
        )
      }
      throw new Error(
        `端口 ${nextPort} 无法连通（安全组未放行或未监听），已恢复为 ${previousPort}`,
      )
    }
  }

  try {
    const synced = await syncPanelProxies(panel)
    await writeState({ panel, inboundId: inbound.id })
    return { port: nextPort, ...synced }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : '本地配置没有写回去'
    throw new Error(`面板端口已经改为 ${nextPort}。${message}`, {
      cause: error,
    })
  }
}

export const switchInboundPortRandom = async (
  panel: PanelConfig,
  inbound: InboundSummary,
  occupiedPorts: number[],
): Promise<SwitchPortResult> => {
  const nextPort = pickRandomPort(panel.panelPort, [
    ...occupiedPorts,
    inbound.port,
  ])
  return switchInboundPort(panel, inbound, nextPort, {
    verifyBeforeSync: true,
  })
}
