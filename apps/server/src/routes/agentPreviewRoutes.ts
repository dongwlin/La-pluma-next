import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { PreviewRequest } from '../controllers/previewDto.ts';
import * as agentPreviewController from '../controllers/agentPreviewController.ts';

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
