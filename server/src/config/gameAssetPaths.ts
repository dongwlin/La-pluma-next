import { join, resolve } from 'node:path';
import { resolveAppPaths } from './runtimeConfig.ts';
import type { RuntimeEnvSource } from './runtimeConfig.ts';

export const GAME_ASSET_DIR_ENV = 'LA_PLUMA_GAME_ASSET_DIR';

export interface GameAssetPathOptions {
  env?: RuntimeEnvSource;
  serverRoot?: string;
}

export interface GameAssetPaths {
  rootDir: string;
  itemDir: string;
  avatarDir: string;
}

/**
 * 解析本地图标与头像根目录：显式 `LA_PLUMA_GAME_ASSET_DIR` 优先，
 * 缺省使用应用数据目录下的 `game-assets/`，子目录与上游资源仓库一致。
 */
export function resolveGameAssetPaths(options: GameAssetPathOptions = {}): GameAssetPaths {
  const env = options.env ?? process.env;
  const override = env[GAME_ASSET_DIR_ENV]?.trim();
  const rootDir = override
    ? resolve(override)
    : join(resolveAppPaths({ env, serverRoot: options.serverRoot }).appDataDir, 'game-assets');

  return {
    rootDir,
    itemDir: join(rootDir, 'item'),
    avatarDir: join(rootDir, 'avatar')
  };
}
