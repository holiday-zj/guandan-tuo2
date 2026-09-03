// 端到端：1 真人 + 3 机器人，真人用引擎决策，验证服务端能打完一整场
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { interpret, bestInterpretation, canBeat } from '../engine/classify.js';

function post(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request({ host: '127.0.0.1', port: 8080, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.end(body);
  });
}

class WsClient {
  constructor() { this.buf = Buffer.alloc(0); this.inbox = []; this.handlers = []; }
  async connect(token) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(8080, '127.0.0.1', () => {
        socket.write(`GET /?token=${token} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let upgraded = false;
      socket.on('data', chunk => {
        if (!upgraded) {
          const all = Buffer.concat([this.buf, chunk]);
          const s = all.toString('binary');
          const i = s.indexOf('\r\n\r\n');
          if (i < 0) { this.buf = all; return; }
          upgraded = true;
          if (!s.startsWith('HTTP/1.1 101')) reject(new Error('no 101'));
          this.buf = all.slice(i + 4);
          resolve(); this.pump(); return;
        }
        this.buf = Buffer.concat([this.buf, chunk]); this.pump();
      });
      socket.on('error', reject);
      this.socket = socket;
    });
  }
  pump() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let len = b[1] & 0x7f, p = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); p = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); p = 10; }
      if (b.length < p + len) return;
      if ((b[0] & 0x0f) === 0x1) {
        const msg = JSON.parse(b.slice(p, p + len).toString());
        this.inbox.push(msg);
        for (const h of this.handlers) h(msg);
      }
      this.buf = b.slice(p + len);
    }
  }
  send(obj) {
    const data = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  waitFor(pred, ms = 8000) {
    return new Promise((resolve, reject) => {
      const found = this.inbox.find(pred);
      if (found) return resolve(found);
      const t = setTimeout(() => reject(new Error('timeout; got: ' + [...new Set(this.inbox.map(m => m.type))].join(','))), ms);
      this.handlers.push(m => { if (pred(m)) { clearTimeout(t); resolve(m); } });
    });
  }
  latest(pred) { for (let i = this.inbox.length - 1; i >= 0; i--) if (pred(this.inbox[i])) return this.inbox[i]; return null; }
}

function valueOf(c, level) {
  return c.rank === 'BJ' ? 17 : c.rank === 'SJ' ? 16 : c.rank === level ? 15 : '23456789TJQKA'.indexOf(c.rank) + 2;
}

// 真人决策：领出最小单张；跟牌用引擎找最小能压的单张，否则过
function decide(snap, seat) {
  const level = snap.level;
  const hand = snap.hand;
  const sorted = hand.slice().sort((a, b) => valueOf(a, level) - valueOf(b, level));
  if (!snap.best) return { type: 'play', cards: [{ id: sorted[0].id }] };
  // 跟牌：用引擎对 best 重建解释，再找最小能压的单张
  const target = bestInterpretation(snap.best.cards, level);
  for (const c of sorted) {
    const it = bestInterpretation([c], level);
    if (it && target && canBeat(it, target)) return { type: 'play', cards: [{ id: c.id }] };
  }
  return { type: 'pass' };
}

async function main() {
  const name = '真人_' + Date.now().toString(36);
  const reg = await post('/api/register', { name, password: 'test123' });
  if (!reg.ok) throw new Error('注册失败: ' + JSON.stringify(reg));
  console.log('✓ 注册', name, '币', reg.profile.coins);

  const c = new WsClient();
  await c.connect(reg.token);
  await c.waitFor(m => m.type === 'welcome');
  console.log('✓ 连接成功');

  c.send({ type: 'create_room', stake: 10, botFill: true });
  const rc = await c.waitFor(m => m.type === 'room_created');
  console.log('✓ 建房', rc.roomId);

  c.send({ type: 'start_game' });
  const gs = await c.waitFor(m => m.type === 'game_start' || m.type === 'error', 8000);
  if (gs.type === 'error') throw new Error('开局失败: ' + gs.error);
  const seat = gs.seat;
  console.log('✓ 开局, 座位', seat, '级牌', gs.snapshot.level, '队友', gs.snapshot.teamOf.map((t, i) => t === gs.snapshot.teamOf[seat] ? i : null).filter(x => x !== null && x !== seat).join(','));

  // 主循环：真人在自己回合出牌，其余靠服务端机器人驱动
  let actions = 0;
  let matchOver = false;
  const seenEvents = [];
  let eventCursor = 0;
  const collect = () => {
    for (let i = eventCursor; i < c.inbox.length; i++) {
      const m = c.inbox[i];
      if (m.type === 'events') for (const e of m.events) seenEvents.push(e);
    }
    eventCursor = c.inbox.length;
    matchOver = seenEvents.some(e => e.type === 'match_over');
  };

  let iterations = 0;
  while (!matchOver && actions < 4000 && iterations < 60000) {
    iterations++;
    collect();
    if (matchOver) break;
    const snapMsg = c.latest(m => m.type === 'snapshot' || m.type === 'game_start');
    const snap = snapMsg.snapshot;

    if (snap.turn === snap.mySeat) {
      const act = decide(snap, snap.mySeat);
      c.send(act);
      actions++;
      // 等待服务端回推新快照（机器人已同步驱动完毕）
      const before = c.inbox.length;
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        if (c.inbox.length > before) break;
        await new Promise(r => setTimeout(r, 30));
      }
      if (actions % 20 === 0) {
        collect();
        console.log(`  ... 已出 ${actions} 手, 已完成副数=${seenEvents.filter(e => e.type === 'round_result').length}, 手牌=${snap.hand.length}`);
      }
    } else {
      await new Promise(r => setTimeout(r, 50));
    }
  }
  collect();

  const roundResults = seenEvents.filter(e => e.type === 'round_result');
  const overEv = seenEvents.find(e => e.type === 'match_over');
  console.log('✓ 出手数:', actions);
  console.log('✓ 完成副数:', roundResults.length, '各副级数:', roundResults.map(r => r.result.total).join(','));
  if (overEv) console.log('✓ 比赛结束, 胜方队伍', overEv.winnerTeam);

  const login = await post('/api/login', { name, password: 'test123' });
  console.log('✓ 最终余额:', login.profile.coins, '(初始1000)');

  if (!overEv) { console.error('✗ 未打完整场'); process.exit(1); }
  console.log('\n=== 端到端测试通过 ===');
  process.exit(0);
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
