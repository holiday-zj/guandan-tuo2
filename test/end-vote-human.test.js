// 验证：纯真人房（无机器人）申请结束仍需 2 人投票同意
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';

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
  constructor() { this.buf = Buffer.alloc(0); this.inbox = []; }
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
      if ((b[0] & 0x0f) === 0x1) this.inbox.push(JSON.parse(b.slice(p, p + len).toString()));
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
  async waitFor(pred, ms = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = this.inbox.find(pred);
      if (f) return f;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('timeout; got: ' + [...new Set(this.inbox.map(m => m.type))].join(','));
  }
}

const suffix = Date.now().toString(36);
// 4 真人（无机器人）
const players = [];
for (let i = 0; i < 4; i++) {
  const reg = await post('/api/register', { name: `纯人${i}_${suffix}`, password: 'x' });
  if (!reg.ok) throw new Error('注册失败');
  players.push(reg);
}
const ws = [];
for (const p of players) {
  const c = new WsClient();
  await c.connect(p.token);
  await c.waitFor(m => m.type === 'welcome');
  ws.push(c);
}
console.log('✓ 4 名真人连接成功（无机器人）');

ws[0].send({ type: 'create_room', stake: 1, rounds: 8 });
const rc = await ws[0].waitFor(m => m.type === 'room_created');
for (let i = 1; i < 4; i++) {
  ws[i].send({ type: 'join_room', roomId: rc.roomId });
  await ws[i].waitFor(m => m.type === 'room_joined');
}
ws[0].send({ type: 'start_game' });
for (const c of ws) await c.waitFor(m => m.type === 'game_start');
console.log('✓ 对局开始（4真人）');

// 玩家0 申请结束：纯真人房不应立即结束，应广播投票
ws[0].send({ type: 'end_request', reason: '测试投票' });
const prop = await ws[1].waitFor(m => m.type === 'end_proposal');
console.log('✓ 广播投票请求：', prop.byName, '票数', prop.votes + '/' + prop.need);
if (prop.votes !== 1) throw new Error('申请人默认同意，票数应为1');

// 等 300ms 确认没有立即结束
await new Promise(r => setTimeout(r, 300));
if (ws[1].inbox.some(m => m.type === 'match_over')) throw new Error('纯真人房不应申请即结束');
console.log('✓ 纯真人房未立即结束（正确）');

// 玩家1 同意 → 达到2票 → 结束
ws[1].send({ type: 'end_vote', agree: true });
const over = await ws[1].waitFor(m => m.type === 'match_over');
console.log('✓ 2人同意后结束：', over.reason);

console.log('\n=== 纯真人房投票流程测试通过 ===');
process.exit(0);
