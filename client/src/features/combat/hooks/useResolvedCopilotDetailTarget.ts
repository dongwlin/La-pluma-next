import { useQuery } from '@tanstack/react-query'
import { readMissingDetailCopilotId, type CopilotDetailTarget } from '../model/copilotDetail'
import { copilotInfoQueryOptions } from '../model/queries'

export function useResolvedCopilotDetailTarget(
  target: CopilotDetailTarget | null,
): CopilotDetailTarget | null {
  const copilotId = readMissingDetailCopilotId(target)
  const query = useQuery({
    ...copilotInfoQueryOptions(copilotId ?? ''),
    enabled: copilotId !== null,
  })
  const details = copilotId ? query.data?.detail?.details : undefined
  return target && details ? { ...target, details } : target
}
