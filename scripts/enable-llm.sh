#!/usr/bin/env bash
# 启用大模型出牌：把本机 Hermes 的百炼密钥写入 data/llm.env（不打印明文）
# 用法: bash scripts/enable-llm.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${HOME}/.hermes/.env"
DST="data/llm.env"

[ -f "$SRC" ] || { echo "❌ 未找到 $SRC"; exit 1; }

KEY=*** -oP '^ALIBABA_TOKEN_PLAN_CN_API_KEY=\K.*' "$SRC" | head -1)
[ -n "$KEY" ] || { echo "❌ 未从 $SRC 读到 ALIBABA_TOKEN_PLAN_CN_API_KEY"; exit 1; }
echo "✓ 读取到密钥，长度 ${#KEY}"

cat > "$DST" <<EOF
# 本地 LLM 配置（不入库，已在 .gitignore，权限 600）
LLM_BASE=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
LLM_KEY=***
LLM_MODEL=qwen3.8-max
LLM_FAST_MODEL=qwen3.8-max
EOF
chmod 600 "$DST"

git check-ignore -q "$DST" && echo "✓ $DST 已被 git 忽略（不会推送）" || { echo "❌ $DST 未被忽略，已中止"; rm -f "$DST"; exit 1; }
echo "✓ 已写入 $DST"
echo ""
echo "下一步：systemctl --user restart guandan && curl -s localhost:8080/api/ai/status"
