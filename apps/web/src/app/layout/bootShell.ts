const BOOT_SHELL_SELECTOR = '[data-boot-shell]'
const LEAVE_CLASS = 'is-leaving'
const EXIT_FALLBACK_MS = 400
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function dismissBootShell(): void {
  const boot = document.querySelector<HTMLElement>(BOOT_SHELL_SELECTOR)
  if (!boot || boot.dataset.bootLeaving === 'true') return

  boot.dataset.bootLeaving = 'true'
  boot.setAttribute('aria-busy', 'false')

  let exitTimer = 0
  const finish = () => {
    window.clearTimeout(exitTimer)
    boot.remove()
  }

  if (window.matchMedia?.(REDUCED_MOTION_QUERY).matches) {
    finish()
    return
  }

  boot.classList.add(LEAVE_CLASS)
  boot.addEventListener('transitionend', event => {
    if (event.target === boot && event.propertyName === 'opacity') finish()
  })
  exitTimer = window.setTimeout(finish, EXIT_FALLBACK_MS)
}
