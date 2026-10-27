import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('release preparation rejects tags outside main before any build can be planned', () => {
  const directory = mkdtempSync(join(tmpdir(), 'la-pluma-ci-plan-'))
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git('init', '--quiet', '--initial-branch=main')
    git('config', 'user.name', 'CI test')
    git('config', 'user.email', 'ci@example.invalid')
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    git('add', 'package.json')
    git('commit', '--quiet', '-m', 'test: initialize fixture')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    const eventPath = join(directory, 'event.json')
    const outputPath = join(directory, 'output')
    writeFileSync(eventPath, '{}')
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('./prepare.mjs', import.meta.url))], {
      cwd: directory, encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY_OWNER: 'Example' },
    })
    const valid = run()
    assert.equal(valid.status, 0, valid.stderr || valid.stdout)
    assert.match(readFileSync(outputPath, 'utf8'), /publish=true/)
    assert.match(readFileSync(outputPath, 'utf8'), /image=ghcr.io\/example\/la-pluma-next/)
    writeFileSync(outputPath, '')
    git('switch', '--quiet', '-c', 'feature')
    writeFileSync(join(directory, 'unreviewed.js'), 'throw new Error("unreviewed")')
    git('add', 'unreviewed.js')
    git('commit', '--quiet', '-m', 'test: unreviewed commit')
    assert.notEqual(run().status, 0)
    assert.equal(readFileSync(outputPath, 'utf8'), '')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
