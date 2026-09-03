// 会员与钱包（内存版，后续替换为持久化）
import crypto from 'node:crypto';

const SECRET = process.env.GD_SECRET || 'guandan-tuo2-dev-secret';

export const members = new Map();   // memberId -> profile
export const sessions = new Map();  // token -> memberId

let seq = 1;

export function register(name, password) {
  const id = 'm' + (seq++);
  const member = {
    id,
    name,
    passwordHash: sha256(password),
    createdAt: Date.now(),
    coins: 1000,        // 游戏币（1级 = 1币 × 房主设定倍数，默认1）
    level: '新手',
    stats: { matches: 0, wins: 0, rounds: 0 },
  };
  members.set(id, member);
  return member;
}

export function login(name, password) {
  for (const m of members.values()) {
    if (m.name === name && m.passwordHash === sha256(password)) return m;
  }
  return null;
}

export function issueToken(memberId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, memberId);
  return token;
}

export function auth(token) {
  const id = sessions.get(token);
  return id ? members.get(id) : null;
}

// 结算转账：输家各扣 amount，赢家各加 amount；返回 {ok, error}
export function settleCoins(winners, losers, amount) {
  if (amount < 0) return { ok: false, error: 'negative amount' };
  for (const m of losers) if (m.coins < amount) return { ok: false, error: `${m.name} 游戏币不足` };
  for (const m of losers) m.coins -= amount;
  for (const m of winners) m.coins += amount;
  return { ok: true };
}

export function publicProfile(m) {
  return { id: m.id, name: m.name, coins: m.coins, level: m.level, stats: m.stats };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
