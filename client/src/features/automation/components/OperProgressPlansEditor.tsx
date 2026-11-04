import { Plus, Trash2 } from 'lucide-react'
import { Button, IconButton, Input, Select } from '@/shared/ui'
import {
  OPER_PROGRESS_ROLES,
  updateOperProgressMastery,
  updateOperProgressTarget,
} from '../model/gameTaskParams'
import type { OperProgressPlan } from '../types'

interface OperProgressPlansEditorProps {
  plans: OperProgressPlan[]
  disabled: boolean
  onChange: (plans: OperProgressPlan[]) => void
}

const eliteOptions = [
  { value: '', label: '不提升精英阶段' },
  { value: 1, label: '精英一' },
  { value: 2, label: '精英二' },
]
const skillOptions = [
  { value: '', label: '不提升技能等级' },
  ...[2, 3, 4, 5, 6, 7].map(level => ({ value: level, label: `${level} 级` })),
]
const masteryOptions = [
  { value: 0, label: '不专精' },
  ...[1, 2, 3].map(level => ({ value: level, label: `专精 ${level}` })),
]

export default function OperProgressPlansEditor({ plans, disabled, onChange }: OperProgressPlansEditorProps) {
  const updatePlan = (index: number, plan: OperProgressPlan) => {
    onChange(plans.map((current, currentIndex) => currentIndex === index ? plan : current))
  }

  return (
    <div className="@container space-y-4">
      <p className="text-xs leading-5 text-secondary">在游戏内提升干员，按精英阶段、技能等级、专精的顺序处理。执行会消耗已有资源，可能自动合成材料或用采购凭证购买芯片助剂；专精会占用训练室。每轮执行最多启动一项专精训练，其余专精目标留待后续执行。</p>
      {plans.length === 0 && <p className="text-sm text-secondary">添加干员并选择培养目标。</p>}
      {plans.map((plan, index) => (
        <fieldset key={index} disabled={disabled} className="min-w-0 space-y-3 border-t border-(--app-border) pt-3">
          <legend className="px-1 text-sm font-semibold text-primary">培养计划 {index + 1}</legend>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-secondary">{plan.name || '未填写干员'}</span>
            <IconButton icon={<Trash2 size={16} />} title={`删除培养计划 ${index + 1}`} disabled={disabled} onClick={() => onChange(plans.filter((_, current) => current !== index))} />
          </div>
          <div className="grid min-w-0 gap-3 @sm:grid-cols-2">
            <Select label="职业" aria-label={`培养计划 ${index + 1} 职业`} value={plan.role ?? 'Unknown'} options={OPER_PROGRESS_ROLES} disabled={disabled} onChange={role => updatePlan(index, { ...plan, role })} />
            <Input label="干员姓名" aria-label={`培养计划 ${index + 1} 干员姓名`} value={plan.name} placeholder="游戏内完整姓名" disabled={disabled} onChange={name => updatePlan(index, { ...plan, name })} />
            <Select label="精英目标" aria-label={`培养计划 ${index + 1} 精英目标`} value={plan.elite ?? ''} options={eliteOptions} disabled={disabled} onChange={value => updatePlan(index, updateOperProgressTarget(plan, 'elite', value))} />
            <Select label="技能等级" aria-label={`培养计划 ${index + 1} 技能等级`} value={plan.skill_level ?? ''} options={skillOptions} disabled={disabled} onChange={value => updatePlan(index, updateOperProgressTarget(plan, 'skill_level', value))} />
          </div>
          <div className="grid min-w-0 gap-3 @sm:grid-cols-2 @md:grid-cols-3">
            {[0, 1, 2].map(skill => <Select key={skill} label={`技能 ${skill + 1} 专精`} aria-label={`培养计划 ${index + 1} 技能 ${skill + 1} 专精`} value={plan.skill_mastery?.[skill] ?? 0} options={masteryOptions} disabled={disabled} onChange={value => updatePlan(index, updateOperProgressMastery(plan, skill, value))} />)}
          </div>
        </fieldset>
      ))}
      <Button variant="secondary" icon={<Plus size={16} />} disabled={disabled} onClick={() => onChange([...plans, { role: 'Unknown', name: '' }])}>添加培养计划</Button>
      <p className="text-xs leading-5 text-secondary">只处理明确选择的目标。自动识别职业要求姓名唯一；专精可能先启动前置等级，实际结果以执行详情为准。</p>
    </div>
  )
}
