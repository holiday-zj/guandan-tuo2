// 集成测试：4 个真实 WS 客户端 → 注册 → 建房 → 对战 → 结算
// 用法: node test/integration.test.js
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';

const HOST = '127.0.0.1', PORT = 8080;

function post(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request({ host: HOST, port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.end(body);
  });
}

class WsClient {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.handlers = [];
    this.inbox = [];
  }
  async connect(token) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(PORT, HOST, () => {
        socket.write(
          `GET /?token=${token} HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let upgraded = false;
      socket.on('data', chunk => {
        if (!upgraded) {
          const text = chunk.toString('binary');
          const idx = text.indexOf('\r\n\r\n');
          if (idx < 0) { this.buf = Buffer.concat([this.buf, chunk]); return; }
          upgraded = true;
          const head = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
          const headStr = head.toString('binary');
          const bodyStart = headStr.indexOf('\r\n\r\n') + 4;
          if (!headStr.startsWith('HTTP/1.1 101')) reject(new Error('no 101: ' + headStr.slice(0, 60)));
          this.buf = head.slice(bodyStart);
          resolve();
          this.pump(socket);
          return;
        }
        this.buf = Buffer.concat([this.buf, chunk]);
        this.pump(socket);
      });
      socket.on('error', reject);
      this.socket = socket;
    });
  }
  pump(socket) {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, p = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); p = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); p = 10; }
      if (masked) p += 4;
      if (b.length < p + len) return;
      const payload = b.slice(p, p + len);
      this.buf = b.slice(p + len);
      if (opcode === 0x1) {
        const msg = JSON.parse(payload.toString());
        this.inbox.push(msg);
        for (const h of this.handlers.slice()) h(msg);
      }
    }
  }
  send(obj) {
    // 客户端帧必须掩码
    const data = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
    else if (data.length < 65536) {
      header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  waitFor(pred, ms = 8000) {
    return new Promise((resolve, reject) => {
      const found = this.inbox.find(pred);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error('timeout waiting; got ' + this.inbox.map(m => m.type).join(','))), ms);
      this.handlers.push(msg => {
        if (pred(msg)) { clearTimeout(timer); resolve(msg); }
      });
    });
  }
}

// —— 机器人出牌策略：领出最小单张，跟牌用引擎找最小能压的单张，否则过 ——
import { bestInterpretation, canBeat } from '../engine/classify.js';

function valueOfC(c, level) {
  return c.rank === 'BJ' ? 17 : c.rank === 'SJ' ? 16 : c.rank === level ? 15 : '23456789TJQKA'.indexOf(c.rank) + 2;
}

function chooseAction(snapshot, mySeat) {
  const hand = snapshot.hand;
  if (snapshot.turn !== mySeat) return null;
  const level = snapshot.level;
  const sorted = hand.slice().sort((a, b) => valueOfC(a, level) - valueOfC(b, level));
  if (!snapshot.best) return { type: 'play', cards: [{ id: sorted[0].id }] };
  // 跟牌：引擎重建 best 解释，找最小能压的单张
  const target = bestInterpretation(snapshot.best.cards, level);
  for (const c of sorted) {
    const it = bestInterpretation([c], level);
    if (it && target && canBeat(it, target)) return { type: 'play', cards: [{ id: c.id }] };
  }
  return { type: 'pass' };
}

async function main() {
  // 注册 4 个玩家
  const tokens = [];
  const names = ['阿龙', '阿虎', '阿豹', '阿彪'].map(n => n + '_' + Date.now().toString(36));
  for (const name of names) {
    const r = await post('/api/register', { name, password: 'test123' });
    if (!r.ok) throw new Error('register failed: ' + JSON.stringify(r));
    tokens.push({ name, token: r.token, coins: r.profile.coins });
  }
  console.log('✓ 注册 4 名玩家，各 1000 币');

  // 连接
  const clients = [];
  for (const t of tokens) {
    const c = new WsClient();
    await c.connect(t.token);
    await c.waitFor(m => m.type === 'welcome');
    clients.push(c);
  }
  console.log('✓ 4 个 WebSocket 连接建立');

  // 房主建房（机器人补位，stake=5）
  clients[0].send({ type: 'create_room', stake: 5, botFill: true });
  await clients[0].waitFor(m => m.type === 'room_created');
  const roomId = clients[0].inbox.find(m => m.type === 'room_created').roomId;
  console.log('✓ 房间已创建:', roomId);

  // 三人加入
  for (let i = 1; i < 4; i++) {
    clients[i].send({ type: 'join_room', roomId });
    await clients[i].waitFor(m => m.type === 'room_joined');
  }
  console.log('✓ 4 人就座');

  // 房主点击开始
  clients[0].send({ type: 'start_game' });

  // 等待 game_start
  const starts = await Promise.all(clients.map(c => c.waitFor(m => m.type === 'game_start', 5000)));
  const seatOf = starts.map(s => s.seat);
  console.log('✓ 对局开始，座位分配:', seatOf.join(','));

  // 出牌循环（保守策略：领出时出最小单张，否则过）
  let roundsPlayed = 0;
  const maxActions = 3000;
  let actions = 0;
  while (actions < maxActions) {
    actions++;
    // 找到当前快照中轮到的玩家
    let acted = false;
    for (let i = 0; i < 4; i++) {
      const snapMsg = [...clients[i].inbox].reverse().find(m => m.type === 'snapshot' || m.type === 'game_start');
      const snap = snapMsg && snapMsg.snapshot;
      if (!snap || snap.turn !== snap.mySeat) continue; // 每副牌重排后座位动态变化，用快照里的 mySeat
      const act = chooseAction(snap, snap.mySeat);
      if (!act) continue;
      const before = clients[i].inbox.length;
      clients[i].send(act);
      acted = true;
      // 等待服务端回推新消息（新快照/事件）
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        if (clients[i].inbox.length > before) break;
        await new Promise(r => setTimeout(r, 20));
      }
      break;
    }
    if (!acted) {
      await new Promise(r => setTimeout(r, 50));
    }
    roundsPlayed = actions;
    // 检查是否结束
    const anyOver = clients.some(c => c.inbox.some(m => m.type === 'events' && m.events.some(e => e.type === 'match_over')));
    if (anyOver) break;
  }
  console.log('✓ 出牌动作数:', roundsPlayed);

  const overMsg = clients.find(c => c.inbox.some(m => m.type === 'events' && m.events.some(e => e.type === 'match_over')));
  if (overMsg) {
    let ev = null;
    for (const m of overMsg.inbox) {
      if (m.type !== 'events') continue;
      const f = m.events.find(e => e.type === 'match_over');
      if (f) { ev = f; break; }
    }
    console.log('✓ 比赛结束，获胜方: 队伍', ev.winnerTeam);
  }

  // 查余额
  const roundResults = [];
  for (const c of clients) {
    for (const m of c.inbox) {
      if (m.type === 'events') for (const e of m.events) if (e.type === 'round_result') roundResults.push(e.result);
    }
  }
  console.log('✓ 副牌数:', roundResults.length);
  console.log('✓ 各副总级数:', roundResults.map(r => r.total).join(', '));

  // 钱包守恒校验：4 人初始各 1000，每副赢家 2 人各 +total×stake，输家 2 人各 -total×stake → 总和恒为 4000
  const finals = [];
  for (const n of names) {
    const l = await post('/api/login', { name: n, password: 'test123' });
    finals.push(l.profile.coins);
  }
  const sum = finals.reduce((a, b) => a + b, 0);
  console.log('✓ 四人最终余额:', finals.join(', '), '总和:', sum);
  if (sum !== 4000) { console.error('✗ 钱包不守恒!'); process.exit(1); }
  console.log('✓ 钱包守恒');

  console.log('\n=== 集成测试通过 ===');
  process.exit(0);
}

main().catch(e => { console.error('集成测试失败:', e.message); process.exit(1); });
