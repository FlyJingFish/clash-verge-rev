import { createTheme, ThemeProvider } from '@mui/material/styles'
import { createInstance } from 'i18next'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { expect, it } from 'vitest'

import layout from '@/locales/zh/layout.json'

import PortSwitchPage from './port-switch'

it('shows the import prompt before a panel is loaded', async () => {
  const i18n = createInstance()
  await i18n.init({
    lng: 'zh',
    resources: { zh: { translation: { layout } } },
    interpolation: { escapeValue: false },
  })

  const html = renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(PortSwitchPage),
      ),
    ),
  )

  expect(html).toContain('端口')
  expect(html).toContain('导入 install-result.env')
  expect(html).toContain('删除配置')
  expect(html).toContain('还没有导入面板')
  expect(html).toContain('也可以把 install-result.env 拖进这个页面')
})
