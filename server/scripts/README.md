# 服务器脚本

维护脚本以 TypeScript 编写，由 Node.js 原生类型擦除直接运行（`node scripts/<name>.ts`）；导入脚本不会触发抓取或写文件，只有作为入口运行时才执行。

材料与掉落脚本的输出目录与养成服务共用 `resolveAppPaths().trainingDataDir`：默认 `server/data`，设置 `LA_PLUMA_TRAINING_DATA_DIR` 时写入同一目录，避免服务读取目录与脚本输出目录分裂。

## fetch-operator-materials.ts

自动从 [Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData) 获取干员材料数据。

### 功能

- 获取所有可招募的 4 星及以上干员
- 解析精英 1 和精英 2 所需材料
- 自动分类材料和芯片
- 生成标准化的 JSON 数据文件

### 使用方法

```bash
pnpm --filter la-pluma-next-server fetch-materials
```

### 输出

生成的文件：`<trainingDataDir>/operator-materials.json`（默认 `server/data/operator-materials.json`）

包含：
- 123 个六星干员
- 185 个五星干员
- 61 个四星干员
- 总共 369 个干员

### 数据结构

```json
{
  "operators": {
    "char_xxx_xxx": {
      "id": "char_xxx_xxx",
      "name": "干员名称",
      "rarity": 6,
      "profession": "职业",
      "elite1": {
        "lmd": 30000,
        "materials": [
          { "id": "30011", "name": "固源岩", "count": 5 }
        ]
      },
      "elite2": {
        "lmd": 180000,
        "materials": [...],
        "chips": [...]
      }
    }
  },
  "metadata": {
    "version": "2.0.0",
    "lastUpdated": "2026-02-06",
    "totalOperators": 369,
    "source": "Kengxxiao/ArknightsGameData"
  }
}
```

### 更新频率

建议在游戏更新后运行此脚本以获取最新的干员数据。
