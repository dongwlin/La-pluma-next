import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { ApiErrorResponse, ApiSuccessResponse } from '../../utils/apiHelper.ts';
import type { WebrtcSignalingGateway } from '../../services/webrtcSignalingGateway.ts';
import { loggerManager } from '../../utils/logger.ts';

type CreateLaPlumaApp = typeof import('../../app.ts').createLaPlumaApp;

export type HttpApp = ReturnType<CreateLaPlumaApp>;
export type SignalingGatewayStub = Pick<WebrtcSignalingGateway, 'proxyPath' | 'handleLogin'>;

function isApiSuccess(value: unknown): value is ApiSuccessResponse<unknown> {
  return typeof value === 'object'
    && value !== null
    && (value as { success?: unknown }).success === true;
}

function isApiError(value: unknown): value is ApiErrorResponse {
  return typeof value === 'object'
    && value !== null
    && (value as { success?: unknown }).success === false;
}

/** 真实 HTTP 回归共用：绑定 127.0.0.1 的临时端口，server 由调用方统一关闭。 */
export async function startHttpServer(app: HttpApp, servers: Server[]): Promise<number> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

export async function closeHttpServers(servers: Server[]): Promise<void> {
  while (servers.length) {
    const server = servers.pop();
    assert.ok(server);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

export function agentApiBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/agent`;
}

export async function readSuccess<T>(response: Response): Promise<ApiSuccessResponse<T>> {
  const body: unknown = await response.json();
  assert.ok(isApiSuccess(body), `unexpected API envelope: ${JSON.stringify(body)}`);
  return body as ApiSuccessResponse<T>;
}

export async function readError(response: Response): Promise<ApiErrorResponse> {
  const body: unknown = await response.json();
  assert.ok(isApiError(body));
  return body as ApiErrorResponse;
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

/** 信令网关替身：登录只回固定票据，不启动 WebRTC 运行时。 */
export function stubSignalingGateway(proxyPath: string): SignalingGatewayStub {
  return {
    proxyPath,
    async handleLogin(_req, res) {
      res.json({ token: 'stub' });
    }
  };
}

/** 真实 HTTP 用例会触发服务日志；控制台输出关闭，避免门禁输出被诊断行淹没。 */
export function silenceLoggers(names: readonly string[]): void {
  for (const name of names) loggerManager.getLogger(name).enableConsole = false;
}
