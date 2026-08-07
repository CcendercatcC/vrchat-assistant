/**
 * VRChat 好友监控系统 — 主入口
 * 
 * 独立 MCP 服务（不依赖 VRCX-0）
 * Phase 1: 基础设施 — 数据库 + 基础 MCP 工具
 * 
 * 启动: node start-monitor.js
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Storage } from './core/storage.js';
import { RateLimiter } from './core/rate-limiter.js';
import { VrchatApiClient } from './vrchat-api.js';
import { WsManager } from './core/ws-manager.js';
import { EventPipeline } from './core/event-pipeline.js';
import { FriendStateManager } from './core/friend-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const COOKIE_FILE = path.join(__dirname, 'auth_cookie.txt');
const CRED_FILE = path.join(__dirname, 'credentials.json');
const DB_PATH = path.join(__dirname, 'vrc-monitor.sqlite3');

// ── 全局状态 ──
let storage;
let api;
let rateLimiter;
let wsManager;
let eventPipeline;
let friendState;
let serverState = { started: null, authUser: null, friendCount: 0, needsOtp: false };

// ── Watchlist 内存缓存（避免每次 WS 事件查 DB）──
let _watchlistCache = [];       // 内存中的 watchlist 快照
let _watchlistDirty = false;    // 标记是否需要刷新

function _refreshWatchlistCache() {
  _watchlistCache = storage.getWatchlist();
  _watchlistDirty = false;
}

function _invalidateWatchlistCache() {
  _watchlistDirty = true;
}

// ── WebSocket 事件 → 好友状态更新 ──
async function _updateFriendState(event) {
  switch (event.type) {
    case 'friend-online':
      friendState.setOnline(event.userId, {
        displayName: event.displayName,
        location: event.location,
        worldId: event.worldId,
      });
      break;
    case 'friend-offline':
      friendState.setOffline(event.userId);
      break;
    case 'friend-location':
      friendState.updateLocation(event.userId, {
        displayName: event.displayName,
        location: event.location,
        worldId: event.worldId,
      });
      break;
    case 'friend-active':
      friendState.setOnline(event.userId);
      break;
  }
}

// ── WebSocket 重连后刷新全量在线状态 ──
async function _refreshOnlineState() {
  try {
    const r = await api._request('GET', '/auth/user/friends?offline=false');
    if (r.status === 200 && Array.isArray(r.data)) {
      const online = r.data.filter(f => f.location && f.location !== 'offline');
      friendState.batchSetOnline(online.map(f => ({
        userId: f.id,
        displayName: f.displayName,
        location: f.location,
        worldId: f.worldId,
        isOnline: true,
      })));
      log(`🔄 刷新在线状态: ${friendState.getOnlineCount()} 人在线`);
    }
  } catch (err) {
    log(`⚠️ 刷新在线状态失败: ${err.message}`);
  }
}

// ── MCP 会话管理 ──
const sessions = new Map();

class McpSession {
  constructor() {
    this.id = randomUUID();
    this.initialized = false;
  }
}

function getOrCreateSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) {
    const s = new McpSession();
    sessions.set(s.id, s);
    return s;
  }
  return sessions.get(sessionId);
}

// ── SSE 响应辅助 ──
function sendSSE(res, events, sessionId) {
  if (res.headersSent) return;
  let body = '';
  for (const event of events) {
    body += `data: ${JSON.stringify(event)}\n\n`;
  }
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(body),
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  res.writeHead(200, headers);
  res.end(body);
}

function sendError(res, id, message) {
  sendSSE(res, [{
    jsonrpc: '2.0', id,
    error: { code: -32603, message },
  }]);
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── MCP 工具定义 ──

const CUSTOM_TOOLS = [
  // ── 已有的写工具 ──
  {
    name: 'send_boop',
    description: '[write·vrchat] Send a boop to a user. Requires userId.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        emojiId: { type: 'string', description: 'Optional emoji ID' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'send_invite',
    description: '[write·vrchat] Send an invite to join your current instance.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        worldId: { type: 'string' },
        instanceId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['userId', 'worldId', 'instanceId'],
    },
  },
  {
    name: 'request_invite',
    description: '[write·vrchat] Request an invite from a user.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'send_friend_request',
    description: '[write·vrchat] Send a friend request to a user. Supports userId or exact displayName match.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Exact display name to search and send friend request' },
      },
    },
  },
  {
    name: 'remove_friend',
    description: '[write·vrchat] Remove a friend. Requires userId or exact displayName match, plus confirm: true to execute (irreversible).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Exact display name to search and remove friend' },
        confirm: { type: 'boolean', description: 'Set true to actually remove the friend (irreversible). Default false returns preview only.' },
      },
    },
  },
  // ── Phase 1 新增的读工具 ──
  {
    name: 'get_online_friends',
    description: '[query] List currently online friends from VRChat API.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_friend_info',
    description: '[query] Get detailed info about a specific friend from API.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Or search by display name' },
      },
    },
  },
  {
    name: 'get_mutual_friends',
    description: '[query] List mutual friends between you and a user (userId or exact displayName). Includes local nicknames.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Exact display name to search' },
        limit: { type: 'number', default: 100, description: 'Max results (1-100, default 100)' },
      },
    },
  },
  {
    name: 'search_users',
    description: '[query] Search VRChat users by display name.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_database_stats',
    description: '[system] Get local database statistics (event count, friend count, etc).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_server_status',
    description: '[system] Check server health and auth status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // ── 新增 Phase 4 工具 ──
  {
    name: 'get_friend_events',
    description: '[query] Query a friend\'s event history from local database.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Friend ID (usr_...)' },
        limit: { type: 'number', default: 20 },
        offset: { type: 'number', default: 0 },
        types: { type: 'string', description: 'Comma-separated event types to filter' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'get_recent_events',
    description: '[query] Get the latest event stream from local database.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 30 },
        offset: { type: 'number', default: 0 },
        typeFilter: { type: 'string', description: 'Comma-separated event types to filter' },
        userIdFilter: { type: 'string', description: 'Filter by friend user ID' },
      },
    },
  },
  {
    name: 'get_world_name',
    description: '[query] Get world name by worldId. Checks local cache first, falls back to API.',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'World ID (wrld_...)' },
        forceRefresh: { type: 'boolean', description: 'Force refresh from API' },
      },
      required: ['worldId'],
    },
  },
  {
    name: 'get_watchlist',
    description: '[manage] List all watched friends.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'add_to_watchlist',
    description: '[manage] Add a friend to watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user ID (usr_...)' },
        displayName: { type: 'string', description: 'Optional display name' },
        priority: { type: 'number', default: 1, description: 'Priority 0-5' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'remove_from_watchlist',
    description: '[manage] Remove a friend from watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user ID (usr_...)' },
      },
      required: ['userId'],
    },
  },
  // ── 新增：同屏好友查询 ──
  {
    name: 'get_companions',
    description: '[query] Find all friends who were in the same instances as you during a time range. Uses SQLite cross-reference by instanceId.',
    inputSchema: {
      type: 'object',
      properties: {
        startTime: { type: 'string', description: 'Start time (ISO 8601, UTC recommended, e.g. 2026-07-25T11:00:00Z)' },
        endTime: { type: 'string', description: 'End time (ISO 8601, UTC)' },
        userId: { type: 'string', description: 'Optional: override userId. Defaults to current user.' },
      },
      required: ['startTime', 'endTime'],
    },
  },
  // ── 新增：好友上线规律分析 ──
  {
    name: 'get_online_pattern',
    description: '[query] Analyze a friend\'s online activity pattern (hourly distribution and frequency in Beijing time).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        days: { type: 'number', default: 30, description: 'Analyze last N days (Beijing time natural days, default 30)' },
        startTime: { type: 'string', description: 'Optional exact start time (ISO 8601 UTC); if provided with endTime, overrides days' },
        endTime: { type: 'string', description: 'Optional exact end time (ISO 8601 UTC); if provided with startTime, overrides days' },
      },
      required: ['userId'],
    },
  },
  // ── 新增：昵称映射 ──
  {
    name: 'get_nicknames',
    description: '[manage] Query friend nickname mappings (exact by userId, fuzzy by nickname/displayName, or all).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        query: { type: 'string', description: 'Fuzzy search on display_name or nickname' },
      },
    },
  },
  {
    name: 'set_nickname',
    description: '[manage] Set or update a friend nickname mapping (upsert).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        nickname: { type: 'string', description: 'Nickname to store' },
        displayName: { type: 'string', description: 'Optional current display name' },
      },
      required: ['userId', 'nickname'],
    },
  },
];

// ── 工具处理器 ──

async function handleGetOnlineFriends() {
  const r = await api._request('GET', '/auth/user/friends?offline=false');
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const friends = Array.isArray(r.data) ? r.data : [];
  const online = friends.filter(f => f.location && f.location !== 'offline');
  return {
    online: online.length,
    total: friends.length,
    friends: online.map(f => ({
      userId: f.id,
      displayName: f.displayName,
      location: f.location || 'private',
      status: f.status,
      statusDescription: f.statusDescription,
      platform: f.platform,
      avatarImageUrl: f.currentAvatarThumbnailImageUrl,
    })),
  };
}

async function handleGetFriendInfo({ userId, displayName }) {
  let targetId = userId;
  if (!targetId && displayName) {
    // 搜索用户
    const r = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=5`);
    if (r.status !== 200) throw new Error(`API error: ${r.status}`);
    const users = Array.isArray(r.data) ? r.data : [];
    if (users.length === 0) return { error: 'User not found' };
    targetId = users[0].id;
  }
  if (!targetId) throw new Error('Provide userId or displayName');

  const r = await api._request('GET', `/users/${targetId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const u = r.data;
  return {
    userId: u.id,
    displayName: u.displayName,
    bio: u.bio,
    status: u.status,
    statusDescription: u.statusDescription,
    state: u.state,
    location: u.location,
    worldId: u.worldId,
    platform: u.platform,
    avatarImageUrl: u.currentAvatarImageUrl,
    avatarThumbnail: u.currentAvatarThumbnailImageUrl,
    tags: u.tags,
    developerType: u.developerType,
    isFriend: u.isFriend,
    lastLogin: u.last_login,
    pastDisplayNames: u.pastDisplayNames,
    dateJoined: u.date_joined,
    ageVerification: u.ageVerificationStatus,
  };
}

async function handleSearchUsers({ query, limit = 10 }) {
  const r = await api._request('GET', `/users?search=${encodeURIComponent(query)}&n=${limit}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  return {
    query,
    results: (Array.isArray(r.data) ? r.data : []).map(u => ({
      userId: u.id,
      displayName: u.displayName,
      bio: (u.bio || '').slice(0, 100),
      status: u.status,
      isFriend: u.isFriend,
    })),
  };
}

async function handleGetMutualFriends({ userId, displayName, limit = 100 }) {
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  let targetId = userId;
  let targetDisplayName = null;

  if (!targetId) {
    const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
    if (search.status !== 200) throw new Error(`API error: ${search.status}`);
    const users = Array.isArray(search.data) ? search.data : [];
    const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

    if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
    if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

    targetId = matches[0].id;
    targetDisplayName = matches[0].displayName;
  }

  const n = Math.max(1, Math.min(100, Number(limit) || 100));
  const r = await api._request('GET', `/users/${targetId}/mutuals/friends?n=${n}&offset=0`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const nicknames = storage.getNicknames({});
  const nicknameMap = new Map();
  for (const item of nicknames) {
    if (item.userId) nicknameMap.set(item.userId, item.nickname);
  }

  const mutuals = Array.isArray(r.data) ? r.data : [];
  const mutualFriends = mutuals.map(u => ({
    userId: u.id,
    displayName: u.displayName,
    nickname: nicknameMap.get(u.id) || null,
    isFriend: u.isFriend !== undefined ? u.isFriend : true,
  }));

  return {
    userId: targetId,
    displayName: targetDisplayName,
    total: mutualFriends.length,
    mutualFriends,
  };
}

async function handleSendFriendRequest({ userId, displayName }) {
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  if (userId) {
    const r = await api.sendFriendRequest(userId);
    if (r.status >= 400) throw new Error(`API error ${r.status}`);
    return { userId, displayName: null, method: 'userId', ok: true };
  }

  const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
  if (search.status !== 200) throw new Error(`API error: ${search.status}`);
  const users = Array.isArray(search.data) ? search.data : [];
  const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

  if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
  if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

  const target = matches[0];
  if (target.isFriend) throw new Error(`"${displayName}" 已经是你的好友，无需重复添加`);
  const r = await api.sendFriendRequest(target.id);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { userId: target.id, displayName, method: 'displayName', ok: true };
}

async function handleRemoveFriend({ userId, displayName, confirm }) {
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  let target = { userId, displayName };
  if (!userId) {
    const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
    if (search.status !== 200) throw new Error(`API error: ${search.status}`);
    const users = Array.isArray(search.data) ? search.data : [];
    const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

    if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
    if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

    const found = matches[0];
    if (found.isFriend === false) throw new Error(`"${displayName}" 不是你的好友，无需删除`);
    target = { userId: found.id, displayName };
  }

  if (!confirm) {
    return { userId: target.userId, displayName: target.displayName, confirmRequired: true, message: '删除好友不可逆，请传 confirm: true 确认执行' };
  }

  const r = await api.removeFriend(target.userId);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { userId: target.userId, displayName: target.displayName, ok: true };
}

function handleGetDatabaseStats() {
  return {
    ...storage.getStats(),
    friendState: friendState?.getStats(),
    eventPipeline: eventPipeline?.getStats(),
  };
}

function handleGetServerStatus() {
  return {
    status: 'running',
    startedAt: serverState.started,
    authenticated: !!serverState.authUser,
    user: serverState.authUser,
    dbEvents: storage.getStats().events,
    dbFriends: storage.getStats().friends,
    ws: wsManager?.getState(),
    friendState: friendState?.getStats(),
    eventPipeline: eventPipeline?.getStats(),
  };
}

// ── Phase 4 新增处理器 ──

async function handleGetFriendEvents({ userId, limit = 20, offset = 0, types }) {
  // 单类型查询
  if (types && !types.includes(',')) {
    const events = storage.getEventsByUser(userId, { limit, offset, type: types.trim() });
    return { userId, total: events.length, events };
  }
  // 多类型/无类型过滤
  const events = storage.getEventsByUser(userId, { limit, offset });
  if (types) {
    const typeSet = new Set(types.split(',').map(t => t.trim()));
    const filtered = events.filter(e => typeSet.has(e.type));
    return { userId, total: filtered.length, events: filtered };
  }
  return { userId, total: events.length, events };
}

function handleGetRecentEvents({ limit = 30, offset = 0, typeFilter, userIdFilter }) {
  let events;
  if (userIdFilter) {
    events = storage.getEventsByUser(userIdFilter, { limit, offset });
  } else {
    events = storage.getRecentEvents({ limit: limit + offset });
    if (offset > 0) events = events.slice(offset);
  }
  if (typeFilter) {
    const typeSet = new Set(typeFilter.split(',').map(t => t.trim()));
    events = events.filter(e => typeSet.has(e.type));
  }
  return { total: events.length, events };
}

async function handleGetWorldName({ worldId, forceRefresh }) {
  const WORLD_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h：世界名会变（改名），缓存不能永远新鲜
  // 查缓存（带 TTL：超过 24h 的缓存视为陈旧，重新走 API）
  if (!forceRefresh) {
    const cached = storage.getWorldName(worldId);
    if (cached) {
      let fresh = true;
      if (cached.updated_at) {
        const updated = Date.parse(String(cached.updated_at).replace(' ', 'T') + 'Z');
        const ageMs = Number.isFinite(updated) ? Date.now() - updated : NaN;
        if (!(ageMs >= 0 && ageMs < WORLD_CACHE_TTL_MS)) fresh = false;
      }
      if (fresh) return { worldId, name: cached.name, source: 'cache', ...cached };
    }
  }
  // 调 API
  const r = await api._request('GET', `/worlds/${worldId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const w = r.data;
  const result = {
    worldId: w.id,
    name: w.name,
    authorName: w.authorName,
    capacity: w.capacity,
    occupants: w.occupants,
    releaseStatus: w.releaseStatus,
    tags: w.tags,
    description: (w.description || '').slice(0, 200),
    imageUrl: w.imageUrl,
    favorites: w.favorites,
    source: 'api',
  };
  // 写入缓存
  storage.upsertWorld({
    worldId: w.id, name: w.name, authorName: w.authorName,
    capacity: w.capacity, favorites: w.favorites,
    releaseStatus: w.releaseStatus, tags: w.tags || [],
  });
  return result;
}

function handleGetWatchlist() {
  return { watchlist: storage.getWatchlist() };
}

function handleAddToWatchlist({ userId, displayName, priority = 1 }) {
  storage.addToWatchlist(userId, displayName, priority);
  storage.save();
  _invalidateWatchlistCache();
  return { success: true, userId, priority };
}

function handleRemoveFromWatchlist({ userId }) {
  storage.removeFromWatchlist(userId);
  storage.save();
  _invalidateWatchlistCache();
  return { success: true, userId };
}

// ── 新增：同屏好友查询 ──

function handleGetCompanions({ startTime, endTime, userId }) {
  const targetUserId = userId || serverState.authUser?.id;
  if (!targetUserId) throw new Error('No userId provided and not authenticated');
  return storage.findCompanions(targetUserId, startTime, endTime);
}

// ── 新增：好友上线规律分析 ──

function handleGetOnlinePattern({ userId, days, startTime, endTime }) {
  if (!userId) throw new Error('userId is required');
  const opts = {};
  if (startTime && endTime) {
    opts.startTime = startTime;
    opts.endTime = endTime;
  } else if (days !== undefined && days !== null) {
    opts.days = days;
  }
  return storage.getOnlinePattern(userId, opts);
}

// ── 新增：昵称映射 ──

function handleGetNicknames({ userId, query }) {
  return { nicknames: storage.getNicknames({ userId, query }) };
}

function handleSetNickname({ userId, nickname, displayName }) {
  if (!userId) throw new Error('userId is required');
  if (!nickname) throw new Error('nickname is required');
  const result = storage.setNickname({ userId, nickname, displayName });
  storage.save();
  return result;
}

// ── RPC 处理 ──

async function handleRpc(rpc, session, res) {
  const { id, method, params } = rpc;

  switch (method) {
    case 'initialize': {
      session.initialized = true;
      sendSSE(res, [{
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'vrc-monitor', version: '1.0.0' },
        },
      }], session.id);
      break;
    }

    case 'notifications/initialized':
      sendSSE(res, [], session.id);
      break;

    case 'tools/list': {
      sendSSE(res, [{
        jsonrpc: '2.0', id,
        result: { tools: CUSTOM_TOOLS },
      }], session.id);
      break;
    }

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        let result;

        switch (name) {
          // 写工具（依赖 api client，经限流器）
          case 'send_boop': {
            const r = await rateLimiter.execute(() => api.sendBoop(args.userId, args.emojiId || ''));
            if (r.status >= 400) throw new Error(`API error ${r.status}`);
            result = { success: true, userId: args.userId, booped: true };
            break;
          }
          case 'send_invite': {
            await rateLimiter.execute(() => api.ensureAuth());
            const body = { instanceId: `${args.worldId}:${args.instanceId}` };
            if (args.message) body.message = args.message;
            const r = await rateLimiter.execute(() => api._request('POST', `/invite/${args.userId}`, body));
            if (r.status >= 400) throw new Error(`API error ${r.status}`);
            result = { success: true, userId: args.userId, invited: true };
            break;
          }
          case 'request_invite': {
            await rateLimiter.execute(() => api.ensureAuth());
            const r = await rateLimiter.execute(() => api._request('POST', `/requestInvite/${args.userId}`, {
              message: args.message || 'Can I join you?',
              platform: 'standalonewindows',
            }));
            if (r.status >= 400) throw new Error(`API error ${r.status}`);
            result = { success: true, userId: args.userId, requestSent: true };
            break;
          }
          case 'send_friend_request': {
            result = await rateLimiter.execute(() => handleSendFriendRequest(args));
            break;
          }
          case 'remove_friend': {
            result = await rateLimiter.execute(() => handleRemoveFriend(args));
            break;
          }
          // 读工具
          case 'get_online_friends':
            result = await rateLimiter.execute(handleGetOnlineFriends);
            break;
          case 'get_friend_info':
            result = await rateLimiter.execute(() => handleGetFriendInfo(args));
            break;
          case 'get_mutual_friends':
            result = await rateLimiter.execute(() => handleGetMutualFriends(args));
            break;
          case 'search_users':
            result = await rateLimiter.execute(() => handleSearchUsers(args));
            break;
          case 'get_database_stats':
            result = handleGetDatabaseStats();
            break;
          case 'get_server_status':
            result = handleGetServerStatus();
            break;
          // Phase 4 新工具
          case 'get_friend_events':
            result = await handleGetFriendEvents(args);
            break;
          case 'get_recent_events':
            result = handleGetRecentEvents(args);
            break;
          case 'get_world_name':
            result = await rateLimiter.execute(() => handleGetWorldName(args));
            break;
          case 'get_watchlist':
            result = handleGetWatchlist();
            break;
          case 'add_to_watchlist':
            result = handleAddToWatchlist(args);
            break;
          case 'remove_from_watchlist':
            result = handleRemoveFromWatchlist(args);
            break;
          case 'get_companions':
            result = handleGetCompanions(args);
            break;
          case 'get_online_pattern':
            result = handleGetOnlinePattern(args);
            break;
          case 'get_nicknames':
            result = handleGetNicknames(args);
            break;
          case 'set_nickname':
            result = handleSetNickname(args);
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        sendSSE(res, [{
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        }]);
      } catch (err) {
        log(`❌ ${name} failed: ${err.message}`);
        sendError(res, id, err.message);
      }
      break;
    }

    default:
      sendSSE(res, [], session.id);
  }
}

// ── HTTP 服务 ──

function createServer() {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      log(`❌ Unhandled: ${err.message}`);
      if (!res.headersSent) {
        try { res.writeHead(502); res.end(err.message); } catch {}
      }
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
    }
  });

  // 端口冲突不直接 crash
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`❌ 端口 ${PORT} 已被占用，请检查是否有旧进程残留`);
    } else {
      log(`❌ 服务器错误: ${err.message}`);
    }
  });

  return server;
}

async function handleRequest(req, res) {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    const uptime = serverState.started ? Math.floor((Date.now() - serverState.started) / 1000) : 0;
    const status = {
      ok: true,
      auth: serverState.authUser
        ? { authenticated: true, user: serverState.authUser }
        : { authenticated: false, needsOtp: serverState.needsOtp },
      db: storage.getStats(),
      rateLimiter: rateLimiter.getStats(),
      ws: wsManager?.getState(),
      friendState: friendState?.getStats(),
      eventPipeline: eventPipeline?.getStats(),
      uptime,
    };
    const body = JSON.stringify(status, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // MCP endpoint probe
  if (req.method === 'GET' && req.url === '/mcp') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Content-Length': 0 });
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  let body = '';
  req.on('data', (chunk) => body += chunk);
  req.on('end', async () => {
    try {
      const rpc = JSON.parse(body);
      const sessionId = req.headers['mcp-session-id'];
      const session = getOrCreateSession(sessionId);
      log(`MCP ${rpc.method || '?'} ${body.slice(0, 60)}...`);
      await handleRpc(rpc, session, res);
    } catch (err) {
      log(`Parse error: ${err.message}`);
      sendError(res, null, 'Parse error: ' + err.message);
    }
  });
}

// ── OTP 邮箱获取 ──

async function fetchOtpFromEmail() {
  const otpScript = path.join(__dirname, 'fetch-otp.py');
  if (!existsSync(otpScript)) {
    throw new Error('fetch-otp.py 不存在');
  }
  const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  const { execSync } = await import('node:child_process');
  const authCode = creds.imap_auth_code || creds.qqmail_auth_code || '';
  let cmd = `python "${otpScript}" "${creds.email}" "${authCode}"`;
  if (creds.imap_host) cmd += ` "${creds.imap_host}"`;
  const otp = execSync(cmd, { timeout: 15000, encoding: 'utf-8' }).trim();
  return otp;
}

// ── 启动 ──

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('  VRChat 好友监控系统 v1.0');
  console.log('  Phase 1 — 基础设施');
  console.log('══════════════════════════════════════════════\n');

  serverState.started = new Date().toISOString();

  // 1. 初始化数据库
  log('📦 初始化数据库...');
  storage = new Storage();
  await storage.init(DB_PATH);
  const stats = storage.getStats();
  log(`   ✅ 数据库就绪: ${DB_PATH}`);
  log(`   📊 事件: ${stats.events} 条 | 好友: ${stats.friends} 位 | 世界缓存: ${stats.world_cache} 个`);
  _refreshWatchlistCache();  // 初始化 watchlist 内存缓存

  // 2. 初始化 API 客户端
  log('\n🔑 初始化 API 客户端...');
  if (!existsSync(CRED_FILE)) {
    console.error('\n❌ 未找到 credentials.json — 无法登录 VRChat');
    console.error('');
    console.error('   请先完成配置：');
    console.error(`   1. 复制 credentials.example.json 为 credentials.json`);
    console.error('   2. 填入 VRChat 邮箱、密码、邮箱 IMAP 授权码（imap_auth_code）');
    console.error('   3. 配置说明详见仓库根目录 AGENTS.md');
    console.error('');
    process.exit(1);
  }
  let creds;
  try {
    creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  } catch (parseErr) {
    console.error(`\n❌ credentials.json 解析失败: ${parseErr.message}`);
    console.error('   请检查文件是否为合法 JSON（参考 credentials.example.json 模板）');
    process.exit(1);
  }
  if (!creds.email || !creds.password) {
    console.error('\n❌ credentials.json 缺少 email 或 password 字段');
    console.error('   请参考 credentials.example.json 补全配置');
    process.exit(1);
  }
  api = new VrchatApiClient(creds.email, creds.password);
  api.loadCookieFromFile(COOKIE_FILE);
  try {
    const user = await api.ensureAuthWithAutoOtp(fetchOtpFromEmail);
    serverState.authUser = { id: user.id, displayName: user.displayName };
    serverState.needsOtp = false;
    log(`   ✅ 已登录: ${user.displayName} (${user.id})`);
    api.saveCookieToFile(COOKIE_FILE);
  } catch (err) {
    serverState.needsOtp = false;
    log(`   ❌ 登录失败: ${err.message}`);
    // 不退出进程，让 MCP/WS 服务启动以便后续重试
  }

  // 3. 初始化限流器
  rateLimiter = new RateLimiter({ minInterval: 2600 });
  log(`\n⏱  限流器: 间隔 ${rateLimiter.minInterval}ms`);

  // 4. 初始化好友状态管理器
  friendState = new FriendStateManager();
  log(`\n👥 好友状态管理器就绪`);

  // 5. 初始化事件处理管道
  eventPipeline = new EventPipeline(storage, null);
  log(`📨 事件处理管道就绪`);

  // 6. 启动 WebSocket
  log('\n🔌 启动 WebSocket 连接...');
  wsManager = new WsManager({
    apiClient: api,
    otpFetcher: fetchOtpFromEmail,
    onEvent: async (event) => {
      try {
        await eventPipeline.process(event);
        await _updateFriendState(event);
        
        // 核心关注好友活动日志（从内存缓存读取，不查 DB）
        if (_watchlistDirty) _refreshWatchlistCache();
        const isWatched = _watchlistCache.some(w => w.user_id === event.userId);
        if (isWatched) {
          log(`⭐ [关注] ${event.displayName || event.userId}: ${event.type}`);
        }
      } catch (err) {
        log(`⚠️ 事件处理失败: ${err.message}`);
      }
    },
    onStatusChange: (status) => {
      log(`🔌 WebSocket: ${status}`);
      if (status === 'connected') {
        _refreshOnlineState(); // 连接后刷新全量状态
        // WS 重连成功但启动登录可能失败(如 OTP 错位)，此处复查认证并同步 authUser
        api.checkAuth().then((res) => {
          if (res.valid) {
            serverState.authUser = { id: res.user.id, displayName: res.displayName };
          }
        }).catch((err) => {
          log(`⚠️ 认证复查失败: ${err.message}`);
        });
      }
    },
  });
  wsManager.start();

  // 7. 启动 MCP 服务
  const server = createServer();
  server.listen(PORT, '127.0.0.1', () => {
    log(`\n🚀 MCP 服务运行在 http://127.0.0.1:${PORT}/mcp\n`);
    log('可用工具:');
    for (const t of CUSTOM_TOOLS) {
      log(`  ${t.name} — ${t.description}`);
    }
    log(`\n健康检查: http://127.0.0.1:${PORT}/health`);
    log('\n按 Ctrl+C 停止\n');
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

// ── 优雅关闭 ──
async function shutdown(signal) {
  log(`\n⚠️ 收到 ${signal}，正在关闭...`);
  try {
    if (wsManager) wsManager.stop();
    if (eventPipeline) eventPipeline.flush();
    if (storage) storage.save();
    log('✅ 已保存数据');
  } catch (e) {
    console.error('关闭时出错:', e);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('beforeExit', () => {
  if (eventPipeline) eventPipeline.flush();
  if (storage) storage.save();
});

// ── 全局异常兜底（防止僵尸进程 + 端口残留）──
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
  shutdown('unhandledRejection');
});
