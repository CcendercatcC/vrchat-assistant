---
name: vrc-monitor-companion-query
description: "Correct way to answer 'who played with me / with XX' VRChat queries. DO NOT delegate to subagents — use the get_companions MCP tool directly for instanceId cross-reference."
version: 1.0.0
metadata:
  hermes:
    tags: [vrchat, query, companion, cross-reference]
---

# VRChat Companion Query

## When to Use

Answer questions like:
- "我今天和谁一起玩过？" / "今晚和谁一起了？"
- "XX和谁在一起？" / "XX和谁同屏过？"
- 任何需要找出**在特定时间段内同世界同实例的所有好友**的查询

## CRITICAL: Do NOT Delegate to Subagents

**Subagents CANNOT correctly answer "who played with me" queries.** They only check a few known userIds; everyone else gets missed.

真实教训：用户问"今天和谁一起玩过"，委派子 agent 只查到少数已知好友，漏掉了很多人；改用全量交叉查询才拿到完整列表。这类查询**必须**用 `get_companions` 工具直接做（它内部是全量 SQLite 交叉比对），不要依赖子 agent 的局部知识。

## Correct Approach

Use the `get_companions` MCP tool directly on the vrc-monitor server (port 8799).

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `startTime` | ✅ | ISO 8601 UTC (e.g. `2026-07-25T11:00:00Z`). Beijing → UTC: -8h |
| `endTime` | ✅ | ISO 8601 UTC. Suggest ≤24h window |
| `userId` | optional | Target user. Omit = self (the logged-in account); pass a friend's ID = "who did XX play with" |

### How to Call

```bash
curl -s http://127.0.0.1:8799/mcp -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_companions","arguments":{"startTime":"2026-07-25T11:00:00Z","endTime":"2026-07-25T17:00:00Z","userId":"<目标userId>"}}}'
```

### How to Parse the Response

Response is SSE format. After the `data: ` prefix, parse JSON:

```python
import json
data = json.loads(sse_line[6:])  # strip "data: " prefix
result = json.loads(data['result']['content'][0]['text'])
companions = result['companions']  # list of {userId, displayName, firstSeen, lastSeen, matchCount, worlds}
```

### Rendering with Nicknames

Map displayNames to nicknames via the `get_nicknames` MCP tool (fuzzy `query` param or fetch-all then map by userId). Nickname data lives in the vrc-monitor database — do not maintain it in skill files.

## Why Subagent Fails (Technical)

| Method | Why it fails |
|--------|-------------|
| `get_recent_events(limit=30)` | Only returns latest 30 events, can't cover hours |
| `get_friend_events(userId)` | Need to know WHO to look up first → can't find unknowns |
| `get_online_friends()` | Only currently online, misses past visitors |
| Known-nickname matching | Only covers a handful of friends, misses everyone else |

## References

- MCP server: `<本仓库>/start-monitor.js`
- Storage method: `<本仓库>/core/storage.js` → `findCompanions()`
