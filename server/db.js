// SQLite 持久化层（node:sqlite，零依赖）
// 会员、战绩、对局记录；服务重启不丢数据
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.GD_DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'guandan.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    coins INTEGER NOT NULL DEFAULT 1000,
    level_title TEXT NOT NULL DEFAULT '新手',
    matches INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    rounds INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS match_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    winner_team INTEGER,
    rounds INTEGER,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    member_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const stmts = {
  insertMember: db.prepare('INSERT INTO members (name, password_hash, coins, created_at) VALUES (?, ?, ?, ?)'),
  findByName: db.prepare('SELECT * FROM members WHERE name = ?'),
  findById: db.prepare('SELECT * FROM members WHERE id = ?'),
  setCoins: db.prepare('UPDATE members SET coins = ? WHERE id = ?'),
  bumpStats: db.prepare('UPDATE members SET matches = ?, wins = ?, rounds = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT OR REPLACE INTO sessions (token, member_id, created_at) VALUES (?, ?, ?)'),
  findSession: db.prepare('SELECT member_id FROM sessions WHERE token = ?'),
  insertMatchLog: db.prepare('INSERT INTO match_log (created_at, winner_team, rounds, detail) VALUES (?, ?, ?, ?)'),
};

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export const store = {
  register(name, password) {
    if (!name || name.length < 1 || name.length > 16) return { ok: false, error: '昵称需1-16字' };
    if (stmts.findByName.get(name)) return { ok: false, error: '昵称已被占用' };
    const info = stmts.insertMember.run(name, sha256(password), 1000, Date.now());
    return { ok: true, member: this.memberById(Number(info.lastInsertRowid)) };
  },

  login(name, password) {
    const row = stmts.findByName.get(name);
    if (!row || row.password_hash !== sha256(password)) return { ok: false, error: '账号或密码错误' };
    return { ok: true, member: this.memberById(row.id) };
  },

  memberById(id) {
    const row = stmts.findById.get(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      coins: row.coins,
      levelTitle: row.level_title,
      stats: { matches: row.matches, wins: row.wins, rounds: row.rounds },
    };
  },

  setCoins(id, coins) { stmts.setCoins.run(coins, id); },

  bumpStats(id, stats) { stmts.bumpStats.run(stats.matches, stats.wins, stats.rounds, id); },

  issueToken(memberId) {
    const token = crypto.randomBytes(24).toString('hex');
    stmts.insertSession.run(token, memberId, Date.now());
    return token;
  },

  authByToken(token) {
    const row = stmts.findSession.get(token);
    if (!row) return null;
    return this.memberById(row.member_id);
  },

  logMatch(winnerTeam, rounds, detail) {
    stmts.insertMatchLog.run(Date.now(), winnerTeam, rounds, JSON.stringify(detail));
  },
};

// —— 内存缓存（运行时用，落库时同步写）——
export const memberCache = new Map(); // id -> live profile {id,name,coins,levelTitle,stats}

export function loadMember(id) {
  if (memberCache.has(id)) return memberCache.get(id);
  const m = store.memberById(id);
  if (m) memberCache.set(id, m);
  return m;
}

export function settleCoins(winnerIds, loserIds, amount) {
  if (amount < 0) return { ok: false, error: '非法金额' };
  const losers = loserIds.map(loadMember).filter(Boolean);
  const winners = winnerIds.map(loadMember).filter(Boolean);
  for (const m of losers) if (m.coins < amount) return { ok: false, error: `${m.name} 游戏币不足` };
  for (const m of losers) { m.coins -= amount; store.setCoins(m.id, m.coins); }
  for (const m of winners) { m.coins += amount; store.setCoins(m.id, m.coins); }
  return { ok: true };
}

export function publicProfile(m) {
  return { id: m.id, name: m.name, coins: m.coins, level: m.levelTitle, stats: m.stats };
}
