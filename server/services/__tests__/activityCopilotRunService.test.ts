import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildActivityCopilotRunPlan,
  getCombatCopilotPreferences,
  shouldRefreshActivityNavigation,
  summarizeActivityCompletion
} from '../activityCopilotRunService.ts';
import type { ActivityCandidatePlan } from '../activityCopilotRunService.ts';
import type { ActivityCopilotCandidate } from '../activityCopilotDiscoveryService.ts';
import type { ActivityNavigationResult } from '../activityNavigationService.ts';

/** 就绪预检的固定投影：计划只读取 activity 与 stages，不触发任何读取。 */
const readyPreflight: ActivityNavigationResult = {
  state: 'ready',
  canPrepare: true,
  canRun: false,
  reasonCode: null,
  reason: '已确认当前活动和从主页进入活动关卡的导航资源；此接口不会启动作业。',
  activity: { code: 'BD', name: '丛林症结', source: 'maa', stages: ['BD-1', 'BD-2'] },
  navigation: { source: 'maa-resource', stageFile: 'tasks/Stages/BD.json', stageCount: 2, entryTask: 'BD-OpenOpt' }
};

/** 一份完整的作业站候选：字段与发现服务收窄后的投影一致。 */
function candidate(id: number, stage: string): ActivityCopilotCandidate {
  return {
    id,
    uri: `prts://${id}`,
    stage,
    title: stage,
    stageName: `act_${id}`,
    presetFormation: false,
    uploader: null,
    uploadTime: null,
    ratingLevel: 10,
    ratingRatio: 1,
    hotScore: 0,
    views: 0
  };
}

const candidatePlan: ActivityCandidatePlan = {
  state: 'candidates-ready',
  preflight: readyPreflight,
  stages: [
    { stage: 'BD-1', candidates: [candidate(10, 'BD-1')] },
    { stage: 'BD-2', candidates: [candidate(11, 'BD-2')] }
  ]
};

test('activity run plan selects the top reliable candidate for every known stage in order', () => {
  const plan = buildActivityCopilotRunPlan(candidatePlan, { raid: 'normal' });
  assert.equal(plan.state, 'ready');
  assert.deepEqual(plan.entries.map(entry => [entry.displayStage, entry.copilotId, entry.mode]), [
    ['BD-1', 10, 'normal'],
    ['BD-2', 11, 'normal']
  ]);
});

test('activity run plan refuses to silently omit a known stage', () => {
  const incomplete = { ...candidatePlan, stages: [...candidatePlan.stages, { stage: 'BD-3', candidates: [] }] };
  const plan = buildActivityCopilotRunPlan(incomplete, {});
  assert.equal(plan.state, 'blocked');
  assert.match(plan.reason, /BD-3/);
});

test('saved combat preferences map to the dynamic copilot options', () => {
  const preferences = getCombatCopilotPreferences({
    advancedParams: { copilot: { raid: 'both', loopTimes: '3', useSanityPotion: true, ignoreRequirements: false } },
    autoFormation: { copilot: 'off' }
  });
  assert.deepEqual(preferences, {
    raid: 'both', loopTimes: '3', ignoreRequirements: false, useSanityPotion: true,
    addTrust: false, formationIndex: undefined, supportUsage: undefined, supportName: undefined, formationMode: 'off'
  });
});

test('activity completion requires every known main stage', () => {
  const activity = { code: 'BD', stages: ['BD-1', 'BD-2', 'BD-3'] };
  assert.deepEqual(
    summarizeActivityCompletion(activity, { BD: { stages: ['BD-1', 'BD-2'] } }),
    {
      known: true,
      complete: false,
      completedStages: ['BD-1', 'BD-2'],
      totalStages: 3,
      source: 'local-activity-progress'
    }
  );
  assert.equal(
    summarizeActivityCompletion(activity, { BD: { stages: ['BD-1', 'BD-2', 'BD-3'] } }).complete,
    true
  );
});

test('missing navigation resources trigger a throttled resource refresh', () => {
  const preflight = { reasonCode: 'navigation-resource-unavailable', activity: { code: 'BD' } };
  assert.equal(shouldRefreshActivityNavigation(preflight, 0, 24 * 60 * 60 * 1000), true);
  assert.equal(shouldRefreshActivityNavigation(preflight, 10_000, 10_000 + 60_000), false);
  assert.equal(shouldRefreshActivityNavigation({ reasonCode: 'activity-unavailable' }, 0, 24 * 60 * 60 * 1000), false);
});
