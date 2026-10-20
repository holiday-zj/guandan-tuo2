#!/usr/bin/env python3
"""启用大模型出牌：把本机 Hermes 的百炼密钥写入 data/llm.env（不打印明文）

用法:  python3 scripts/enable_llm.py
校验:  curl -s http://127.0.0.1:8080/api/ai/status   # 应显示 llmEnabled:true
"""
import os
import re
import stat
import subprocess
import sys

HOME = os.path.expanduser('~')
SRC = os.path.join(HOME, '.hermes', '.env')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(ROOT, 'data', 'llm.env')

BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
MODEL = 'qwen3.8-max'
VAR = 'ALIBABA_TOKEN_PLAN_CN_API_KEY'


def read_key():
    if not os.path.isfile(SRC):
        sys.exit(f'❌ 未找到 {SRC}')
    with open(SRC, encoding='utf-8') as f:
        for line in f:
            m = re.match(r'^%s=(.+?)\s*$' % VAR, line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    sys.exit(f'❌ 未在 {SRC} 中找到 {VAR}')


def main():
    key = read_key()
    print(f'✓ 读取到密钥，长度 {len(key)}')
    if len(key) < 20:
        sys.exit('❌ 密钥长度异常（<20），已中止')

    os.makedirs(os.path.dirname(DST), exist_ok=True)
    content = (
        '# 本地 LLM 配置（不入库，已在 .gitignore，权限 600）\n'
        f'LLM_BASE={BASE}\n'
        f'LLM_KEY={key}\n'
        f'LLM_MODEL={MODEL}\n'
        f'LLM_FAST_MODEL={MODEL}\n'
    )
    with open(DST, 'w', encoding='utf-8') as f:
        f.write(content)
    os.chmod(DST, stat.S_IRUSR | stat.S_IWUSR)  # 600

    # 确认被 git 忽略，否则立刻删除以防泄露
    r = subprocess.run(['git', '-C', ROOT, 'check-ignore', '-q', 'data/llm.env'])
    if r.returncode != 0:
        os.remove(DST)
        sys.exit('❌ data/llm.env 未被 git 忽略，已删除并中止')
    print(f'✓ 已写入 {DST}（git 已忽略，权限600）')

    # 用项目自身的加载逻辑复核
    sys.path.insert(0, ROOT)
    import importlib.util
    spec = importlib.util.spec_from_file_location('llm', os.path.join(ROOT, 'engine', 'ai', 'llm.js'))
    del spec  # JS 模块无法用 python 导入，仅占位
    print('')
    print('下一步：')
    print('  systemctl --user restart guandan')
    print('  curl -s http://127.0.0.1:8080/api/ai/status   # 期望 llmEnabled:true, keyLen:%d' % len(key))


if __name__ == '__main__':
    main()
