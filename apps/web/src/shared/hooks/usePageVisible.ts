import { useSyncExternalStore } from 'react'

export function isPageHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

const readPageVisible = () => !isPageHidden()

function subscribePageVisible(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

export function usePageVisible() {
  // React checks the snapshot again when Activity reactivates the subscription.
  return useSyncExternalStore(subscribePageVisible, readPageVisible, () => true)
}
