import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'framer-motion'
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpToLine, Check, ClipboardList, Filter, Package, Plus, Search, Sparkles, Trash2, UserRoundSearch, X } from 'lucide-react'
import { getItemIconUrl } from '@/features/game-data'
import { useResourceInvalidation } from '@/features/resource-invalidation'
import {
  trainingCandidatesQueryOptions,
  trainingQueueQueryOptions,
  trainingStatusCountsQueryOptions,
} from '../model/queries'
import { trainingKeys } from '../model/queryKeys'
import { isTrainingQueueMutationInvalidation } from '../model/queueCommands'
import {
  canApplyTrainingPlan,
  canGenerateTrainingPlan,
  isTrainingPlanBasisCurrent,
} from '../model/planValidity'
import { getOpenStagePlan } from '../model/planCommands'
import {
  TRAINING_SETTINGS_FAILURE_MESSAGE,
  isTrainingSettingsInvalidation,
} from '../model/settingsCommands'
import { EMPTY_TRAINING_COUNTS } from '../model/statusCounts'
import { useTrainingQueueCommands } from '../hooks/useTrainingQueueCommands'
import { useTrainingPlan } from '../hooks/useTrainingPlan'
import { useTrainingSettings } from '../hooks/useTrainingSettings'
import { PageHeader, Button, EmptyState, IconButton, Input, Loading, Select, Switch } from '@/shared/ui'
import { Modal } from '@/shared/ui/Modal'
import { FloatingStatusIndicator, useStatusStore } from '@/features/runtime-status'
import { useFluidTabIndicator } from '@/shared/hooks/useFluidTabIndicator'
import type { TrainingQueueCommandOutcome } from '../model/queueCommands'
import type { TrainingOperator, TrainingQueueItem, TrainingSettings, TrainingPlan, MaterialNode, TrainingFilters, TrainingPlanMode } from '../types'

const TRAINING_STATUS_OPTIONS: Array<{ value: TrainingFilters['status']; label: string; desc: string }> = [
  { value: 'trainable', label: '可养成', desc: '可加入队列' },
  { value: 'owned', label: '已拥有', desc: '已识别干员' },
  { value: 'all', label: '全部', desc: '含未拥有' },
]

function ResourceIcon({ id }: { id?: string | number }) {
  return <span className="training-resource-icon"><Package size={18} aria-hidden="true" />{id && <img src={getItemIconUrl(id)} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none' }} />}</span>
}

function MaterialTable({ materials }: { materials: MaterialNode[] }) {
  return <div className="training-material-table" role="table" aria-label="材料筹备明细">
    <div className="training-material-line training-material-labels" role="row"><span role="columnheader">材料</span><span role="columnheader">拥有</span><span role="columnheader">需要</span><span role="columnheader">缺口</span></div>
    {materials.map(material => <div className="training-material-line" role="row" key={material.id}>
      <span role="cell" className="training-material-name"><ResourceIcon id={material.iconId} /><span>{material.name}</span></span>
      <span role="cell">{material.have}</span><span role="cell">{material.needed}</span>
      <span role="cell" className={material.stillNeeded > 0 ? 'brand-text font-semibold' : 'text-secondary'}>{material.stillNeeded > 0 ? material.stillNeeded : '已齐'}</span>
    </div>)}
  </div>
}

function MaterialTree({ nodes }: { nodes: MaterialNode[] }) {
  return <ul className="training-material-tree">{nodes.map(node => <li key={node.id}>
    <div><ResourceIcon id={node.iconId} /><span className="min-w-0 flex-1">{node.name}</span><span className="text-secondary tabular-nums">{node.have} / {node.needed}</span><span className="brand-text">{node.stillNeeded > 0 ? `缺 ${node.stillNeeded}` : '已齐'}</span></div>
    {node.children && node.children.length > 0 && <MaterialTree nodes={node.children} />}
  </li>)}</ul>
}

function getQueueMaterials(item: TrainingQueueItem): MaterialNode[] {
  const materials = item.materials ?? []
  return item.lmd ? [...materials, { id: '4001', name: '龙门币', iconId: '4001', count: item.lmd.needed, ...item.lmd }] : materials
}

function UndoToast({ name, pending, onUndo, onDismiss }: { name: string; pending: boolean; onUndo: () => void; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false)
  const dismissRef = useRef(onDismiss)
  useEffect(() => { dismissRef.current = onDismiss }, [onDismiss])
  useEffect(() => {
    if (paused || pending) return
    const timeout = setTimeout(() => dismissRef.current(), 8000)
    return () => clearTimeout(timeout)
  }, [name, paused, pending])
  return createPortal(<div className="training-undo-toast" role="status" aria-live="polite" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false) }}>
    <Check size={18} aria-hidden="true" /><span className="min-w-0 flex-1">已移除 {name}</span>
    <Button variant="ghost" onClick={onUndo} loading={pending} loadingText="恢复中">撤销</Button>
    <IconButton variant="ghost" aria-label="关闭移除提示" disabled={pending} onClick={onDismiss} icon={<X size={17} />} />
  </div>, document.body)
}

interface OperatorEmptyStateProps {
  title: string
  description: string
}

function OperatorEmptyState({ title, description }: OperatorEmptyStateProps) {
  return (
    <EmptyState
      compact
      className="py-8"
      icon={<UserRoundSearch size={21} strokeWidth={1.8} />}
      title={title}
      description={description}
    />
  );
}

function TrainingLoadError({
  title,
  description,
  onRetry,
}: {
  title: string
  description: string
  onRetry: () => void
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-4 rounded-xl px-6 py-8 text-center status-danger" role="alert">
      <AlertCircle size={22} strokeWidth={1.9} aria-hidden="true" />
      <div className="max-w-md">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 text-sm leading-6">{description}</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        重新加载
      </Button>
    </div>
  );
}

const OPERATOR_RENDER_BATCH_SIZE = 72
const EMPTY_TRAINING_QUEUE: TrainingQueueItem[] = []
const TRAINING_RESOURCE_SCOPES = [
  'depot',
  'operbox',
  'catalog',
  'materials',
  'training-queue',
  'training-plan',
] as const

export default function OperatorTraining() {
  const shouldReduceMotion = useReducedMotion();
  const { setMessage: setStatusMessage } = useStatusStore()

  // 辅助函数：使用 statusMessage 显示消息
  const showSuccess = (msg: string) => {
    setStatusMessage(msg, 'success')
  }
  const showError = (msg: string) => {
    setStatusMessage(msg, 'error')
  }
  
  // 设置的读取、串行提交与本地 revision 由 training 领域所有者持有；
  // 页面只显示当前值，并把要应用的设置交给 apply 请求。
  const {
    settings,
    revision: settingsRevision,
    update: updateSettings,
  } = useTrainingSettings()
  // 计划预览、版本前提、生成/应用/同步编排与跨域失效发布由领域所有者持有。
  const {
    plan,
    basis: planBasis,
    error: planError,
    warning: planWarning,
    flowSync,
    generating,
    applying,
    syncing,
    generate: generatePlan,
    apply: applyPlan,
    retrySync: retryFlowSync,
    reload: reloadQueue,
    invalidate: invalidatePlan,
    recordFlowSync,
  } = useTrainingPlan()
  const [filters, setFilters] = useState<TrainingFilters>({
    rarity: '',
    status: 'trainable',
    needsElite2: true
  });
  const {
    containerRef: statusTabsRef,
    activeRect: activeStatusRect,
    setTabRef: setStatusTabRef,
    handleTabKeyDown: handleStatusKeyDown,
  } = useFluidTabIndicator(filters.status);

  // 候选列表与三种状态计数由 training 领域 query 持有：页面不再保存请求 id、
  // request 生命周期或资源副本；筛选切换按 key 隔离，取消由 Query signal 负责。
  const queryClient = useQueryClient()
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

  // 队列由 training 领域 query 持有唯一快照；写入、写后刷新与 fallback 都归
  // queueCommands 领域命令，页面不再维护第二份可写队列。
  const queueOptions = useMemo(() => trainingQueueQueryOptions(), [])
  const queueQuery = useQuery(queueOptions)
  const queueSnapshot = queueQuery.data
  const queue = queueSnapshot?.queue ?? EMPTY_TRAINING_QUEUE
  // 首次读取失败后重试期间保持加载态，避免错误页与请求进度同时出现。
  const queueLoading = queueQuery.isPending
    || (queueQuery.isFetching && !queueSnapshot && queueQuery.isError)
  const queueError = queueQuery.isError && !queueSnapshot
    ? (queueQuery.error instanceof Error && queueQuery.error.message
        ? queueQuery.error.message
        : '养成队列加载失败，请稍后重试')
    : null
  const queueUncertain = queueSnapshot?.uncertain ?? null
  const refreshError = Boolean(queueUncertain)
    || (queueQuery.isError && Boolean(queueSnapshot))
  const {
    pendingOperatorIds,
    queueMutationPending,
    run: runQueueCommand,
  } = useTrainingQueueCommands()

  const [searchTerm, setSearchTerm] = useState('');
  const [planMode, setPlanMode] = useState<TrainingPlanMode>('current');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const queueHeadingRef = useRef<HTMLHeadingElement>(null);
  const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>({});
  const [visibleOperatorLimit, setVisibleOperatorLimit] = useState(OPERATOR_RENDER_BATCH_SIZE);
  const [recentlyRemoved, setRecentlyRemoved] = useState<{ item: TrainingQueueItem; index: number } | null>(null);

  const handleTrainingStatusChange = (status: TrainingFilters['status']) => {
    setFilters(current => ({
      ...current,
      status,
      needsElite2: status === 'all' ? false : current.needsElite2,
    }));
  };

  const getOpenStageCount = (sourcePlan: TrainingPlan | null): number => {
    if (!sourcePlan) return 0;
    return sourcePlan.openStages?.length ?? sourcePlan.stages?.filter(stage => stage.isOpen !== false).length ?? 0;
  };

  useEffect(() => {
    // 筛选/搜索变化时重置分页游标；这是对本页已渲染列表的同步复位。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisibleOperatorLimit(OPERATOR_RENDER_BATCH_SIZE);
  }, [filters.status, filters.rarity, filters.needsElite2, searchTerm]);

  // 识别、材料刷新与资源更新可能来自本页之外。候选列表与计数按资源作用域
  // 失效领域 query，计划前提变化时作废旧计划；队列写入的权威快照已由领域
  // 命令写入，因此忽略本页自己发布的队列失效。
  useResourceInvalidation(TRAINING_RESOURCE_SCOPES, invalidation => {
    if (isTrainingQueueMutationInvalidation(invalidation)) return
    // 设置所有者已在编辑时按 revision 作废旧计划；它自己的成功发布不再重复
    // 清空用户在该写入期间重新生成的预览。外部 `training-plan` 仍会作废。
    if (isTrainingSettingsInvalidation(invalidation)) return
    const { resources } = invalidation
    const touchesPlan = resources.some(resource => (
      resource === 'depot' || resource === 'materials' || resource === 'training-plan'
    ))
    const touchesQueue = resources.some(resource => (
      resource === 'depot' || resource === 'materials' || resource === 'training-queue'
    ))
    const touchesOperators = resources.some(resource => (
      resource === 'depot' || resource === 'operbox' || resource === 'catalog' || resource === 'materials'
    ))

    if (touchesPlan) invalidatePlan()
    if (touchesQueue) void reloadQueue()
    if (touchesOperators) {
      void queryClient.invalidateQueries({ queryKey: trainingKeys.resource('candidates') })
      void queryClient.invalidateQueries({ queryKey: trainingKeys.resource('counts') })
    }
  });

  // 命令失败保留原队列并展示可重试错误；写入成功（含写后刷新失败）才推进 UI。
  const settleQueueOutcome = (
    outcome: TrainingQueueCommandOutcome,
  ): Extract<TrainingQueueCommandOutcome, { status: 'applied' | 'uncertain' }> | null => {
    if (outcome.status === 'ignored') return null
    if (outcome.status === 'failed') {
      setOperationError(outcome.message)
      showError(outcome.message)
      // 命令开始时会取消在途读取；若当时还没有快照，失败后重新建立首屏读取。
      if (!queueSnapshot) void queueQuery.refetch()
      return null
    }
    recordFlowSync(outcome.flowSync)
    if (outcome.status === 'uncertain') setStatusMessage(outcome.message, 'warning')
    else if (outcome.message) showSuccess(outcome.message)
    return outcome
  }

  const handleAddToQueue = async (operator: TrainingOperator) => {
    if (queue.some(item => item.operatorId === operator.id)) return;
    setRecentlyRemoved(null);
    setOperationError(null);
    invalidatePlan();
    const outcome = await runQueueCommand({ type: 'add', operator });
    settleQueueOutcome(outcome);
  };

  const handleRemoveFromQueue = async (operatorId: string) => {
    if (!queue.some(item => item.operatorId === operatorId)) return;
    setOperationError(null);
    invalidatePlan();
    const outcome = await runQueueCommand({ type: 'remove', operatorId });
    const settled = settleQueueOutcome(outcome);
    if (!settled?.removed) return;
    setRecentlyRemoved(settled.removed);
    queueHeadingRef.current?.focus({ preventScroll: true });
  };

  const handleUndoRemove = async () => {
    const snapshot = recentlyRemoved;
    if (!snapshot) return;
    setOperationError(null);
    // 撤销同样是队列写入：开始时立即作废旧预览，不依赖写后 revision 兜底。
    invalidatePlan();
    const outcome = await runQueueCommand({
      type: 'undo',
      item: snapshot.item,
      index: snapshot.index,
    });
    const settled = settleQueueOutcome(outcome);
    if (!settled) return;
    setRecentlyRemoved(null);
    queueHeadingRef.current?.focus({ preventScroll: true });
  };

  const handleReorder = async (operatorId: string, destination: number) => {
    const index = queue.findIndex(item => item.operatorId === operatorId);
    if (
      index < 0
      || index === destination
      || destination < 0
      || destination >= queue.length
    ) return;
    setOperationError(null);
    invalidatePlan();
    const outcome = await runQueueCommand({ type: 'reorder', operatorId, destination });
    const settled = settleQueueOutcome(outcome);
    if (!settled) return;
    setRecentlyRemoved(null);
    queueHeadingRef.current?.focus({ preventScroll: true });
  };

  const handleGeneratePlan = () => {
    // 可生成条件和版本前提由领域所有者再次校验；按钮状态只是提前反馈。
    void generatePlan(planMode);
  };

  const handleApplyPlan = async () => {
    const outcome = await applyPlan();
    if (outcome.status === 'applied') {
      showSuccess(`养成计划已应用到${outcome.flowName}`);
    } else if (outcome.status === 'partial') {
      setStatusMessage(outcome.message, 'warning');
    }
  };

  const handleRetrySync = async () => {
    const outcome = await retryFlowSync();
    if (outcome.status === 'partial') setStatusMessage(outcome.message, 'warning');
  };

  const handleUpdateSettings = (newSettings: TrainingSettings) => {
    // 编辑立即作废旧计划：即使随后写入失败，旧计划也不能继续被应用。
    invalidatePlan();
    void updateSettings(newSettings).then(outcome => {
      if (outcome.status === 'failed' && !outcome.superseded) {
        showError(TRAINING_SETTINGS_FAILURE_MESSAGE);
      }
    });
  };

  // 过滤干员
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const filteredOperators = operators.filter(op => {
    if (normalizedSearchTerm && !op.name.toLowerCase().includes(normalizedSearchTerm)) {
      return false;
    }
    return true;
  });
  const visibleOperators = filteredOperators.slice(0, visibleOperatorLimit);
  const hiddenOperatorCount = Math.max(filteredOperators.length - visibleOperators.length, 0);
  const openStageCount = getOpenStageCount(plan);
  const currentTarget = queue[0] ?? null;
  const todayStages = plan ? getOpenStagePlan(plan).stages ?? [] : [];
  const todayRunCount = todayStages.reduce((sum, stage) => sum + Number(stage.totalTimes ?? 0), 0);
  const currentMaterials = currentTarget ? getQueueMaterials(currentTarget) : [];
  const currentMissingMaterials = currentMaterials.filter(material => material.stillNeeded > 0);
  const currentProgress = currentTarget?.progress ?? 0;
  const planFocusName = plan?.focusOperator?.name || plan?.operators?.[0]?.name || currentTarget?.operator.name || '未设置';
  const busy = queueMutationPending || generating || applying || syncing;
  const planBasisCurrent = Boolean(plan && planBasis
    && isTrainingPlanBasisCurrent(planBasis, {
      queueRevision: queueSnapshot?.revision ?? null,
      settingsRevision,
    }));
  const previewAvailable = canGenerateTrainingPlan({
    hasQueue: queue.length > 0 && !queueError,
    busy,
    refreshFailed: refreshError,
  });
  const applyAvailable = canApplyTrainingPlan({
    hasPlan: Boolean(plan),
    busy,
    refreshFailed: refreshError,
    basisCurrent: planBasisCurrent,
  });
  const todaySanity = todayStages.reduce((total, stage) => total + (plan?.stages?.find(entry => entry.stage === stage.stage)?.sanityPerRun ?? 0) * (stage.totalTimes ?? 0), 0);
  const operatorEmptyState: OperatorEmptyStateProps | null = !operatorsLoading && filteredOperators.length === 0
    ? (() => {
        if (normalizedSearchTerm || filters.rarity) {
          return {
            title: '没有找到符合条件的干员',
            description: '换个名称、稀有度或状态筛选再试。'
          };
        }

        if (filters.status === 'trainable') {
          return {
            title: '没有可养成干员',
            description: '当前没有可直接加入队列的干员，可以切到“已拥有”或“全部”查看其他状态。'
          };
        }

        if (filters.status === 'owned') {
          return {
            title: '还没有已拥有干员',
            description: '请先在“数据统计”页面识别干员，或切到“全部”查看完整干员列表。'
          };
        }

        return {
          title: '没有干员数据',
          description: '全量干员数据暂不可用，请先更新资源或稍后重试。'
        };
      })()
    : null;

  return (
    <div className="app-page ios-workspace-page training-workspace" data-page="training">
      <PageHeader title="养成" subtitle="管理目标，筹备材料，安排下一次作战" actions={<><FloatingStatusIndicator /><Button onClick={() => setSelectorOpen(true)} icon={<Plus size={17} />}>添加干员</Button></>} />
      <div className="training-workspace-grid">
        <section className="training-queue-section training-surface" aria-labelledby="training-queue-title">
          <div className="training-section-heading">
            <div><h2 ref={queueHeadingRef} tabIndex={-1} id="training-queue-title">养成队列 <span className="text-secondary font-normal">{queue.length}</span></h2><p>按顺序筹备，第一位是当前目标</p></div>
            <ClipboardList size={20} className="text-tertiary" aria-hidden="true" />
          </div>
          {operationError && <div role="alert" className="training-feedback status-danger">{operationError}</div>}
          {refreshError && !queueError && <div role="alert" className="training-feedback status-warning"><span>{queueUncertain ?? '队列已更新，但刷新失败。重新加载后再预览计划。'}</span><Button variant="ghost" onClick={() => { invalidatePlan(); void reloadQueue(); }} disabled={busy}>重新加载</Button></div>}
          {queueLoading ? <div className="training-state"><Loading text="正在读取养成队列..." /></div> : queueError ? <TrainingLoadError title="养成队列加载失败" description={queueError} onRetry={() => void reloadQueue()} /> : queue.length === 0 ? (
            <div className="training-state"><EmptyState compact icon={<ClipboardList size={24} />} title="养成队列还是空的" description="添加需要筹备材料的干员，按目标安排刷图。" /><Button onClick={() => setSelectorOpen(true)} variant="secondary" icon={<Plus size={17} />}>选择干员</Button></div>
          ) : <ol className="training-queue-list">
            {queue.map((item, index) => <li key={item.operatorId} className={`training-queue-row ${index === 0 ? 'is-current' : ''}`}>
              <div className="training-queue-identity">
                <span className="training-queue-rank">{String(index + 1).padStart(2, '0')}</span>
                <span className="training-avatar"><UserRoundSearch size={22} aria-hidden="true" /><img src={`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${item.operatorId}.png`} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none' }} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><h3 className="training-operator-name">{item.operator.name}</h3>{index === 0 && <span className="training-current-label">当前</span>}</div>
                  <p className="training-queue-meta">精{item.currentElite} → 精{item.targetElite}<span>{getQueueMaterials(item).filter(material => material.stillNeeded > 0).length} 种缺口</span></p>
                  <div className="training-row-progress"><span className="training-progress-track" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, item.progress ?? 0))}%` }} /></span><span>{item.progress ?? 0}%</span><span className="sr-only">材料筹备进度</span></div>
                </div>
              </div>
              <div className="training-queue-actions">
                {index > 0 && <Button variant="ghost" size="md" disabled={busy} onClick={() => void handleReorder(item.operatorId, 0)} aria-label={`将${item.operator.name}设为当前`} icon={<ArrowUpToLine size={15} />}>设为当前</Button>}
                <div className="flex items-center">
                  <IconButton variant="ghost" disabled={busy || index === 0} onClick={() => void handleReorder(item.operatorId, index - 1)} aria-label={`上移${item.operator.name}`} title="上移" icon={<ArrowUp size={16} />} />
                  <IconButton variant="ghost" disabled={busy || index === queue.length - 1} onClick={() => void handleReorder(item.operatorId, index + 1)} aria-label={`下移${item.operator.name}`} title="下移" icon={<ArrowDown size={16} />} />
                  <IconButton variant="ghost" disabled={busy} onClick={() => void handleRemoveFromQueue(item.operatorId)} aria-label={`移除${item.operator.name}`} title="移除" className="training-remove" icon={pendingOperatorIds.has(item.operatorId) ? <span className="h-4 w-4 motion-safe:animate-spin rounded-full border-2 border-current border-r-transparent" /> : <Trash2 size={16} />} />
                </div>
              </div>
            </li>)}
          </ol>}
          {queue.length > 0 && <div className="training-queue-footer"><span className="text-xs text-secondary">进度仅表示材料筹备情况</span><Button variant="ghost" onClick={() => setSelectorOpen(true)} icon={<Plus size={15} />}>继续添加</Button></div>}
        </section>

        <div className="training-detail-column">
          <section className="training-surface" aria-labelledby="training-materials-title">
            <div className="training-section-heading"><div><h2 id="training-materials-title">{currentTarget ? `${currentTarget.operator.name}的材料` : '材料筹备'}</h2><p>{currentTarget ? `精${currentTarget.currentElite} → 精${currentTarget.targetElite} · ${currentMissingMaterials.length > 0 ? `还缺 ${currentMissingMaterials.length} 种材料` : '材料已集齐'}` : '添加目标后查看材料缺口'}</p></div>{currentTarget && <span className="training-progress-value">{currentProgress}%<small>材料筹备进度</small></span>}</div>
            {currentTarget ? <>
              <div className="training-current-progress" role="progressbar" aria-label="当前目标材料筹备进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={currentProgress}><span style={{ width: `${Math.min(100, Math.max(0, currentProgress))}%` }} /></div>
              {currentMissingMaterials.length > 0 ? <MaterialTable materials={currentMissingMaterials} /> : <p className="training-inline-empty"><Check size={18} />当前目标材料已集齐，可在游戏内完成养成。</p>}
              {currentMaterials.length > 0 && <details className="training-disclosure"><summary>查看全部材料与合成需求</summary><MaterialTree nodes={currentMaterials} /></details>}
            </> : <p className="training-inline-empty">还没有需要筹备的材料。</p>}
          </section>

          <section className="training-surface" aria-labelledby="training-plan-title">
            <div className="training-section-heading"><div><h2 id="training-plan-title">刷图计划</h2><p>先预览，再应用到任务流程</p></div><Sparkles size={20} className="text-tertiary" aria-hidden="true" /></div>
            <div className="training-plan-controls"><Select aria-label="计划范围" value={planMode} onChange={mode => { setPlanMode(mode as TrainingPlanMode); invalidatePlan(); }} disabled={busy} options={[{ value: 'current', label: '仅当前目标' }, { value: 'all', label: '全部队列' }]} /><Button onClick={handleGeneratePlan} disabled={!previewAvailable} loading={generating} loadingText="计算中" variant={plan && planBasisCurrent ? 'secondary' : 'primary'} icon={<Sparkles size={16} />}>预览刷图计划</Button></div>
            {planError && <div role="alert" className="training-feedback status-danger">{planError}</div>}
            {planWarning && <div role="alert" className="training-feedback status-warning"><span>{planWarning}</span><Button variant="ghost" onClick={() => void reloadQueue()} disabled={busy}>重新加载</Button></div>}
            {plan && planBasisCurrent ? <>
              <div className="training-plan-overview"><div><h3>{planFocusName}</h3><p>今日可刷 {openStageCount} 个关卡 · {todayRunCount} 次{todaySanity > 0 ? ` · 约 ${todaySanity} 理智` : ''}</p><p>完整计划约 {plan.totalSanity ?? 0} 理智（含未开放关卡）</p></div></div>
              {!!plan.warnings?.length && <div role="note" className="training-plan-warnings status-warning">{plan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
              {todayStages.length > 0 ? <div className="training-stage-list">{todayStages.map((stage, index) => <div key={`${stage.stage}-${index}`} className="training-stage-row"><div><strong>{stage.stage}</strong><p>{stage.materials?.map(material => `${material.name} ×${material.count ?? material.needed ?? 0}`).join('、') || '今日可直接推进'}</p></div><span className="tabular-nums font-semibold">×{stage.totalTimes ?? 0}</span></div>)}</div> : <p className="training-inline-empty">{currentMissingMaterials.length === 0 ? '当前材料已齐，无需刷取。' : '今天没有可直接推进的开放关卡，查看详情安排后续刷取。'}</p>}
              <div className="training-apply"><Button onClick={handleApplyPlan} disabled={!applyAvailable || !openStageCount} loading={applying} loadingText="应用中" icon={<Check size={16} />} fullWidth>应用到{flowSync.flowName}</Button><p>写入{flowSync.taskName ? `「${flowSync.taskName}」` : '作战任务'}的智能养成关卡，保留普通关卡。</p></div>
              <details className="training-disclosure"><summary>查看完整材料、未开放关卡与计算详情</summary>
                {!!plan.closedStages?.length && <div className="training-closed-stages"><h3>今日未开放</h3>{plan.closedStages.map((stage, index) => <p key={`${stage.stage}-${index}`}><strong>{stage.stage}</strong><span>{stage.totalTimes ?? 0} 次 · 等待开放</span></p>)}</div>}
                {!!plan.materialHierarchy?.length && <><h3 className="mt-4 font-semibold">计划材料需求</h3><MaterialTree nodes={plan.materialHierarchy} /></>}
                {!!plan.stages?.length && <div className="training-closed-stages"><h3>完整关卡列表</h3>{plan.stages.map((stage, index) => <p key={`${stage.stage}-${index}`}><strong>{stage.stage}</strong><span>{stage.totalTimes ?? 0} 次 · {stage.isOpen === false ? '未开放' : '今日开放'}</span></p>)}</div>}
              </details>
            </> : !planError && <p className="training-plan-placeholder">{queue.length ? '队列变更后需重新预览，确保计划与当前目标一致。' : '选择养成目标后，即可计算材料缺口与推荐关卡。'}</p>}
            <div className={`training-sync-status ${flowSync.status === 'failed' ? 'status-warning' : ''}`} role="status">
              <div>{flowSync.status === 'failed' ? <><strong>队列已更新，任务流程同步失败</strong><p>{flowSync.error || '请重试同步，避免流程使用旧关卡。'}</p></> : flowSync.status === 'synced' ? <><strong>已同步到{flowSync.flowName}</strong><p>队列变更会自动同步智能养成关卡，删空后清理。</p></> : <p>尚未应用到{flowSync.flowName}。添加干员与预览不会修改流程。</p>}</div>
              {flowSync.status === 'failed' && <Button variant="secondary" onClick={handleRetrySync} loading={syncing} loadingText="同步中" disabled={busy}>重试同步</Button>}
            </div>
          </section>
        </div>
      </div>
      <details className="training-surface training-settings"><summary>自动化设置<span>自动切换与完成通知</span></summary><div className="training-settings-grid">
        <div><div><h3>自动切换</h3><p>当前目标材料齐备后，继续筹备下一位</p></div><Switch compact label="自动切换" checked={settings.autoSwitch} onChange={checked => handleUpdateSettings({ ...settings, autoSwitch: checked })} /></div>
        <div><div><h3>完成通知</h3><p>目标材料筹备完成时发送通知</p></div><Switch compact label="完成通知" checked={settings.notifyOnComplete} onChange={checked => handleUpdateSettings({ ...settings, notifyOnComplete: checked })} /></div>
      </div></details>
      <Modal isOpen={selectorOpen} onClose={() => setSelectorOpen(false)} title="添加干员" size="xl" footer={<div className="flex w-full items-center justify-between gap-3"><span className="text-sm text-secondary">已加入 {queue.length} 名干员</span><Button onClick={() => setSelectorOpen(false)} variant="secondary">完成选择</Button></div>}>
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
          ) : operatorEmptyState ? (
            <OperatorEmptyState {...operatorEmptyState} />
          ) : (
            <div className="min-h-65">
              <div className="training-operator-grid grid grid-cols-3 overflow-hidden rounded-xl surface-soft sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-5 xl:grid-cols-5">
                {visibleOperators.map((operator, idx) => {
                  const isInQueue = queue.some(q => q.operatorId === operator.id);
                  const imageLoaded = loadedImages[operator.id] || false;
                  const isOwned = operator.owned !== false;
                  const isAlreadyElite2 = operator.disabledReason === 'already_elite2';
                  const canAdd = Boolean(operator.canTrain) && !isInQueue;
                  const actionLabel = isInQueue
                    ? '已添加'
                    : !isOwned
                      ? '未拥有'
                      : !operator.hasMaterialData
                        ? '暂无数据'
                        : isAlreadyElite2
                          ? '已完成'
                          : '添加';

                  return (
                    <div
                      key={operator.id}
                      className={`training-operator-item relative overflow-hidden p-2.5 ${!isOwned ? 'opacity-75' : ''}`}
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
                          {!canAdd && imageLoaded && (
                            <div className={`absolute inset-0 ${isOwned ? 'bg-(--app-surface)/25' : 'bg-(--app-surface)/50'}`} />
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
                        {isOwned && operator.currentElite !== undefined && (
                          <span className="whitespace-nowrap rounded-full px-2 py-0.5 surface-panel text-secondary">
                            精{operator.currentElite}{operator.currentLevel ? ` · ${operator.currentLevel} 级` : ''}
                          </span>
                        )}
                      </div>
                      
                      {/* 添加按钮 */}
                      <Button
                        onClick={() => handleAddToQueue(operator)}
                        aria-label={canAdd ? `添加${operator.name}` : undefined}
                        disabled={!canAdd || busy}
                        loading={pendingOperatorIds.has(operator.id)}
                        loadingText="添加中"
                        variant='secondary'
                        size="md"
                        fullWidth
                      >
                        {actionLabel}
                      </Button>
                    </div>
                    </div>
                  );
                })}
              </div>
              {hiddenOperatorCount > 0 && (
                <div className="flex flex-col items-center gap-2 py-3">
                  <Button
                    onClick={() => setVisibleOperatorLimit(limit => limit + OPERATOR_RENDER_BATCH_SIZE)}
                    variant="secondary"
                    size="md"
                    className="min-w-36"
                  >
                    继续显示 {Math.min(OPERATOR_RENDER_BATCH_SIZE, hiddenOperatorCount)} 个
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
      {recentlyRemoved && <UndoToast key={recentlyRemoved.item.operatorId} name={recentlyRemoved.item.operator.name} pending={queueMutationPending} onUndo={handleUndoRemove} onDismiss={() => setRecentlyRemoved(null)} />}
    </div>
  );
}
