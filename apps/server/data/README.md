# server/data 目录说明

该目录同时承载两类内容，部署与打包时必须区分：

## 参考数据（可重新生成，不属于用户隐私）

| 文件 | 生成方式 | 用途 |
| --- | --- | --- |
| `materials.json` | `pnpm --filter la-pluma-next-server fetch-all-materials`，再执行 `fetch-formulas` 合并配方 | 材料表与最佳关卡 |
| `material-formulas.json` | `pnpm --filter la-pluma-next-server fetch-formulas` 的中间产物 | 合成配方 |
| `operator-materials.json` | `pnpm --filter la-pluma-next-server fetch-materials` | 干员精英化材料 |
| `penguin-drop-data.json` | `pnpm --filter la-pluma-next-server fetch-drop-data` | 企鹅物流掉落统计 |

这些文件由外部公开数据源生成，默认写入 `LA_PLUMA_TRAINING_DATA_DIR`（缺省为本目录）。仓库与镜像不内置游戏参考数据；缺失时养成、掉落相关页面会为空。部署前请在宿主机生成并挂载，或在容器首次启动后按部署指南补生成。

## 运行数据（不要提交、不要打进自定义镜像）

- `user-configs/`：用户配置与养成队列
- `depot.json`、`operbox.json`：仓库与干员识别结果
- `drop-records/`：掉落记录
- `agent-runs.json`、`maa-execution.lock`：Agent Run、幂等记录与执行互斥锁
- `copilot-progress.json`、`activity-copilot-progress.json`：作业集与活动进度
- `operatorQuotes.json`：用户可编辑的台词数据

运行数据通过 Docker 卷持久化到 `/app/server/data`，不要复制进镜像。参考数据的生成命令与 Docker 持久化说明见 [部署指南](../../docs/guides/deployment.md#参考数据与运行数据) 和 [服务器脚本说明](../scripts/README.md)。
