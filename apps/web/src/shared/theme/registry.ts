/**
 * 主题注册表：可插拔主题系统的唯一注册点。
 *
 * 主题包分层契约：
 * - Tier 1 纯 token：仅覆盖 shadcn 语义 CSS 变量，天然兼容所有组件。
 * - Tier 2 token + 材质：额外定义主题私有变量（材质、阴影、壁纸）。
 * - Tier 3 皮肤层：针对 [data-slot] / [data-region] 的 CSS 覆盖，只动视觉，不动结构与尺寸。
 *
 * "default" 是特殊 id：不写 data-theme 属性，页面完全保持 shadcn 基线；
 * boot 色卡按「主题 × 模式」存放在 ThemeDefinition.boot，首帧脚本在构建期从此序列化。
 */

export interface ThemeBootColors {
  background: string
  themeColor: string
  statusBar: string
}

export interface ThemeSwatch {
  label: string
  light: string
  dark: string
}

export interface ThemeDefinition {
  /** 写入 <html data-theme="...">；"default" 表示移除属性、回归 shadcn 基线。 */
  id: string
  name: string
  description: string
  boot: {
    light: ThemeBootColors
    dark: ThemeBootColors
  }
  swatches: ThemeSwatch[]
}

export const DEFAULT_THEME_ID = 'default'

export const THEMES: ThemeDefinition[] = [
  {
    id: DEFAULT_THEME_ID,
    name: '默认',
    description: 'shadcn 语义变量基线，零主题覆盖。',
    boot: {
      light: {
        background: '#f2f2f7',
        themeColor: '#f6f8fb',
        statusBar: 'default',
      },
      dark: {
        background: '#000000',
        themeColor: '#05090c',
        statusBar: 'black-translucent',
      },
    },
    swatches: [
      { label: 'background', light: '#f2f2f7', dark: '#000000' },
      { label: 'primary', light: '#007aff', dark: '#0a84ff' },
      { label: 'card', light: '#ffffff', dark: '#1c1c1e' },
    ],
  },
]

export function getTheme(id: string): ThemeDefinition | undefined {
  return THEMES.find(theme => theme.id === id)
}
