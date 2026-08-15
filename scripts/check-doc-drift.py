#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check-doc-drift.py — vrchat-assistant 文档漂移检测 + 自动修复（固定脚本）

权威口径：core/mcp-definitions.js 中 name: '...' 的集合 = 实际 MCP 工具清单。

检查项（对应 vrchat-assistant-history skill Phase 2）：
  [FAIL] README 工具清单完整    代码新增工具必须登记进 README「🔌 MCP 工具」章节
  [INFO] AGENTS.md 工具列举     提示哪些工具未在 AGENTS 出现（AGENTS 为采样列举，仅新增工具需核对）
  [FAIL] 工具总数数字残留        全仓库禁止"N 个 MCP 工具"表述（2026-08-14 拍板去数字）
  [FAIL] plugin.yaml 版本同步    hermes-plugin/plugin.yaml version 应 = package.json version
  [WARN] GitHub 仓库描述        描述不应含过时工具数（gh repo view；修复需 owner 权限，失败仅提示）

用法：
  python scripts/check-doc-drift.py             # 只检测，输出报告
  python scripts/check-doc-drift.py --fix       # 检测 + 自动修复（数字残留清除、plugin.yaml 版本同步）
  python scripts/check-doc-drift.py --json      # 输出 JSON 摘要（供 agent 解析）

退出码：0=无漂移 / 1=检测到漂移（含 INFO 级提示） / 2=执行错误（文件缺失等）
"""
import argparse
import json
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根（本脚本在 scripts/ 下）

# 需要扫数字残留的路径（相对仓库根；目录递归，文件单查）
NUMERIC_RESIDUE_TARGETS = [
    "README.md", "AGENTS.md", "ARCHITECTURE.md",
    "core/", "skills/", "start-monitor.js", "hermes-plugin/",
]
# 数字残留正则：覆盖 skill 中的几种写法
NUMERIC_RE = re.compile(
    r"[0-9]+\s*个\s*(?:MCP\s*)?工具\s*|"
    r"MCP\s*工具（[0-9]+\s*个）\s*|"
    r"[0-9]+\s*个\s*MCP\s*工具\s*|"
    r"[0-9]+\s*MCP\s*tools",
    re.IGNORECASE,
)

def read_text(rel):
    """读文件，容忍编码问题。返回 str 或 None。"""
    path = os.path.join(REPO, rel)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()

def extract_code_tools():
    """从 core/mcp-definitions.js 提取权威工具清单。"""
    src = read_text("core/mcp-definitions.js")
    if src is None:
        return None
    return set(re.findall(r"name:\s*'([a-z_]+)'", src))

def extract_readme_tools():
    """从 README「🔌 MCP 工具」章节提取已登记工具（反引号包裹的 snake_case 标识符）。

    注意：MCP 章节内部的小节标题是 `### `（三级），结束于下一个 `## `（二级）标题。
    必须用 ^## 行首锚定 + MULTILINE，避免把 `### ` 的子串误判为章节边界。
    """
    readme = read_text("README.md")
    if readme is None:
        return None
    m = re.search(r"^## 🔌 MCP 工具.*?\n(.*?)^## ", readme, re.DOTALL | re.MULTILINE)
    section = m.group(1) if m else readme
    return set(re.findall(r"`([a-z_]+)`", section))

def scan_numeric_residue():
    """扫描数字残留，返回 [(相对路径, 行号, 匹配文本)]。"""
    hits = []
    for target in NUMERIC_RESIDUE_TARGETS:
        full = os.path.join(REPO, target)
        if os.path.isdir(full):
            for root, _dirs, files in os.walk(full):
                for fn in files:
                    if not fn.endswith((".md", ".js", ".py", ".yaml", ".yml", ".json")):
                        continue
                    _scan_file(os.path.relpath(os.path.join(root, fn), REPO), hits)
        elif os.path.isfile(full):
            _scan_file(target, hits)
    return hits

def _scan_file(rel, hits):
    try:
        with open(os.path.join(REPO, rel), "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f, 1):
                if NUMERIC_RE.search(line):
                    hits.append((rel, i, line.strip()[:120]))
    except OSError:
        pass

def version_sync():
    """返回 (pkg_version, plugin_version) 或 None（文件缺失）。"""
    pkg = read_text("package.json")
    plugin = read_text("hermes-plugin/plugin.yaml")
    if pkg is None or plugin is None:
        return None
    try:
        pv = json.loads(pkg)["version"]
    except (json.JSONDecodeError, KeyError):
        pv = None
    m = re.search(r"^version:\s*(\S+)", plugin, re.M)
    plv = m.group(1) if m else None
    return (pv, plv)

def fix_numeric_residue():
    """清除数字残留。返回修改的文件数。"""
    fixed = 0
    for rel, _line, _text in scan_numeric_residue():
        path = os.path.join(REPO, rel)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            new_content = NUMERIC_RE.sub("", content)
            if new_content != content:
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(new_content)
                fixed += 1
        except OSError:
            continue
    return fixed

def fix_plugin_version():
    """把 plugin.yaml version 对齐 package.json。返回 True 表示已修改。"""
    pv, plv = version_sync()
    if not pv or plv == pv:
        return False
    path = os.path.join(REPO, "hermes-plugin", "plugin.yaml")
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    content = re.sub(r"^version:\s*\S+", f"version: {pv}", content, count=1, flags=re.M)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    return True

def gh_repo_description():
    """查 GitHub 仓库描述。返回 (desc, error)。gh 不可用或网络失败时 error 非空。"""
    try:
        r = subprocess.run(
            ["gh", "repo", "view", "ggg123124/vrchat-assistant", "--json", "description", "-q", ".description"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return None, r.stderr.strip() or "gh repo view failed"
        return r.stdout.strip(), None
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        return None, str(e)

def main():
    ap = argparse.ArgumentParser(description="vrchat-assistant 文档漂移检测 + 自动修复")
    ap.add_argument("--fix", action="store_true", help="自动修复可确定性修复的漂移")
    ap.add_argument("--json", action="store_true", help="输出 JSON 摘要")
    args = ap.parse_args()

    code_tools = extract_code_tools()
    if code_tools is None:
        print("ERROR: core/mcp-definitions.js 不存在，无法检测", file=sys.stderr)
        return 2

    readme_tools = extract_readme_tools()
    if readme_tools is None:
        print("ERROR: README.md 不存在", file=sys.stderr)
        return 2

    # ── 检测 ──
    missing_readme = sorted(code_tools - readme_tools)
    agents = read_text("AGENTS.md") or ""
    agents_present = set(re.findall(r"[a-z_]+", agents))
    missing_agents = sorted(t for t in code_tools if t not in agents_present)
    numeric_hits = scan_numeric_residue()
    pkg_v, plugin_v = version_sync() if version_sync() else (None, None)
    version_ok = (pkg_v is not None and pkg_v == plugin_v)
    gh_desc, gh_err = gh_repo_description()
    gh_ok = True
    if gh_desc is not None:
        gh_ok = not NUMERIC_RE.search(gh_desc)

    # ── 修复 ──
    fixed_numeric = 0
    fixed_plugin = False
    if args.fix:
        fixed_numeric = fix_numeric_residue()
        fixed_plugin = fix_plugin_version()
        # 修复后重测
        missing_readme = sorted(code_tools - extract_readme_tools())
        numeric_hits = scan_numeric_residue()
        pkg_v, plugin_v = version_sync() if version_sync() else (None, None)
        version_ok = (pkg_v is not None and pkg_v == plugin_v)

    # ── 汇总 ──
    has_drift = bool(missing_readme or numeric_hits or not version_ok)
    # AGENTS 缺失仅 INFO（README 是完整权威清单；AGENTS 采样列举，只提示）
    report = {
        "code_tools_count": len(code_tools),
        "readme_tools_count": len(readme_tools & code_tools),
        "missing_in_readme": missing_readme,
        "missing_in_agents": missing_agents,
        "numeric_residue": [{"file": r, "line": l, "text": t} for r, l, t in numeric_hits],
        "plugin_yaml_version": plugin_v,
        "package_json_version": pkg_v,
        "version_in_sync": version_ok,
        "gh_description": gh_desc,
        "gh_check_ok": gh_ok,
        "gh_error": gh_err,
        "has_drift": has_drift,
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if has_drift else 0

    print("=" * 60)
    print("vrchat-assistant 文档漂移检测（固定脚本 check-doc-drift.py）")
    print("=" * 60)
    print(f"权威工具数（core/mcp-definitions.js）: {len(code_tools)}")
    print(f"README 已登记: {len(readme_tools & code_tools)}")
    if missing_readme:
        print(f"\n[FAIL] README 缺失 {len(missing_readme)} 个工具（需补进「🔌 MCP 工具」对应分组）:")
        for t in missing_readme:
            print(f"  - {t}")
    else:
        print("\n[OK] README 工具清单完整")

    if missing_agents:
        print(f"\n[INFO] {len(missing_agents)} 个工具未在 AGENTS.md 出现（AGENTS 为采样列举，仅新增工具需核对补录）:")
        print("  " + ", ".join(missing_agents))
    else:
        print("\n[OK] AGENTS.md 工具覆盖无缺失")

    if numeric_hits:
        print(f"\n[FAIL] 发现 {len(numeric_hits)} 处工具总数数字残留（2026-08-14 拍板全仓库去数字）:")
        for rel, line, text in numeric_hits:
            print(f"  - {rel}:{line}  {text}")
    else:
        print("\n[OK] 无工具总数数字残留")

    if version_ok:
        print(f"\n[OK] plugin.yaml 版本同步（{plugin_v}）")
    else:
        print(f"\n[FAIL] plugin.yaml 版本 {plugin_v} ≠ package.json 版本 {pkg_v}（--fix 可自动对齐）")

    if gh_desc is not None:
        if gh_ok:
            print(f"\n[OK] GitHub 描述无过时工具数")
        else:
            print(f"\n[WARN] GitHub 描述可能含过时工具数: {gh_desc!r}")
            print("       （gh repo edit 需 owner 权限，nixi-agent 会 404 —— 请在 Phase 5 报告提醒用户手动改）")
    elif gh_err:
        print(f"\n[WARN] GitHub 描述检查跳过（{gh_err}）")

    if args.fix:
        print(f"\n[FIX] 清除数字残留 {fixed_numeric} 处；plugin.yaml 版本{'已对齐' if fixed_plugin else '无需修改'}")

    print("\n" + ("结论: ✅ 无漂移，文档与现状一致" if not has_drift else "结论: ❌ 存在漂移（详见上方 [FAIL] 项）"))
    return 1 if has_drift else 0

if __name__ == "__main__":
    sys.exit(main())
