/**
 * Agent API 版本常量（单一字面量来源）。
 *
 * manifest（buildAgentManifest）、OpenAPI（buildOpenApiSpec）与 /status api
 * 块共用同一份版本；routes/agentContract.ts 以 import + re-export 保持既有
 * 导入路径。
 */

export const API_VERSION = '2026-07-12';
