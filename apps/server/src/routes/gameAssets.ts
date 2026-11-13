import { Router } from 'express';
import type { Request, Response } from 'express';
import { isGameAssetKind, resolveItemAssetFile, resolveGameAssetFile } from '../services/gameAssetService.ts';
import type { GameAssetDirs, GameAssetKind } from '../services/gameAssetService.ts';

const GAME_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export interface GameAssetRouterOptions {
  resolveDirs: () => Promise<GameAssetDirs>;
}

export function createGameAssetRouter(options: GameAssetRouterOptions): Router {
  const router = Router();

  router.get('/:kind/:fileName', async (req: Request, res: Response): Promise<void> => {
    const { kind, fileName } = req.params;
    if (typeof kind !== 'string' || typeof fileName !== 'string' || !isGameAssetKind(kind)) {
      res.status(404).end();
      return;
    }

    const dirs = await options.resolveDirs();
    const asset = kind === 'item'
      ? await resolveItemAssetFile({
        itemDirs: dirs.itemDirs,
        fileName,
        itemTablePath: dirs.itemTablePath,
        itemIndexPath: dirs.itemIndexPath
      })
      : await resolveGameAssetFile({ kindDirs: dirs.avatarDirs, fileName });
    if (!asset) {
      res.status(404).end();
      return;
    }

    res.setHeader('Cache-Control', GAME_ASSET_CACHE_CONTROL);
    res.type(asset.contentType);
    // MAA 资源默认位于含点目录（如 ~/.local）下，sendFile 默认拒绝这类路径；
    // 文件名与真实路径已校验，这里只放开点目录限制。
    res.sendFile(asset.filePath, { dotfiles: 'allow' }, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });

  // 资源命名空间内未匹配的路径同样按缺失资源返回空 404：
  // 生产环境静态资源之后存在 SPA fallback，不能让它把 HTML 当作图片响应。
  router.use((_req: Request, res: Response): void => {
    res.status(404).end();
  });

  return router;
}
