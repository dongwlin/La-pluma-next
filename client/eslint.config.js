import path from 'node:path'
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tailwindcss from 'eslint-plugin-tailwindcss'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'coverage']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      'no-control-regex': 'off',
      'no-empty-pattern': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^[A-Z_]',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
      }],
    },
  },
  // Tailwind v4 canonical 类名：只开这一条，避免 no-custom-classname 把项目自定义类全部报出。
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { tailwindcss },
    settings: {
      tailwindcss: {
        cssConfigPath: path.resolve(import.meta.dirname, 'src/styles/index.css'),
      },
    },
    rules: {
      'tailwindcss/enforces-canonical-classname': 'error',
    },
  },
  // 分层护栏：app → pages → features → shared 只能单向依赖。
  // flat config 中同一规则后置块会整体覆盖前置块，因此每个块都写全该目录需要的 patterns。
  {
    // 任何 src 文件都只能经 feature 的 index.ts 根 import，禁止 `@/features/<x>/...` 深路径。
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^@/features/[^/]+/.+',
          message: '功能域对外只有 index.ts 一个公开面，请改为 @/features/<domain> 根 import。',
        }],
      }],
    },
  },
  {
    // features/shared 不得反向依赖 app 或 pages 层。
    files: ['src/features/**/*.{ts,tsx}', 'src/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '^@/features/[^/]+/.+',
            message: '功能域对外只有 index.ts 一个公开面，请改为 @/features/<domain> 根 import。',
          },
          {
            regex: '^@/app(?:/.*)?$',
            message: 'app 是组装层，features/shared 不得反向依赖 @/app。',
          },
          {
            regex: '^@/pages(?:/.*)?$',
            message: 'pages 是组合层，features/shared 不得反向依赖 @/pages。',
          },
        ],
      }],
    },
  },
  {
    // shared 不感知任何功能域。`^@/features(?:/.*)?$` 同时覆盖根 import 与深路径，
    // 因此这里不再重复列深路径 pattern，避免同一处 import 报两条错误。
    files: ['src/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '^@/features(?:/.*)?$',
            message: 'shared 不感知 features，请把跨域能力留在所属域内或上移到 shared 的通用能力。',
          },
          {
            regex: '^@/app(?:/.*)?$',
            message: 'app 是组装层，features/shared 不得反向依赖 @/app。',
          },
          {
            regex: '^@/pages(?:/.*)?$',
            message: 'shared 不感知 pages，组合职责留在 pages/app。',
          },
        ],
      }],
    },
  },
  {
    // pages 只向下组合：可以经功能域根入口与 shared，不得反向依赖 app；
    // 页面内部不得跨域深路径，也不得深路径访问自身域内部。
    files: ['src/pages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '^@/features/[^/]+/.+',
            message: '页面只能经功能域根入口组合，请改为 @/features/<domain> 根 import。',
          },
          {
            regex: '^@/app(?:/.*)?$',
            message: 'pages 是组合层，不得反向依赖 @/app。',
          },
        ],
      }],
    },
  },
  {
    // 页面测试允许深路径到被测域内部（构造领域状态），不进入产物；
    // 分层方向仍然生效，只是放开 @/features/<domain>/... 的深路径。
    files: ['src/pages/**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '^@/app(?:/.*)?$',
            message: 'pages 是组合层，不得反向依赖 @/app。',
          },
        ],
      }],
    },
  },
])
