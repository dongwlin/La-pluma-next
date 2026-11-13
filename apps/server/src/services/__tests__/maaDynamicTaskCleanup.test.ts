import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  MAA_DYNAMIC_TASK_DIR_PREFIX,
  cleanupStaleDynamicTaskDirectories
} from '../maaExecutionService.ts'

const root = await mkdtemp(join(tmpdir(), 'la-pluma-dynamic-task-cleanup-'))
const tasksDir = join(root, 'tasks')
const now = Date.parse('2026-01-01T12:00:00.000Z')
const expiryMs = 60 * 60 * 1000
const expiredAt = '2026-01-01T10:00:00.000Z'
const freshAt = '2026-01-01T11:59:00.000Z'
const deadPid = 2147483647

await mkdir(tasksDir, { recursive: true })
after(() => rm(root, { recursive: true, force: true }))

async function writeTaskDir(name: string, owner: Record<string, unknown> | string | null): Promise<string> {
  const taskDir = join(tasksDir, name)
  await mkdir(taskDir, { recursive: true })
  await writeFile(join(taskDir, 'task.toml'), '[[tasks]]\nname = "Award"\ntype = "Award"\n')
  if (owner !== null) {
    await writeFile(
      join(taskDir, 'owner.json'),
      typeof owner === 'string' ? owner : JSON.stringify(owner)
    )
  }
  return taskDir
}

function cleanup(): ReturnType<typeof cleanupStaleDynamicTaskDirectories> {
  return cleanupStaleDynamicTaskDirectories({
    getConfigDir: async () => root,
    now: () => now,
    expiryMs
  })
}

describe('dynamic task directory cleanup', () => {
  it('removes only expired directories whose owner process is gone', async () => {
    const expiredDir = await writeTaskDir(`${MAA_DYNAMIC_TASK_DIR_PREFIX}expired`, {
      pid: deadPid,
      startedAt: expiredAt
    })
    const activeDir = await writeTaskDir(`${MAA_DYNAMIC_TASK_DIR_PREFIX}active`, {
      pid: process.pid,
      startedAt: expiredAt
    })
    const freshDir = await writeTaskDir(`${MAA_DYNAMIC_TASK_DIR_PREFIX}fresh`, {
      pid: deadPid,
      startedAt: freshAt
    })
    const unknownOwnerDir = await writeTaskDir(`${MAA_DYNAMIC_TASK_DIR_PREFIX}unknown`, null)
    const invalidOwnerDir = await writeTaskDir(`${MAA_DYNAMIC_TASK_DIR_PREFIX}invalid`, '{not json')
    const foreignDir = await writeTaskDir('manual-task', {
      pid: deadPid,
      startedAt: expiredAt
    })
    await writeFile(join(tasksDir, `${MAA_DYNAMIC_TASK_DIR_PREFIX}file.toml`), 'not a directory')

    const summary = await cleanup()

    assert.deepEqual(summary, { scanned: 5, removed: 1, retained: 4 })
    await assert.rejects(stat(expiredDir), { code: 'ENOENT' })
    for (const retainedDir of [activeDir, freshDir, unknownOwnerDir, invalidOwnerDir, foreignDir]) {
      assert.equal((await stat(retainedDir)).isDirectory(), true)
    }
  })

  it('treats a missing tasks directory as nothing to clean', async () => {
    const summary = await cleanupStaleDynamicTaskDirectories({
      getConfigDir: async () => join(root, 'missing-config'),
      now: () => now,
      expiryMs
    })

    assert.deepEqual(summary, { scanned: 0, removed: 0, retained: 0 })
  })
})
