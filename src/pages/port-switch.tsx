import { SwapHorizOutlined } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Radio,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useLockFn } from 'ahooks'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseDialog, BasePage } from '@/components/base'
import {
  isInboundPortLocked,
  type InboundSummary,
  type PanelConfig,
} from '@/services/port-switch'
import {
  clearImportedConfig,
  importGeneratedProfile,
  importInstallResult,
  importInstallResultFromPath,
  loadPortSwitchState,
  switchInboundPort,
  switchInboundPortRandom,
  syncPanelProxies,
} from '@/services/port-switch-client'

const pickDroppedInstallResult = (paths: string[]) => {
  const nameOf = (file: string) => file.split(/[/\\]/).pop() ?? file
  return (
    paths.find((file) => /install-result\.env$/i.test(nameOf(file))) ??
    paths.find((file) => /\.(env|txt)$/i.test(file)) ??
    paths[0] ??
    null
  )
}

const PortSwitchPage = () => {
  const { t } = useTranslation()
  const [panel, setPanel] = useState<PanelConfig | null>(null)
  const [inbounds, setInbounds] = useState<InboundSummary[]>([])
  const [inboundId, setInboundId] = useState<number | null>(null)
  const [nextPort, setNextPort] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const applyInbounds = (
    items: InboundSummary[],
    preferredId: number | null,
  ) => {
    setInbounds(items)
    const selected =
      items.find((item) => item.id === preferredId) ??
      items.find((item) => item.enable) ??
      items[0]
    setInboundId(selected?.id ?? null)
  }

  const syncFromServer = useLockFn(
    async (current: PanelConfig, preferredId: number | null) => {
      setLoading(true)
      setError('')
      try {
        const result = await syncPanelProxies(current)
        applyInbounds(result.inbounds, preferredId)
        setMessage(
          t('layout.portSwitch.synced', {
            count: result.nodeCount,
            profile: result.profileName,
          }),
        )
        return result
      } catch (cause) {
        setInbounds([])
        setError(cause instanceof Error ? cause.message : String(cause))
        return null
      } finally {
        setLoading(false)
      }
    },
  )

  useEffect(() => {
    let cancelled = false
    void loadPortSwitchState().then(async (state) => {
      if (cancelled || !state) return
      setPanel(state.panel)
      setLoading(true)
      setError('')
      try {
        const result = await syncPanelProxies(state.panel)
        if (!cancelled) {
          applyInbounds(result.inbounds, state.inboundId)
          setMessage(
            t('layout.portSwitch.synced', {
              count: result.nodeCount,
              profile: result.profileName,
            }),
          )
        }
      } catch (cause) {
        if (!cancelled) {
          setInbounds([])
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [t])

  const loadInstallResult = useLockFn(async (path: string | null) => {
    setError('')
    setMessage('')
    try {
      const state = path
        ? await importInstallResultFromPath(path)
        : await importInstallResult()
      if (!state) return
      setPanel(state.panel)
      setLoading(true)
      const result = await importGeneratedProfile(state.panel)
      applyInbounds(result.inbounds, null)
      setMessage(
        result.createdPort
          ? t('layout.portSwitch.importedWithPort', {
              port: result.createdPort,
              count: result.nodeCount,
              profile: result.profileName,
            })
          : t('layout.portSwitch.importedProfile', {
              count: result.nodeCount,
              profile: result.profileName,
            }),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  })

  const deleteConfig = useLockFn(async () => {
    if (!panel) return
    setError('')
    setMessage('')
    setLoading(true)
    try {
      await clearImportedConfig(panel)
      setPanel(null)
      setInbounds([])
      setInboundId(null)
      setNextPort('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setConfirmDelete(false)
      setLoading(false)
    }
  })

  const loadInstallResultRef = useRef(loadInstallResult)
  loadInstallResultRef.current = loadInstallResult

  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | undefined
    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      const { payload } = event
      if (payload.type === 'enter' || payload.type === 'over') {
        setDragging((current) => (current ? current : true))
        return
      }
      setDragging(false)
      if (payload.type !== 'drop') return
      const path = pickDroppedInstallResult(payload.paths)
      if (!path) return
      void loadInstallResultRef.current(path)
    })
    void unlisten.then((fn) => {
      if (disposed) fn()
      else cleanup = fn
    })
    return () => {
      disposed = true
      cleanup?.()
    }
  }, [])

  const applySwitchResult = (
    result: Awaited<ReturnType<typeof switchInboundPort>>,
    inbound: InboundSummary,
  ) => {
    const switched = t('layout.portSwitch.switched', {
      port: result.port,
      profile: result.profileName,
    })
    setMessage(
      result.remoteProfile
        ? `${switched} ${t('layout.portSwitch.remoteWarning')}`
        : `${switched} ${t('layout.portSwitch.synced', {
            count: result.nodeCount,
            profile: result.profileName,
          })}`,
    )
    setNextPort('')
    applyInbounds(result.inbounds, inbound.id)
  }

  const switchPort = useLockFn(async () => {
    const inbound = inbounds.find((item) => item.id === inboundId)
    if (!panel || !inbound) return
    setError('')
    setMessage('')
    setLoading(true)
    try {
      const result = await switchInboundPort(panel, inbound, Number(nextPort))
      applySwitchResult(result, inbound)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  })

  const switchPortRandom = useLockFn(async () => {
    const inbound = inbounds.find((item) => item.id === inboundId)
    if (!panel || !inbound) return
    setError('')
    setMessage('')
    setLoading(true)
    try {
      setMessage(t('layout.portSwitch.randomTesting'))
      const result = await switchInboundPortRandom(
        panel,
        inbound,
        inbounds.map((item) => item.port),
      )
      applySwitchResult(result, inbound)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setMessage('')
    } finally {
      setLoading(false)
    }
  })

  const selected = inbounds.find((item) => item.id === inboundId)

  return (
    <BasePage title={t('layout.portSwitch.title')}>
      <Box sx={{ position: 'relative', maxWidth: 760 }}>
        <Stack spacing={2} sx={{ p: 1 }}>
          <Typography color="text.secondary">
            {t('layout.portSwitch.hint')}
          </Typography>

          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              onClick={() => void loadInstallResult(null)}
              disabled={loading}
            >
              {t('layout.portSwitch.import')}
            </Button>
            <Button
              variant="outlined"
              disabled={!panel || loading}
              onClick={() => panel && void syncFromServer(panel, inboundId)}
            >
              {t('layout.portSwitch.refresh')}
            </Button>
            <Button
              variant="outlined"
              color="error"
              disabled={!panel || loading}
              onClick={() => setConfirmDelete(true)}
            >
              {t('layout.portSwitch.delete')}
            </Button>
          </Stack>
          <Typography color="text.secondary" variant="body2">
            {t('layout.portSwitch.dropHint')}
          </Typography>

          {panel && (
            <Typography>
              {t('layout.portSwitch.server')}：{panel.server}
              {'  '}
              {t('layout.portSwitch.panelPort')}：{panel.panelPort || '-'}
            </Typography>
          )}

          {error && <Alert severity="error">{error}</Alert>}
          {message && <Alert severity="success">{message}</Alert>}

          {!panel && (
            <Alert severity="info">{t('layout.portSwitch.empty')}</Alert>
          )}
          {panel && inbounds.length === 0 && !loading && !error && (
            <Alert severity="info">{t('layout.portSwitch.noInbound')}</Alert>
          )}

          {inbounds.map((item) => (
            <Card
              key={item.id}
              variant="outlined"
              sx={{ cursor: 'pointer' }}
              onClick={() => setInboundId(item.id)}
            >
              <CardContent
                sx={{ display: 'flex', gap: 1, alignItems: 'center', py: 1.5 }}
              >
                <Radio checked={item.id === inboundId} />
                <Box>
                  <Typography sx={{ fontWeight: 700 }}>
                    {item.remark || `#${item.id}`}
                  </Typography>
                  <Typography color="text.secondary" variant="body2">
                    {item.protocol || t('layout.portSwitch.protocol')} ·{' '}
                    {item.port}
                    {item.enable ? '' : ` · ${t('layout.portSwitch.disabled')}`}
                    {isInboundPortLocked(item.port)
                      ? ` · ${t('layout.portSwitch.portLocked')}`
                      : ''}
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          ))}

          {selected && isInboundPortLocked(selected.port) && (
            <Alert severity="info">
              {t('layout.portSwitch.portLockedHint', { port: selected.port })}
            </Alert>
          )}

          {selected && !isInboundPortLocked(selected.port) && (
            <Stack spacing={1}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                sx={{ alignItems: 'center' }}
              >
                <TextField
                  label={t('layout.portSwitch.nextPort')}
                  value={nextPort}
                  type="number"
                  size="small"
                  onChange={(event) => setNextPort(event.target.value)}
                  sx={{ width: 220 }}
                />
                <Button
                  variant="contained"
                  startIcon={<SwapHorizOutlined />}
                  disabled={loading || !nextPort}
                  onClick={() => void switchPort()}
                >
                  {t('layout.portSwitch.switch')}
                </Button>
                <Button
                  variant="outlined"
                  disabled={loading}
                  onClick={() => void switchPortRandom()}
                >
                  {t('layout.portSwitch.switchRandom')}
                </Button>
              </Stack>
              <Typography color="text.secondary" variant="body2">
                {t('layout.portSwitch.randomHint')}
              </Typography>
            </Stack>
          )}
        </Stack>
        {dragging && (
          <Box
            sx={{
              position: 'absolute',
              inset: 8,
              zIndex: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '2px dashed',
              borderColor: 'primary.main',
              borderRadius: 1,
              bgcolor: 'action.hover',
              pointerEvents: 'none',
            }}
          >
            <Typography sx={{ fontWeight: 700 }}>
              {t('layout.portSwitch.dropping')}
            </Typography>
          </Box>
        )}
      </Box>
      {confirmDelete && (
        <BaseDialog
          open
          title={t('layout.portSwitch.deleteTitle')}
          okBtn={t('layout.portSwitch.deleteOk')}
          cancelBtn={t('layout.portSwitch.deleteCancel')}
          loading={loading}
          onOk={() => void deleteConfig()}
          onCancel={() => setConfirmDelete(false)}
          onClose={() => setConfirmDelete(false)}
        >
          {t('layout.portSwitch.deleteConfirm')}
        </BaseDialog>
      )}
    </BasePage>
  )
}

export default PortSwitchPage
