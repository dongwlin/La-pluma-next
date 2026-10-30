#!/bin/sh
set -e

echo "=== MAA WebUI Docker 启动脚本 ==="

# 检查 MaaCore 是否已安装
# 注意：maa-cli 已在镜像构建时固定到具体 release，但首次 maa install 仍会从
# 上游解析并下载当前 MaaCore/资源；需要完全可复现时请预置 maa-data 与 maa-state 卷。
if ! maa version 2>/dev/null | grep -q "MaaCore"; then
    echo "⚠️  MaaCore 未安装或损坏，开始安装..."
    echo "这可能需要几分钟时间，请耐心等待..."
    
    # 强制安装 MaaCore（避免残留文件导致的问题）
    if maa install --force; then
        echo "✅ MaaCore 安装成功"
    else
        echo "❌ MaaCore 安装失败，但服务仍会启动"
        echo "你可以稍后在 WebUI 中手动更新"
    fi
else
    echo "✅ MaaCore 已安装"
    maa version
fi

# 参考数据不随镜像发布；缺失只提示，不自动联网生成。
training_data_dir="${LA_PLUMA_TRAINING_DATA_DIR:-/app/server/data}"
app_data_dir="/app/server/data"
missing_reference=""
for file in materials.json operator-materials.json; do
    if [ ! -f "$training_data_dir/$file" ]; then
        missing_reference="$missing_reference $file"
    fi
done
if [ ! -f "$app_data_dir/penguin-drop-data.json" ]; then
    missing_reference="$missing_reference penguin-drop-data.json"
fi
if [ -n "$missing_reference" ]; then
    echo "⚠️  参考数据缺失:$missing_reference"
    echo "   养成、掉落相关页面可能为空。请在宿主机生成后挂载到 /app/server/data，"
    echo "   或参考 docs/guides/deployment.md 的“参考数据与运行数据”。"
fi

echo "=== 启动 Node.js 服务器 ==="
exec "$@"
