/**
 * 干员目录与识别完整度：只做 MAA OperBox 识别载荷与目录投影，
 * 不读取文件、不写缓存，读取失败的降级由调用方决定。
 */

/** MAA 识别目录携带的多语言名称；缺失语种不补空值。 */
export interface OperatorNameSet {
  en?: string;
  jp?: string;
  kr?: string;
  tw?: string;
}

/** 干员目录条目的稳定字段；`rarity` 等资料字段在部分来源中可能缺失。 */
export interface OperatorCatalogEntry {
  id: string;
  name: string;
  names?: OperatorNameSet;
  rarity?: number;
  profession?: string;
  position?: string;
}

/** 识别目录条目：目录字段之外带有 MAA 的拥有标记。 */
export interface OperBoxCatalogOperator extends OperatorCatalogEntry {
  owned: boolean;
}

export type OperBoxRecognitionStatus = 'complete' | 'partial';

/** 读取侧完整状态：没有识别快照时为 `missing`。 */
export type OperatorRecognitionStatus = OperBoxRecognitionStatus | 'missing';

/** `/training/operators` 返回的识别概要；`missing` 相对合并后的训练目录计算。 */
export interface OperatorRecognitionSummary {
  status: OperatorRecognitionStatus;
  recognizedAt: string | null;
  total: number;
  owned: number;
  unknown: number;
  missing: string[];
}

/** 解析后的 OperBoxInfo 载荷：`own_opers` 与 `all_opers` 分别保留。 */
export interface OperBoxRecognitionPayload {
  /** 最近一次识别是否完整结束（MAA `details.done`）。 */
  complete: boolean;
  owned: Record<string, unknown>[];
  catalog: OperBoxCatalogOperator[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// MAA 载荷用 `name_en` 等扁平字段，本仓库目录用 `names` 对象；两种形态都读取。
function parseOperatorNames(source: Record<string, unknown>): OperatorNameSet | undefined {
  const stored = isRecord(source.names) ? source.names : {};
  const names: OperatorNameSet = {};
  const en = readNonEmptyString(stored.en) ?? readNonEmptyString(source.name_en);
  const jp = readNonEmptyString(stored.jp) ?? readNonEmptyString(source.name_jp);
  const kr = readNonEmptyString(stored.kr) ?? readNonEmptyString(source.name_kr);
  const tw = readNonEmptyString(stored.tw) ?? readNonEmptyString(source.name_tw);
  if (en) names.en = en;
  if (jp) names.jp = jp;
  if (kr) names.kr = kr;
  if (tw) names.tw = tw;
  return Object.keys(names).length > 0 ? names : undefined;
}

// MAA 载荷用 `own`，本仓库持久化与接口用 `owned`；读取两侧同一份目录时都接受。
function parseCatalogOperator(value: unknown): OperBoxCatalogOperator | null {
  if (!isRecord(value)) return null;
  const id = readNonEmptyString(value.id);
  const name = readNonEmptyString(value.name);
  if (!id || !name) return null;

  const operator: OperBoxCatalogOperator = { id, name, owned: value.own === true || value.owned === true };
  const names = parseOperatorNames(value);
  if (names) operator.names = names;
  if (typeof value.rarity === 'number' && Number.isFinite(value.rarity)) {
    operator.rarity = value.rarity;
  }
  return operator;
}

/**
 * 解析 `all_opers`：不是数组时视为旧载荷没有识别目录（返回 null），
 * 单条格式不符只跳过该条，目录整体仍可用于覆盖判定。
 */
export function parseOperBoxCatalog(value: unknown): OperBoxCatalogOperator[] | null {
  if (!Array.isArray(value)) return null;
  const catalog: OperBoxCatalogOperator[] = [];
  for (const entry of value) {
    const operator = parseCatalogOperator(entry);
    if (operator) catalog.push(operator);
  }
  return catalog;
}

/** 解析 OperBoxInfo details：`own_opers` 必须是数组，`all_opers` 缺失时目录为空。 */
export function parseOperBoxRecognitionPayload(details: unknown): OperBoxRecognitionPayload | null {
  if (!isRecord(details)) return null;
  const ownOpers = details.own_opers;
  if (!Array.isArray(ownOpers)) return null;

  const owned: Record<string, unknown>[] = [];
  for (const entry of ownOpers) {
    if (!isRecord(entry)) return null;
    owned.push(entry);
  }

  return {
    complete: details.done === true,
    owned,
    catalog: parseOperBoxCatalog(details.all_opers) ?? []
  };
}

/**
 * 按 id 合并目录来源，先出现的来源优先，缺失字段由后续来源补齐。
 * 训练目录放在首位，识别目录与持有名单只补充本地目录缺省或不存在的条目。
 */
export function mergeOperatorCatalog(
  ...sources: readonly (readonly OperatorCatalogEntry[])[]
): OperatorCatalogEntry[] {
  const merged = new Map<string, OperatorCatalogEntry>();
  for (const source of sources) {
    for (const entry of source) {
      const existing = merged.get(entry.id);
      if (!existing) {
        merged.set(entry.id, { ...entry });
        continue;
      }
      if (!existing.names && entry.names) existing.names = entry.names;
      if (existing.rarity === undefined) existing.rarity = entry.rarity;
      if (existing.profession === undefined) existing.profession = entry.profession;
      if (existing.position === undefined) existing.position = entry.position;
    }
  }
  return [...merged.values()];
}

export interface RecognitionSnapshotInput {
  status: OperBoxRecognitionStatus;
  catalog: readonly OperatorCatalogEntry[];
  ownedIds: ReadonlySet<string>;
}

/**
 * 覆盖计算：完整识别同时确认目录内每个干员的拥有与未拥有；
 * 部分识别只确认已识别为拥有的干员，其余条目保持未确认。
 */
export interface OperatorRecognitionCoverage {
  status: OperatorRecognitionStatus;
  knownIds: ReadonlySet<string>;
  unownedIds: ReadonlySet<string>;
  missing: string[];
}

export function resolveRecognitionCoverage(
  catalogIds: readonly string[],
  snapshot: RecognitionSnapshotInput | null
): OperatorRecognitionCoverage {
  if (!snapshot) {
    return {
      status: 'missing',
      knownIds: new Set<string>(),
      unownedIds: new Set<string>(),
      missing: [...catalogIds]
    };
  }

  const knownIds = new Set(snapshot.ownedIds);
  const unownedIds = new Set<string>();
  if (snapshot.status === 'complete') {
    for (const entry of snapshot.catalog) {
      knownIds.add(entry.id);
      if (!snapshot.ownedIds.has(entry.id)) unownedIds.add(entry.id);
    }
  }

  const missing = catalogIds.filter(id => !knownIds.has(id));
  return {
    // 目录中有未确认项时整体按部分识别上报，避免消费者把缺失项当作已确认未拥有。
    status: missing.length > 0 ? 'partial' : 'complete',
    knownIds,
    unownedIds,
    missing
  };
}

export function buildOperatorRecognitionSummary(
  coverage: OperatorRecognitionCoverage,
  options: { recognizedAt: string | null; total: number; owned: number }
): OperatorRecognitionSummary {
  return {
    status: coverage.status,
    recognizedAt: options.recognizedAt,
    total: options.total,
    owned: options.owned,
    unknown: coverage.missing.length,
    missing: coverage.missing
  };
}

/**
 * 单个快照的识别概要：只有上游报告完整结束且带识别目录的快照才能确认未拥有状态；
 * 目录存在本身不是完整信号，漏扫的目录同样存在。
 */
export interface OperBoxRecognitionInfo {
  status: OperBoxRecognitionStatus;
  total: number;
  owned: number;
}

export function describeOperBoxRecognition(input: {
  allOpers?: readonly OperatorCatalogEntry[] | null;
  operTotal?: number | null;
  operCount: number;
  complete?: boolean;
}): OperBoxRecognitionInfo {
  const catalogCount = input.allOpers?.length ?? 0;
  return {
    status: input.complete === true && catalogCount > 0 ? 'complete' : 'partial',
    total: input.operTotal ?? (catalogCount > 0 ? catalogCount : input.operCount),
    owned: input.operCount
  };
}

/** 读取快照持久化的识别状态；缺失或非法时为 null，调用方按部分识别处理。 */
export function readOperBoxRecognitionStatus(value: unknown): OperBoxRecognitionStatus | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  return status === 'complete' || status === 'partial' ? status : null;
}
