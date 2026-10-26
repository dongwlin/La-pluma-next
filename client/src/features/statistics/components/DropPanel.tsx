/**
 * 掉落记录面板
 *
 * 面板持有统计周期与掉落 Query；周期天数进入 Query key，切换周期复用
 * `keepPreviousData` 行为。面板随页面挂载常驻，非当前 tab 时只返回 null：
 * 掉落读取仍在首屏启动，切回时保留已选周期。
 *
 * 排序与展示上限在 `model/dropRecords`，视图组件 `DropRecords` 只渲染结果。
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'framer-motion'
import { dropStatisticsQueryOptions } from '../model/queries'
import DropRecords from './DropRecords'

const DROP_READ_ERROR = '暂时无法读取掉落记录，请检查服务连接后重试。'

interface DropPanelProps {
  isActive: boolean
}

export default function DropPanel({ isActive }: DropPanelProps) {
  const shouldReduceMotion = useReducedMotion()
  const [dropDays, setDropDays] = useState(7)
  const dropQuery = useQuery(dropStatisticsQueryOptions(dropDays))

  if (!isActive) return null

  return (
    <motion.div
      id="data-statistics-panel-drops"
      role="tabpanel"
      aria-labelledby="data-statistics-tab-drops"
      initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={shouldReduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 38, mass: 0.72 }}
      className="min-w-0"
    >
      <DropRecords
        dropStatistics={dropQuery.data ?? null}
        dropDays={dropDays}
        setDropDays={setDropDays}
        onRefresh={() => {
          void dropQuery.refetch()
        }}
        isLoading={dropQuery.isFetching}
        error={dropQuery.isError ? DROP_READ_ERROR : null}
      />
    </motion.div>
  )
}
