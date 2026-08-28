#!/bin/bash
# narrative-prompt-polish preflight: build 前必过三关
#  1) JS 语法 (node --check)
#  2) 文件大小无异常翻倍（基线 34546 字节；13:08 56K 重复 bug 教训）
#  3) 不出现多个 __ModuleLoader__.load 顶层调用（同一 bug 根因）
set -e
M=$(dirname "$(dirname "$(readlink -f "$0")")")
cd "$M"

fail=0
for f in src/*.js; do
  if ! node --check "$f" 2>/dev/null; then
    echo "X 语法失败: $f"; fail=1
  fi
done
[ "$fail" -eq 0 ] && echo "OK 关1: 语法" || exit 1

PREV_BYTES=34546
CUR_BYTES=$(stat -c %s src/client.bundle.js)
python3 -c "CUR=$CUR_BYTES; PREV=$PREV_BYTES; import sys; r=CUR/PREV; sys.exit(0 if (0.7<=r<=1.5) else 1)"
if [ $? -ne 0 ]; then
  echo "X 字节异常: 当前 $CUR_BYTES, 基线 $PREV_BYTES"
  exit 1
fi
echo "OK 关2: 大小 $CUR_BYTES/$PREV_BYTES"

LO=$(grep -c "^window.__ModuleLoader__\.load" src/client.bundle.js || true)
if [ "$LO" -gt 1 ]; then
  echo "X 发现 $LO 个 __ModuleLoader__.load"
  exit 1
fi
echo "OK 关3: 单一 __ModuleLoader__.load ($LO)"

echo ""
echo "OK preflight 通过, 可 build"


# gate 4（0.0.26：BUNDLE 改 $M 相对路径——原写死本机绝对路径，clone 后他人/CI 必失败且泄漏本机路径）
BUNDLE="$M/src/client.bundle.js"
for guard in "ctx.connection:1" "ctx.slots:2" "slots service unavailable at boot:2"; do
  pat="${guard%:*}"
  need="${guard##*:}"
  have=$(grep -c "$pat" "$BUNDLE" || true)
  if [ "$have" -lt "$need" ]; then
    echo "X 防御未丢: $pat 出现 $have 次, 至少 $need 次"
    exit 1
  fi
done
echo "OK 关4: 核心防御未丢"
