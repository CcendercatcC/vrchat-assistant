/**
 * VRChat 好友监控系统 — SQLite 存储层
 * 
 * 封装 sql.js 的所有数据库操作
 */
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DDL_PATH = path.join(__dirname, 'init-db.sql');

export class Storage {
  /** @type {import('sql.js').Database} */
  db = null;
  dbPath = '';

  async init(dbPath) {
    this.dbPath = dbPath;
    const SQL = await initSqlJs();

    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    const ddl = readFileSync(DDL_PATH, 'utf-8');
    this.db.run(ddl);
    this._save();
    return this;
  }

  _save() {
    if (this.dbPath) {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    }
  }

  _query(sql, params = {}) {
    const stmt = this.db.prepare(sql);
    if (Object.keys(params).length > 0) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  _run(sql, params = {}) {
    this.db.run(sql, params);
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
      stmt.bind({
        $type: e.type, $userId: e.userId, $displayName: e.displayName || '',
        $contentJson: JSON.stringify(e.contentJson || {}),
        $worldId: e.worldId || '', $worldName: e.worldName || '',
        $createdAt: e.createdAt, $source: e.source || 'migrate',
      });
      stmt.step();
      stmt.reset();
    }
    stmt.free();
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
    const params = {
      $userId: friend.userId,
      $displayName: friend.displayName || '',
      $memo: friend.memo ?? null,
      $trustLevel: friend.trustLevel ?? null,
      $isOnline: friend.isOnline ? 1 : 0,
      $location: friend.location || '',
      $worldId: friend.worldId || '',
      $worldName: friend.worldName || '',
      $platform: friend.platform || '',
      $status: friend.status || '',
      $statusDescription: friend.statusDescription || '',
      $avatarImageUrl: friend.avatarImageUrl || '',
      $lastSeen: friend.lastSeen || '',
      $lastOnline: friend.lastOnline || '',
      $lastOffline: friend.lastOffline || '',
    };

    this._run(
      `INSERT INTO friends (user_id, display_name, memo, trust_level, is_online, location,
        world_id, world_name, platform, status, status_description, avatar_image_url,
        last_seen, last_online, last_offline)
       VALUES ($userId, $displayName, $memo, $trustLevel, $isOnline, $location,
        $worldId, $worldName, $platform, $status, $statusDescription, $avatarImageUrl,
        $lastSeen, $lastOnline, $lastOffline)
       ON CONFLICT(user_id) DO UPDATE SET
        display_name=COALESCE($displayName, display_name),
        memo=COALESCE($memo, memo),
        trust_level=COALESCE($trustLevel, trust_level),
        is_online=COALESCE($isOnline, is_online),
        location=COALESCE($location, location),
        world_id=COALESCE($worldId, world_id),
        world_name=COALESCE($worldName, world_name),
        platform=COALESCE($platform, platform),
        status=COALESCE($status, status),
        status_description=COALESCE($statusDescription, status_description),
        avatar_image_url=COALESCE($avatarImageUrl, avatar_image_url),
        last_seen=COALESCE($lastSeen, last_seen),
        last_online=COALESCE($lastOnline, last_online),
        last_offline=COALESCE($lastOffline, last_offline),
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

  upsertWorld(world) {
    this._run(
      `INSERT OR REPLACE INTO world_cache
       (world_id, name, author_id, author_name, description, image_url,
        release_status, capacity, favorites, tags, updated_at)
       VALUES ($worldId, $name, $authorId, $authorName, $description, $imageUrl,
        $releaseStatus, $capacity, $favorites, $tags, datetime('now'))`,
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
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO world_cache
       (world_id, name, author_id, author_name, description, image_url,
        release_status, capacity, favorites, tags, updated_at)
       VALUES ($worldId, $name, $authorId, $authorName, $description, $imageUrl,
        $releaseStatus, $capacity, $favorites, $tags, datetime('now'))`
    );
    for (const w of worlds) {
      stmt.bind({
        $worldId: w.worldId, $name: w.name || '',
        $authorId: w.authorId || '', $authorName: w.authorName || '',
        $description: w.description || '', $imageUrl: w.imageUrl || '',
        $releaseStatus: w.releaseStatus || '',
        $capacity: w.capacity || 0, $favorites: w.favorites || 0,
        $tags: JSON.stringify(w.tags || []),
      });
      stmt.step();
      stmt.reset();
    }
    stmt.free();
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

  // ── 工具方法 ──

  // ── 新增：查找同屏好友 ──

  findCompanions(userId, startTime, endTime) {
    // 1. 获取用户在时间范围内的所有 location 事件
    const userEvents = this._query(
      `SELECT * FROM events WHERE user_id = $userId AND type = 'user-location'
       AND created_at >= $start AND created_at <= $end
       ORDER BY created_at ASC`,
      { $userId: userId, $start: startTime, $end: endTime }
    );

    // 2. 提取用户去过的所有 unique instanceId
    const userInstances = new Set();
    const userTimeline = [];
    for (const ev of userEvents) {
      let location = '';
      try {
        const cj = JSON.parse(ev.content_json);
        location = cj.location || '';
      } catch {}
      if (location && location !== 'offline' && location !== 'traveling') {
        const parts = location.split(':');
        const worldId = parts[0];
        const instanceId = parts.slice(1).join(':');
        if (worldId && instanceId) {
          userInstances.add(instanceId);
          userInstances.add(`${worldId}:${instanceId}`);
        }
        userTimeline.push({
          id: ev.id,
          created_at: ev.created_at,
          type: ev.type,
          world_id: worldId,
          instance_id: instanceId,
          world_name: ev.world_name || '',
          content_json: ev.content_json,
        });
      } else {
        userTimeline.push({
          id: ev.id,
          created_at: ev.created_at,
          type: ev.type,
          world_id: location || 'offline',
          instance_id: null,
          world_name: ev.world_name || '',
          content_json: ev.content_json,
        });
      }
    }

    // 3. 获取所有好友在时间范围内的 friend-location 事件
    const friendEvents = this._query(
      `SELECT * FROM events WHERE type = 'friend-location'
       AND created_at >= $start AND created_at <= $end
       ORDER BY created_at ASC`,
      { $start: startTime, $end: endTime }
    );

    // 4. 交叉匹配
    const matchedMap = new Map();
    for (const ev of friendEvents) {
      let location = '';
      try {
        const cj = JSON.parse(ev.content_json);
        location = cj.location || '';
      } catch {}
      if (!location || location === 'offline' || location === 'traveling') continue;

      const parts = location.split(':');
      const worldId = parts[0];
      const instanceId = parts.slice(1).join(':');
      const key = `${worldId}:${instanceId}`;

      if (userInstances.has(instanceId) || userInstances.has(key)) {
        if (!matchedMap.has(ev.user_id)) {
          matchedMap.set(ev.user_id, {
            displayName: ev.display_name,
            events: [],
          });
        }
        matchedMap.get(ev.user_id).events.push({
          id: ev.id,
          created_at: ev.created_at,
          type: ev.type,
          world_id: worldId,
          instance_id: instanceId,
          world_name: ev.world_name || '',
        });
      }
    }

    // 5. 整理输出
    const companions = [];
    for (const [uid, info] of matchedMap) {
      const times = info.events.map(e => e.created_at).sort();
      const worlds = new Set(info.events.map(e => e.world_name || e.world_id));
      companions.push({
        userId: uid,
        displayName: info.displayName,
        firstSeen: times[0],
        lastSeen: times[times.length - 1],
        matchCount: info.events.length,
        worlds: [...worlds].filter(Boolean),
      });
    }

    companions.sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1));

    return {
      userId,
      timeRange: { start: startTime, end: endTime },
      userInstanceCount: userInstances.size,
      userTimeline,
      companionCount: companions.length,
      companions,
    };
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
}
