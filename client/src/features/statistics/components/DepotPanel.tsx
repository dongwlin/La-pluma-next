/**
 * 仓库识别面板
 *
 * 面板持有仓库读取、失败图标缓存与分类汇总展示；汇总规则在
 * `model/depotSummary`，识别命令仍由工作区投影注入。
 *
 * 与干员面板一样随页面挂载常驻，非当前 tab 时只返回 null：仓库读取的
 * 首屏时机不随 tab 变化，切回时不会重新加载或丢失图标失败状态。
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  depotQueryOptions,
  getItemIconUrl,
  useItemIconCacheVersion,
} from '@/features/game-data'
import { motion, useReducedMotion } from 'framer-motion'
import { Package as PackageIcon, Play } from 'lucide-react'
import Icons from '@/shared/ui/Icons'
import { Button, Card, EmptyState, Loading } from '@/shared/ui'
import { getDepotTypeLabel, summarizeDepot } from '../model/depotSummary'
import InlineDataError from './InlineDataError'
import type { StatisticsCommands } from '../hooks/useStatisticsCommands'

const DEPOT_READ_ERROR = '暂时无法读取仓库数据，请检查服务连接后重试。'

const taskPanelClass = (isActive: boolean) =>
  `data-statistics-task-card p-0!${isActive ? ' is-active' : ''}`

const statCardClass = 'data-statistics-kpi'
const chipClass = 'control-surface rounded-full px-2 py-0.5 text-xs whitespace-nowrap'

interface DepotPanelProps {
  isActive: boolean
  command: StatisticsCommands
}

export default function DepotPanel({ isActive, command }: DepotPanelProps) {
  const shouldReduceMotion = useReducedMotion()
  // 资源更新成功后推进，使同一图标的 `<img src>` 换到新的浏览器缓存身份。
  const itemIconVersion = useItemIconCacheVersion()
  const depotQuery = useQuery(depotQueryOptions())
  const [failedDepotImages, setFailedDepotImages] = useState<Record<string, boolean>>({})

  const depotData = depotQuery.data ?? null
  const depotDataLoading = depotQuery.isPending
  const depotDataRefreshing = depotQuery.isFetching
  const depotDataError = depotQuery.isError ? DEPOT_READ_ERROR : null
  const overview = useMemo(() => summarizeDepot(depotData), [depotData])

  if (!isActive) return null

  const isRecognizing = command.activeKind === 'depot' && command.isRunning

  return (
    <motion.div
      id="data-statistics-panel-depot"
      role="tabpanel"
      aria-labelledby="data-statistics-tab-depot"
      initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={shouldReduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 38, mass: 0.72 }}
      className="min-w-0"
    >
      <Card
        smoothCorners
        className={taskPanelClass(command.activeTask === 'depot')}
      >
        <div className="data-statistics-task-content app-stack-card">
          <div className="data-statistics-task-header flex items-start gap-3 sm:items-center">
            <div className="flex w-full min-w-0 flex-1 items-center gap-3 sm:w-auto">
              <div className="flex h-10 w-10 flex-none items-center justify-center" aria-hidden="true">
                <Icons.Package />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-primary">仓库识别</h2>
                <p className="mt-1 text-sm leading-relaxed text-secondary">
                  汇总物品库存、材料分类与数量
                </p>
              </div>
            </div>

            <div className="data-statistics-task-actions shrink-0">
              <Button
                onClick={() => command.startRecognition('depot')}
                disabled={command.isRunning}
                loading={isRecognizing}
                loadingText="正在执行"
                variant="primary"
                size="md"
                icon={<Play size={15} fill="currentColor" aria-hidden="true" />}
              >
                {command.actionLabel('depot')}
              </Button>
            </div>
          </div>

          {/* 识别结果展示 */}
          {!depotDataError && !depotData && (depotDataLoading || command.activeTask === 'depot') && (
            <div className="rounded-xl py-12 surface-soft" aria-live="polite">
              <Loading text={command.activeTask === 'depot' ? '正在识别仓库数据' : '正在读取仓库数据'} />
            </div>
          )}
          {depotDataError && (
            <InlineDataError
              title="仓库数据读取失败"
              description={depotDataError}
              isRetrying={depotDataRefreshing}
              onRetry={() => {
                void depotQuery.refetch()
              }}
            />
          )}
          {!depotDataLoading && !depotDataError && !command.isRunning && !depotData && (
            <EmptyState
              compact
              className="py-10"
              icon={<Icons.Package />}
              title="还没有仓库识别结果"
              description="完成一次仓库识别后，物品清单会显示在这里。"
            />
          )}
          {depotData && (
            <div className="app-stack-card">
              <div
                className="data-statistics-kpi-grid grid grid-cols-2 md:grid-cols-3"
                aria-label="仓库数据概览"
              >
                <div className={statCardClass}>
                  <p className="text-xs text-secondary">物品种类</p>
                  <p className="mt-1 text-2xl font-semibold text-primary">
                    {overview.itemCount}
                  </p>
                </div>
                <div className={statCardClass}>
                  <p className="text-xs text-secondary">材料种类</p>
                  <p className="mt-1 text-2xl font-semibold text-primary">
                    {overview.materialKinds}
                  </p>
                </div>
                <div className={statCardClass}>
                  <p className="text-xs text-secondary">识别分类</p>
                  <p className="mt-1 text-2xl font-semibold text-primary">
                    {overview.categoryCount}
                  </p>
                </div>
                <div className={statCardClass}>
                  <p className="text-xs text-secondary">库存总量</p>
                  <p className="mt-1 text-2xl font-semibold text-primary">
                    {overview.totalCount.toLocaleString()}
                  </p>
                </div>
                <div className={statCardClass}>
                  <p className="text-xs text-secondary">库存最多</p>
                  <p className="mt-1 truncate text-sm font-semibold text-primary">
                    {overview.topItem?.name ?? '-'}
                  </p>
                </div>
                {depotData.timestamp && (
                  <div className={statCardClass}>
                    <p className="text-xs text-secondary">最近识别</p>
                    <p className="mt-1 truncate text-sm font-semibold text-primary">
                      {new Date(depotData.timestamp).toLocaleString('zh-CN')}
                    </p>
                  </div>
                )}
              </div>

              {overview.groups.length > 0 && (
                <section className="rounded-xl surface-soft p-3" aria-labelledby="depot-category-title">
                  <h3 id="depot-category-title" className="mb-2 text-sm font-semibold text-primary">分类汇总</h3>
                  <div className="flex flex-wrap gap-2">
                    {overview.groups.map((group) => (
                      <div key={group.type} className="control-surface rounded-full px-3 py-1.5 text-xs text-secondary">
                        <span className="font-medium">{group.label}</span>
                        <span className="mx-1 brand-text">·</span>
                        <span>{group.kinds} 种</span>
                        <span className="mx-1 brand-text">/</span>
                        <span>{group.count.toLocaleString()} 件</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* 物品卡片网格 */}
              {depotData.items && depotData.items.length > 0 && (
                <div className="data-statistics-item-grid grid grid-cols-1 overflow-hidden rounded-xl surface-soft sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
                  {depotData.items.map((item) => {
                    const itemKey = item.id || item.iconId
                    const imageKey = `${itemKey}:${item.iconId}`

                    return (
                      <div
                        key={itemKey}
                        className="data-statistics-depot-item flex min-w-0 items-center gap-3 p-3"
                      >
                        {/* 物品图标 */}
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-(--app-surface-muted)">
                          {failedDepotImages[imageKey] ? (
                            <span role="img" aria-label={`${item.name}图标不可用`}>
                              <PackageIcon className="h-6 w-6 brand-text" aria-hidden="true" />
                            </span>
                          ) : (
                            <img
                              src={getItemIconUrl(item.iconId, itemIconVersion)}
                              alt={item.name}
                              className="w-full h-full object-cover"
                              onError={() => {
                                setFailedDepotImages(previous => ({ ...previous, [imageKey]: true }))
                              }}
                            />
                          )}
                        </div>

                        {/* 物品信息 */}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-bold text-primary truncate" title={item.name}>
                            {item.name}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            {item.classifyType && (
                              <span className={chipClass}>
                                {getDepotTypeLabel(item.classifyType)}
                              </span>
                            )}
                            <span className={`${chipClass} font-semibold`}>
                              ×{item.count.toLocaleString()}
                            </span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </motion.div>
  )
}
