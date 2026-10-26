/**
 * 当前目标材料面板
 *
 * 队列当前目标（第一位）的材料缺口与合成需求只从纯模型派生；面板不读取
 * 队列、不发起请求，也不保存材料副本。
 */

import { Check } from 'lucide-react'
import { summarizeTargetMaterials } from '../model/materials'
import { MaterialTable, MaterialTree } from './MaterialViews'
import type { TrainingQueueItem } from '../types'

export interface TrainingMaterialsPanelProps {
  target: TrainingQueueItem | null
}

export default function TrainingMaterialsPanel({ target }: TrainingMaterialsPanelProps) {
  const summary = summarizeTargetMaterials(target)
  const progress = Math.min(100, Math.max(0, summary.progress))

  return (
    <section className="training-surface" aria-labelledby="training-materials-title">
      <div className="training-section-heading"><div><h2 id="training-materials-title">{summary.title}</h2><p>{summary.subtitle}</p></div>{target && <span className="training-progress-value">{summary.progress}%<small>材料筹备进度</small></span>}</div>
      {target ? <>
        <div className="training-current-progress" role="progressbar" aria-label="当前目标材料筹备进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.progress}><span style={{ width: `${progress}%` }} /></div>
        {summary.missingMaterials.length > 0 ? <MaterialTable materials={summary.missingMaterials} /> : <p className="training-inline-empty"><Check size={18} />当前目标材料已集齐，可在游戏内完成养成。</p>}
        {summary.materials.length > 0 && <details className="training-disclosure"><summary>查看全部材料与合成需求</summary><MaterialTree nodes={summary.materials} /></details>}
      </> : <p className="training-inline-empty">还没有需要筹备的材料。</p>}
    </section>
  )
}
