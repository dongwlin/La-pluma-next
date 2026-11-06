// 资源源表单只覆盖 maa-cli cli.toml 的 [resource] 段：Git / MirrorChyan 来源、
// 自动更新开关与凭据。凭据输入框留空表示保留已保存的值，页面从不回显明文。

import { Checkbox, Input, Select, Switch } from '@/shared/ui'
import { useStatusStore } from '@/features/runtime-status'
import { useConfigDraftPanel } from '../hooks/useConfigDraftPanel'
import { useSettingsResourceSource } from '../hooks/useSettingsResourceSource'
import { CONFIG_SECTION_VIEWS } from './configSectionViews'
import ConfigEditorCard from './ConfigEditorCard'
import { DEFAULT_RESOURCE_GIT_URL, DEFAULT_MIRRORCHYAN_CHECK_INTERVAL } from '../model/resourceSource'
import { GIT_BACKENDS, RESOURCE_SOURCE_TYPES } from '../types'
import type {
  GitBackend,
  ResourceSecretKind,
  ResourceSourceDraft,
  ResourceSourceType,
} from '../types'

const SOURCE_LABELS: Record<ResourceSourceType, string> = {
  git: 'Git 仓库',
  mirrorchyan: 'MirrorChyan',
}

const SOURCE_OPTIONS = RESOURCE_SOURCE_TYPES.map(source => ({
  value: source,
  label: SOURCE_LABELS[source],
}))

const BACKEND_LABELS: Record<GitBackend, string> = {
  git: 'git（系统命令）',
  libgit2: 'libgit2（内置）',
}

const BACKEND_OPTIONS = GIT_BACKENDS.map(backend => ({
  value: backend,
  label: BACKEND_LABELS[backend],
}))

const describeSecret = (kind: ResourceSecretKind, what: string): string => {
  switch (kind) {
    case 'plain':
      return `已保存${what}，留空保持不变`
    case 'env':
      return `${what}来自环境变量，留空保持不变`
    case 'command':
      return `${what}由命令提供，留空保持不变`
    case 'prompt':
      return `${what}在运行时交互输入，留空保持不变`
    case 'none':
    default:
      return `尚未保存${what}`
  }
}

export interface ResourceSourcePanelProps {
  /** 只有 resource section 渲染可写表单；隐藏时保留订阅与反馈。 */
  readonly isActive: boolean
}

export default function ResourceSourcePanel({ isActive }: ResourceSourcePanelProps) {
  const setStatusMessage = useStatusStore(state => state.setMessage)
  const {
    draft,
    update,
    restoreDefaults,
    save: saveResourceSourceDraft,
    syncState,
    loadError,
    loaded,
  } = useSettingsResourceSource(undefined, isActive)
  const saving = syncState === 'saving'
  const {
    feedback: configFeedback,
    setFeedback: setConfigFeedback,
    saveBlockedReason,
    save: saveResourceSource,
  } = useConfigDraftPanel({
    label: '资源源配置',
    savingMessage: '正在保存资源源配置...',
    loadError,
    loaded,
    saving,
    save: saveResourceSourceDraft,
  })

  const updateGit = (patch: Partial<ResourceSourceDraft['git']>) => {
    update({ git: { ...draft.git, ...patch } })
    setConfigFeedback(null)
  }

  const updateMirrorChyan = (patch: Partial<ResourceSourceDraft['mirrorchyan']>) => {
    update({ mirrorchyan: { ...draft.mirrorchyan, ...patch } })
    setConfigFeedback(null)
  }

  const handleSave = () => {
    void saveResourceSource()
  }

  const handleReset = () => {
    restoreDefaults()
    setConfigFeedback(null)
    setStatusMessage('已重置资源源配置为默认值')
  }

  const handleCheckIntervalChange = (value: string) => {
    const parsed = Number.parseInt(value, 10)
    updateMirrorChyan({
      checkInterval: Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_MIRRORCHYAN_CHECK_INTERVAL,
    })
  }

  if (!isActive) return null

  return (
    <ConfigEditorCard
      title={CONFIG_SECTION_VIEWS.resource.name}
      feedback={configFeedback}
      saving={saving}
      saveDisabled={!loaded}
      saveBlockedReason={saveBlockedReason}
      onSave={handleSave}
      onReset={handleReset}
    >
      <Select
        label="资源来源"
        value={draft.source}
        onChange={(value: string) => {
          update({ source: value as ResourceSourceType })
          setConfigFeedback(null)
        }}
        options={SOURCE_OPTIONS}
        hint="MaaResource 由 maa-cli 的 hot-update 同步；Git 直连仓库，MirrorChyan 走镜像快照"
      />

      {draft.source === 'git' && (
        <>
          <Select
            label="Git 后端"
            value={draft.git.backend}
            onChange={(value: string) => {
              updateGit({ backend: value as GitBackend })
            }}
            options={BACKEND_OPTIONS}
            hint="系统 git 支持 SSH 口令；libgit2 内置于 maa-cli"
          />
          <Input
            label="仓库地址"
            value={draft.git.url}
            onChange={(value: string) => {
              updateGit({ url: value })
            }}
            placeholder={DEFAULT_RESOURCE_GIT_URL}
            hint="留空使用 MaaAssistantArknights/MaaResource 官方仓库"
          />
          <Input
            label="分支"
            value={draft.git.branch}
            onChange={(value: string) => {
              updateGit({ branch: value })
            }}
            placeholder="默认分支"
            hint="留空跟随仓库默认分支"
          />
          <div className="config-reconnect-row flex min-h-14 items-center justify-between gap-3 py-1">
            <div className="min-w-0">
              <div className="text-sm font-medium text-primary">使用 ssh-agent</div>
              <div className="mt-1 text-xs leading-5 text-tertiary">通过 ssh-agent 提供克隆凭据，无需填写私钥</div>
            </div>
            <Switch
              label="使用 ssh-agent"
              checked={draft.git.useSshAgent}
              onChange={(checked: boolean) => {
                updateGit({ useSshAgent: checked })
              }}
            />
          </div>
          {!draft.git.useSshAgent && (
            <Input
              label="SSH 私钥路径"
              value={draft.git.sshKey}
              onChange={(value: string) => {
                updateGit({ sshKey: value })
              }}
              placeholder="~/.ssh/id_ed25519"
              hint="使用 SSH 地址克隆时填写；留空表示不需要证书"
            />
          )}
          <Input
            label="SSH 私钥口令"
            type="password"
            value={draft.git.passphrase}
            onChange={(value: string) => {
              updateGit({ passphrase: value })
            }}
            hint={describeSecret(draft.git.passphraseKind, '口令')}
          />
        </>
      )}

      {draft.source === 'mirrorchyan' && (
        <>
          <Input
            label="MirrorChyan CDK"
            type="password"
            value={draft.mirrorchyan.cdk}
            onChange={(value: string) => {
              updateMirrorChyan({ cdk: value, clearCdk: false })
            }}
            disabled={draft.mirrorchyan.clearCdk}
            hint={describeSecret(draft.mirrorchyan.cdkKind, ' CDK')}
          />
          {draft.mirrorchyan.cdkKind !== 'none' && (
            <Checkbox
              label="清除已保存的 CDK"
              checked={draft.mirrorchyan.clearCdk}
              onChange={(checked: boolean) => {
                updateMirrorChyan({ clearCdk: checked, cdk: checked ? '' : draft.mirrorchyan.cdk })
              }}
            />
          )}
          <Input
            label="检查间隔（秒）"
            type="number"
            value={draft.mirrorchyan.checkInterval}
            onChange={handleCheckIntervalChange}
            hint="0 表示禁用缓存；默认 600 秒"
          />
        </>
      )}

      <div className="config-switch-list flex flex-col gap-3">
        <div className="config-reconnect-row flex min-h-14 items-center justify-between gap-3 py-1">
          <div className="min-w-0">
            <div className="text-sm font-medium text-primary">自动更新资源</div>
            <div className="mt-1 text-xs leading-5 text-tertiary">由 maa-cli 在运行前按需同步 MaaResource</div>
          </div>
          <Switch
            label="自动更新资源"
            checked={draft.autoUpdate}
            onChange={(checked: boolean) => {
              update({ autoUpdate: checked })
              setConfigFeedback(null)
            }}
          />
        </div>
        <div className="config-reconnect-row flex min-h-14 items-center justify-between gap-3 py-1">
          <div className="min-w-0">
            <div className="text-sm font-medium text-primary">更新失败时告警</div>
            <div className="mt-1 text-xs leading-5 text-tertiary">资源自动更新失败时输出警告而不是静默跳过</div>
          </div>
          <Switch
            label="更新失败时告警"
            checked={draft.warnOnUpdateFailure}
            onChange={(checked: boolean) => {
              update({ warnOnUpdateFailure: checked })
              setConfigFeedback(null)
            }}
          />
        </div>
      </div>

    </ConfigEditorCard>
  )
}
