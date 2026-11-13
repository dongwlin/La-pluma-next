import type { OperBoxFile } from './dataParserService.ts';

export type CopilotMatchMode = 'ready' | 'borrow' | 'train' | 'check' | 'blocked';

export interface CopilotMatchSummary {
  mode: CopilotMatchMode;
  missing: string[];
  training: string[];
  check: string[];
  totalSlots: number;
}

export interface OwnedOperatorSnapshot {
  name: string;
  rarity: number;
  elite: number;
  level: number;
}

const MAX_LEVELS_BY_RARITY: Record<number, readonly number[]> = {
  0: [30, 0, 0],
  1: [30, 0, 0],
  2: [30, 0, 0],
  3: [40, 55, 0],
  4: [45, 60, 70],
  5: [50, 70, 80],
  6: [50, 80, 90]
};

const FALLBACK_RARITY = 6;
const FALLBACK_ELITE = 0;
const FALLBACK_LEVEL = 1;
const MAX_SLOTS = 13;

type SlotStatus = 'met' | 'unverified' | 'unmet';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : undefined;
}

function operatorName(slot: Record<string, unknown>): string {
  return typeof slot.name === 'string' ? slot.name.trim() : '';
}

function maxLevelsFor(rarity: number): readonly number[] {
  return MAX_LEVELS_BY_RARITY[rarity] ?? MAX_LEVELS_BY_RARITY[FALLBACK_RARITY];
}

function progressScore(rarity: number, elite: number, level: number): number {
  const maxLevels = maxLevelsFor(rarity);
  let score = Math.max(1, level);
  for (let index = 0; index < elite; index += 1) {
    score += maxLevels[index] ?? 0;
  }
  return score;
}

function inferElite(rarity: number, level: number): number {
  const maxLevels = maxLevelsFor(rarity);
  let inferredElite = 0;
  while (inferredElite < maxLevels.length - 1 && level > (maxLevels[inferredElite] ?? 0)) {
    inferredElite += 1;
  }
  return inferredElite;
}

function meetsProgress(requirements: Record<string, unknown>, owned: OwnedOperatorSnapshot): boolean {
  const requiredLevelValue = toNonNegativeInteger(requirements.level);
  const requiredEliteValue = toNonNegativeInteger(requirements.elite);
  if (requiredLevelValue === undefined && requiredEliteValue === undefined) return true;

  const requiredLevel = requiredLevelValue ?? 1;
  const requiredElite = requiredEliteValue ?? inferElite(owned.rarity, requiredLevel);
  return progressScore(owned.rarity, owned.elite, owned.level) >= progressScore(owned.rarity, requiredElite, requiredLevel);
}

// 持有快照没有技能等级与模组数据，这类需求无法证伪，只能要求用户到游戏内确认。
function hasUnverifiableRequirement(requirements: Record<string, unknown>): boolean {
  const skillLevel = toNonNegativeInteger(requirements.skill_level);
  const module = toNonNegativeInteger(requirements.module);
  return (skillLevel !== undefined && skillLevel > 0) || (module !== undefined && module > 0);
}

function evaluateSlot(slot: Record<string, unknown>, owned: OwnedOperatorSnapshot): SlotStatus {
  const requirements = isRecord(slot.requirements) ? slot.requirements : undefined;
  if (requirements && !meetsProgress(requirements, owned)) return 'unmet';
  return requirements && hasUnverifiableRequirement(requirements) ? 'unverified' : 'met';
}

function readSlots(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function groupDisplayName(group: Record<string, unknown>, candidates: readonly Record<string, unknown>[]): string {
  const name = typeof group.name === 'string' ? group.name.trim() : '';
  if (name) return name;
  const joined = candidates.map(operatorName).filter(Boolean).join(' / ');
  return joined || '未命名分组';
}

interface GroupEvaluation {
  name: string;
  status: 'ready' | 'check' | 'train' | 'missing';
}

function evaluateGroup(
  group: Record<string, unknown>,
  owned: ReadonlyMap<string, OwnedOperatorSnapshot>
): GroupEvaluation {
  const candidates = readSlots(group.opers);
  const name = groupDisplayName(group, candidates);
  let hasOwnedCandidate = false;
  let hasUnverifiedCandidate = false;

  for (const candidate of candidates) {
    const snapshot = owned.get(operatorName(candidate));
    if (!snapshot) continue;
    hasOwnedCandidate = true;
    const status = evaluateSlot(candidate, snapshot);
    if (status === 'met') return { name, status: 'ready' };
    if (status === 'unverified') hasUnverifiedCandidate = true;
  }

  if (!hasOwnedCandidate) return { name, status: 'missing' };
  return { name, status: hasUnverifiedCandidate ? 'check' : 'train' };
}

function resolveMode(
  missing: string[],
  training: string[],
  check: string[],
  totalSlots: number
): CopilotMatchMode {
  if (totalSlots > MAX_SLOTS || missing.length >= 2) return 'blocked';
  if (missing.length === 1) {
    if (training.length > 0) return 'train';
    return check.length > 0 ? 'check' : 'borrow';
  }
  if (training.length > 0) {
    return training.length === 1 && totalSlots < MAX_SLOTS && check.length === 0 ? 'borrow' : 'train';
  }
  if (check.length > 0) return 'check';
  return totalSlots === MAX_SLOTS ? 'borrow' : 'ready';
}

export function buildOwnedOperatorMap(operBox: OperBoxFile | null): Map<string, OwnedOperatorSnapshot> {
  const owned = new Map<string, OwnedOperatorSnapshot>();
  if (!operBox) return owned;

  for (const entry of operBox.data) {
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    owned.set(name, {
      name,
      rarity: toNonNegativeInteger(entry.rarity) ?? FALLBACK_RARITY,
      elite: toNonNegativeInteger(entry.elite) ?? FALLBACK_ELITE,
      level: toNonNegativeInteger(entry.level) ?? FALLBACK_LEVEL
    });
  }
  return owned;
}

function parseContent(content: unknown): Record<string, unknown> | null {
  if (typeof content !== 'string') return isRecord(content) ? content : null;
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveCopilotMatch(
  content: unknown,
  owned: ReadonlyMap<string, OwnedOperatorSnapshot>
): CopilotMatchSummary | null {
  if (owned.size === 0) return null;

  const document = parseContent(content);
  if (!document) return null;

  const operators = readSlots(document.opers);
  const groups = readSlots(document.groups);
  const missing: string[] = [];
  const training: string[] = [];
  const check: string[] = [];

  for (const operator of operators) {
    const name = operatorName(operator) || '未命名干员';
    const snapshot = owned.get(operatorName(operator));
    if (!snapshot) {
      missing.push(name);
      continue;
    }
    const status = evaluateSlot(operator, snapshot);
    if (status === 'unmet') training.push(name);
    else if (status === 'unverified') check.push(name);
  }

  for (const group of groups) {
    const evaluation = evaluateGroup(group, owned);
    if (evaluation.status === 'missing') missing.push(evaluation.name);
    else if (evaluation.status === 'train') training.push(evaluation.name);
    else if (evaluation.status === 'check') check.push(evaluation.name);
  }

  const totalSlots = operators.length + groups.length;
  return {
    mode: resolveMode(missing, training, check, totalSlots),
    missing,
    training,
    check,
    totalSlots
  };
}
