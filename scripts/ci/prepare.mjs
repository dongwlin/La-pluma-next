import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { releaseVersion, selectChecks } from './policy.mjs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
const ref = process.env.GITHUB_REF
const version = releaseVersion(ref, JSON.parse(readFileSync('package.json', 'utf8')).version)
const revision = git('rev-parse', 'HEAD')
const publish = version !== null

if (publish) {
  // A tag cannot bypass the reviewed integration branch.
  git('merge-base', '--is-ancestor', revision, 'origin/main')
}

const full = publish || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
const base = event.pull_request?.base.sha || event.before
const paths = !full && base && !/^0+$/.test(base)
  ? execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, revision], { encoding: 'utf8' }).split('\0').filter(Boolean)
  : []
const plan = selectChecks(paths, {
  full: full || !base || /^0+$/.test(base),
  publish,
  mainPush: process.env.GITHUB_EVENT_NAME === 'push' && ref === 'refs/heads/main',
})
const outputs = {
  ...plan,
  matrix: JSON.stringify(plan.matrix),
  image: `ghcr.io/${process.env.GITHUB_REPOSITORY_OWNER.toLowerCase()}/la-pluma-next`,
  version: version?.version || revision,
  revision,
}
for (const [key, value] of Object.entries(outputs)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
console.log(JSON.stringify(outputs, null, 2))
