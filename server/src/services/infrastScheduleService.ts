import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { agentError } from '../utils/apiHelper.ts';
import type { AgentError } from '../utils/apiHelper.ts';
import { writeJsonFile } from '../utils/fileHelper.ts';

export const INFRASTRUCT_SCHEDULE_FACILITIES = [
  'control',
  'manufacture',
  'trading',
  'power',
  'meeting',
  'hire',
  'dormitory',
  'processing',
  'training',
  'recycle'
] as const;

export type InfrastScheduleFacility = (typeof INFRASTRUCT_SCHEDULE_FACILITIES)[number];

/**
 * 文档列出的产物，仅作为编辑器选项。Core 对未知产物保留 Unknown 并只记一条
 * 警告，保存校验不能把未来或更新的内置排班表挡在编辑器之外，因此不按此表
 * 限制取值。
 */
export const INFRASTRUCT_SCHEDULE_PRODUCTS = [
  'Battle Record',
  'Pure Gold',
  'Dualchip',
  'Originium Shard',
  'LMD',
  'Orundum'
] as const;

export type InfrastScheduleProduct = (typeof INFRASTRUCT_SCHEDULE_PRODUCTS)[number];

export const INFRASTRUCT_SCHEDULE_ERROR_CODES = {
  invalid: 'AGENT_INFRASTRUCT_SCHEDULE_INVALID',
  notFound: 'AGENT_INFRASTRUCT_SCHEDULE_NOT_FOUND',
  ioFailed: 'AGENT_INFRASTRUCT_SCHEDULE_IO_FAILED'
} as const;

export const MAX_INFRASTRUCT_SCHEDULE_DIRECTORY_DEPTH = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateOptionalString(
  record: Record<string, unknown>,
  key: string,
  label: string
): string | null {
  const value = record[key];
  if (value === undefined) return null;
  return typeof value === 'string' ? null : `${label}.${key} 必须是字符串`;
}

function validateOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string
): string | null {
  const value = record[key];
  if (value === undefined) return null;
  return typeof value === 'boolean' ? null : `${label}.${key} 必须是布尔值`;
}

function validateOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  label: string
): string | null {
  const value = record[key];
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    return `${label}.${key} 必须是字符串数组`;
  }
  return null;
}

function validateOptionalStringEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  label: string
): string | null {
  const value = record[key];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return `${label}.${key} 必须是 ${allowed.join(' / ')} 之一`;
  }
  return null;
}

function validateOptionalIntegerInRange(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  label: string
): string | null {
  const value = record[key];
  if (value === undefined) return null;
  const message = `${label}.${key} 必须是 ${min}-${max} 之间的整数`;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= min && value <= max ? null : message;
  }
  // MAA 内置排班文件把 drones.index 写成数字字符串，Core 按同一数值处理。
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const numericValue = Number(value);
    return numericValue >= min && numericValue <= max ? null : message;
  }
  return message;
}

function validateDuration(plan: Record<string, unknown>, label: string): string | null {
  const duration = plan.duration;
  if (duration === undefined) return null;
  return typeof duration === 'number' && Number.isFinite(duration)
    ? null
    : `${label}.duration 必须是数字（分钟）`;
}

function validatePeriod(plan: Record<string, unknown>, label: string): string | null {
  const period = plan.period;
  if (period === undefined) return null;
  if (!Array.isArray(period)) return `${label}.period 必须是数组`;
  for (let index = 0; index < period.length; index += 1) {
    const range = period[index];
    if (!Array.isArray(range) || range.length !== 2 || range.some(value => typeof value !== 'string')) {
      return `${label}.period[${index}] 必须是 [开始时间, 结束时间] 两元素数组`;
    }
  }
  return null;
}

function validateFiammetta(plan: Record<string, unknown>, label: string): string | null {
  const fiammetta = plan.Fiammetta;
  if (fiammetta === undefined) return null;
  const targetLabel = `${label}.Fiammetta`;
  if (!isRecord(fiammetta)) return `${targetLabel} 必须是 JSON 对象`;
  return validateOptionalBoolean(fiammetta, 'enable', targetLabel)
    ?? validateOptionalString(fiammetta, 'target', targetLabel)
    ?? validateOptionalStringEnum(fiammetta, 'order', ['pre', 'post'], targetLabel);
}

function validateDrones(plan: Record<string, unknown>, label: string): string | null {
  const drones = plan.drones;
  if (drones === undefined) return null;
  const targetLabel = `${label}.drones`;
  if (!isRecord(drones)) return `${targetLabel} 必须是 JSON 对象`;
  return validateOptionalBoolean(drones, 'enable', targetLabel)
    ?? validateOptionalStringEnum(drones, 'room', ['trading', 'manufacture'], targetLabel)
    ?? validateOptionalIntegerInRange(drones, 'index', 1, 5, targetLabel)
    ?? validateOptionalString(drones, 'rule', targetLabel)
    ?? validateOptionalStringEnum(drones, 'order', ['pre', 'post'], targetLabel);
}

function validateGroups(plan: Record<string, unknown>, label: string): string | null {
  const groups = plan.groups;
  if (groups === undefined) return null;
  if (!Array.isArray(groups)) return `${label}.groups 必须是数组`;
  for (let index = 0; index < groups.length; index += 1) {
    const targetLabel = `${label}.groups[${index}]`;
    const group = groups[index];
    if (!isRecord(group)) return `${targetLabel} 必须是 JSON 对象`;
    if (typeof group.name !== 'string') return `${targetLabel}.name 必须是字符串`;
    if (!Array.isArray(group.operators) || group.operators.some(item => typeof item !== 'string')) {
      return `${targetLabel}.operators 必须是字符串数组`;
    }
  }
  return null;
}

function validateProduct(room: Record<string, unknown>, label: string): string | null {
  const product = room.product;
  if (product === undefined) return null;
  return typeof product === 'string' ? null : `${label}.product 必须是字符串`;
}

function validateRoom(room: unknown, label: string): string | null {
  if (!isRecord(room)) return `${label} 必须是 JSON 对象`;
  return validateOptionalBoolean(room, 'skip', label)
    ?? validateOptionalBoolean(room, 'autofill', label)
    ?? validateOptionalBoolean(room, 'sort', label)
    ?? validateOptionalBoolean(room, 'use_operator_groups', label)
    ?? validateOptionalStringArray(room, 'operators', label)
    ?? validateOptionalStringArray(room, 'candidates', label)
    ?? validateOptionalStringArray(room, 'operatorsA', label)
    ?? validateOptionalStringArray(room, 'operatorsB', label)
    ?? validateProduct(room, label);
}

function validateFacilityRooms(facility: string, facilityRooms: unknown, label: string): string | null {
  if (!Array.isArray(facilityRooms)) return `${label}.${facility} 必须是数组`;
  for (let index = 0; index < facilityRooms.length; index += 1) {
    const roomError = validateRoom(facilityRooms[index], `${label}.${facility}[${index}]`);
    if (roomError) return roomError;
  }
  return null;
}

function validatePlan(plan: unknown, index: number): string | null {
  const label = `排班表.plans[${index}]`;
  if (!isRecord(plan)) return `${label} 必须是 JSON 对象`;
  const fieldError = validateOptionalString(plan, 'name', label)
    ?? validateOptionalString(plan, 'description', label)
    ?? validateOptionalString(plan, 'description_post', label)
    ?? validateDuration(plan, label)
    ?? validatePeriod(plan, label)
    ?? validateFiammetta(plan, label)
    ?? validateDrones(plan, label)
    ?? validateGroups(plan, label);
  if (fieldError) return fieldError;

  const rooms = plan.rooms;
  if (rooms === undefined) return `${label}.rooms 缺失，MAA 要求每个计划提供 rooms`;
  if (!isRecord(rooms)) return `${label}.rooms 必须是 JSON 对象`;
  for (const [facility, facilityRooms] of Object.entries(rooms)) {
    const roomError = validateFacilityRooms(facility, facilityRooms, `${label}.rooms`);
    if (roomError) return roomError;
  }
  return null;
}

/**
 * 校验 MAA 自定义基建排班文档（`resource/custom_infrast/*.json` 与 maa-cli
 * `<maa config>/infrast/*.json`）。返回中文错误信息，合法时返回 null。
 * 只校验协议已知字段的类型与取值范围；未知设施键与未知字段原样保留，
 * 缺失的可选字段不视为错误。
 */
export function validateInfrastScheduleDocument(document: unknown): string | null {
  if (!isRecord(document)) return '排班表必须是 JSON 对象';
  const fieldError = validateOptionalString(document, 'title', '排班表')
    ?? validateOptionalString(document, 'description', '排班表');
  if (fieldError) return fieldError;

  const plans = document.plans;
  if (plans === undefined) return '排班表.plans 缺失，MAA 要求顶层提供 plans 数组';
  if (!Array.isArray(plans)) return '排班表.plans 必须是数组';
  if (plans.length === 0) return '排班表.plans 不能为空';
  for (let index = 0; index < plans.length; index += 1) {
    const planError = validatePlan(plans[index], index);
    if (planError) return planError;
  }
  return null;
}

export interface InfrastScheduleDirectoryEntry {
  name: string;
  /** `other` 覆盖符号链接等条目：列表不跟随，避免经链接目录绕过排班根目录。 */
  kind: 'file' | 'directory' | 'other';
}

export interface InfrastScheduleFileSystemStats {
  mtime: Date;
}

export interface InfrastScheduleFileSystem {
  listDirectory(directory: string): Promise<InfrastScheduleDirectoryEntry[]>;
  readTextFile(filePath: string): Promise<string>;
  readFileStats(filePath: string): Promise<InfrastScheduleFileSystemStats>;
  realpath(filePath: string): Promise<string>;
  writeJson(filePath: string, document: unknown): Promise<void>;
}

export interface InfrastScheduleSummary {
  name: string;
  title: string | null;
  planCount: number;
  updatedAt: string;
  valid: boolean;
}

export interface InfrastScheduleListResult {
  directory: string;
  schedules: InfrastScheduleSummary[];
}

export interface InfrastScheduleDocumentResult {
  name: string;
  document: unknown;
}

export interface InfrastScheduleSaveResult {
  name: string;
  planCount: number;
}

export interface InfrastScheduleService {
  list(): Promise<InfrastScheduleListResult>;
  read(name: unknown): Promise<InfrastScheduleDocumentResult>;
  save(name: unknown, document: unknown): Promise<InfrastScheduleSaveResult>;
}

export type InfrastScheduleRootSource = string | (() => string | Promise<string>);

export interface InfrastScheduleServiceOptions {
  rootDir: InfrastScheduleRootSource;
  fileSystem?: Partial<InfrastScheduleFileSystem>;
}

function directoryEntryKind(entry: Dirent): InfrastScheduleDirectoryEntry['kind'] {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
}

const defaultFileSystem: InfrastScheduleFileSystem = {
  async listDirectory(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.map(entry => ({ name: entry.name, kind: directoryEntryKind(entry) }));
  },
  readTextFile: filePath => readFile(filePath, 'utf-8'),
  async readFileStats(filePath) {
    const stats = await stat(filePath);
    return { mtime: stats.mtime };
  },
  realpath: filePath => realpath(filePath),
  writeJson: (filePath, document) => writeJsonFile(filePath, document)
};

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

function invalidRequest(message: string): AgentError {
  return agentError(INFRASTRUCT_SCHEDULE_ERROR_CODES.invalid, message, { statusCode: 400 });
}

function notFound(name: string): AgentError {
  return agentError(
    INFRASTRUCT_SCHEDULE_ERROR_CODES.notFound,
    `未找到基建排班文件：${name}`,
    { statusCode: 404, details: { name } }
  );
}

function ioFailed(message: string): AgentError {
  return agentError(INFRASTRUCT_SCHEDULE_ERROR_CODES.ioFailed, message, {
    statusCode: 500,
    retryable: true
  });
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isInsideDirectory(rootDir: string, candidatePath: string): boolean {
  const relativePath = relative(rootDir, candidatePath);
  return Boolean(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

function normalizeScheduleName(rawName: unknown): string {
  if (typeof rawName !== 'string') throw invalidRequest('排班文件名必须是字符串');
  const name = rawName.trim();
  if (!name) throw invalidRequest('排班文件名不能为空');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw invalidRequest('排班文件名包含控制字符');
  if (name.includes('\\')) throw invalidRequest('排班文件名不能包含反斜杠');
  if (/^[A-Za-z]:/.test(name)) throw invalidRequest('排班文件名不能使用盘符');
  if (name.split('/').some(segment => segment === '..')) {
    throw invalidRequest('排班文件名不能包含 ..');
  }
  if (extname(name).toLowerCase() !== '.json') {
    throw invalidRequest('排班文件名必须以 .json 结尾');
  }
  return name;
}

async function canonicalizePath(
  fileSystem: InfrastScheduleFileSystem,
  targetPath: string
): Promise<string> {
  const absolutePath = resolve(targetPath);
  let currentPath = absolutePath;
  const missingSegments: string[] = [];

  // 缺失目录按最近的已存在祖先拼回真实路径；祖先链本身无法解析时不允许退回
  // 字面路径，否则根外符号链接会在检查耗尽后漏过。
  for (;;) {
    try {
      const resolvedPath = await fileSystem.realpath(currentPath);
      return missingSegments.length === 0
        ? resolvedPath
        : join(resolvedPath, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`无法解析路径的真实位置：${absolutePath}`);
    }
    missingSegments.unshift(basename(currentPath));
    currentPath = parentPath;
  }
}

interface ResolvedSchedulePath {
  absolutePath: string;
  relativeName: string;
}

async function resolveRootDirectory(rootDirSource: InfrastScheduleRootSource): Promise<string> {
  try {
    const configuredRoot = typeof rootDirSource === 'function'
      ? await rootDirSource()
      : rootDirSource;
    return resolve(configuredRoot);
  } catch {
    throw ioFailed('无法定位 MAA 配置目录');
  }
}

async function resolveSchedulePath(
  fileSystem: InfrastScheduleFileSystem,
  rootDirSource: InfrastScheduleRootSource,
  rawName: unknown,
  action: 'read' | 'save'
): Promise<ResolvedSchedulePath> {
  const name = normalizeScheduleName(rawName);
  const rootDir = await resolveRootDirectory(rootDirSource);

  const absolutePath = isAbsolute(name) ? resolve(name) : resolve(rootDir, name);
  const lexicalRelative = relative(rootDir, absolutePath);
  if (!isInsideDirectory(rootDir, absolutePath)) {
    throw invalidRequest(`排班文件必须位于基建排班目录内：${lexicalRelative}`);
  }

  let canonicalRoot: string;
  let canonicalTarget: string;
  try {
    canonicalRoot = await canonicalizePath(fileSystem, rootDir);
    canonicalTarget = await canonicalizePath(fileSystem, absolutePath);
  } catch {
    throw ioFailed(action === 'save' ? '保存基建排班文件失败' : '读取基建排班文件失败');
  }
  if (!isInsideDirectory(canonicalRoot, canonicalTarget)) {
    throw invalidRequest('排班文件真实路径超出基建排班目录');
  }

  return {
    absolutePath,
    relativeName: relative(rootDir, absolutePath).split(sep).join('/')
  };
}

async function collectScheduleFiles(
  fileSystem: InfrastScheduleFileSystem,
  directory: string,
  relativePrefix: string,
  depth: number,
  files: Array<{ absolutePath: string; relativeName: string }>
): Promise<void> {
  let entries: InfrastScheduleDirectoryEntry[];
  try {
    entries = await fileSystem.listDirectory(directory);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relativeName = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      if (depth < MAX_INFRASTRUCT_SCHEDULE_DIRECTORY_DEPTH) {
        await collectScheduleFiles(fileSystem, join(directory, entry.name), relativeName, depth + 1, files);
      }
      continue;
    }
    if (entry.kind !== 'file') continue;
    if (extname(entry.name).toLowerCase() !== '.json') continue;
    files.push({ absolutePath: join(directory, entry.name), relativeName });
  }
}

function readPlanCount(document: unknown): number {
  return isRecord(document) && Array.isArray(document.plans) ? document.plans.length : 0;
}

function summarizeDocument(content: string): { title: string | null; planCount: number; valid: boolean } {
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    return { title: null, planCount: 0, valid: false };
  }
  const title = isRecord(document) && typeof document.title === 'string' ? document.title : null;
  return {
    title,
    planCount: readPlanCount(document),
    valid: validateInfrastScheduleDocument(document) === null
  };
}

async function summarizeScheduleFile(
  fileSystem: InfrastScheduleFileSystem,
  absolutePath: string,
  relativeName: string
): Promise<InfrastScheduleSummary | null> {
  const stats = await fileSystem.readFileStats(absolutePath).catch(() => null);
  if (!stats) return null;

  let summary: { title: string | null; planCount: number; valid: boolean };
  try {
    summary = summarizeDocument(await fileSystem.readTextFile(absolutePath));
  } catch (error) {
    if (isMissingPathError(error)) return null;
    summary = { title: null, planCount: 0, valid: false };
  }

  return {
    name: relativeName,
    title: summary.title,
    planCount: summary.planCount,
    updatedAt: stats.mtime.toISOString(),
    valid: summary.valid
  };
}

function compareScheduleNames(left: InfrastScheduleSummary, right: InfrastScheduleSummary): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

async function resolveDefaultScheduleRoot(): Promise<string> {
  const { getMaaConfigDir } = await import('./maaConfigService.ts');
  const configDir = (await getMaaConfigDir()).trim();
  return join(configDir, 'infrast');
}

export function createInfrastScheduleService(
  options: InfrastScheduleServiceOptions
): InfrastScheduleService {
  const fileSystem: InfrastScheduleFileSystem = { ...defaultFileSystem, ...options.fileSystem };
  const rootDirSource = options.rootDir;

  return {
    async list() {
      const directory = await resolveRootDirectory(rootDirSource);
      const files: Array<{ absolutePath: string; relativeName: string }> = [];
      try {
        await collectScheduleFiles(fileSystem, directory, '', 0, files);
      } catch {
        throw ioFailed('读取基建排班目录失败');
      }

      const summaries: InfrastScheduleSummary[] = [];
      for (const file of files) {
        const summary = await summarizeScheduleFile(fileSystem, file.absolutePath, file.relativeName);
        if (summary) summaries.push(summary);
      }
      summaries.sort(compareScheduleNames);
      return { directory, schedules: summaries };
    },

    async read(name) {
      const target = await resolveSchedulePath(fileSystem, rootDirSource, name, 'read');
      let content: string;
      try {
        content = await fileSystem.readTextFile(target.absolutePath);
      } catch (error) {
        if (isMissingPathError(error) || errorCodeOf(error) === 'EISDIR') {
          throw notFound(target.relativeName);
        }
        throw ioFailed('读取基建排班文件失败');
      }

      let document: unknown;
      try {
        document = JSON.parse(content);
      } catch {
        throw invalidRequest(`基建排班文件不是有效的 JSON：${target.relativeName}`);
      }
      return { name: target.relativeName, document };
    },

    async save(name, document) {
      const target = await resolveSchedulePath(fileSystem, rootDirSource, name, 'save');
      const validationMessage = validateInfrastScheduleDocument(document);
      if (validationMessage) throw invalidRequest(validationMessage);

      try {
        await fileSystem.writeJson(target.absolutePath, document);
      } catch {
        throw ioFailed('保存基建排班文件失败');
      }
      return { name: target.relativeName, planCount: readPlanCount(document) };
    }
  };
}

const defaultInfrastScheduleService: InfrastScheduleService = createInfrastScheduleService({
  rootDir: resolveDefaultScheduleRoot
});

export default defaultInfrastScheduleService;
