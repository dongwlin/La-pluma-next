import { assertCheckResults } from './policy.mjs'

assertCheckResults(JSON.parse(process.env.CHECK_RESULTS))
console.log('All required checks passed; only explicitly unneeded jobs were skipped.')
