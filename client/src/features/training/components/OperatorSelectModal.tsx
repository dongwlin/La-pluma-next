import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, UserRoundSearch } from 'lucide-react'
import {
  operBoxQueryOptions,
  operatorCatalogQueryOptions,
  type OperatorDetailed,
} from '@/features/game-data'
import { Button, EmptyState, Input, Loading } from '@/shared/ui'
import { Modal } from '@/shared/ui/Modal'
import {
  OPERATOR_RENDER_BATCH_SIZE,
  filterOperatorRows,
  nextOperatorRenderLimit,
  paginateOperatorRows,
} from '../model/operatorRows'
import { toOperatorPickerOption } from '../model/operatorSelection'
import OperatorPickerGrid, { type OperatorPickerGridItem } from './OperatorPickerGrid'
import TrainingLoadError from './TrainingLoadError'
import type { OperatorPickerOption } from '../types'

export interface OperatorSelectModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (operator: OperatorPickerOption) => void
  title?: string
  selectedOperatorId?: string | null
  selectedOperatorName?: string | null
}

const EMPTY_OPERATORS: readonly OperatorDetailed[] = []
const LOAD_ERROR_MESSAGE = '干员列表加载失败，请稍后重试'

function OperatorEmptyState({ title, description }: { title: string; description?: string }) {
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

/**
 * 跨页面复用的单干员选择模态窗。没有识别数据时静默回退到全量目录，
 * 列表不得反显识别或拥有状态；选择结果只回传干员身份。
 */
export default function OperatorSelectModal({
  isOpen,
  onClose,
  onConfirm,
  title = '选择干员',
  selectedOperatorId = null,
  selectedOperatorName = null,
}: OperatorSelectModalProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [visibleLimit, setVisibleLimit] = useState(OPERATOR_RENDER_BATCH_SIZE)
  const [pendingSelection, setPendingSelection] = useState<OperatorPickerOption | null>(null)

  const operBoxQuery = useQuery({ ...operBoxQueryOptions(), enabled: isOpen })
  const ownedOperators = operBoxQuery.data?.data ?? EMPTY_OPERATORS
  const hasOwnedOperators = ownedOperators.length > 0
  const catalogQuery = useQuery({
    ...operatorCatalogQueryOptions(),
    enabled: isOpen && operBoxQuery.isSuccess && !hasOwnedOperators,
  })

  const options = useMemo(
    () => (hasOwnedOperators ? ownedOperators : catalogQuery.data ?? EMPTY_OPERATORS)
      .map(toOperatorPickerOption),
    [hasOwnedOperators, ownedOperators, catalogQuery.data],
  )
  const initialSelection = useMemo(() => (
    (selectedOperatorId ? options.find(option => option.id === selectedOperatorId) : undefined)
    ?? (selectedOperatorName ? options.find(option => option.name === selectedOperatorName) : undefined)
    ?? null
  ), [options, selectedOperatorId, selectedOperatorName])
  const selectedOperator = pendingSelection ?? initialSelection
  const catalogPending = operBoxQuery.isSuccess && !hasOwnedOperators && catalogQuery.isPending
  const loading = operBoxQuery.isPending || catalogPending
  const catalogError = operBoxQuery.isSuccess && !hasOwnedOperators && catalogQuery.isError
  const hasError = operBoxQuery.isError || catalogError

  const filteredOperators = filterOperatorRows(options, searchTerm)
  const { rows: visibleOperators, hiddenCount } = paginateOperatorRows(filteredOperators, visibleLimit)
  const emptyState = !loading && !hasError && filteredOperators.length === 0

  const handleSearchChange = (value: string) => {
    setSearchTerm(value)
    setVisibleLimit(OPERATOR_RENDER_BATCH_SIZE)
  }

  const handleClose = () => {
    setPendingSelection(null)
    onClose()
  }

  const handleConfirm = () => {
    if (!selectedOperator) return
    setPendingSelection(null)
    onConfirm(selectedOperator)
    onClose()
  }

  const handleRetry = () => {
    void operBoxQuery.refetch()
    if (catalogError) void catalogQuery.refetch()
  }

  const gridItems: OperatorPickerGridItem[] = visibleOperators.map((operator) => {
    const isSelected = operator.id === selectedOperator?.id
    return {
      id: operator.id,
      name: operator.name,
      rarity: operator.rarity,
      elite: operator.elite,
      level: operator.level,
      action: (
        <Button
          variant={isSelected ? 'primary' : 'secondary'}
          size="md"
          fullWidth
          aria-pressed={isSelected}
          aria-label={`${isSelected ? '已选择' : '选择'}${operator.name}`}
          onClick={() => setPendingSelection(operator)}
        >
          {isSelected ? '已选择' : '选择'}
        </Button>
      ),
    }
  })

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={title}
      size="xl"
      footer={(
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-secondary">
            {selectedOperator ? `已选择 ${selectedOperator.name}` : '选择一名干员'}
          </span>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={handleClose}>取消</Button>
            <Button onClick={handleConfirm} disabled={!selectedOperator}>确认选择</Button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        <Input
          type="text"
          aria-label="搜索干员名称"
          placeholder="搜索干员"
          value={searchTerm}
          onChange={handleSearchChange}
          icon={<Search size={17} strokeWidth={1.9} aria-hidden="true" />}
        />

        {loading ? (
          <div className="flex min-h-65 items-center justify-center">
            <Loading text="正在读取干员..." />
          </div>
        ) : hasError ? (
          <TrainingLoadError
            title="干员列表加载失败"
            description={LOAD_ERROR_MESSAGE}
            onRetry={handleRetry}
          />
        ) : emptyState ? (
          <OperatorEmptyState
            title={searchTerm.trim() ? '没有找到符合条件的干员' : '没有可选择的干员'}
            description={searchTerm.trim() ? '换个名称再试。' : undefined}
          />
        ) : (
          <OperatorPickerGrid
            items={gridItems}
            visibleCount={visibleOperators.length}
            totalCount={filteredOperators.length}
            hiddenCount={hiddenCount}
            onShowMore={() => setVisibleLimit(nextOperatorRenderLimit)}
          />
        )}
      </div>
    </Modal>
  )
}
