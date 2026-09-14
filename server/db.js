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
  -- 充值订单（幂等：out_trade_no 唯一，防重复到账）
  CREATE TABLE IF NOT EXISTS recharge_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    out_trade_no TEXT UNIQUE NOT NULL,   -- 我方订单号
    member_id INTEGER NOT NULL,
    package_id TEXT NOT NULL,
    coins INTEGER NOT NULL,
    amount_fen INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'created', -- created/paid/failed/refunded
    channel TEXT NOT NULL DEFAULT 'wechat', -- wechat / free
    txn_id TEXT,                          -- 微信侧交易号（对账用）
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  );
  -- 每日免费领取记录（合规兜底：无版号时的免费模式）
  CREATE TABLE IF NOT EXISTS daily_claims (
    member_id INTEGER NOT NULL,
    day TEXT NOT NULL,                    -- YYYY-MM-DD
    coins INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (member_id, day)
  );
`);

// —— 安全迁移：老库补列（SQLite 无 ADD COLUMN IF NOT EXISTS）——
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn('members', 'openid', 'TEXT');
ensureColumn('members', 'idcard_hash', 'TEXT');   // 实名认证：只存哈希，不存明文
ensureColumn('members', 'is_verified', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('members', 'is_minor', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('members', 'total_paid_fen', 'INTEGER NOT NULL DEFAULT 0'); // 累计充值（限额风控）
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_members_openid ON members(openid) WHERE openid IS NOT NULL');

const stmts = {
  insertMember: db.prepare('INSERT INTO members (name, password_hash, coins, created_at) VALUES (?, ?, ?, ?)'),
  insertWxMember: db.prepare('INSERT INTO members (name, password_hash, coins, created_at, openid) VALUES (?, ?, ?, ?, ?)'),
  findByName: db.prepare('SELECT * FROM members WHERE name = ?'),
  findById: db.prepare('SELECT * FROM members WHERE id = ?'),
  findByOpenid: db.prepare('SELECT * FROM members WHERE openid = ?'),
  setCoins: db.prepare('UPDATE members SET coins = ? WHERE id = ?'),
  setVerify: db.prepare('UPDATE members SET idcard_hash = ?, is_verified = ?, is_minor = ? WHERE id = ?'),
  addPaid: db.prepare('UPDATE members SET total_paid_fen = total_paid_fen + ? WHERE id = ?'),
  bumpStats: db.prepare('UPDATE members SET matches = ?, wins = ?, rounds = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT OR REPLACE INTO sessions (token, member_id, created_at) VALUES (?, ?, ?)'),
  findSession: db.prepare('SELECT member_id FROM sessions WHERE token = ?'),
  insertMatchLog: db.prepare('INSERT INTO match_log (created_at, winner_team, rounds, detail) VALUES (?, ?, ?, ?)'),
  // 充值订单
  insertOrder: db.prepare(`INSERT INTO recharge_orders
      (out_trade_no, member_id, package_id, coins, amount_fen, status, channel, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  findOrder: db.prepare('SELECT * FROM recharge_orders WHERE out_trade_no = ?'),
  markOrderPaid: db.prepare(`UPDATE recharge_orders SET status='paid', txn_id=?, paid_at=?
      WHERE out_trade_no=? AND status<>'paid'`),
  listOrders: db.prepare('SELECT * FROM recharge_orders WHERE member_id=? ORDER BY id DESC LIMIT 20'),
  // 每日领取
  claimDaily: db.prepare('INSERT OR IGNORE INTO daily_claims (member_id, day, coins, created_at) VALUES (?, ?, ?, ?)'),
  getClaim: db.prepare('SELECT * FROM daily_claims WHERE member_id=? AND day=?'),
};

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export const store = {
  register(name, password) {
    let n = String(name || '').trim().slice(0, 20); // 昵称上限20字，超长自动截断
    if (!n) return { ok: false, error: '昵称不能为空' };
    if (stmts.findByName.get(n)) return { ok: false, error: '昵称已被占用' };
    const info = stmts.insertMember.run(n, sha256(password), 1000, Date.now());
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
      openid: row.openid || null,
      isVerified: !!row.is_verified,
      isMinor: !!row.is_minor,
      totalPaidFen: row.total_paid_fen || 0,
    };
  },

  // —— 微信登录：openid 已存在则直接登录，否则自动注册 ——
  loginByOpenid(openid, nickname) {
    const row = stmts.findByOpenid.get(openid);
    if (row) return { ok: true, member: this.memberById(row.id), isNew: false };
    let name = String(nickname || ('wx' + openid.slice(-6))).trim().slice(0, 20);
    // 昵称去重
    let n = name, i = 1;
    while (stmts.findByName.get(n)) n = name.slice(0, 14) + '_' + (++i);
    const info = stmts.insertWxMember.run(n, sha256(openid), 1000, Date.now(), openid);
    return { ok: true, member: this.memberById(Number(info.lastInsertRowid)), isNew: true };
  },

  // —— 实名认证（法定强制）：只存证件哈希，不存明文；按出生年份判成年 ——
  verifyIdentity(id, name, idNumber) {
    const birthYear = parseInt(String(idNumber).slice(6, 10), 10);
    const isMinor = !birthYear || (new Date().getFullYear() - birthYear) < 18;
    stmts.setVerify.run(sha256(name + idNumber), 1, isMinor ? 1 : 0, id);
    memberCache.delete(id);
    return { ok: true, isMinor };
  },

  // —— 充值订单 ——
  createOrder(memberId, pkg, channel = 'wechat') {
    const outTradeNo = 'GD' + Date.now() + crypto.randomBytes(4).toString('hex').toUpperCase();
    stmts.insertOrder.run(outTradeNo, memberId, pkg.id, pkg.coins, pkg.amountFen, 'created', channel, Date.now());
    return outTradeNo;
  },

  // 幂等到账：仅 created→paid 的那一次真正加币，重复回调不会重复加
  payOrder(outTradeNo, txnId) {
    const order = stmts.findOrder.get(outTradeNo);
    if (!order) return { ok: false, error: '订单不存在' };
    if (order.status === 'paid') return { ok: true, already: true, member: this.memberById(order.member_id) };
    const res = stmts.markOrderPaid.run(txnId || null, Date.now(), outTradeNo);
    if (res.changes === 0) return { ok: true, already: true, member: this.memberById(order.member_id) }; // 并发保护
    const m = this.memberById(order.member_id);
    this.setCoins(order.member_id, m.coins + order.coins);
    stmts.addPaid.run(order.amount_fen, order.member_id);
    memberCache.delete(order.member_id);
    return { ok: true, already: false, member: this.memberById(order.member_id), order };
  },

  listOrders(memberId) {
    return stmts.listOrders.all(memberId).map(o => ({
      outTradeNo: o.out_trade_no, packageId: o.package_id, coins: o.coins,
      amountFen: o.amount_fen, status: o.status, channel: o.channel, createdAt: o.created_at,
    }));
  },

  // —— 每日免费领取（免费模式合规兜底）——
  claimDaily(memberId, coins, day) {
    const d = day || new Date().toISOString().slice(0, 10);
    const res = stmts.claimDaily.run(memberId, d, coins, Date.now());
    if (res.changes === 0) return { ok: false, error: '今日已领取', day: d };
    const m = this.memberById(memberId);
    this.setCoins(memberId, m.coins + coins);
    memberCache.delete(memberId);
    return { ok: true, coins, day: d, member: this.memberById(memberId) };
  },

  dailyClaimed(memberId, day) {
    const d = day || new Date().toISOString().slice(0, 10);
    return !!stmts.getClaim.get(memberId, d);
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
  return {
    id: m.id, name: m.name, coins: m.coins, level: m.levelTitle, stats: m.stats,
    isVerified: !!m.isVerified, isMinor: !!m.isMinor,
  };
}
