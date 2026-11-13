import type { Plugin } from 'vite'

/** Applied identically to both exported source trees; never part of a normal build. */
export const PROFILING_OVERLAY = `
const profilingSample = { enabled: false, commits: [] }
window.__reactProfiler = profilingSample
const recordProfile = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
  if (profilingSample.enabled) profilingSample.commits.push({
    id, phase, actualDuration, baseDuration, startTime, commitTime,
  })
}
`

export function createProfilingOverlay(mainFile: string): Plugin {
  let applied = 0
  return {
    name: 'paired-app-profiler',
    enforce: 'pre',
    transform(source, id) {
      if (id !== mainFile) return
      if (!source.includes("import { StrictMode } from 'react'") || !source.includes('<App />')) {
        throw new Error('Unsupported main.tsx: paired profiling requires the same App boundary')
      }
      applied += 1
      return source
        .replace("import { StrictMode } from 'react'", "import { StrictMode, Profiler } from 'react'")
        .replace('createRoot(', `${PROFILING_OVERLAY}\ncreateRoot(`)
        .replace('<App />', '<Profiler id="App" onRender={recordProfile}><App /></Profiler>')
    },
    buildEnd(error) {
      if (!error && applied !== 1) throw new Error(`Profiler overlay applied ${applied} times; expected exactly one`)
    },
  }
}
