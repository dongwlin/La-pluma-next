import { join, resolve } from 'node:path';
import { resolveResourceRoot } from './paths.ts';
import type { RuntimeEnvSource } from './runtimeConfig.ts';

export const GAME_ASSET_DIR_ENV = 'LA_PLUMA_GAME_ASSET_DIR';

export interface GameAssetPathOptions {
  env?: RuntimeEnvSource;
}

export interface GameAssetPaths {
  rootDir: string;
  itemDir: string;
  avatarDir: string;
}

/**
 * 解析本地图标与头像目录。显式 `LA_PLUMA_GAME_ASSET_DIR` 优先，目录布局与上游
 * 资源仓库一致（`item/`、`avatar/`）；缺省使用 MAA 资源自带的识别模板
 * （`template/items`、`template/avatar`），安装后无需另外准备图片。
 */
export function resolveGameAssetPaths(options: GameAssetPathOptions = {}): GameAssetPaths {
  const env = options.env ?? process.env;
  const override = env[GAME_ASSET_DIR_ENV]?.trim();
  if (override) {
    const rootDir = resolve(override);
    return {
      rootDir,
      itemDir: join(rootDir, 'item'),
      avatarDir: join(rootDir, 'avatar')
    };
  }

  const rootDir = join(resolveResourceRoot({ env }), 'template');
  return {
    rootDir,
    itemDir: join(rootDir, 'items'),
    avatarDir: join(rootDir, 'avatar')
  };
}
