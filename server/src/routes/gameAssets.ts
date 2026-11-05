import { Router } from 'express';
import type { Request, Response } from 'express';
import { isGameAssetKind, resolveGameAssetFile } from '../services/gameAssetService.ts';

const GAME_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function createGameAssetRouter(rootDir: string): Router {
  const router = Router();

  router.get('/:kind/:fileName', async (req: Request, res: Response): Promise<void> => {
    const { kind, fileName } = req.params;
    if (typeof kind !== 'string' || typeof fileName !== 'string' || !isGameAssetKind(kind)) {
      res.status(404).end();
      return;
    }

    const asset = await resolveGameAssetFile({ rootDir, kind, fileName });
    if (!asset) {
      res.status(404).end();
      return;
    }

    res.setHeader('Cache-Control', GAME_ASSET_CACHE_CONTROL);
    res.type(asset.contentType);
    res.sendFile(asset.filePath, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });

  return router;
}
