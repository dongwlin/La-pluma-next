import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, afterEach, describe, it } from 'node:test'
import {
  beginAgentRun,
  completeAgentRun,
  markAgentRunWaiting,
  resetAgentRunsForTests,
  startAgentRun
} from '../agentRunService.ts'
import { getTaskStatus, setTaskStatus } from '../maaProcessService.ts'
import { buildAgentRunSnapshot } from '../runSnapshotService.ts'
import { loggerManager } from '../../utils/logger.ts'

loggerManager.getLogger('MaaService').enableConsole = false

let lockDir: string
let lockFile: string
let previousLockFile: string | undefined

before(async () => {
  lockDir = await mkdtemp(join(tmpdir(), 'la-pluma-run-snapshot-'))
  lockFile = join(lockDir, 'maa-execution.lock')
  previousLockFile = process.env.LA_PLUMA_MAA_LOCK_FILE
  process.env.LA_PLUMA_MAA_LOCK_FILE = lockFile
})

after(async () => {
  if (previousLockFile === undefined) delete process.env.LA_PLUMA_MAA_LOCK_FILE
  else process.env.LA_PLUMA_MAA_LOCK_FILE = previousLockFile
  await rm(lockDir, { recursive: true, force: true })
})

async function writeLease(owner: Record<string, unknown>): Promise<void> {
  await writeFile(lockFile, JSON.stringify(owner))
}

describe('run snapshot', () => {
  beforeEach(async () => {
    resetAgentRunsForTests()
    await rm(lockFile, { force: true })
    if (getTaskStatus().isRunning) setTaskStatus(false)
  })

  it('reports idle without runs, tasks or a lease', async () => {
    const snapshot = await buildAgentRunSnapshot()

    assert.equal(snapshot.run, null)
    assert.equal(snapshot.lastRun, null)
    assert.deepEqual(snapshot.activeRuns, [])
    assert.equal(snapshot.isRunning, false)
    assert.equal(snapshot.occupancy.state, 'idle')
    assert.deepEqual(snapshot.occupancy.lease, { state: 'free', owner: null })
    assert.deepEqual(snapshot.occupancy.sources, [])
  })

  it('reports a tracked run as the device owner', async () => {
    const run = beginAgentRun({ operationId: 'run_daily_flow' }).run
    startAgentRun(run.runId)

    const snapshot = await buildAgentRunSnapshot()

    assert.ok(snapshot.run)
    assert.equal(snapshot.run.runId, run.runId)
    assert.equal(snapshot.run.state, 'running')
    assert.equal(snapshot.occupancy.state, 'run')
    assert.equal(snapshot.occupancy.runId, run.runId)
    assert.equal(snapshot.occupancy.runState, 'running')
    assert.deepEqual(snapshot.occupancy.sources, ['run'])
    assert.ok(snapshot.run.progress)
    assert.equal(snapshot.run.progress.currentStep, null)
    assert.equal(snapshot.run.progress.message, '等待流程状态')
  })

  it('does not project another flow into a daily-flow run that does not own it', async () => {
    const accepted = beginAgentRun({ operationId: 'run_daily_flow' }).run

    const pendingSnapshot = await buildAgentRunSnapshot()
    assert.ok(pendingSnapshot.run)
    assert.ok(pendingSnapshot.run.progress)
    assert.equal(pendingSnapshot.run.progress.currentStep, null)
    assert.equal(pendingSnapshot.run.progress.message, '等待执行权')

    startAgentRun(accepted.runId)
    const snapshot = await buildAgentRunSnapshot()
    assert.ok(snapshot.run)
    assert.ok(snapshot.run.progress)
    assert.equal(snapshot.run.progress.currentStep, null)
    assert.equal(snapshot.run.progress.message, '等待流程状态')
  })

  it('reports a live lease without a run as external occupancy', async () => {
    const startedAt = new Date().toISOString()
    await writeLease({
      pid: process.pid,
      source: 'auto-update',
      taskName: '自动更新 MAA',
      command: 'update',
      startedAt
    })

    const snapshot = await buildAgentRunSnapshot()

    assert.equal(snapshot.occupancy.state, 'external')
    assert.equal(snapshot.occupancy.runId, null)
    assert.deepEqual(snapshot.occupancy.sources, ['lease'])
    assert.equal(snapshot.occupancy.lease.state, 'held')
    assert.deepEqual(snapshot.occupancy.lease.owner, {
      pid: process.pid,
      source: 'auto-update',
      taskName: '自动更新 MAA',
      command: 'update',
      startedAt
    })
  })

  it('treats a reclaimable lock file as stale rather than occupied', async () => {
    await writeLease({
      pid: 2147483647,
      source: 'dead-process',
      taskName: '已退出的进程',
      command: 'fight',
      startedAt: new Date().toISOString()
    })

    const snapshot = await buildAgentRunSnapshot()

    assert.equal(snapshot.occupancy.lease.state, 'stale')
    assert.equal(snapshot.occupancy.state, 'idle')
    assert.deepEqual(snapshot.occupancy.sources, [])
  })

  it('reports an unreadable lease as unknown instead of idle', async () => {
    await writeFile(lockFile, '{not json')

    const snapshot = await buildAgentRunSnapshot()

    assert.equal(snapshot.occupancy.lease.state, 'unknown')
    assert.equal(snapshot.occupancy.lease.owner, null)
    assert.equal(snapshot.occupancy.state, 'unknown')
  })

  it('reports a waiting manual set as a pending intent without device ownership', async () => {
    const run = beginAgentRun({ operationId: 'run_copilot_set' }).run
    startAgentRun(run.runId)
    markAgentRunWaiting(run.runId)

    const snapshot = await buildAgentRunSnapshot()

    assert.ok(snapshot.run)
    assert.ok(snapshot.run.progress)
    assert.equal(snapshot.run.runId, run.runId)
    assert.equal(snapshot.run.state, 'waiting')
    assert.equal(snapshot.run.progress.message, '等待开始下一关')
    assert.equal(snapshot.occupancy.state, 'pending')
    assert.equal(snapshot.occupancy.runState, 'waiting')
    assert.deepEqual(snapshot.occupancy.sources, ['run'])

    const newer = beginAgentRun({ operationId: 'run_task' }).run
    const withIntent = await buildAgentRunSnapshot()
    assert.ok(withIntent.run)
    assert.equal(withIntent.run.runId, newer.runId)
    const waitingEntry = withIntent.activeRuns.find(active => active.runId === run.runId)
    assert.ok(waitingEntry?.progress)
    assert.equal(waitingEntry.state, 'waiting')
    assert.equal(waitingEntry.progress.message, '等待开始下一关')
    assert.equal(withIntent.occupancy.state, 'pending')
  })

  it('keeps the latest terminal run without making it the current identity', async () => {
    const run = beginAgentRun({ operationId: 'fight' }).run
    startAgentRun(run.runId)
    completeAgentRun(run.runId, { ok: true })

    const snapshot = await buildAgentRunSnapshot()

    assert.equal(snapshot.run, null)
    assert.ok(snapshot.lastRun)
    assert.equal(snapshot.lastRun.runId, run.runId)
    assert.equal(snapshot.lastRun.state, 'succeeded')
    assert.equal(snapshot.occupancy.state, 'idle')
  })

  it('only projects progress onto the current active run', async () => {
    const older = beginAgentRun({ operationId: 'fight' }).run
    const newer = beginAgentRun({ operationId: 'run_task' }).run

    const snapshot = await buildAgentRunSnapshot()

    assert.ok(snapshot.run)
    assert.ok(snapshot.run.progress)
    assert.equal(snapshot.run.runId, newer.runId)
    assert.equal(snapshot.activeRuns.find(item => item.runId === older.runId)?.progress, undefined)
  })
})
