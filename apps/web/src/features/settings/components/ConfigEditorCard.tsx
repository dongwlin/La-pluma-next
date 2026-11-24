import type { ReactNode } from 'react'
import { LoaderCircle, RotateCcw, Save } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import SettingsFeedback from './SettingsFeedback'

export interface ConfigEditorFeedback {
  type: 'error'
  message: string
}

export interface ConfigEditorCardProps {
  readonly title: string
  readonly feedback: ConfigEditorFeedback | null
  readonly saving: boolean
  readonly saveDisabled?: boolean
  /** 首次服务端快照被采纳前禁用编辑入口（重置），保存另有 saveDisabled。 */
  readonly editingDisabled?: boolean
  /** 读取失败时提供的显式重试入口。 */
  readonly onRetryLoad?: () => void
  readonly onSave: () => void
  readonly onReset: () => void
  readonly children: ReactNode
}

/** 配置编辑卡的公共外壳：标题、保存/重置按钮与读取失败提示；表单内容由各 section 提供。 */
export default function ConfigEditorCard({
  title,
  feedback,
  saving,
  saveDisabled = false,
  editingDisabled = false,
  onRetryLoad,
  onSave,
  onReset,
  children,
}: ConfigEditorCardProps) {
  return (
    <Card>
      <CardHeader className="border-b py-3.5">
        <CardTitle role="heading" aria-level={2}>{title}</CardTitle>
        <CardAction>
          <div className="flex items-center gap-2">
            <Button
              onClick={onReset}
              disabled={saving || editingDisabled}
              variant="outline"
              size="sm"
            >
              <RotateCcw size={16} aria-hidden="true" />
              重置
            </Button>
            <Button
              onClick={onSave}
              disabled={saveDisabled || saving}
              aria-busy={saving || undefined}
              size="sm"
            >
              {saving
                ? <><LoaderCircle className="animate-spin" aria-hidden="true" />保存中</>
                : (
                  <>
                    <Save size={16} aria-hidden="true" />
                    保存
                  </>
                )}
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="app-stack-card">
        {feedback && (
          <SettingsFeedback
            tone="error"
            message={feedback.message}
            action={onRetryLoad
              ? (
                  <Button
                    type="button"
                    onClick={onRetryLoad}
                    disabled={saving}
                    variant="outline"
                    size="sm"
                  >
                    重新读取
                  </Button>
                )
              : undefined}
          />
        )}
        {children}
      </CardContent>
    </Card>
  )
}
