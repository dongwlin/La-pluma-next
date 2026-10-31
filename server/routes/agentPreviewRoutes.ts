import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { PreviewRequest } from '../controllers/previewDto.ts';
import * as agentPreviewController from '../controllers/agentPreviewController.ts';

/**
 * 设备预览路由：只做端点映射，保持与抽离前一致的注册顺序。
 *
 * 截图、WebRTC 启停与状态、方向设置和设备采样的 req/res 解析、校验与
 * envelope 装配在 controllers/agentPreviewController.ts；请求的未知值
 * 收窄与响应载荷类型在 controllers/previewDto.ts。WebRTC 进程、viewer
 * 计时器与资源所有权仍由 webrtcService/webrtcRuntime 持有；浏览器实时
 * 预览继续经过同源 `/webrtc-signaling` 网关，上游管理端点不外露。
 */
const router = Router();

router.post('/screen/screenshot', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.takeScreenshot));

router.get('/webrtc/status', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.readWebrtcStatus));

router.get('/webrtc/devices', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.readWebrtcDevices));

router.post('/webrtc/start', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.startWebrtcPreview));

router.post('/webrtc/stop', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.stopWebrtcPreview));

router.post('/preview/orientation', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.applyPreviewOrientation));

router.post('/webrtc/install', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.installWebrtcComponents));

router.post('/webrtc/start-server', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.startWebrtcServerProcess));

router.post('/webrtc/stop-server', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.stopWebrtcServerProcess));

router.post('/webrtc/start-agent', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.startWebrtcAgentProcess));

router.post('/webrtc/stop-agent', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.stopWebrtcAgentProcess));

router.get('/device-stats', asyncHandler<PreviewRequest, ApiResponseWriter>(agentPreviewController.readDeviceStats));

export default router;
