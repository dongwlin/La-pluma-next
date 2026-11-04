import { useSyncExternalStore } from 'react'
import {
  statisticsCommandOwner,
  type StatisticsCommandOwner,
  type StatisticsCommandState,
} from '../model/commandOwner'

export function useStatisticsCommandState(
  owner: StatisticsCommandOwner = statisticsCommandOwner,
): StatisticsCommandState {
  return useSyncExternalStore(owner.subscribe, owner.getState, owner.getState)
}
