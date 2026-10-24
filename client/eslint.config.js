import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
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
  // 分层护栏：app → features → shared 只能单向依赖。
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
    // features/shared 不得反向依赖 app 层。
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
        ],
      }],
    },
  },
])
