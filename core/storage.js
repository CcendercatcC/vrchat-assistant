/**
 * VRChat 好友监控系统 — SQLite 存储层
 * 
 * 封装 better-sqlite3 的所有数据库操作（2026-08-09 由 sql.js 迁移）。
 * 为什么换：sql.js 是 WASM 内存库，_save() 整文件覆盖写，强杀进程会
 * 截断 303MB 大文件导致数据全丢（2026-08-09 真实事故）。better-sqlite3
 * 是原生绑定 + WAL 模式：每次写即时落盘、崩溃安全、支持并发读。
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { backupDatabase } from './backup.js';
import { SocialAnalytics } from './analytics/social.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DDL_PATH = path.join(__dirname, 'init-db.sql');
const X_WORLDS_DDL_PATH = path.join(__dirname, 'init-x-worlds.sql');

export class Storage {
  constructor() {
    this.social = new SocialAnalytics(this);
  }

  /** @type {import('better-sqlite3').Database} */
  db = null;
  dbPath = '';

  async init(dbPath) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    const ddl = readFileSync(DDL_PATH, 'utf-8');
    // 迁移：旧库表名 new_worlds → world_kb（2026-08-16 更名，幂等）
    // ⚠️ 必须在 DDL exec 之前执行！否则 CREATE TABLE IF NOT EXISTS world_kb 会先建出
    // 空表，RENAME 因名字冲突失败，老数据残留在 new_worlds 中（代码全查 world_kb → 空）。
    // 顺序：老库（仅 new_worlds）→ RENAME 带走数据 + 索引跟随 → DDL 建 idx_world_kb_visited。
    const oldKbCols = this._query(`PRAGMA table_info(new_worlds)`);
    const newKbCols = this._query(`PRAGMA table_info(world_kb)`);
    if (oldKbCols.length > 0 && newKbCols.length === 0) {
      this._run(`ALTER TABLE new_worlds RENAME TO world_kb`);
      this._run(`DROP INDEX IF EXISTS idx_new_worlds_visited`);
    }
    this.db.exec(ddl);
    // X 博主世界推荐表（x_world_digest 工具，幂等 CREATE IF NOT EXISTS）
    try {
      const xddl = readFileSync(X_WORLDS_DDL_PATH, 'utf-8');
      this.db.exec(xddl);
    } catch (e) {
      console.warn(`[storage] x-worlds DDL 加载失败: ${e.message}`);
    }
    // 迁移：旧库 world_cache 缺 note 列
    const worldCols = this._query(`PRAGMA table_info(world_cache)`);
    if (!worldCols.some(c => c.name === 'note')) {
      this._run(`ALTER TABLE world_cache ADD COLUMN note TEXT`);
    }
    // 迁移：旧库 world_cache 缺 favorited 列（favorite_world 云端收藏本地标记，幂等）
    const wcFavCols = this._query(`PRAGMA table_info(world_cache)`);
    if (!wcFavCols.some(c => c.name === 'favorited')) {
      this._run(`ALTER TABLE world_cache ADD COLUMN favorited INTEGER DEFAULT 0`);
    }
    // 迁移：旧库 world_kb 缺 sleep_ok 列（recommend_join 睡觉图评分用，幂等）
    const nwCols = this._query(`PRAGMA table_info(world_kb)`);
    if (!nwCols.some(c => c.name === 'sleep_ok')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN sleep_ok INTEGER DEFAULT 0`);
    }
    // 迁移：旧库 join_choices 缺 world_tags 列（类型偏好学习用，幂等）
    const jcCols = this._query(`PRAGMA table_info(join_choices)`);
    if (!jcCols.some(c => c.name === 'world_tags')) {
      this._run(`ALTER TABLE join_choices ADD COLUMN world_tags TEXT DEFAULT ''`);
    }
    // 迁移：旧库 world_kb 缺 tags/description 列（scan_new_worlds upsert 依赖，幂等）
    const nwCols2 = this._query(`PRAGMA table_info(world_kb)`);
    if (!nwCols2.some(c => c.name === 'tags')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN tags TEXT DEFAULT ''`);
    }
    if (!nwCols2.some(c => c.name === 'description')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN description TEXT DEFAULT ''`);
    }
    // 迁移：旧库 world_kb 缺 user_rating 列（rate_world 用户反馈，幂等）
    const nwCols3 = this._query(`PRAGMA table_info(world_kb)`);
    if (!nwCols3.some(c => c.name === 'user_rating')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN user_rating INTEGER DEFAULT 0`);
    }
    // 迁移：旧库 world_kb 缺 author_id 列（作者维度推荐用，幂等）
    const nwCols4 = this._query(`PRAGMA table_info(world_kb)`);
    if (!nwCols4.some(c => c.name === 'author_id')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN author_id TEXT DEFAULT ''`);
    }
    // 迁移：旧库 world_kb 缺 backlog 系列列（待逛地图列表，幂等）
    const nwCols5 = this._query(`PRAGMA table_info(world_kb)`);
    if (!nwCols5.some(c => c.name === 'backlog')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN backlog INTEGER DEFAULT 0`);
    }
    if (!nwCols5.some(c => c.name === 'backlog_added_at')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN backlog_added_at TEXT`);
    }
    if (!nwCols5.some(c => c.name === 'backlog_reason')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN backlog_reason TEXT DEFAULT ''`);
    }
    if (!nwCols5.some(c => c.name === 'backlog_priority')) {
      this._run(`ALTER TABLE world_kb ADD COLUMN backlog_priority INTEGER DEFAULT 0`);
    }
    // 迁移：world_kb.source 是死列（issue #78）——从未被写入/读取，仅靠误导性注释自我解释，
    // 与 events.source 同名易混淆，且 DDL 声称的「scan_new_worlds upsert 依赖」实际不存在。
    // 幂等删除：PRAGMA 判列存在再 DROP（SQLite ≥3.35 支持；better-sqlite3 已满足）。
    const nwCols6 = this._query(`PRAGMA table_info(world_kb)`);
    if (nwCols6.some(c => c.name === 'source')) {
      this._run(`ALTER TABLE world_kb DROP COLUMN source`);
    }
    // 迁移：历史 tags='' 脏数据统一为 '[]'（json_each 对空串抛 malformed JSON，Review R2）
    this._run(`UPDATE world_kb SET tags = '[]' WHERE tags IS NULL OR tags = ''`);
    // 迁移：旧库 friends 缺 bio/user_icon/pronouns 列（friend-profile 变更追踪用，幂等）
    const friendCols = this._query(`PRAGMA table_info(friends)`);
    if (!friendCols.some(c => c.name === 'bio')) {
      this._run(`ALTER TABLE friends ADD COLUMN bio TEXT`);
    }
    if (!friendCols.some(c => c.name === 'user_icon')) {
      this._run(`ALTER TABLE friends ADD COLUMN user_icon TEXT`);
    }
    if (!friendCols.some(c => c.name === 'pronouns')) {
      this._run(`ALTER TABLE friends ADD COLUMN pronouns TEXT`);
    }
    return this;
  }

  // better-sqlite3 每次写操作即时落盘（WAL），无需手动保存。
  // 保留为 no-op 兼容旧调用方（save()/close()）。
  _save() {}

  // better-sqlite3 绑定键不带 $ 前缀（SQL 里 $x 对应对象键 x）
  _normParams(params = {}) {
    const out = {};
    for (const [k, v] of Object.entries(params)) {
      out[k.startsWith('$') ? k.slice(1) : k] = v;
    }
    return out;
  }

  _query(sql, params = {}) {
    if (Object.keys(params).length > 0) {
      return this.db.prepare(sql).all(this._normParams(params));
    }
    return this.db.prepare(sql).all();
  }

  _run(sql, params = {}) {
    if (Object.keys(params).length > 0) {
      this.db.prepare(sql).run(this._normParams(params));
    } else {
      this.db.prepare(sql).run();
    }
  }

  // 公开薄封装（消除外部对 this.db / _query / _run 的直接耦合）
  query(sql, params = {}) {
    if (Object.keys(params).length > 0) {
      return this.db.prepare(sql).all(this._normParams(params));
    }
    return this.db.prepare(sql).all();
  }

  run(sql, params = {}) {
    if (params !== undefined && Object.keys(params).length > 0) {
      return this.db.prepare(sql).run(this._normParams(params));
    }
    return this.db.prepare(sql).run();
  }

  get(sql, params = {}) {
    return this.db.prepare(sql).get(this._normParams(params));
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  transaction(fn) {
    return this.db.transaction(fn);
  }

  backup(dir) {
    return backupDatabase(this.db, dir);
  }

  // ── 事件流 ──

  insertEvent({ type, userId, displayName, contentJson, worldId, worldName, createdAt, source = 'websocket' }) {
    this._run(
      `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
       VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`,
      { $type: type, $userId: userId, $displayName: displayName || '', $contentJson: JSON.stringify(contentJson), $worldId: worldId || '', $worldName: worldName || '', $createdAt: createdAt, $source: source }
    );
  }

  insertEventsBatch(events) {
    const stmt = this.db.prepare(
      `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
       VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`
    );
    for (const e of events) {
      stmt.run(this._normParams({
        $type: e.type, $userId: e.userId, $displayName: e.displayName || '',
        $contentJson: JSON.stringify(e.contentJson || {}),
        $worldId: e.worldId || '', $worldName: e.worldName || '',
        $createdAt: e.createdAt, $source: e.source || 'migrate',
      }));
    }
  }

  getEventsByUser(userId, { limit = 50, offset = 0, type } = {}) {
    let sql = `SELECT * FROM events WHERE user_id = $userId`;
    const params = { $userId: userId };
    if (type) { sql += ` AND type = $type`; params.$type = type; }
    sql += ` ORDER BY created_at DESC LIMIT $limit OFFSET $offset`;
    params.$limit = limit;
    params.$offset = offset;
    return this._query(sql, params);
  }

  /**
   * 批量取多个用户各自最新一条 friend-location 事件（get_online_friends 停留时长用）。
   * 返回 Map<userId, {createdAt, content}>；某用户无事件则不在 Map 中。
   * 窗口函数 PARTITION BY user_id 一次查询拿全，避免 N 次点查。
   */
  getLatestFriendLocations(userIds) {
    if (!userIds || userIds.length === 0) return new Map();
    const ph = userIds.map((_, i) => `$u${i}`).join(',');
    const params = {};
    userIds.forEach((id, i) => { params[`$u${i}`] = id; });
    const rows = this._query(
      `SELECT user_id, created_at, content_json FROM (
         SELECT user_id, created_at, content_json,
                ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
         FROM events
         WHERE type = 'friend-location' AND user_id IN (${ph})
       ) WHERE rn = 1`,
      params
    );
    const map = new Map();
    for (const r of rows) map.set(r.user_id, { createdAt: r.created_at, content: r.content_json });
    return map;
  }

  /**
   * 批量取每个用户本次在线会话的起点（get_online_friends 在线时长用，2026-08-16 新增）。
   * 口径：会话起点 = 最近一次 friend-offline 之后最早的一条 friend-online。
   * 为何不能直接取最新 friend-online：VRChat WS 重连/状态同步会重复推送 friend-online
   * （实测 24h 527 条 vs ~30 人在线），最新一条会严重低估时长；MIN(>last_off) 天然跳过重复推送。
   * 仅当用户从未有过 offline 记录时才取最早一条 friend-online（数据库记录以来首次上线）；
   * 有 offline 但 offline 后无 online（事件丢失/数据不一致）→ 返回 NULL，调用方安全降级
   * （避免把离线前时间当会话起点导致 onlineMinutes 高估，PR #36 审核 W1）。
   * 返回 Map<userId, sessionStartIso|null>；无 friend-online 事件则不在 Map 中。
   */
  getOnlineSessionStarts(userIds) {
    if (!userIds || userIds.length === 0) return new Map();
    const ph = userIds.map((_, i) => `$u${i}`).join(',');
    const params = {};
    userIds.forEach((id, i) => { params[`$u${i}`] = id; });
    const rows = this._query(
      `WITH offs AS (
         SELECT user_id, MAX(created_at) AS last_off FROM events
         WHERE type='friend-offline' AND user_id IN (${ph}) GROUP BY user_id
       )
       SELECT e.user_id,
              CASE WHEN o.last_off IS NULL THEN MIN(e.created_at)
                   ELSE MIN(CASE WHEN e.created_at > o.last_off THEN e.created_at END) END
              AS session_start
       FROM events e
       LEFT JOIN offs o ON e.user_id = o.user_id
       WHERE e.type = 'friend-online' AND e.user_id IN (${ph})
       GROUP BY e.user_id`,
      params
    );
    const map = new Map();
    for (const r of rows) map.set(r.user_id, r.session_start || null);
    return map;
  }

  getRecentEvents({ limit = 50, type } = {}) {
    let sql = `SELECT * FROM events`;
    const params = {};
    if (type) { sql += ` WHERE type = $type`; params.$type = type; }
    sql += ` ORDER BY created_at DESC LIMIT $limit`;
    params.$limit = limit;
    return this._query(sql, params);
  }

  getEventsByTimeRange(start, end, { limit = 1000 } = {}) {
    return this._query(
      `SELECT * FROM events WHERE created_at >= $start AND created_at <= $end ORDER BY created_at DESC LIMIT $limit`,
      { $start: start, $end: end, $limit: limit }
    );
  }

  countEventsByUserInRange(userId, start, end) {
    return this._query(
      `SELECT type, COUNT(*) as count FROM events WHERE user_id = $userId AND created_at >= $start AND created_at <= $end GROUP BY type`,
      { $userId: userId, $start: start, $end: end }
    );
  }

  // ── 好友状态 ──

  upsertFriend(friend) {
    const userId = friend.userId;
    // 只更新显式传入的字段：partial upsert（如 friend-location/friend-active 事件只带少数字段）
    // 不得覆盖未传的 profile 字段。历史 bug（PR #56 审查实测复现）：location 事件穿插会
    // 把 bio/status/avatar_image_url 等用 '' 覆盖，导致资料变更追踪基线被清空、main 上
    // status/avatar 数据同源丢失。故按 key 存在性动态构建 SET 子句。
    const columns = {
      display_name: 'displayName',
      memo: 'memo',
      trust_level: 'trustLevel',
      is_online: 'isOnline',
      location: 'location',
      world_id: 'worldId',
      world_name: 'worldName',
      platform: 'platform',
      status: 'status',
      status_description: 'statusDescription',
      avatar_image_url: 'avatarImageUrl',
      bio: 'bio',
      user_icon: 'userIcon',
      pronouns: 'pronouns',
      last_seen: 'lastSeen',
      last_online: 'lastOnline',
      last_offline: 'lastOffline',
    };
    const norm = {
      displayName: v => v || '',
      memo: v => v ?? null,
      trustLevel: v => v ?? null,
      isOnline: v => v ? 1 : 0,
      location: v => v || '',
      worldId: v => v || '',
      worldName: v => v || '',
      platform: v => v || '',
      status: v => v || '',
      statusDescription: v => v || '',
      avatarImageUrl: v => v || '',
      bio: v => v || '',
      userIcon: v => v || '',
      pronouns: v => v || '',
      lastSeen: v => v || '',
      lastOnline: v => v || '',
      lastOffline: v => v || '',
    };

    const setCols = [];
    const params = { $userId: userId };
    for (const [col, key] of Object.entries(columns)) {
      if (friend[key] === undefined) continue;  // 未传 → 不更新该列
      params[`$${col}`] = norm[key](friend[key]);
      setCols.push(`${col}=COALESCE($${col}, ${col})`);
    }
    if (setCols.length === 0) return;

    const insCols = ['user_id', ...Object.keys(columns).filter(c => friend[columns[c]] !== undefined)];
    const insPh = insCols.map(c => c === 'user_id' ? '$userId' : `$${c}`);

    this._run(
      `INSERT INTO friends (${insCols.join(', ')})
       VALUES (${insPh.join(', ')})
       ON CONFLICT(user_id) DO UPDATE SET
        ${setCols.join(', ')}${setCols.length ? ',' : ''}
        updated_at=datetime('now')`,
      params
    );
  }

  getAllFriends() {
    return this._query(`SELECT * FROM friends ORDER BY display_name`);
  }

  getOnlineFriends() {
    return this._query(`SELECT * FROM friends WHERE is_online = 1 ORDER BY display_name`);
  }

  getFriend(userId) {
    const rows = this._query(`SELECT * FROM friends WHERE user_id = $userId`, { $userId: userId });
    return rows[0] || null;
  }

  // 好友资料变更历史（friend-profile 变更追踪，2026-08-19 新增）
  // 查询 events 表中 content_json.type 为 avatar/status/bio/user_icon/pronouns 的记录。
  // 与 VRCX 迁移脚本（feed_avatar/feed_status/feed_bio）写入格式一致：顶层 type='friend-update'，
  // 实际变更类型在 content_json.type 里。types 参数逗号分隔过滤（默认全部）。
  getFriendProfileChanges(userId, { limit = 50, offset = 0, types } = {}) {
    const validTypes = ['avatar', 'status', 'bio', 'user_icon', 'pronouns'];
    let typesArr = validTypes;
    if (types) {
      typesArr = String(types).split(',').map(t => t.trim()).filter(t => validTypes.includes(t));
      if (typesArr.length === 0) typesArr = validTypes;
    }
    const params = { $limit: limit, $offset: offset };
    const placeholders = typesArr.map((t, i) => { params[`$t${i}`] = t; return `$t${i}`; }).join(',');
    let sql = `SELECT * FROM events WHERE type = 'friend-update'
               AND json_extract(content_json, '$.type') IN (${placeholders})`;
    if (userId) { sql += ` AND user_id = $userId`; params.$userId = userId; }
    sql += ` ORDER BY created_at DESC LIMIT $limit OFFSET $offset`;
    return this._query(sql, params);
  }

  getFriendProfileChangeCount(userId, { types } = {}) {
    const validTypes = ['avatar', 'status', 'bio', 'user_icon', 'pronouns'];
    let typesArr = validTypes;
    if (types) {
      typesArr = String(types).split(',').map(t => t.trim()).filter(t => validTypes.includes(t));
      if (typesArr.length === 0) typesArr = validTypes;
    }
    const params = {};
    const placeholders = typesArr.map((t, i) => { params[`$t${i}`] = t; return `$t${i}`; }).join(',');
    let sql = `SELECT COUNT(*) n FROM events WHERE type = 'friend-update'
               AND json_extract(content_json, '$.type') IN (${placeholders})`;
    if (userId) { sql += ` AND user_id = $userId`; params.$userId = userId; }
    return this._query(sql, params)[0].n;
  }

  searchFriends(query) {
    return this._query(
      `SELECT * FROM friends WHERE display_name LIKE $q OR memo LIKE $q ORDER BY display_name LIMIT 50`,
      { $q: `%${query}%` }
    );
  }

  // ── 世界缓存 ──

  getWorldName(worldId) {
    const rows = this._query(`SELECT * FROM world_cache WHERE world_id = $worldId`, { $worldId: worldId });
    return rows[0] || null;
  }

  // ── 世界中文简介翻译（个人数据，本地表）──

  getZhTranslations(worldIds) {
    if (!worldIds || worldIds.length === 0) return new Map();
    const params = {};
    const ph = worldIds.map((id, i) => { params[`$w${i}`] = id; return `$w${i}`; }).join(',');
    const rows = this._query(`SELECT world_id, zh FROM world_zh_translations WHERE world_id IN (${ph})`, params);
    const map = new Map();
    for (const r of rows) map.set(r.world_id, r.zh);
    return map;
  }

  setZhTranslation(worldId, zh) {
    this._run(
      `INSERT INTO world_zh_translations (world_id, zh, updated_at) VALUES ($worldId, $zh, datetime('now'))
       ON CONFLICT(world_id) DO UPDATE SET zh = $zh, updated_at = datetime('now')`,
      { $worldId: worldId, $zh: zh }
    );
  }

  searchWorldsByName(keyword) {
    const like = `%${keyword}%`;
    const rows = this._query(
      `SELECT world_id, name FROM world_cache WHERE name LIKE $like ORDER BY name LIMIT 20`,
      { $like: like }
    );
    const eventRows = this._query(
      `SELECT world_id, world_name AS name FROM events WHERE world_name LIKE $like AND world_id != '' GROUP BY world_id, world_name ORDER BY world_name LIMIT 20`,
      { $like: like }
    );
    const seen = new Set();
    const merged = [];
    for (const r of [...rows, ...eventRows]) {
      if (!r.world_id || seen.has(r.world_id)) continue;
      seen.add(r.world_id);
      merged.push({ worldId: r.world_id, name: r.name || '' });
    }
    return merged;
  }

  _recordWorldChanges(world) {
    const old = this.getWorldName(world.worldId);
    if (!old) return;
    // 数据库列名 → upsertWorld 传入对象的驼峰字段名映射（避免取到 undefined）
    const fieldMap = {
      name: 'name',
      description: 'description',
      author_name: 'authorName',
      image_url: 'imageUrl',
      release_status: 'releaseStatus',
      capacity: 'capacity',
      tags: 'tags',
    };
    const fields = ['name', 'description', 'author_name', 'image_url', 'release_status', 'capacity', 'tags'];
    const newTags = JSON.stringify(world.tags || []);
    for (const f of fields) {
      const oldValue = f === 'tags' ? String(old.tags ?? '') : String(old[f] ?? '');
      const newValue = f === 'tags' ? newTags : String(world[fieldMap[f]] ?? '');
      if (oldValue !== newValue) {
        this._run(
          `INSERT INTO world_history (world_id, field, old_value, new_value)
           VALUES ($worldId, $field, $oldValue, $newValue)`,
          { $worldId: world.worldId, $field: f, $oldValue: oldValue, $newValue: newValue }
        );
      }
    }
  }

  upsertWorld(world) {
    this._recordWorldChanges(world);
    this._run(
      `INSERT INTO world_cache
       (world_id, name, author_id, author_name, description, image_url,
        release_status, capacity, favorites, tags, updated_at)
       VALUES ($worldId, $name, $authorId, $authorName, $description, $imageUrl,
        $releaseStatus, $capacity, $favorites, $tags, datetime('now'))
       ON CONFLICT(world_id) DO UPDATE SET
        name = excluded.name,
        author_id = excluded.author_id,
        author_name = excluded.author_name,
        description = excluded.description,
        image_url = excluded.image_url,
        release_status = excluded.release_status,
        capacity = excluded.capacity,
        favorites = excluded.favorites,
        tags = excluded.tags,
        updated_at = datetime('now')`,
      {
        $worldId: world.worldId, $name: world.name || '',
        $authorId: world.authorId || '', $authorName: world.authorName || '',
        $description: world.description || '', $imageUrl: world.imageUrl || '',
        $releaseStatus: world.releaseStatus || '',
        $capacity: world.capacity || 0, $favorites: world.favorites || 0,
        $tags: JSON.stringify(world.tags || []),
      }
    );
  }

  upsertWorldsBatch(worlds) {
    for (const w of worlds) {
      this._recordWorldChanges(w);
    }
    const stmt = this.db.prepare(
      `INSERT INTO world_cache
       (world_id, name, author_id, author_name, description, image_url,
        release_status, capacity, favorites, tags, updated_at)
       VALUES ($worldId, $name, $authorId, $authorName, $description, $imageUrl,
        $releaseStatus, $capacity, $favorites, $tags, datetime('now'))
       ON CONFLICT(world_id) DO UPDATE SET
        name = excluded.name,
        author_id = excluded.author_id,
        author_name = excluded.author_name,
        description = excluded.description,
        image_url = excluded.image_url,
        release_status = excluded.release_status,
        capacity = excluded.capacity,
        favorites = excluded.favorites,
        tags = excluded.tags,
        updated_at = datetime('now')`
    );
    for (const w of worlds) {
      stmt.run(this._normParams({
        $worldId: w.worldId, $name: w.name || '',
        $authorId: w.authorId || '', $authorName: w.authorName || '',
        $description: w.description || '', $imageUrl: w.imageUrl || '',
        $releaseStatus: w.releaseStatus || '',
        $capacity: w.capacity || 0, $favorites: w.favorites || 0,
        $tags: JSON.stringify(w.tags || []),
      }));
    }
  }

  // ── 群组缓存 ──

  getGroupCached(groupId) {
    const rows = this._query(`SELECT * FROM group_cache WHERE group_id = $g`, { $g: groupId });
    return rows[0] || null;
  }

  upsertGroupCache({ groupId, name, description, memberCount }) {
    this._run(
      `INSERT INTO group_cache (group_id, name, description, member_count, updated_at)
       VALUES ($g, $name, $desc, $mc, datetime('now'))
       ON CONFLICT(group_id) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         member_count = excluded.member_count, updated_at = datetime('now')`,
      { $g: groupId, $name: name || '', $desc: description || '', $mc: memberCount || 0 }
    );
  }

  // ── PlanetVRC TTL 缓存 ──

  /** 读缓存：不存在或超 ttlMs 返回 null，否则 JSON.parse(payload) */
  getPlanetCache(key, ttlMs) {
    const rows = this._query(`SELECT payload, fetched_at FROM planet_cache WHERE key = $key`, { $key: key });
    if (rows.length === 0) return null;
    const row = rows[0];
    if (ttlMs && row.fetched_at) {
      const fetchedMs = Date.parse(row.fetched_at);
      if (Number.isFinite(fetchedMs) && Date.now() - fetchedMs > ttlMs) return null;
    }
    try { return JSON.parse(row.payload); } catch { return null; }
  }

  /** 写缓存：payload 传对象，内部 JSON.stringify，fetched_at 存 ISO 时间戳 */
  setPlanetCache(key, payload) {
    this._run(
      `INSERT INTO planet_cache (key, payload, fetched_at)
       VALUES ($key, $payload, $fetchedAt)
       ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      { $key: key, $payload: JSON.stringify(payload), $fetchedAt: new Date().toISOString() }
    );
  }

  setWorldNote({ worldId, note = '' }) {
    this._run(
      `INSERT INTO world_cache (world_id, name, note)
       VALUES ($worldId, '', $note)
       ON CONFLICT(world_id) DO UPDATE SET note = $note, updated_at = datetime('now')`,
      { $worldId: worldId, $note: note }
    );
    const rows = this._query(`SELECT world_id, note FROM world_cache WHERE world_id = $worldId`, { $worldId: worldId });
    const r = rows[0];
    return { worldId: r.world_id, note: r.note };
  }

  /** BOOTH 商品快照 upsert（Issue #28：落库旁路缓存，失败不影响实时返回——调用方 try-catch） */
  upsertBoothItem(item) {
    this._run(
      `INSERT INTO booth_items (id, name, price, wishlist_count, shop_name, description, tags, image_url, url, published_at, is_sold_out, updated_at)
       VALUES ($id, $name, $price, $wishlist, $shop, $desc, $tags, $img, $url, $published, $soldOut, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, price = excluded.price, wishlist_count = excluded.wishlist_count,
         shop_name = excluded.shop_name, description = excluded.description, tags = excluded.tags,
         image_url = excluded.image_url, url = excluded.url, published_at = excluded.published_at,
         is_sold_out = excluded.is_sold_out, updated_at = datetime('now')`,
      {
        $id: String(item.id),
        $name: item.name || '',
        $price: item.price || '',
        $wishlist: item.wishlistCount ?? 0,
        $shop: (item.shop && item.shop.name) || '',
        $desc: (item.description || '').slice(0, 2000),
        $tags: JSON.stringify(item.tags || []),
        $img: (item.images && item.images[0] && item.images[0].original) || '',
        $url: item.url || '',
        $published: item.publishedAt || '',
        $soldOut: item.isSoldOut ? 1 : 0,
      }
    );
  }

  /** BOOTH 商品快照读取（无缓存返回 null） */
  getBoothItemCache(id) {
    const rows = this._query(
      `SELECT id, name, price, wishlist_count AS wishlistCount, shop_name AS shopName,
              description, tags, image_url AS imageUrl, url, published_at AS publishedAt,
              is_sold_out AS isSoldOut, updated_at AS updatedAt
       FROM booth_items WHERE id = $id`,
      { $id: String(id) }
    );
    const r = rows[0];
    if (!r) return null;
    try { r.tags = JSON.parse(r.tags || '[]'); } catch { r.tags = []; }
    return r;
  }

  /** 按收藏数排序的商品快照列表（趋势跟踪用） */
  listBoothItems({ sortBy = 'wishlist', limit = 20, minWishlist = 0 } = {}) {
    const order = sortBy === 'wishlist' ? 'wishlist_count DESC' : 'updated_at DESC';
    const rows = this._query(
      `SELECT id, name, price, wishlist_count AS wishlistCount, shop_name AS shopName,
              image_url AS imageUrl, url, is_sold_out AS isSoldOut, updated_at AS updatedAt
       FROM booth_items WHERE wishlist_count >= $minWishlist
       ORDER BY ${order} LIMIT $limit`,
      { $minWishlist: minWishlist, $limit: Math.max(1, Math.min(100, limit)) }
    );
    return rows;
  }

  /** 记录一次 BOOTH 搜索（结果 id 列表入历史表） */
  recordBoothSearch(query, resultIds) {
    this._run(
      `INSERT INTO booth_search_history (query, result_ids, result_count, created_at)
       VALUES ($query, $ids, $count, datetime('now'))`,
      { $query: query, $ids: JSON.stringify(resultIds || []), $count: (resultIds || []).length }
    );
  }

  /** 最近搜索历史（含每次结果的商品快照信息） */
  getBoothSearches({ limit = 10 } = {}) {
    const rows = this._query(
      `SELECT id, query, result_ids AS resultIds, result_count AS resultCount, created_at AS createdAt
       FROM booth_search_history ORDER BY id DESC LIMIT $limit`,
      { $limit: Math.max(1, Math.min(50, limit)) }
    );
    for (const r of rows) {
      try { r.resultIds = JSON.parse(r.resultIds || '[]'); } catch { r.resultIds = []; }
    }
    return rows;
  }

  /** 云端收藏标记：favorite_world 成功后写本地 world_cache（Issue #25），世界不存在时插入兜底行 */
  setWorldFavorited({ worldId, favorited = 1 }) {
    this._run(
      `INSERT INTO world_cache (world_id, name, favorited)
       VALUES ($worldId, '', $favorited)
       ON CONFLICT(world_id) DO UPDATE SET favorited = $favorited, updated_at = datetime('now')`,
      { $worldId: worldId, $favorited: favorited ? 1 : 0 }
    );
    const rows = this._query(`SELECT world_id, name, favorited FROM world_cache WHERE world_id = $worldId`, { $worldId: worldId });
    const row = rows[0];
    return { worldId: row.world_id, name: row.name || '', favorited: row.favorited === 1 };
  }

  /**
   * 用户反馈：给世界打好评/差评标记（Issue #19）
   * rating: -1=烂图(junk) / 0=清除标记 / 1=好图
   * 若世界不在 world_kb 表（如手动收藏的世界），自动插入一行兜底。
   */
  rateWorld({ worldId, rating = 0 }) {
    const r = parseInt(rating, 10);
    const finalRating = r === -1 ? -1 : (r === 1 ? 1 : 0);
    this._run(
      `INSERT INTO world_kb (world_id, world_name, tags, user_rating)
       VALUES ($worldId, '', '[]', $rating)
       ON CONFLICT(world_id) DO UPDATE SET user_rating = $rating`,
      { $worldId: worldId, $rating: finalRating }
    );
    const rows = this._query(`SELECT world_id, world_name, user_rating FROM world_kb WHERE world_id = $worldId`, { $worldId: worldId });
    const row = rows[0];
    return { worldId: row.world_id, worldName: row.world_name || '', userRating: row.user_rating };
  }

  /** 显式确认逛过某个世界（Issue #19 痛点 3：事件驱动 visited 不可靠） */
  markWorldVisited({ worldId }) {
    const now = new Date().toISOString();
    // ON CONFLICT 同时清 backlog=0：逛过即从待逛列表移除（与 event-pipeline 事件回写、scan
    // 回填三处口径一致），避免"已逛但仍标待逛"的矛盾残留。
    this._run(
      `INSERT INTO world_kb (world_id, world_name, tags, visited, visited_at)
       VALUES ($worldId, '', '[]', 1, $now)
       ON CONFLICT(world_id) DO UPDATE SET visited = 1, visited_at = $now, backlog = 0`,
      { $worldId: worldId, $now: now }
    );
    const rows = this._query(`SELECT world_id, world_name, visited, visited_at, backlog FROM world_kb WHERE world_id = $worldId`, { $worldId: worldId });
    const row = rows[0];
    return { worldId: row.world_id, worldName: row.world_name || '', visited: row.visited === 1, visitedAt: row.visited_at, backlog: row.backlog === 1 };
  }

  /**
   * 手动标记某世界是否为适合睡觉的地图（recommend_join / recommend_worlds 用 sleep_ok 强信号）。
   * isSleep: true=标为睡觉图 / false=取消标记。世界不在表里插兜底行（复用 rateWorld 模式）。
   */
  setWorldSleep({ worldId, isSleep = true }) {
    const flag = isSleep ? 1 : 0;
    this._run(
      `INSERT INTO world_kb (world_id, world_name, tags, sleep_ok)
       VALUES ($worldId, '', '[]', $flag)
       ON CONFLICT(world_id) DO UPDATE SET sleep_ok = $flag`,
      { $worldId: worldId, $flag: flag }
    );
    const rows = this._query(`SELECT world_id, world_name, sleep_ok FROM world_kb WHERE world_id = $worldId`, { $worldId: worldId });
    const row = rows[0];
    return { worldId: row.world_id, worldName: row.world_name || '', isSleep: row.sleep_ok === 1 };
  }

  /** 待逛列表：加入/更新（幂等，重复加入 = 更新备注/优先级；世界不在表里插兜底行） */
  addToBacklog({ worldId, reason = '', priority = 0 }) {
    const now = new Date().toISOString();
    const p = Math.min(Math.max(parseInt(priority, 10) || 0, 0), 2);
    this._run(
      `INSERT INTO world_kb (world_id, world_name, tags, backlog, backlog_added_at, backlog_reason, backlog_priority)
       VALUES ($worldId, '', '[]', 1, $now, $reason, $priority)
       ON CONFLICT(world_id) DO UPDATE SET
         backlog = 1,
         backlog_reason = CASE WHEN $reason != '' THEN $reason ELSE backlog_reason END,
         backlog_priority = $priority,
         backlog_added_at = COALESCE(backlog_added_at, $now)`,
      { $worldId: worldId, $now: now, $reason: reason, $priority: p }
    );
    const rows = this._query(
      `SELECT world_id, world_name, backlog, backlog_added_at, backlog_reason, backlog_priority, visited, visited_at
       FROM world_kb WHERE world_id = $worldId`,
      { $worldId: worldId }
    );
    const row = rows[0];
    return {
      worldId: row.world_id, worldName: row.world_name || '',
      inBacklog: row.backlog === 1, addedAt: row.backlog_added_at,
      reason: row.backlog_reason || '', priority: row.backlog_priority,
      visited: row.visited === 1, visitedAt: row.visited_at,
    };
  }

  /** 待逛列表：移除（backlog=0；保留行，世界知识不删） */
  removeFromBacklog({ worldId }) {
    this._run(`UPDATE world_kb SET backlog = 0 WHERE world_id = $worldId`, { $worldId: worldId });
    const rows = this._query(`SELECT world_id, backlog FROM world_kb WHERE world_id = $worldId`, { $worldId: worldId });
    return { worldId, removed: rows.length === 0 || rows[0].backlog === 0 };
  }

  /**
   * 读取 world_kb 某行的信息字段（world_name / author_name / author_id / created_at）。
   * 用于 #77 的 created_at 预检：已填则 ensureWorldKbInfo 早退省一次 API。
   * @returns {{worldId, worldName, authorName, authorId, createdAt}}
   */
  getWorldKbInfo(worldId) {
    const rows = this._query(
      `SELECT world_id, world_name, author_name, author_id, created_at FROM world_kb WHERE world_id = $worldId`,
      { $worldId: worldId }
    );
    const row = rows[0];
    if (!row) return { worldId, worldName: '', authorName: '', authorId: '', createdAt: '' };
    return {
      worldId: row.world_id, worldName: row.world_name || '',
      authorName: row.author_name || '', authorId: row.author_id || '',
      createdAt: row.created_at || '',
    };
  }

  /**
   * 幂等回填 world_kb 的信息字段（#76：兜底插入只写标记位，信息字段恒空）。
   * 仅当对应列当前为空/NULL 时才回填，已存在的值不回写（幂等）。
   * ⚠️ 注意：本方法是 UPDATE 非 INSERT，隐含「world_kb 行已存在」前提——生产路径由
   * rateWorld / markWorldVisited / addToBacklog / set_world_sleep 先兜底插入保证成立，
   * 若独立复用于不存在的行会静默 0 行且后续查询回 undefined，调用方需先确保行存在。
   * @param {object} p {worldId, name?, authorName?, authorId?, createdAt?}
   * @returns {{worldId, worldName, authorName, authorId, createdAt}}
   */
  backfillWorldKbInfo({ worldId, name, authorName, authorId, createdAt }) {
    const sets = [];
    const params = { $worldId: worldId };
    // 仅在「该列值为空」时回填，避免覆盖扫描/其他来源已写入的真实值
    if (name !== undefined && name !== '') { sets.push(`world_name = CASE WHEN COALESCE(world_name,'') = '' THEN $name ELSE world_name END`); params.$name = name; }
    if (authorName !== undefined && authorName !== '') { sets.push(`author_name = CASE WHEN COALESCE(author_name,'') = '' THEN $authorName ELSE author_name END`); params.$authorName = authorName; }
    if (authorId !== undefined && authorId !== '') { sets.push(`author_id = CASE WHEN COALESCE(author_id,'') = '' THEN $authorId ELSE author_id END`); params.$authorId = authorId; }
    if (createdAt !== undefined && createdAt !== '') { sets.push(`created_at = CASE WHEN COALESCE(created_at,'') = '' THEN $createdAt ELSE created_at END`); params.$createdAt = createdAt; }
    if (sets.length > 0) {
      this._run(`UPDATE world_kb SET ${sets.join(', ')} WHERE world_id = $worldId`, params);
    }
    const rows = this._query(
      `SELECT world_id, world_name, author_name, author_id, created_at FROM world_kb WHERE world_id = $worldId`,
      { $worldId: worldId }
    );
    const row = rows[0];
    return {
      worldId: row.world_id, worldName: row.world_name || '',
      authorName: row.author_name || '', authorId: row.author_id || '',
      createdAt: row.created_at || '',
    };
  }

  /** 待逛列表：查询（pending = backlog=1 AND visited=0；visited=1 的逛完历史也可见） */
  getBacklog({ status = 'pending', sortBy = 'added_at', limit = 20 } = {}) {
    const st = ['pending', 'visited', 'all'].includes(status) ? status : 'pending';
    const sortCol = ['added_at', 'priority', 'favorites'].includes(sortBy) ? sortBy : 'added_at';
    limit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    let where = 'WHERE backlog = 1';
    if (st === 'pending') where += ' AND visited = 0';
    else if (st === 'visited') where += ' AND visited = 1';
    const order = sortCol === 'priority'
      ? 'backlog_priority DESC, backlog_added_at DESC'
      : `${sortCol === 'added_at' ? 'backlog_added_at' : sortCol} DESC`;
    const total = this._query(`SELECT COUNT(*) AS cnt FROM world_kb ${where}`)[0].cnt;
    const rows = this._query(
      `SELECT world_id, world_name, author_name, favorites, occupants, popularity, description, tags,
              created_at, visited, visited_at, backlog_added_at, backlog_reason, backlog_priority
       FROM world_kb ${where} ORDER BY ${order} LIMIT ${limit}`
    );
    const worlds = rows.map(r => {
      let worldTags = [];
      try { worldTags = JSON.parse(r.tags || '[]'); } catch { /* 脏数据按空数组 */ }
      return {
        worldId: r.world_id,
        worldName: r.world_name || '',
        authorName: r.author_name || '',
        favorites: r.favorites || 0,
        occupants: r.occupants || 0,
        popularity: r.popularity || 0,
        description: r.description || '',
        tags: Array.isArray(worldTags) ? worldTags : [],
        created: r.created_at || '',
        visited: r.visited === 1,
        visitedAt: r.visited_at || '',
        addedAt: r.backlog_added_at || '',
        reason: r.backlog_reason || '',
        priority: r.backlog_priority || 0,
      };
    });
    return { total, status: st, worlds };
  }

  getWorldHistory(worldId, limit = 50) {
    const rows = this._query(
      `SELECT field, old_value, new_value, changed_at FROM world_history WHERE world_id = $worldId ORDER BY id DESC LIMIT $limit`,
      { $worldId: worldId, $limit: limit }
    );
    return rows.map(r => ({ field: r.field, oldValue: r.old_value, newValue: r.new_value, changedAt: r.changed_at }));
  }

  // ── 关注名单 ──

  addToWatchlist(userId, displayName, priority = 0) {
    this._run(
      `INSERT OR REPLACE INTO watchlist (user_id, display_name, priority)
       VALUES ($userId, $displayName, $priority)`,
      { $userId: userId, $displayName: displayName || '', $priority: priority }
    );
  }

  removeFromWatchlist(userId) {
    this._run(`DELETE FROM watchlist WHERE user_id = $userId`, { $userId: userId });
  }

  getWatchlist() {
    return this._query(`SELECT * FROM watchlist ORDER BY priority DESC, display_name`);
  }

  // ── 配置 ──

  getConfig(key, defaultValue = null) {
    const rows = this._query(`SELECT value FROM config WHERE key = $key`, { $key: key });
    return rows.length > 0 ? rows[0].value : defaultValue;
  }

  setConfig(key, value) {
    this._run(`INSERT OR REPLACE INTO config (key, value) VALUES ($key, $value)`, { $key: key, $value: String(value) });
  }

  // ── 昵称映射 ──

  getNicknames({ userId, query } = {}) {
    if (userId) {
      const rows = this._query(
        `SELECT user_id, display_name, nickname, updated_at FROM nicknames WHERE user_id = $userId`,
        { $userId: userId }
      );
      return rows.map(r => ({ userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at }));
    }

    if (query) {
      const q = `%${query}%`;
      const rows = this._query(
        `SELECT user_id, display_name, nickname, updated_at FROM nicknames
         WHERE display_name LIKE $q OR nickname LIKE $q
         ORDER BY display_name`,
        { $q: q }
      );
      return rows.map(r => ({ userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at }));
    }

    const rows = this._query(`SELECT user_id, display_name, nickname, updated_at FROM nicknames ORDER BY display_name`);
    return rows.map(r => ({ userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at }));
  }

  setNickname({ userId, nickname, displayName = '' } = {}) {
    this._run(
      `INSERT INTO nicknames (user_id, display_name, nickname, updated_at)
       VALUES ($userId, $displayName, $nickname, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = CASE WHEN excluded.display_name = '' THEN nicknames.display_name ELSE excluded.display_name END,
         nickname = excluded.nickname,
         updated_at = datetime('now')`,
      { $userId: userId, $displayName: displayName || '', $nickname: nickname }
    );
    const rows = this._query(
      `SELECT user_id, display_name, nickname, updated_at FROM nicknames WHERE user_id = $userId`,
      { $userId: userId }
    );
    const r = rows[0];
    return { userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at };
  }

  // ── 工具方法 ──

  // ── 社交分析转发（核心实现在 core/analytics/social.js）──

  findCompanions(...args) { return this.social.findCompanions(...args); }
  findFriendPairScreen(...args) { return this.social.findFriendPairScreen(...args); }
  findFriendPairMeetings(...args) { return this.social.findFriendPairMeetings(...args); }
  getOnlinePattern(...args) { return this.social.getOnlinePattern(...args); }
  getOwnWorldSessions(...args) { return this.social.getOwnWorldSessions(...args); }
  getWeeklyCompanions(...args) { return this.social.getWeeklyCompanions(...args); }
  getFriendGroupStats(...args) { return this.social.getFriendGroupStats(...args); }

  /**
   * 群组热度聚合: 统计窗口内好友/自己在群组房的活动事件
   * (type=friend-location|user-location 且 location 含 ~group(gmem_/grp_xxx)).
   * 返回 Map<groupId, {count, users:Set, worlds:Set, hourly:Map<'dow:hour', count>}>
   * 时间按北京时区分桶 (dow: 0=周日..6=周六).
   */
  getGroupHeat(startIso, endIso) {
    const rows = this._query(
      `SELECT type, content_json, created_at FROM events
       WHERE (type='friend-location' OR type='user-location')
         AND created_at >= $start AND created_at <= $end
         AND (content_json LIKE '%~group(grp_%' OR content_json LIKE '%~group(gmem_%')
       ORDER BY created_at ASC`,
      { $start: startIso, $end: endIso }
    );
    const groups = new Map();
    for (const row of rows) {
      try {
        const c = JSON.parse(row.content_json);
        const loc = c.location || '';
        const m = loc.match(/~group\((grp_[a-f0-9-]+|gmem_[a-f0-9-]+)\)/);
        if (!m || !loc.startsWith('wrld_')) continue;
        const gid = m[1];
        if (!groups.has(gid)) groups.set(gid, { count: 0, users: new Set(), worlds: new Set(), hourly: new Map() });
        const s = groups.get(gid);
        s.count++;
        s.users.add(c.userId || '');
        s.worlds.add(loc.split(':')[0]);
        const d = new Date(row.created_at);
        if (!Number.isNaN(d.getTime())) {
          const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
          const key = `${bj.getUTCDay()}:${bj.getUTCHours()}`;
          s.hourly.set(key, (s.hourly.get(key) || 0) + 1);
        }
      } catch {}
    }
    return groups;
  }

  getStats() {
    const result = {};
    for (const table of ['events', 'friends', 'world_cache', 'watchlist']) {
      const rows = this._query(`SELECT COUNT(*) as count FROM ${table}`);
      result[table] = rows[0]?.count || 0;
    }
    result.eventTypes = this._query(`SELECT type, COUNT(*) as count FROM events GROUP BY type ORDER BY count DESC`);
    return result;
  }

  save() { this._save(); }
  close() { this._save(); this.db.close(); }

  // ── X 博主世界推荐（x_world_digest） ──

  getXWorld(worldId) {
    const rows = this._query(
      `SELECT * FROM x_world_recommendations WHERE world_id = $worldId`,
      { $worldId: worldId }
    );
    return rows.length > 0 ? rows[0] : null;
  }

  insertXWorld({ worldId, worldName, authorName, description, imageUrl, favorites, visits, popularity, capacity, tags, firstSeenAt, lastRecommendedAt, creators, tweetCount }) {
    this._run(
      `INSERT INTO x_world_recommendations
        (world_id, world_name, author_name, description, image_url, favorites, visits, popularity, capacity, tags,
         first_seen_at, last_recommended_at, creators, tweet_count)
       VALUES ($worldId, $worldName, $authorName, $description, $imageUrl, $favorites, $visits, $popularity, $capacity, $tags,
         $firstSeenAt, $lastRecommendedAt, $creators, $tweetCount)
       ON CONFLICT(world_id) DO UPDATE SET
         world_name = $worldName, author_name = $authorName, description = $description, image_url = $imageUrl,
         favorites = $favorites, visits = $visits, popularity = $popularity, capacity = $capacity, tags = $tags,
         last_recommended_at = $lastRecommendedAt, tweet_count = $tweetCount`,
      {
        $worldId: worldId, $worldName: worldName || '', $authorName: authorName || '',
        $description: description || '', $imageUrl: imageUrl || '',
        $favorites: favorites || 0, $visits: visits || 0, $popularity: popularity || 0,
        $capacity: capacity || 0, $tags: tags || '[]',
        $firstSeenAt: firstSeenAt || new Date().toISOString(),
        $lastRecommendedAt: lastRecommendedAt || new Date().toISOString(),
        $creators: creators || '[]', $tweetCount: tweetCount || 1,
      }
    );
  }

  updateXWorld(worldId, { worldName, authorName, description, imageUrl, favorites, visits, popularity, capacity, tags, lastRecommendedAt, creators, tweetCount }) {
    this._run(
      `UPDATE x_world_recommendations SET
         world_name = $worldName, author_name = $authorName, description = $description, image_url = $imageUrl,
         favorites = $favorites, visits = $visits, popularity = $popularity, capacity = $capacity, tags = $tags,
         last_recommended_at = $lastRecommendedAt, creators = $creators, tweet_count = $tweetCount
       WHERE world_id = $worldId`,
      {
        $worldId: worldId, $worldName: worldName || '', $authorName: authorName || '',
        $description: description || '', $imageUrl: imageUrl || '',
        $favorites: favorites || 0, $visits: visits || 0, $popularity: popularity || 0,
        $capacity: capacity || 0, $tags: tags || '[]',
        $lastRecommendedAt: lastRecommendedAt || new Date().toISOString(),
        $creators: creators || '[]', $tweetCount: tweetCount || 1,
      }
    );
  }

  getXWorldsSince(sinceIso, { creator, limit = 100 } = {}) {
    let sql = `SELECT * FROM x_world_recommendations WHERE last_recommended_at >= $since`;
    const params = { $since: sinceIso };
    if (creator) {
      sql += ` AND creators LIKE $creator`;
      params.$creator = `%${creator}%`;
    }
    sql += ` ORDER BY last_recommended_at DESC LIMIT $limit`;
    params.$limit = limit;
    return this._query(sql, params);
  }

  getAllXWorlds(limit = 200) {
    return this._query(`SELECT * FROM x_world_recommendations ORDER BY favorites DESC LIMIT $limit`, { $limit: limit });
  }

  clearXWorlds() {
    this._run(`DELETE FROM x_world_recommendations`);
  }
}
