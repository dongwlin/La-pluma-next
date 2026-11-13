import type { MaterialNode, TrainingQueueItem } from '../types'

/** 队列项的完整材料明细；龙门币追加在普通材料之后。 */
export const getQueueMaterials = (item: TrainingQueueItem): MaterialNode[] => {
  const materials = item.materials ?? []
  return item.lmd
    ? [...materials, {
        id: '4001',
        name: '龙门币',
        iconId: '4001',
        count: item.lmd.needed,
        ...item.lmd,
      }]
    : materials
}

export const selectMissingMaterials = (
  materials: readonly MaterialNode[],
): MaterialNode[] => materials.filter(material => material.stillNeeded > 0)

export interface TargetMaterialSummary {
  title: string
  subtitle: string
  /** 展示用进度，保持服务端原值（进度条自行夹紧到 0–100）。 */
  progress: number
  materials: MaterialNode[]
  missingMaterials: MaterialNode[]
}

/**
 * 当前目标的材料面板摘要。空队列返回固定文案，不读取任何资源。
 */
export const summarizeTargetMaterials = (
  target: TrainingQueueItem | null,
): TargetMaterialSummary => {
  if (!target) {
    return {
      title: '材料筹备',
      subtitle: '添加目标后查看材料缺口',
      progress: 0,
      materials: [],
      missingMaterials: [],
    }
  }

  const materials = getQueueMaterials(target)
  const missingMaterials = selectMissingMaterials(materials)
  return {
    title: `${target.operator.name}的材料`,
    subtitle: `精${target.currentElite} → 精${target.targetElite} · ${
      missingMaterials.length > 0 ? `还缺 ${missingMaterials.length} 种材料` : '材料已集齐'
    }`,
    progress: target.progress ?? 0,
    materials,
    missingMaterials,
  }
}
