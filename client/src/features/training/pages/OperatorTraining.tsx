import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpToLine, Check, ClipboardList, Filter, Package, Plus, Search, Sparkles, Trash2, UserRoundSearch, X } from 'lucide-react'
import { getOperatorList, getAllOperators, getOperBoxData, getTrainingQueue, addToTrainingQueue, removeFromTrainingQueue, updateTrainingQueueOrder, updateTrainingSettings, generateTrainingPlan, applyTrainingPlan, retryTrainingSync, getItemIconUrl } from '@/shared/api'
import { PageHeader, Button, EmptyState, IconButton, Input, Loading, Select, Switch } from '@/shared/ui'
import { Modal } from '@/shared/ui/Modal'
import { FloatingStatusIndicator, useStatusStore } from '@/features/runtime-status'
import { useFluidTabIndicator } from '@/shared/hooks/useFluidTabIndicator'
import type { TrainingOperator, TrainingQueueItem, TrainingSettings, TrainingPlan, MaterialNode, TrainingFilters, TrainingPlanMode } from '@/shared/types/components'
import './OperatorTraining.css'

const TRAINING_STATUS_OPTIONS: Array<{ value: TrainingFilters['status']; label: string; desc: string }> = [
  { value: 'trainable', label: '可养成', desc: '可加入队列' },
  { value: 'owned', label: '已拥有', desc: '已识别干员' },
  { value: 'all', label: '全部', desc: '含未拥有' },
]

interface TrainingFlowSync {
  status: 'not_applied' | 'synced' | 'failed'
  flowName: string
  taskName?: string
  error?: string
}

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

type FallbackOperatorRow = Partial<TrainingOperator> & {
  elite?: number
  level?: number
  potential?: number
  position?: string
}

type TrainingStatusCounts = Record<TrainingFilters['status'], number>
const OPERATOR_RENDER_BATCH_SIZE = 72

const extractOperatorRows = (payload: unknown): FallbackOperatorRow[] => {
  const data = payload as { operators?: FallbackOperatorRow[]; data?: FallbackOperatorRow[] } | FallbackOperatorRow[] | null | undefined;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.operators)) return data.operators;
  if (Array.isArray(data?.data)) return data.data;
  return [];
};

const countOperatorsByCurrentMetaFilters = (
  rows: FallbackOperatorRow[],
  options: { rarity?: number; needsElite2?: boolean } = {}
) => rows.filter(operator => {
  if (options.rarity && operator.rarity !== options.rarity) return false;
  if (options.needsElite2) {
    const elite = operator.currentElite ?? operator.elite ?? 0;
    if (elite >= 2) return false;
  }
  return true;
}).length;

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
  
  const [operators, setOperators] = useState<TrainingOperator[]>([]);
  const [queue, setQueue] = useState<TrainingQueueItem[]>([]);
  const [settings, setSettings] = useState<TrainingSettings>({
    useMedicine: 0,
    useStone: 0,
    autoSwitch: true,
    notifyOnComplete: true
  });
  const [plan, setPlan] = useState<TrainingPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [operatorsLoading, setOperatorsLoading] = useState(false);
  const [operatorsError, setOperatorsError] = useState<string | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [statusCountsLoading, setStatusCountsLoading] = useState(false);
  const [trainingStatusCounts, setTrainingStatusCounts] = useState<TrainingStatusCounts>({
    trainable: 0,
    owned: 0,
    all: 0
  });
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
  const [searchTerm, setSearchTerm] = useState('');
  const [planMode, setPlanMode] = useState<TrainingPlanMode>('current');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [flowSync, setFlowSync] = useState<TrainingFlowSync>({ status: 'not_applied', flowName: '自动任务' });
  const [refreshError, setRefreshError] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const planRequestRef = useRef(0);
  const workInFlightRef = useRef(false);
  const queueHeadingRef = useRef<HTMLHeadingElement>(null);
  const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>({});
  const [visibleOperatorLimit, setVisibleOperatorLimit] = useState(OPERATOR_RENDER_BATCH_SIZE);
  const [pendingOperatorIds, setPendingOperatorIds] = useState<Set<string>>(new Set());
  const [recentlyRemoved, setRecentlyRemoved] = useState<{ item: TrainingQueueItem; index: number } | null>(null);
  const operatorsRequestRef = useRef(0);
  const statusCountsRequestRef = useRef(0);
  const settingsRequestRef = useRef(0);
  const queueRequestRef = useRef(0);
  const queueRevisionRef = useRef<string | null>(null);
  const settingsWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistedSettingsRef = useRef(settings);
  const queueMutationInFlightRef = useRef(false);

  const handleTrainingStatusChange = (status: TrainingFilters['status']) => {
    setFilters(current => ({
      ...current,
      status,
      needsElite2: status === 'all' ? false : current.needsElite2,
    }));
  };

  const getOpenStagePlan = (sourcePlan: TrainingPlan): TrainingPlan => ({
    ...sourcePlan,
    stages: sourcePlan.openStages ?? sourcePlan.stages?.filter(stage => stage.isOpen !== false) ?? []
  });

  const getOpenStageCount = (sourcePlan: TrainingPlan | null): number => {
    if (!sourcePlan) return 0;
    return sourcePlan.openStages?.length ?? sourcePlan.stages?.filter(stage => stage.isOpen !== false).length ?? 0;
  };

  const loadTrainingStatusCounts = useCallback(async () => {
    const requestId = ++statusCountsRequestRef.current;
    const requestedRarity = filters.rarity;
    const requestedNeedsElite2 = filters.needsElite2;
    setStatusCountsLoading(true);
    try {
      const rarity = requestedRarity ? parseInt(requestedRarity) : undefined;
      const [trainableResponse, ownedResponse, allOperatorsResponse, operBoxResponse] = await Promise.all([
        getOperatorList({ status: 'trainable', rarity, needsElite2: requestedNeedsElite2 }),
        getOperatorList({ status: 'owned', rarity, needsElite2: requestedNeedsElite2 }),
        getAllOperators(),
        getOperBoxData()
      ]);

      if (requestId !== statusCountsRequestRef.current) return;

      const trainableRows = trainableResponse.success ? extractOperatorRows(trainableResponse.data) : [];
      const ownedRows = ownedResponse.success ? extractOperatorRows(ownedResponse.data) : [];
      const allRows = allOperatorsResponse.success ? extractOperatorRows(allOperatorsResponse.data) : [];
      const operBoxRows = operBoxResponse.success ? extractOperatorRows(operBoxResponse.data) : [];

      setTrainingStatusCounts(prev => {
        const ownedCount = ownedRows.length > 0
          ? ownedRows.length
          : countOperatorsByCurrentMetaFilters(operBoxRows, { rarity, needsElite2: requestedNeedsElite2 });
        const allCount = countOperatorsByCurrentMetaFilters(allRows, { rarity });

        return {
          trainable: trainableRows.length,
          owned: ownedCount,
          all: allCount > 0 ? allCount : prev.all
        };
      });
    } catch (error) {
      // 静默失败，保留上一次统计
    } finally {
      if (requestId === statusCountsRequestRef.current) setStatusCountsLoading(false);
    }
  }, [filters.rarity, filters.needsElite2]);

  useEffect(() => {
    setVisibleOperatorLimit(OPERATOR_RENDER_BATCH_SIZE);
  }, [filters.status, filters.rarity, filters.needsElite2, searchTerm]);

  // 加载养成队列
  useEffect(() => {
    void loadQueue(true);
  }, []);

  const loadOperators = useCallback(async () => {
    const requestId = ++operatorsRequestRef.current;
    const requestedFilters = { ...filters };
    try {
      setOperatorsLoading(true);
      setOperatorsError(null);
      const response = await getOperatorList({
        ...requestedFilters,
        rarity: requestedFilters.rarity ? parseInt(requestedFilters.rarity) : undefined
      });
      if (requestId !== operatorsRequestRef.current) return;
      if (!response.success) {
        throw new Error(response.message || response.errorInfo?.message || response.error || '干员列表加载失败');
      }
      if (response.success) {
        // 适配新的响应格式：data.operators 是数组
        let nextOperators: TrainingOperator[] = response.data.operators || response.data || [];

        if (requestedFilters.status === 'all' && nextOperators.length === 0) {
          const [allOperatorsResponse, operBoxResponse] = await Promise.all([
            getAllOperators(),
            getOperBoxData()
          ]);

          if (allOperatorsResponse.success) {
            const allOperators: FallbackOperatorRow[] = allOperatorsResponse.data.operators || allOperatorsResponse.data || [];
            const operBoxPayload = operBoxResponse.success ? operBoxResponse.data : null;
            const ownedOperators: FallbackOperatorRow[] = operBoxPayload?.data || operBoxPayload?.operators || [];
            const ownedMap = new Map(ownedOperators.map(operator => [operator.id, operator]));
            if (requestId !== operatorsRequestRef.current) return;
            const rarityFilter = requestedFilters.rarity ? parseInt(requestedFilters.rarity) : null;

            nextOperators = allOperators
              .filter(operator => !rarityFilter || operator.rarity === rarityFilter)
              .map((operator) => {
                const ownedOperator = ownedMap.get(operator.id);
                const owned = Boolean(ownedOperator);
                const disabledReason = owned ? 'missing_material_data' : 'unowned';

                return {
                  id: operator.id || '',
                  name: ownedOperator?.name || operator.name || '未知干员',
                  rarity: ownedOperator?.rarity ?? operator.rarity ?? 0,
                  profession: operator.profession || ownedOperator?.profession || '未知',
                  currentElite: owned ? (ownedOperator?.elite || 0) : 0,
                  currentLevel: owned ? (ownedOperator?.level || 1) : 0,
                  targetElite: 2,
                  owned,
                  potential: owned ? (ownedOperator?.potential || 1) : 0,
                  hasMaterialData: false,
                  canTrain: false,
                  disabledReason,
                  trainingStatus: disabledReason
                };
              });
          } else {
            throw new Error(allOperatorsResponse.message || allOperatorsResponse.errorInfo?.message || allOperatorsResponse.error || '完整干员列表加载失败');
          }
        }

        if (requestId === operatorsRequestRef.current) setOperators(nextOperators);
      }
    } catch (error) {
      if (requestId === operatorsRequestRef.current) {
        setOperators([]);
        setOperatorsError(error instanceof Error && error.message ? error.message : '干员列表加载失败，请稍后重试');
      }
    } finally {
      if (requestId === operatorsRequestRef.current) setOperatorsLoading(false);
    }
  }, [filters]);

  // 加载干员列表
  useEffect(() => {
    void loadOperators();
  }, [loadOperators]);

  useEffect(() => {
    void loadTrainingStatusCounts();
  }, [loadTrainingStatusCounts]);

  const loadQueue = async (syncSettings = false) => {
    const requestId = ++queueRequestRef.current;
    const settingsRevision = settingsRequestRef.current;
    if (syncSettings) {
      setQueueLoading(true);
      setQueueError(null);
    }
    try {
      const response = await getTrainingQueue();
      if (requestId !== queueRequestRef.current) return null;
      if (!response.success) {
        throw new Error(response.message || response.errorInfo?.message || response.error || '养成队列加载失败');
      }
      if (!Array.isArray(response.data?.queue)) {
        throw new Error('养成队列数据格式不正确');
      }
      if (response.success && response.data?.queue) {
        const revision = response.data.revision;
        if (revision && queueRevisionRef.current && revision !== queueRevisionRef.current) {
          planRequestRef.current += 1;
          setPlan(null);
        }
        if (revision) queueRevisionRef.current = revision;
        setQueue(response.data.queue);
        setRefreshError(false);
        if (response.data.flowSync) setFlowSync(response.data.flowSync);
        setQueueError(null);
        if (syncSettings && settingsRevision === settingsRequestRef.current && response.data.settings) {
          persistedSettingsRef.current = response.data.settings;
          setSettings(response.data.settings);
        }
        return response.data;
      }
    } catch (error) {
      if (requestId === queueRequestRef.current) setRefreshError(true);
      if (syncSettings && requestId === queueRequestRef.current) {
        setQueueError(error instanceof Error && error.message ? error.message : '养成队列加载失败，请稍后重试');
      }
    } finally {
      if (requestId === queueRequestRef.current) setQueueLoading(false);
    }
    return null;
  };

  const setOperatorPending = (operatorId: string, pending: boolean) => {
    setPendingOperatorIds(current => {
      const next = new Set(current);
      if (pending) next.add(operatorId);
      else next.delete(operatorId);
      return next;
    });
  };

  const invalidatePlan = () => {
    planRequestRef.current += 1;
    setPlan(null);
    setPlanError(null);
  };

  const beginMutation = (operatorId: string) => {
    if (queueMutationInFlightRef.current || workInFlightRef.current) return false;
    queueMutationInFlightRef.current = true;
    setOperatorPending(operatorId, true);
    setOperationError(null);
    invalidatePlan();
    return true;
  };

  const finishMutation = (operatorId: string) => {
    queueMutationInFlightRef.current = false;
    setOperatorPending(operatorId, false);
  };

  const recordSync = (sync?: TrainingFlowSync) => {
    if (!sync) return;
    setFlowSync(sync);
    if (sync.status === 'synced') window.dispatchEvent(new CustomEvent('training-plan-applied'));
  };

  const handleAddToQueue = async (operator: TrainingOperator) => {
    if (queue.some(item => item.operatorId === operator.id) || !beginMutation(operator.id)) return;
    setRecentlyRemoved(null);
    try {
      const response = await addToTrainingQueue({ operatorId: operator.id, currentElite: operator.currentElite ?? 0, targetElite: operator.targetElite ?? 2 });
      if (!response.success) throw new Error(response.message || '添加失败，请重试');
      const queueData = await loadQueue();
      if (!queueData) {
        setQueue(current => [...current, { operatorId: operator.id, operator: { name: operator.name, rarity: operator.rarity, profession: operator.profession }, currentElite: operator.currentElite ?? 0, targetElite: operator.targetElite ?? 2, materials: [], progress: 0 }]);
      }
      recordSync(queueData?.flowSync ?? response.data?.flowSync);
      setStatusMessage(queueData ? `${operator.name} 已加入养成队列` : `${operator.name} 已添加，但队列刷新失败，请重试`, queueData ? 'success' : 'warning');
    } catch (error) {
      const message = error instanceof Error ? error.message : '添加失败，请重试';
      setOperationError(message);
      showError(message);
    } finally { finishMutation(operator.id); }
  };

  const handleRemoveFromQueue = async (operatorId: string) => {
    const index = queue.findIndex(item => item.operatorId === operatorId);
    const item = queue[index];
    if (!item || !beginMutation(operatorId)) return;
    try {
      const response = await removeFromTrainingQueue(operatorId);
      if (!response.success) throw new Error(response.message || '删除失败，请重试');
      const queueData = await loadQueue();
      if (!queueData) setQueue(current => current.filter(entry => entry.operatorId !== operatorId));
      recordSync(queueData?.flowSync ?? response.data?.flowSync);
      setRecentlyRemoved({ item, index });
      queueHeadingRef.current?.focus({ preventScroll: true });
      if (!queueData) setStatusMessage('已移除，但队列刷新失败，请重试', 'warning');
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除失败，请重试';
      setOperationError(message);
      showError(message);
    } finally { finishMutation(operatorId); }
  };

  const handleUndoRemove = async () => {
    const snapshot = recentlyRemoved;
    if (!snapshot || !beginMutation(snapshot.item.operatorId)) return;
    try {
      const response = await addToTrainingQueue({ operatorId: snapshot.item.operatorId, currentElite: snapshot.item.currentElite, targetElite: snapshot.item.targetElite, position: snapshot.index });
      if (!response.success) throw new Error(response.message || '撤销失败，请重试');
      const queueData = await loadQueue();
      if (!queueData) setQueue(current => {
        const restored = current.filter(item => item.operatorId !== snapshot.item.operatorId);
        restored.splice(Math.min(snapshot.index, restored.length), 0, snapshot.item);
        return restored;
      });
      recordSync(queueData?.flowSync ?? response.data?.flowSync);
      setRecentlyRemoved(null);
      queueHeadingRef.current?.focus({ preventScroll: true });
      setStatusMessage(`${snapshot.item.operator.name} 已恢复${queueData ? '' : '，但队列刷新失败，请重试'}`, queueData ? 'success' : 'warning');
    } catch (error) {
      const message = error instanceof Error ? error.message : '撤销失败，请重试';
      setOperationError(message);
      showError(message);
    } finally { finishMutation(snapshot.item.operatorId); }
  };

  const handleReorder = async (operatorId: string, destination: number) => {
    const index = queue.findIndex(item => item.operatorId === operatorId);
    if (index < 0 || index === destination || destination < 0 || destination >= queue.length || !beginMutation(operatorId)) return;
    const reordered = [...queue];
    const [item] = reordered.splice(index, 1);
    reordered.splice(destination, 0, item!);
    try {
      const response = await updateTrainingQueueOrder(reordered.map(entry => entry.operatorId));
      if (!response.success) throw new Error(response.message || '顺序更新失败，请重试');
      const queueData = await loadQueue();
      if (!queueData) setQueue(reordered);
      setRecentlyRemoved(null);
      recordSync(queueData?.flowSync ?? response.data?.flowSync);
      queueHeadingRef.current?.focus({ preventScroll: true });
      setStatusMessage(queueData ? '养成顺序已更新' : '顺序已更新，但队列刷新失败，请重试', queueData ? 'success' : 'warning');
    } catch (error) {
      const message = error instanceof Error ? error.message : '顺序更新失败，请重试';
      setOperationError(message);
      showError(message);
    } finally { finishMutation(operatorId); }
  };

  const handleGeneratePlan = async () => {
    if (queue.length === 0 || queueMutationInFlightRef.current || workInFlightRef.current || refreshError) return;
    workInFlightRef.current = true;
    let requestId = ++planRequestRef.current;
    setLoading(true);
    setPlan(null);
    setPlanError(null);
    try {
      const freshQueue = await loadQueue();
      if (!freshQueue) throw new Error('队列刷新失败，请重新加载后预览');
      if (!freshQueue.queue.length) throw new Error('养成队列为空，请先添加干员');
      requestId = ++planRequestRef.current;
      const response = await generateTrainingPlan({ mode: planMode });
      if (requestId !== planRequestRef.current) return;
      if (!response.success || !response.data) throw new Error(response.message || '生成计划失败，请重试');
      if (response.data.queueRevision && queueRevisionRef.current && response.data.queueRevision !== queueRevisionRef.current) {
        await loadQueue();
        setPlanError('养成队列已变化，请重新预览计划');
        return;
      }
      setPlan(response.data);
    } catch (error) {
      if (requestId === planRequestRef.current) setPlanError(error instanceof Error ? error.message : '生成计划失败，请重试');
    } finally {
      workInFlightRef.current = false;
      setLoading(false);
    }
  };

  const handleApplyPlan = async () => {
    if (!plan || queueMutationInFlightRef.current || workInFlightRef.current || refreshError) return;
    const todayPlan = getOpenStagePlan(plan);
    if (!todayPlan.stages?.length) return;
    workInFlightRef.current = true;
    setLoading(true);
    setPlanError(null);
    try {
      const response = await applyTrainingPlan({ plan: todayPlan, settings });
      if (!response.success) throw new Error(response.message || '应用失败，请重新预览后重试');
      recordSync(response.data?.flowSync ?? { status: 'synced', flowName: response.data?.flowName || flowSync.flowName, taskName: response.data?.taskName });
      showSuccess(`养成计划已应用到${response.data?.flowName || flowSync.flowName}`);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : '应用失败，请重新预览后重试');
      setPlan(null);
      await loadQueue();
    } finally { workInFlightRef.current = false; setLoading(false); }
  };

  const handleRetrySync = async () => {
    if (queueMutationInFlightRef.current || workInFlightRef.current) return;
    workInFlightRef.current = true;
    setSyncing(true);
    try {
      const response = await retryTrainingSync();
      await loadQueue();
      if (response.data?.flowSync) recordSync(response.data.flowSync);
      else if (!response.success) throw new Error(response.message || '同步失败，请重试');
    } catch (error) {
      setFlowSync(current => ({ ...current, status: 'failed', error: error instanceof Error ? error.message : '同步失败，请重试' }));
    } finally { workInFlightRef.current = false; setSyncing(false); }
  };

  const handleUpdateSettings = (newSettings: TrainingSettings) => {
    const requestId = ++settingsRequestRef.current;
    setSettings(newSettings);

    settingsWriteQueueRef.current = settingsWriteQueueRef.current.then(async () => {
      try {
        const response = await updateTrainingSettings(newSettings);
        if (response.success) {
          const savedSettings = response.data ?? newSettings;
          persistedSettingsRef.current = savedSettings;
          if (requestId === settingsRequestRef.current) setSettings(savedSettings);
          return;
        }
      } catch (error) {
        // The latest requested value is restored below when its write fails.
      }

      if (requestId === settingsRequestRef.current) {
        setSettings(persistedSettingsRef.current);
        showError('设置保存失败，已恢复原设置');
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
  const queueMutationPending = pendingOperatorIds.size > 0;
  const busy = queueMutationPending || loading || syncing;
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
          {refreshError && !queueError && <div role="alert" className="training-feedback status-warning"><span>队列已更新，但刷新失败。重新加载后再预览计划。</span><Button variant="ghost" onClick={() => { invalidatePlan(); void loadQueue(true); }} disabled={busy}>重新加载</Button></div>}
          {queueLoading ? <div className="training-state"><Loading text="正在读取养成队列..." /></div> : queueError ? <TrainingLoadError title="养成队列加载失败" description={queueError} onRetry={() => void loadQueue(true)} /> : queue.length === 0 ? (
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
            <div className="training-plan-controls"><Select aria-label="计划范围" value={planMode} onChange={mode => { setPlanMode(mode as TrainingPlanMode); invalidatePlan(); }} disabled={busy} options={[{ value: 'current', label: '仅当前目标' }, { value: 'all', label: '全部队列' }]} /><Button onClick={handleGeneratePlan} disabled={!queue.length || busy || refreshError || !!queueError} loading={loading && !plan} loadingText="计算中" variant={plan ? 'secondary' : 'primary'} icon={<Sparkles size={16} />}>预览刷图计划</Button></div>
            {planError && <div role="alert" className="training-feedback status-danger">{planError}</div>}
            {plan ? <>
              <div className="training-plan-overview"><div><h3>{planFocusName}</h3><p>今日可刷 {openStageCount} 个关卡 · {todayRunCount} 次{todaySanity > 0 ? ` · 约 ${todaySanity} 理智` : ''}</p><p>完整计划约 {plan.totalSanity ?? 0} 理智（含未开放关卡）</p></div></div>
              {!!plan.warnings?.length && <div role="note" className="training-plan-warnings status-warning">{plan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
              {todayStages.length > 0 ? <div className="training-stage-list">{todayStages.map((stage, index) => <div key={`${stage.stage}-${index}`} className="training-stage-row"><div><strong>{stage.stage}</strong><p>{stage.materials?.map(material => `${material.name} ×${material.count ?? material.needed ?? 0}`).join('、') || '今日可直接推进'}</p></div><span className="tabular-nums font-semibold">×{stage.totalTimes ?? 0}</span></div>)}</div> : <p className="training-inline-empty">{currentMissingMaterials.length === 0 ? '当前材料已齐，无需刷取。' : '今天没有可直接推进的开放关卡，查看详情安排后续刷取。'}</p>}
              <div className="training-apply"><Button onClick={handleApplyPlan} disabled={busy || !openStageCount || refreshError} loading={loading} loadingText="应用中" icon={<Check size={16} />} fullWidth>应用到{flowSync.flowName}</Button><p>写入{flowSync.taskName ? `「${flowSync.taskName}」` : '作战任务'}的智能养成关卡，保留普通关卡。</p></div>
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
            <div className="flex min-h-[260px] items-center justify-center">
              <Loading text="正在读取干员..." />
            </div>
          ) : operatorsError ? (
            <TrainingLoadError
              title="干员列表加载失败"
              description={operatorsError}
              onRetry={() => void loadOperators()}
            />
          ) : operatorEmptyState ? (
            <OperatorEmptyState {...operatorEmptyState} />
          ) : (
            <div className="min-h-[260px]">
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
                            <div className={`absolute inset-0 ${isOwned ? 'bg-[var(--app-surface)]/25' : 'bg-[var(--app-surface)]/50'}`} />
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
