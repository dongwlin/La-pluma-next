import { Router } from 'express';
import type { Request, Response } from 'express';
import type { GameAssetPaths } from '../config/gameAssetPaths.ts';
import { isGameAssetKind, resolveGameAssetFile } from '../services/gameAssetService.ts';
import type { GameAssetKind } from '../services/gameAssetService.ts';

const GAME_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function createGameAssetRouter(paths: Pick<GameAssetPaths, 'itemDir' | 'avatarDir'>): Router {
  const kindDirs: Record<GameAssetKind, string> = {
    item: paths.itemDir,
    avatar: paths.avatarDir
  };
  const router = Router();

  router.get('/:kind/:fileName', async (req: Request, res: Response): Promise<void> => {
    const { kind, fileName } = req.params;
    if (typeof kind !== 'string' || typeof fileName !== 'string' || !isGameAssetKind(kind)) {
      res.status(404).end();
      return;
    }

    const asset = await resolveGameAssetFile({ kindDir: kindDirs[kind], fileName });
    if (!asset) {
      res.status(404).end();
      return;
    }

    res.setHeader('Cache-Control', GAME_ASSET_CACHE_CONTROL);
    res.type(asset.contentType);
    // MAA 资源默认位于含点目录（如 ~/.local）下，sendFile 默认会拒绝这类路径；
    // 文件名与真实路径已由 resolveGameAssetFile 校验，这里放开路径段中的点目录。
    res.sendFile(asset.filePath, { dotfiles: 'allow' }, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });

  return router;
}
