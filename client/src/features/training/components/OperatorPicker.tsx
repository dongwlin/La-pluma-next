/**
 * 添加干员选择器
 *
 * 候选列表与三种状态计数由 training Query 持有；搜索、稀有度、未精二、
 * 分批渲染、头像加载缓存与状态分段测量都是选择器的局部交互状态，
 * 因此跟随本组件，而不是页面或工作区。弹层关闭只卸载 Modal 内容，
 * 选择器本身仍挂载，筛选与“继续显示”游标在再次打开时保留。
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'framer-motion'
import { Filter, Search, UserRoundSearch } from 'lucide-react'
import { Button, EmptyState, Input, Loading, Select } from '@/shared/ui'
import { Modal } from '@/shared/ui/Modal'
import { useFluidTabIndicator } from '@/shared/hooks/useFluidTabIndicator'
import { trainingCandidatesQueryOptions, trainingStatusCountsQueryOptions } from '../model/queries'
import { EMPTY_TRAINING_COUNTS } from '../model/statusCounts'
import {
  OPERATOR_RENDER_BATCH_SIZE,
  describeOperatorRow,
  filterOperatorRows,
  nextOperatorRenderLimit,
  paginateOperatorRows,
  resolveOperatorEmptyState,
  type OperatorEmptyState as OperatorEmptyStateContent,
} from '../model/operatorRows'
import TrainingLoadError from './TrainingLoadError'
import type { TrainingFilters, TrainingOperator } from '../types'

const TRAINING_STATUS_OPTIONS: Array<{
  value: TrainingFilters['status']
  label: string
  desc: string
}> = [
  { value: 'trainable', label: '可养成', desc: '可加入队列' },
  { value: 'owned', label: '已拥有', desc: '已识别干员' },
  { value: 'all', label: '全部', desc: '含未拥有' },
]

const EMPTY_LOADED_IMAGES: Record<string, boolean> = {}

function OperatorEmptyState({ title, description }: OperatorEmptyStateContent) {
  return (
    <EmptyState
      compact
      className="py-8"
      icon={<UserRoundSearch size={21} strokeWidth={1.8} />}
      title={title}
      description={description}
    />
  )
}

export interface OperatorPickerProps {
  isOpen: boolean
  onClose: () => void
  queueOperatorIds: ReadonlySet<string>
  queueLength: number
  busy: boolean
  operationError: string | null
  pendingOperatorIds: ReadonlySet<string>
  onAdd: (operator: TrainingOperator) => void | Promise<void>
}

export default function OperatorPicker({
  isOpen,
  onClose,
  queueOperatorIds,
  queueLength,
  busy,
  operationError,
  pendingOperatorIds,
  onAdd,
}: OperatorPickerProps) {
  const shouldReduceMotion = useReducedMotion()
  const [filters, setFilters] = useState<TrainingFilters>({
    rarity: '',
    status: 'trainable',
    needsElite2: true,
  })
  const [searchTerm, setSearchTerm] = useState('')
  const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>(EMPTY_LOADED_IMAGES)
  const [visibleOperatorLimit, setVisibleOperatorLimit] = useState(OPERATOR_RENDER_BATCH_SIZE)
  const {
    containerRef: statusTabsRef,
    activeRect: activeStatusRect,
    setTabRef: setStatusTabRef,
    handleTabKeyDown: handleStatusKeyDown,
  } = useFluidTabIndicator(filters.status)

  const rarityFilter = filters.rarity ? Number.parseInt(filters.rarity, 10) : null
  const candidateOptions = useMemo(
    () => trainingCandidatesQueryOptions({
      status: filters.status,
      rarity: rarityFilter,
      needsElite2: filters.needsElite2,
    }),
    [filters.status, rarityFilter, filters.needsElite2],
  )
  const countsOptions = useMemo(
    () => trainingStatusCountsQueryOptions({
      rarity: rarityFilter,
      needsElite2: filters.needsElite2,
    }),
    [rarityFilter, filters.needsElite2],
  )
  const candidatesQuery = useQuery(candidateOptions)
  const countsQuery = useQuery(countsOptions)
  const operators = candidatesQuery.data ?? []
  const operatorsLoading = candidatesQuery.isPending
  const operatorsError = candidatesQuery.isError
    ? (candidatesQuery.error instanceof Error && candidatesQuery.error.message
        ? candidatesQuery.error.message
        : '干员列表加载失败，请稍后重试')
    : null
  const trainingStatusCounts = countsQuery.data ?? EMPTY_TRAINING_COUNTS
  // 计数失败静默保留旧值；只有读取中且尚无计数时显示占位。
  const statusCountsLoading = countsQuery.isFetching

  const handleTrainingStatusChange = (status: TrainingFilters['status']) => {
    setFilters(current => ({
      ...current,
      status,
      needsElite2: status === 'all' ? false : current.needsElite2,
    }))
  }

  useEffect(() => {
    // 筛选/搜索变化时重置分页游标；这是对当前已渲染列表的同步复位。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisibleOperatorLimit(OPERATOR_RENDER_BATCH_SIZE)
  }, [filters.status, filters.rarity, filters.needsElite2, searchTerm])

  const filteredOperators = filterOperatorRows(operators, searchTerm)
  const { rows: visibleOperators, hiddenCount } = paginateOperatorRows(
    filteredOperators,
    visibleOperatorLimit,
  )
  const emptyState = !operatorsLoading && filteredOperators.length === 0
    ? resolveOperatorEmptyState(filters, searchTerm)
    : null

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="添加干员" size="xl" footer={<div className="flex w-full items-center justify-between gap-3"><span className="text-sm text-secondary">已加入 {queueLength} 名干员</span><Button onClick={onClose} variant="secondary">完成选择</Button></div>}>
      {operationError && <div role="alert" className="training-feedback status-danger">{operationError}</div>}
      <div className="space-y-4">
        {/* 搜索和过滤 */}
        <div className="flex flex-col gap-3">
          <div className="app-workspace-segments app-liquid-tab-pill training-status-shell">
            <div
              ref={statusTabsRef}
              className="app-workspace-segment-list grid-cols-3"
              role="toolbar"
              aria-label="干员范围"
            >
              {activeStatusRect.width > 0 && (
                <motion.div
                  data-testid="training-status-highlight"
                  aria-hidden="true"
                  className="app-workspace-segment-indicator training-status-highlight"
                  initial={false}
                  animate={{
                    x: activeStatusRect.x,
                    y: activeStatusRect.y,
                    width: activeStatusRect.width,
                    height: activeStatusRect.height,
                  }}
                  transition={shouldReduceMotion
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 420, damping: 38, mass: 0.72 }}
                />
              )}
              {TRAINING_STATUS_OPTIONS.map((option) => {
                const selected = filters.status === option.value;
                const count = statusCountsLoading && trainingStatusCounts[option.value] === 0
                  ? '-'
                  : trainingStatusCounts[option.value];
                return (
                  <button
                    key={option.value}
                    ref={setStatusTabRef(option.value)}
                    type="button"
                    onClick={() => handleTrainingStatusChange(option.value)}
                    onKeyDown={(event) => handleStatusKeyDown(
                      event,
                      TRAINING_STATUS_OPTIONS.map(({ value }) => value),
                      handleTrainingStatusChange,
                    )}
                    aria-pressed={selected}
                    tabIndex={selected ? 0 : -1}
                    className={`app-workspace-segment training-status-segment min-h-11 ${selected ? 'is-selected' : ''}`}
                  >
                    <span
                      className="app-workspace-segment-icon training-status-count"
                      aria-label={`${count} 名`}
                    >
                      {count}
                    </span>
                    <span className="app-workspace-segment-copy">
                      <span>{option.label}</span>
                      <small>{option.desc}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
          <Input
            type="text"
            aria-label="搜索干员名称"
            placeholder="搜索干员"
            value={searchTerm}
            onChange={setSearchTerm}
            icon={<Search size={17} strokeWidth={1.9} aria-hidden="true" />}
            className="col-span-2 min-w-0 sm:col-span-1"
          />
          <Select
            aria-label="稀有度"
            value={filters.rarity}
            onChange={(rarity) => setFilters({ ...filters, rarity })}
            options={[
              { value: '', label: '全部稀有度' },
              { value: '6', label: '6 星' },
              { value: '5', label: '5 星' },
              { value: '4', label: '4 星' },
            ]}
            className="min-w-0"
          />
          <Button
            type="button"
            variant={filters.needsElite2 ? 'primary' : 'secondary'}
            size="md"
            onClick={() => setFilters({ ...filters, needsElite2: !filters.needsElite2 })}
            aria-pressed={filters.needsElite2}
            icon={<Filter size={15} strokeWidth={1.9} aria-hidden="true" />}
            className="whitespace-nowrap"
          >
            未精二
          </Button>
        </div>
        </div>

        {/* 干员卡片列表 */}
        {operatorsLoading ? (
          <div className="flex min-h-65 items-center justify-center">
            <Loading text="正在读取干员..." />
          </div>
        ) : operatorsError ? (
          <TrainingLoadError
            title="干员列表加载失败"
            description={operatorsError}
            onRetry={() => void candidatesQuery.refetch()}
          />
        ) : emptyState ? (
          <OperatorEmptyState {...emptyState} />
        ) : (
          <div className="min-h-65">
            <div className="training-operator-grid grid grid-cols-3 overflow-hidden rounded-xl surface-soft sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-5 xl:grid-cols-5">
              {visibleOperators.map((operator, idx) => {
                const row = describeOperatorRow(operator, queueOperatorIds.has(operator.id));
                const imageLoaded = loadedImages[operator.id] || false;

                return (
                  <div
                    key={operator.id}
                    className={`training-operator-item relative overflow-hidden p-2.5 ${!row.isOwned ? 'opacity-75' : ''}`}
                  >
                  {/* 干员头像 */}
                  <div className="relative mb-2.5 aspect-square w-full overflow-hidden rounded-xl surface-panel">
                    {operator.id ? (
                      <>
                        {/* 骨架屏 */}
                        {!imageLoaded && (
                          <div className="app-skeleton absolute inset-0 surface-soft" />
                        )}
                        <img
                          src={`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${operator.id}.png`}
                          alt={operator.name}
                          loading={idx < 12 ? 'eager' : 'lazy'}
                          decoding="async"
                          className={`h-full w-full object-cover transition-opacity duration-200 ${
                            imageLoaded ? 'opacity-100' : 'opacity-0'
                          }`}
                          onLoad={() => setLoadedImages(prev => prev[operator.id] ? prev : ({ ...prev, [operator.id]: true }))}
                          onError={(e) => {
                            // 如果加载失败，尝试带 _2 后缀的版本（用于异格干员）
                            const target = e.target as HTMLImageElement;
                            const currentSrc = target.src;
                            if (!currentSrc.includes('_2.png') && !currentSrc.includes('_1.png')) {
                              target.src = `https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${operator.id}_2.png`;
                            } else if (currentSrc.includes('_2.png')) {
                              // 如果 _2 也失败，尝试 _1
                              target.src = `https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${operator.id}_1.png`;
                            } else {
                              // 都失败了，隐藏图片并标记为已加载
                              target.style.display = 'none';
                              setLoadedImages(prev => prev[operator.id] ? prev : ({ ...prev, [operator.id]: true }));
                            }
                          }}
                        />
                        {/* 不可添加时的半透明蒙版 */}
                        {!row.canAdd && imageLoaded && (
                          <div className={`absolute inset-0 ${row.isOwned ? 'bg-(--app-surface)/25' : 'bg-(--app-surface)/50'}`} />
                        )}
                      </>
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-tertiary">
                        无头像
                      </div>
                    )}
                    {/* 稀有度标识 */}
                    {operator.rarity !== undefined && operator.rarity > 0 && (
                      <div className="absolute right-2 top-2 rounded-full px-2 py-0.5 text-xs font-semibold surface-panel brand-text">
                        {operator.rarity}★
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 text-center">
                    <div className="truncate text-sm font-semibold text-primary" title={operator.name}>
                      {operator.name || '未知干员'}
                    </div>
                    <div className="flex min-h-5 flex-wrap items-center justify-center gap-1 text-xs">
                      {row.isOwned && operator.currentElite !== undefined && (
                        <span className="whitespace-nowrap rounded-full px-2 py-0.5 surface-panel text-secondary">
                          精{operator.currentElite}{operator.currentLevel ? ` · ${operator.currentLevel} 级` : ''}
                        </span>
                      )}
                    </div>

                    {/* 添加按钮 */}
                    <Button
                      onClick={() => void onAdd(operator)}
                      aria-label={row.canAdd ? `添加${operator.name}` : undefined}
                      disabled={!row.canAdd || busy}
                      loading={pendingOperatorIds.has(operator.id)}
                      loadingText="添加中"
                      variant='secondary'
                      size="md"
                      fullWidth
                    >
                      {row.actionLabel}
                    </Button>
                  </div>
                  </div>
                );
              })}
            </div>
            {hiddenCount > 0 && (
              <div className="flex flex-col items-center gap-2 py-3">
                <Button
                  onClick={() => setVisibleOperatorLimit(nextOperatorRenderLimit)}
                  variant="secondary"
                  size="md"
                  className="min-w-36"
                >
                  继续显示 {Math.min(OPERATOR_RENDER_BATCH_SIZE, hiddenCount)} 个
                </Button>
                <div className="text-xs text-tertiary">
                  已显示 {visibleOperators.length} / {filteredOperators.length}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
