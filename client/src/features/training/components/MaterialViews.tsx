/**
 * 养成材料视图
 *
 * 材料表格与合成树只负责展示，数据由 `model/materials` 与计划响应提供。
 * 物品图标沿用 `game-data` 的图标缓存 epoch；加载失败时隐藏图片并保留占位。
 */

import { Package } from 'lucide-react'
import { getItemIconUrl, useItemIconCacheVersion } from '@/features/game-data'
import type { MaterialNode } from '../types'

export function ResourceIcon({ id }: { id?: string | number }) {
  const itemIconVersion = useItemIconCacheVersion()
  return <span className="training-resource-icon"><Package size={18} aria-hidden="true" />{id && <img src={getItemIconUrl(id, itemIconVersion)} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none' }} />}</span>
}

/** 当前目标的缺口表格：只展示仍有缺口的材料，顺序由调用方决定。 */
export function MaterialTable({ materials }: { materials: MaterialNode[] }) {
  return <div className="training-material-table" role="table" aria-label="材料筹备明细">
    <div className="training-material-line training-material-labels" role="row"><span role="columnheader">材料</span><span role="columnheader">拥有</span><span role="columnheader">需要</span><span role="columnheader">缺口</span></div>
    {materials.map(material => <div className="training-material-line" role="row" key={material.id}>
      <span role="cell" className="training-material-name"><ResourceIcon id={material.iconId} /><span>{material.name}</span></span>
      <span role="cell">{material.have}</span><span role="cell">{material.needed}</span>
      <span role="cell" className={material.stillNeeded > 0 ? 'brand-text font-semibold' : 'text-secondary'}>{material.stillNeeded > 0 ? material.stillNeeded : '已齐'}</span>
    </div>)}
  </div>
}

/** 完整材料与合成需求的层级列表。 */
export function MaterialTree({ nodes }: { nodes: MaterialNode[] }) {
  return <ul className="training-material-tree">{nodes.map(node => <li key={node.id}>
    <div><ResourceIcon id={node.iconId} /><span className="min-w-0 flex-1">{node.name}</span><span className="text-secondary tabular-nums">{node.have} / {node.needed}</span><span className="brand-text">{node.stillNeeded > 0 ? `缺 ${node.stillNeeded}` : '已齐'}</span></div>
    {node.children && node.children.length > 0 && <MaterialTree nodes={node.children} />}
  </li>)}</ul>
}
