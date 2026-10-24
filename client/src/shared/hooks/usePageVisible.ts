import { useSyncExternalStore } from 'react'

const readPageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

function subscribePageVisible(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

export function usePageVisible() {
  // React checks the snapshot again when Activity reactivates the subscription.
  return useSyncExternalStore(subscribePageVisible, readPageVisible, () => true)
}
