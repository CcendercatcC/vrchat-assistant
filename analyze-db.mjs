/**
 * VRCX-0 数据库结构分析 v2
 */
import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';

const DB_PATH = 'C:/Users/MECHREVO/AppData/Roaming/VRCX-0/VRCX-0.sqlite3';

function query(db, sql) {
  const result = db.exec(sql);
  if (result.length === 0) return { columns: [], values: [] };
  return result[0];
}

async function main() {
  const SQL = await initSqlJs();
  const buffer = readFileSync(DB_PATH);
  const db = new SQL.Database(buffer);

  const tables = query(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const tableNames = tables.values.map(v => v[0]);

  console.log('══════════════════════════════════════════════');
  console.log('  VRCX-0 数据库结构分析');
  console.log(`  路径: ${DB_PATH}`);
  console.log(`  总表数: ${tableNames.length}`);
  console.log('══════════════════════════════════════════════\n');

  // 全局表
  console.log('━ 全局表 ｜━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  for (const name of tableNames) {
    if (name.startsWith('usr') || name.startsWith('_usr')) continue;
    printTableInfo(db, name);
  }

  // 用户数据表
  const userTables = tableNames.filter(n => n.startsWith('usr') || n.startsWith('_usr'));
  const prefixSet = new Set();
  for (const n of userTables) {
    const m = n.match(/^(.*?)_(feed|moderation|notes|notifications|friend_log|mutual_graph|activity|avatar_history)/);
    if (m) prefixSet.add(m[1]);
  }
  const prefixes = [...prefixSet].sort();

  console.log(`\n━ 用户数据表 ｜━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  用户前缀数: ${prefixes.length}\n`);

  for (const prefix of prefixes) {
    const prefixTables = tableNames.filter(n => n.startsWith(prefix + '_'));
    const countResult = query(db, `SELECT COUNT(*) FROM "${prefixTables[0]}"`);
    const hasData = countResult.values.length > 0 && countResult.values[0][0] > 0;
    console.log(`  ▸ ${prefix}  (${prefixTables.length} 张表, ${hasData ? '有数据' : '空'})`);
    if (hasData) {
      for (const name of prefixTables) {
        printTableInfo(db, name);
      }
    }
  }

  // 数据量统计
  console.log('\n━ 数据量统计 ｜━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  const allNames = tableNames;
  for (const name of allNames) {
    try {
      const count = query(db, `SELECT COUNT(*) FROM "${name}"`);
      const c = count.values[0][0];
      if (c > 0) {
        console.log(`  ${name.padEnd(50)} : ${c} 行`);
      }
    } catch {}
  }

  db.close();
}

function printTableInfo(db, name) {
  let cols, rows;
  try {
    cols = query(db, `PRAGMA table_info("${name}")`);
    rows = query(db, `SELECT * FROM "${name}" LIMIT 2`);
  } catch (e) {
    console.log(`  ┌─ ${name}`);
    console.log(`  │  (error: ${e.message})`);
    console.log('  └─');
    return;
  }

  const colDefs = cols.values.map(v => {
    const [, colName, colType, notNull, defaultVal, pk] = v;
    const flags = [];
    if (pk) flags.push('PK');
    if (notNull) flags.push('NN');
    return { colName, colType, flags, defaultVal };
  });

  console.log(`  ┌─ ${name}  (${colDefs.length} 字段)`);
  // 列
  const colLines = colDefs.map(c => {
    let s = `  │    ${c.colName}`;
    if (c.colType) s += `  ${c.colType}`;
    if (c.flags.length) s += `  [${c.flags.join(',')}]`;
    if (c.defaultVal) s += `  =${c.defaultVal}`;
    return s;
  });
  console.log(colLines.join('\n'));

  // 示例
  if (rows.values.length > 0) {
    console.log('  │  ── 示例数据 ──');
    for (const row of rows.values) {
      const pairs = rows.columns.map((col, i) => {
        let val = row[i];
        if (val === null || val === undefined) return `${col}=null`;
        val = String(val);
        if (val.length > 80) val = val.slice(0, 80) + '…';
        // 如果是JSON对象，格式化
        if (val.startsWith('{') || val.startsWith('[')) {
          try {
            val = JSON.stringify(JSON.parse(val)).slice(0, 80) + '…';
          } catch {}
        }
        return `${col}=${val}`;
      }).join(', ');
      console.log(`  │  > ${pairs}`);
    }
  } else {
    console.log('  │  (空)');
  }
  console.log('  └─');
}

main().catch(e => console.error('异常:', e));
