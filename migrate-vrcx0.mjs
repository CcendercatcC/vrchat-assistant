/**
 * VRChat 好友监控系统 — 数据迁移脚本
 * 
 * 从 VRCX-0 SQLite 数据库导入历史数据到新系统
 * 
 * VRCX-0 数据库路径: C:/Users/MECHREVO/AppData/Roaming/VRCX-0/VRCX-0.sqlite3
 * 新系统数据库路径: ./vrc-monitor.sqlite3
 * 
 * 使用: node migrate-vrcx0.mjs
 */
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 路径配置
const VRCX0_DB = 'C:/Users/MECHREVO/AppData/Roaming/VRCX-0/VRCX-0.sqlite3';
const MONITOR_DB = path.join(__dirname, 'vrc-monitor.sqlite3');
const DDL_PATH = path.join(__dirname, 'core', 'init-db.sql');

// 用户表前缀（从 VRCX-0 数据库分析得出）
const USER_PREFIX = 'usraa57de30516b404795b630601a6c91a2';

// 统计
const stats = {
  feed_gps: 0,
  feed_online_offline: 0,
  feed_avatar: 0,
  feed_status: 0,
  feed_bio: 0,
  memos: 0,
  friend_log_current: 0,
  friend_log_history: 0,
  cache_world: 0,
  cache_avatar: 0,
  notifications: 0,
  skipped_gps_no_world: 0,
};

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── 世界名提取工具 ──
function worldIdFromLocation(location) {
  if (!location || location === 'offline' || location === 'private' || location === 'traveling') return '';
  const idx = location.indexOf(':');
  return idx > 0 ? location.slice(0, idx) : '';
}

// ── 主函数 ──
async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('  VRCX-0 数据迁移工具');
  console.log('══════════════════════════════════════════════\n');

  // 1. 打开数据库
  log('📂 打开数据库...');
  if (!existsSync(VRCX0_DB)) {
    log(`❌ VRCX-0 数据库不存在: ${VRCX0_DB}`);
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const vrcx0 = new SQL.Database(readFileSync(VRCX0_DB));

  // 初始化新数据库（如果已存在则加载）
  let monitorDb;
  if (existsSync(MONITOR_DB)) {
    monitorDb = new SQL.Database(readFileSync(MONITOR_DB));
    log(`   ✅ 加载已有新数据库`);
  } else {
    monitorDb = new SQL.Database();
    log(`   ✅ 创建新数据库`);
  }
  const ddl = readFileSync(DDL_PATH, 'utf-8');
  monitorDb.run(ddl);
  log(`   ✅ 初始化表结构完成`);

  // ═══════════════════════════════════════════
  // 2. cache_world → world_cache
  // ═══════════════════════════════════════════
  log('\n📦 迁移世界缓存...');
  let count = 0;
  try {
    const rows = vrcx0.exec(`SELECT * FROM cache_world`);
    if (rows.length > 0) {
      const worlds = rows[0].values.map(v => ({
        worldId: v[0],
        name: v[7] || '',                    // 第8列才是 name
        authorId: v[2] || '',
        authorName: v[3] || '',
        description: v[5] || '',
        imageUrl: v[6] || '',
        releaseStatus: v[8] || '',
        capacity: 0,
        favorites: 0,
        tags: [],
      }));
      
      const stmt = monitorDb.prepare(
        `INSERT OR REPLACE INTO world_cache
         (world_id, name, author_id, author_name, description, image_url,
          release_status, capacity, favorites, tags, updated_at)
         VALUES ($worldId, $name, $authorId, $authorName, $description, $imageUrl,
          $releaseStatus, $capacity, $favorites, $tags, datetime('now'))`
      );
      for (const w of worlds) {
        stmt.bind({
          $worldId: w.worldId,
          $name: w.name,
          $authorId: w.authorId,
          $authorName: w.authorName,
          $description: w.description,
          $imageUrl: w.imageUrl,
          $releaseStatus: w.releaseStatus,
          $capacity: w.capacity || 0,
          $favorites: w.favorites || 0,
          $tags: '[]',
        });
        stmt.step();
        stmt.reset();
        count++;
      }
      stmt.free();
      stats.cache_world = count;
    }
  } catch (err) {
    log(`   ⚠️ cache_world: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 个世界缓存`);

  // ═══════════════════════════════════════════
  // 3. memos → friends.memo
  // ═══════════════════════════════════════════
  log('\n📝 迁移好友备注...');
  count = 0;
  try {
    const rows = vrcx0.exec(`SELECT * FROM memos`);
    if (rows.length > 0) {
      let batchCount = 0;
      for (const row of rows[0].values) {
        const userId = row[0];
        const editedAt = row[1] || '';
        const memoText = row[2] || '';
        
        // 从备注文本提取昵称（格式："昵称：风风" 或直接文本）
        let displayName = '';
        let nickName = memoText;
        const nickMatch = memoText.match(/^昵称[：:]\s*(.+)/);
        if (nickMatch) {
          displayName = '';
          nickName = nickMatch[1].trim();
        }

        // 如果好友还不存在则插入，否则更新 memo
        const existing = monitorDb.exec(
          `SELECT user_id FROM friends WHERE user_id = '${userId.replace(/'/g, "''")}'`
        );
        if (existing.length > 0 && existing[0].values.length > 0) {
          monitorDb.run(
            `UPDATE friends SET memo = $memo, updated_at = datetime('now')
             WHERE user_id = $userId`,
            { $memo: nickName, $userId: userId }
          );
        } else {
          monitorDb.run(
            `INSERT INTO friends (user_id, display_name, memo, created_at, updated_at)
             VALUES ($userId, $displayName, $memo, datetime('now'), datetime('now'))`,
            { $userId: userId, $displayName: displayName || userId, $memo: nickName }
          );
        }
        count++;
        batchCount++;
        if (batchCount % 10 === 0) {
          const data = monitorDb.export();
          writeFileSync(MONITOR_DB, Buffer.from(data));
        }
      }
      stats.memos = count;
      const data = monitorDb.export();
      writeFileSync(MONITOR_DB, Buffer.from(data));
    }
  } catch (err) {
    log(`   ⚠️ memos: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条备注`);

  // ═══════════════════════════════════════════
  // 4. friend_log_current → friends（信任等级等）
  // ═══════════════════════════════════════════
  log('\n👥 迁移好友列表...');
  count = 0;
  try {
    const rows = vrcx0.exec(`SELECT * FROM ${USER_PREFIX}_friend_log_current`);
    if (rows.length > 0) {
      for (const row of rows[0].values) {
        const userId = row[0];
        const displayName = row[1] || '';
        const trustLevel = row[2] || '';
        const friendNumber = row[3] || 0;

        // 如果已存在（来自 memos 迁移），更新 display_name 和 trust_level
        const existing = monitorDb.exec(
          `SELECT user_id FROM friends WHERE user_id = '${userId.replace(/'/g, "''")}'`
        );
        if (existing.length > 0 && existing[0].values.length > 0) {
          monitorDb.run(
            `UPDATE friends SET display_name = $displayName, trust_level = $trustLevel,
             updated_at = datetime('now') WHERE user_id = $userId`,
            { $displayName: displayName, $trustLevel: trustLevel, $userId: userId }
          );
        } else {
          monitorDb.run(
            `INSERT INTO friends (user_id, display_name, trust_level, created_at, updated_at)
             VALUES ($userId, $displayName, $trustLevel, datetime('now'), datetime('now'))`,
            { $userId: userId, $displayName: displayName || userId, $trustLevel: trustLevel }
          );
        }
        count++;
      }
      stats.friend_log_current = count;
      const data = monitorDb.export();
      writeFileSync(MONITOR_DB, Buffer.from(data));
    }
  } catch (err) {
    log(`   ⚠️ friend_log_current: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 个好友信息`);

  // ═══════════════════════════════════════════
  // 5. feed_gps → events（好友位置变更）
  // ═══════════════════════════════════════════
  log('\n📍 迁移位置变更历史 (feed_gps)...');
  count = 0;
  const BATCH_SIZE = 10000;
  let batch = [];
  let skipped = 0;

  try {
    const rows = vrcx0.exec(
      `SELECT id, created_at, user_id, display_name, location, world_name, previous_location, time, group_name
       FROM ${USER_PREFIX}_feed_gps ORDER BY created_at ASC`
    );
    if (rows.length > 0) {
      for (const row of rows[0].values) {
        const location = row[4] || '';
        const worldName = row[5] || '';
        const worldId = worldIdFromLocation(location);

        batch.push({
          type: 'friend-location',
          userId: row[2] || '',
          displayName: row[3] || '',
          contentJson: {
            userId: row[2] || '',
            displayName: row[3] || '',
            location,
            worldName,
            previousLocation: row[6] || '',
            time: row[7] || 0,
          },
          worldId,
          worldName,
          createdAt: row[1] || '',
        });
        count++;

        if (batch.length >= BATCH_SIZE) {
          insertBatch(monitorDb, batch);
          log(`   → ${count} 条...`);
          batch = [];
          const data = monitorDb.export();
          writeFileSync(MONITOR_DB, Buffer.from(data));
        }
      }
      // 最后一批
      if (batch.length > 0) {
        insertBatch(monitorDb, batch);
      }
      stats.feed_gps = count;
      const data = monitorDb.export();
      writeFileSync(MONITOR_DB, Buffer.from(data));
    }
  } catch (err) {
    log(`   ⚠️ feed_gps: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条位置变更`);

  // ═══════════════════════════════════════════
  // 6. feed_online_offline → events
  // ═══════════════════════════════════════════
  log('\n🔄 迁移上下线记录 (feed_online_offline)...');
  count = 0;
  batch = [];
  try {
    const rows = vrcx0.exec(
      `SELECT id, created_at, user_id, display_name, type, location, world_name, time, group_name
       FROM ${USER_PREFIX}_feed_online_offline ORDER BY created_at ASC`
    );
    if (rows.length > 0) {
      for (const row of rows[0].values) {
        const eventType = row[4] === 'Online' ? 'friend-online' : 'friend-offline';
        const location = row[5] || '';
        const worldName = row[6] || '';
        const worldId = worldIdFromLocation(location);

        batch.push({
          type: eventType,
          userId: row[2] || '',
          displayName: row[3] || '',
          contentJson: {
            userId: row[2] || '',
            displayName: row[3] || '',
            type: row[4],
            location,
            worldName,
            time: row[7] || 0,
          },
          worldId,
          worldName,
          createdAt: row[1] || '',
        });
        count++;

        if (batch.length >= BATCH_SIZE) {
          insertBatch(monitorDb, batch);
          log(`   → ${count} 条...`);
          batch = [];
          const data = monitorDb.export();
          writeFileSync(MONITOR_DB, Buffer.from(data));
        }
      }
      if (batch.length > 0) insertBatch(monitorDb, batch);
      stats.feed_online_offline = count;
      const data = monitorDb.export();
      writeFileSync(MONITOR_DB, Buffer.from(data));
    }
  } catch (err) {
    log(`   ⚠️ feed_online_offline: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条上下线记录`);

  // ═══════════════════════════════════════════
  // 7. feed_avatar → events
  // ═══════════════════════════════════════════
  log('\n🎭 迁移 Avatar 变更记录 (feed_avatar)...');
  count = 0;
  batch = [];
  try {
    const rows = vrcx0.exec(
      `SELECT id, created_at, user_id, display_name, owner_id, avatar_name,
              current_avatar_image_url, current_avatar_thumbnail_image_url,
              previous_current_avatar_image_url, previous_current_avatar_thumbnail_image_url
       FROM ${USER_PREFIX}_feed_avatar ORDER BY created_at ASC`
    );
    if (rows.length > 0) {
      for (const row of rows[0].values) {
        batch.push({
          type: 'friend-update',
          userId: row[2] || '',
          displayName: row[3] || '',
          contentJson: {
            userId: row[2] || '',
            displayName: row[3] || '',
            type: 'avatar',
            avatarName: row[5] || '',
            avatarImageUrl: row[6] || '',
            avatarThumbnailUrl: row[7] || '',
            previousAvatarImageUrl: row[8] || '',
            previousAvatarThumbnailUrl: row[9] || '',
          },
          worldId: '',
          worldName: '',
          createdAt: row[1] || '',
        });
        count++;

        if (batch.length >= BATCH_SIZE) {
          insertBatch(monitorDb, batch);
          log(`   → ${count} 条...`);
          batch = [];
          const data = monitorDb.export();
          writeFileSync(MONITOR_DB, Buffer.from(data));
        }
      }
      if (batch.length > 0) insertBatch(monitorDb, batch);
      stats.feed_avatar = count;
      const data = monitorDb.export();
      writeFileSync(MONITOR_DB, Buffer.from(data));
    }
  } catch (err) {
    log(`   ⚠️ feed_avatar: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条 Avatar 变更`);

  // ═══════════════════════════════════════════
  // 8. feed_status → events
  // ═══════════════════════════════════════════
  log('\n📊 迁移状态变更记录 (feed_status)...');
  count = 0;
  batch = [];
  try {
    const rows = vrcx0.exec(
      `SELECT id, created_at, user_id, display_name, status, status_description,
              previous_status, previous_status_description
       FROM ${USER_PREFIX}_feed_status ORDER BY created_at ASC`
    );
    if (rows.length > 0) {
      for (const row of rows[0].values) {
        batch.push({
          type: 'friend-update',
          userId: row[2] || '',
          displayName: row[3] || '',
          contentJson: {
            userId: row[2] || '',
            displayName: row[3] || '',
            type: 'status',
            status: row[4] || '',
            statusDescription: row[5] || '',
            previousStatus: row[6] || '',
            previousStatusDescription: row[7] || '',
          },
          worldId: '',
          worldName: '',
          createdAt: row[1] || '',
        });
        count++;

        if (batch.length >= BATCH_SIZE) {
          insertBatch(monitorDb, batch);
          log(`   → ${count} 条...`);
          batch = [];
          const data = monitorDb.export();
          writeFileSync(MONITOR_DB, Buffer.from(data));
        }
      }
      if (batch.length > 0) insertBatch(monitorDb, batch);
      stats.feed_status = count;
      const data = monitorDb.export();
      writeFileSync(MONITOR_DB, Buffer.from(data));
    }
  } catch (err) {
    log(`   ⚠️ feed_status: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条状态变更`);

  // ═══════════════════════════════════════════
  // 9. feed_bio → events
  // ═══════════════════════════════════════════
  log('\n📝 迁移 Bio 变更记录 (feed_bio)...');
  count = 0;
  batch = [];
  try {
    const rows = vrcx0.exec(
      `SELECT id, created_at, user_id, display_name, bio, previous_bio
       FROM ${USER_PREFIX}_feed_bio ORDER BY created_at ASC`
    );
    if (rows.length > 0) {
      for (const row of rows[0].values) {
        batch.push({
          type: 'friend-update',
          userId: row[2] || '',
          displayName: row[3] || '',
          contentJson: {
            userId: row[2] || '',
            displayName: row[3] || '',
            type: 'bio',
            bio: row[4] || '',
            previousBio: row[5] || '',
          },
          worldId: '',
          worldName: '',
          createdAt: row[1] || '',
        });
        count++;

        if (batch.length >= BATCH_SIZE) {
          insertBatch(monitorDb, batch);
          log(`   → ${count} 条...`);
          batch = [];
          const data = monitorDb.export();
          writeFileSync(MONITOR_DB, Buffer.from(data));
        }
      }
      if (batch.length > 0) insertBatch(monitorDb, batch);
      stats.feed_bio = count;
      const data = monitorDb.export();
      writeFileSync(MONITOR_DB, Buffer.from(data));
    }
  } catch (err) {
    log(`   ⚠️ feed_bio: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条 Bio 变更`);

  // ═══════════════════════════════════════════
  // 10. 关闭数据库并输出报告
  // ═══════════════════════════════════════════
  vrcx0.close();
  const finalData = monitorDb.export();
  writeFileSync(MONITOR_DB, Buffer.from(finalData));
  monitorDb.close();

  // 验证
  log('\n══════════════════════════════════════════════');
  log('  迁移完成！验证结果：');
  log('══════════════════════════════════════════════\n');

  // 用 sql.js 重新打开数据库来统计
  const verifyDb = new SQL.Database(readFileSync(MONITOR_DB));
  for (const table of ['events', 'friends', 'world_cache']) {
    const r = verifyDb.exec(`SELECT COUNT(*) as c FROM ${table}`);
    const c = r[0]?.values[0]?.[0] || 0;
    log(`  ${table.padEnd(20)} : ${c.toLocaleString()} 行`);
  }

  log('\n  各类事件分布:');
  const types = verifyDb.exec(
    `SELECT type, COUNT(*) as count FROM events GROUP BY type ORDER BY count DESC`
  );
  if (types.length > 0) {
    for (const row of types[0].values) {
      log(`  ${String(row[0]).padEnd(25)} : ${Number(row[1]).toLocaleString()}`);
    }
  }

  verifyDb.close();

  log('\n  备注迁移:');
  log(`  memos（好友昵称）            : ${stats.memos} 条`);
  log(`  cache_world（世界缓存）       : ${stats.cache_world} 个`);

  log('\n✅ 数据迁移完成！');
  log(`   新数据库: ${MONITOR_DB}`);
  log(`   重启服务后即可使用: node start-monitor.js`);
}

function insertBatch(db, events) {
  if (events.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
     VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`
  );
  for (const e of events) {
    stmt.bind({
      $type: e.type,
      $userId: e.userId,
      $displayName: e.displayName || '',
      $contentJson: JSON.stringify(e.contentJson),
      $worldId: e.worldId || '',
      $worldName: e.worldName || '',
      $createdAt: e.createdAt,
      $source: 'migrate',
    });
    stmt.step();
    stmt.reset();
  }
  stmt.free();
}

main().catch(err => {
  console.error('\n❌ 迁移脚本异常:', err);
  process.exit(1);
});
