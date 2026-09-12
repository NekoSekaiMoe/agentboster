#!/usr/bin/env bash
# 豆包工作 Agent 技能包拉取脚本
# 用法: ./pull_skills.sh "你的doubao.com完整Cookie"
# Cookie 获取方法:
#   浏览器登录 doubao.com -> F12 -> Network -> 任一请求 -> Request Headers -> Cookie 全部复制
set -e
COOKIE="$1"
[ -z "$COOKIE" ] && { echo "用法: $0 '<cookie>'"; exit 1; }
BASE="https://www.doubao.com"
HDR=(-H "Content-Type: application/json" -H "Cookie: $COOKIE" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36")
OUT="skills_pulled"; mkdir -p "$OUT"

echo "[1] 探测 batch_get_package_urls 请求格式..."
for BODY in '{"skill_ids":[]}' '{"requests":[]}' '{"skills":[]}'; do
  echo "  尝试: $BODY"
  RESP=$(curl -s -X POST "$BASE/alice/office/skills/batch_get_package_urls" "${HDR[@]}" -d "$BODY")
  echo "  响应: ${RESP:0:300}"
  echo "$RESP" | grep -q '"code":0' && { echo "  ^^^ 命中正确格式"; break; }
done

echo "[2] 拉取沙箱清单(含技能ID列表)..."
curl -s -X POST "$BASE/alice/office/sandbox/manifest" "${HDR[@]}" -d '{}' | tee "$OUT/sandbox_manifest.json" | head -c 500; echo

echo "[3] 拉取提示词技能市场..."
curl -s -X POST "$BASE/samantha/plugin/prompt_skill/list_discover_skills" "${HDR[@]}" \
  -d '{"page_size":50,"start_index":0,"frontend_source":"desktop"}' > "$OUT/discover_skills.json"
head -c 300 "$OUT/discover_skills.json"; echo

echo "完成。若第1步拿到 zip_url，用 curl -O 下载后 unzip 即得 SKILL.md 技能目录。"
