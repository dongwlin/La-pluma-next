/**
 * 浏览器不直连上游 ScrcpyOverWebRTC：网关用一次性票据换上游 token，只代理
 * `<proxyPath>/connect_client` 升级。升级输入的 URL、查询参数与 `head` 均不可信；
 * 票据须存在且未过期，上游失败只回固定 503，重放与隐藏端点都不能建立上游连接。
 */

import { randomUUID } from 'node:crypto';
import { connect as connectTcp } from 'node:net';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { Request, Response } from 'express';
import { getWebrtcAuthToken, registerWebrtcViewer, WEBRTC_PORT } from './webrtcService.ts';
import type { WebrtcViewerLease } from './webrtcService.ts';

export const WEBRTC_SIGNALING_PATH = '/webrtc-signaling';

const DEFAULT_TICKET_TTL_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TICKETS = 256;
const MAX_DEVICE_ID_LENGTH = 256;

/** 网关使用的 viewer 登记端口；缺省登记 `webrtcService` 的进程内 viewer 生命周期。 */
export type WebrtcViewerRegistrar = (deviceId: string | null) => WebrtcViewerLease;

export interface WebrtcSignalingGatewayOptions {
  proxyPath?: string;
  targetHost?: string;
  targetPort?: number;
  /** 代理票据有效期；过期票据与已使用票据都不可重放 */
  ticketTtlMs?: number;
  connectTimeoutMs?: number;
  maxTickets?: number;
  now?: () => number;
  createTicket?: () => string;
  getUpstreamToken?: () => Promise<string>;
  registerViewer?: WebrtcViewerRegistrar;
  connect?: typeof connectTcp;
}

interface SignalingTicket {
  upstreamToken: string;
  expiresAt: number;
}

export interface WebrtcClientUpgrade {
  ticket: string;
  deviceId: string | null;
}

export interface WebrtcSignalingServer {
  on(
    event: 'upgrade',
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  ): unknown;
  off(
    event: 'upgrade',
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  ): unknown;
}

export interface WebrtcSignalingGateway {
  readonly proxyPath: string;
  handleLogin(request: Request, response: Response): Promise<unknown>;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  attach(server: WebrtcSignalingServer): void;
  close(): void;
}

function writeUpgradeError(socket: Duplex, statusCode: number, statusText: string): void {
  if (socket.destroyed) return;
  const body = `${statusText}\n`;
  socket.end([
    `HTTP/1.1 ${statusCode} ${statusText}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n'));
}

function serializeUpgradeRequest(
  request: IncomingMessage,
  upstreamPath: string,
  targetAuthority: string
): string {
  const lines = [`${request.method || 'GET'} ${upstreamPath} HTTP/${request.httpVersion || '1.1'}`];
  let hasHost = false;

  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    const lowerName = name.toLowerCase();
    // ScrcpyOverWebRTC rejects browser Origin checks on its loopback listener.
    // The public gateway already authenticates a short-lived, one-use ticket.
    if (lowerName === 'origin' || lowerName === 'proxy-authorization') continue;
    if (lowerName === 'host') {
      lines.push(`${name}: ${targetAuthority}`);
      hasHost = true;
      continue;
    }
    lines.push(`${name}: ${value}`);
  }

  if (!hasHost) lines.push(`Host: ${targetAuthority}`);
  lines.push('', '');
  return lines.join('\r\n');
}

/**
 * 校验客户端升级请求。`request.url` 与查询参数来自 socket，不能信任：
 * 路径必须精确等于 `<proxyPath>/connect_client`，令牌非空，设备标识受限。
 */
export function parseClientUpgrade(
  request: Pick<IncomingMessage, 'url'>,
  proxyPath: string
): WebrtcClientUpgrade | null {
  let url: URL;
  try {
    url = new URL(typeof request.url === 'string' ? request.url : '/', 'http://localhost');
  } catch {
    return null;
  }

  if (url.pathname !== `${proxyPath}/connect_client`) return null;
  const ticket = url.searchParams.get('token')?.trim();
  const deviceId = url.searchParams.get('deviceId')?.trim() || null;
  return ticket && (!deviceId || deviceId.length <= MAX_DEVICE_ID_LENGTH) ? { ticket, deviceId } : null;
}

export function createWebrtcSignalingGateway({
  proxyPath = WEBRTC_SIGNALING_PATH,
  targetHost = '127.0.0.1',
  targetPort = WEBRTC_PORT,
  ticketTtlMs = DEFAULT_TICKET_TTL_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  maxTickets = DEFAULT_MAX_TICKETS,
  now = () => Date.now(),
  createTicket = () => randomUUID(),
  getUpstreamToken = () => getWebrtcAuthToken({ throwOnError: true }),
  registerViewer = registerWebrtcViewer,
  connect = connectTcp
}: WebrtcSignalingGatewayOptions = {}): WebrtcSignalingGateway {
  const tickets = new Map<string, SignalingTicket>();
  const activeSockets = new Set<Duplex>();
  const ticketLimit = Number.isInteger(maxTickets) && maxTickets > 0 ? maxTickets : DEFAULT_MAX_TICKETS;
  let attachedServer: WebrtcSignalingServer | null = null;

  function pruneTickets(): void {
    const currentTime = now();
    for (const [ticket, entry] of tickets) {
      if (entry.expiresAt <= currentTime) tickets.delete(ticket);
    }
  }

  async function handleLogin(request: Request, response: Response): Promise<unknown> {
    request.resume();
    try {
      const upstreamToken = await getUpstreamToken();
      if (typeof upstreamToken !== 'string' || !upstreamToken.trim()) {
        throw new Error('WebRTC signaling token is unavailable');
      }

      pruneTickets();
      while (tickets.size >= ticketLimit) {
        const oldestTicket = tickets.keys().next().value;
        if (oldestTicket === undefined) break;
        tickets.delete(oldestTicket);
      }
      const ticket = createTicket();
      tickets.set(ticket, {
        upstreamToken,
        expiresAt: now() + ticketTtlMs
      });
      response.set('Cache-Control', 'no-store');
      return response.json({ token: ticket, expiresInMs: ticketTtlMs });
    } catch {
      response.set('Cache-Control', 'no-store');
      return response.status(503).json({ error: 'WebRTC signaling service is unavailable' });
    }
  }

  function consumeTicket(ticket: string): string | null {
    pruneTickets();
    const entry = tickets.get(ticket);
    tickets.delete(ticket);
    if (!entry || entry.expiresAt <= now()) return null;
    return entry.upstreamToken;
  }

  async function handleUpgrade(
    request: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer
  ): Promise<void> {
    const parsed = parseClientUpgrade(request, proxyPath);
    if (!parsed) {
      writeUpgradeError(clientSocket, 404, 'Not Found');
      return;
    }

    const upstreamToken = consumeTicket(parsed.ticket);
    if (!upstreamToken) {
      writeUpgradeError(clientSocket, 401, 'Unauthorized');
      return;
    }

    let viewer: WebrtcViewerLease | undefined;
    let upstreamSocket: Socket | null = null;
    activeSockets.add(clientSocket);
    clientSocket.once('error', () => upstreamSocket?.destroy());
    clientSocket.once('close', () => {
      activeSockets.delete(clientSocket);
      upstreamSocket?.destroy();
      viewer?.release();
    });
    try {
      viewer = registerViewer(parsed.deviceId);
      await viewer.ready;
      if (clientSocket.destroyed) {
        viewer.release();
        return;
      }
      upstreamSocket = connect({ host: targetHost, port: targetPort });
    } catch {
      viewer?.release();
      writeUpgradeError(clientSocket, 503, 'Service Unavailable');
      return;
    }

    const targetAuthority = `${targetHost}:${targetPort}`;
    const upstreamPath = `/connect_client?token=${encodeURIComponent(upstreamToken)}`;
    let connected = false;
    let failedBeforeConnect = false;

    const connectedSocket = upstreamSocket;
    activeSockets.add(connectedSocket);
    const forgetUpstream = () => activeSockets.delete(connectedSocket);
    connectedSocket.once('close', forgetUpstream);

    const failBeforeConnect = (statusCode: number, statusText: string): void => {
      if (failedBeforeConnect) return;
      failedBeforeConnect = true;
      writeUpgradeError(clientSocket, statusCode, statusText);
      connectedSocket.destroy();
    };
    connectedSocket.setTimeout(connectTimeoutMs, () => {
      if (!connected) failBeforeConnect(504, 'Gateway Timeout');
    });
    connectedSocket.once('error', () => {
      if (!connected) failBeforeConnect(502, 'Bad Gateway');
      else clientSocket.destroy();
    });
    connectedSocket.once('close', () => {
      if (connected) clientSocket.destroy();
      else if (!failedBeforeConnect) failBeforeConnect(502, 'Bad Gateway');
    });

    connectedSocket.once('connect', () => {
      if (clientSocket.destroyed) {
        connectedSocket.destroy();
        return;
      }
      connected = true;
      connectedSocket.setTimeout(0);
      connectedSocket.write(serializeUpgradeRequest(request, upstreamPath, targetAuthority));
      if (head?.length) connectedSocket.write(head);
      clientSocket.pipe(connectedSocket);
      connectedSocket.pipe(clientSocket);
    });
  }

  function attach(server: WebrtcSignalingServer): void {
    if (attachedServer === server) return;
    if (attachedServer) throw new Error('WebRTC signaling gateway is already attached');
    attachedServer = server;
    server.on('upgrade', handleUpgrade);
  }

  function close(): void {
    if (attachedServer) attachedServer.off('upgrade', handleUpgrade);
    attachedServer = null;
    tickets.clear();
    for (const socket of activeSockets) socket.destroy();
    activeSockets.clear();
  }

  return {
    proxyPath,
    handleLogin,
    handleUpgrade,
    attach,
    close
  };
}
