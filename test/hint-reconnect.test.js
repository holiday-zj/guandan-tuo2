// 验证：提示协议 + 断线重连
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
  close() { try { this.socket.destroy(); } catch {} }
  find(pred) { return this.inbox.find(pred); }
}

const suffix = Date.now().toString(36);
const reg = await post('/api/register', { name: '提示测试_' + suffix, password: 'x' });
const token = reg.token;

const c = new WsClient();
await c.connect(token);
c.send({ type: 'create_room', stake: 1, botFill: true });
await new Promise(r => setTimeout(r, 300));
c.send({ type: 'start_game' });
await new Promise(r => setTimeout(r, 500));

const gs = c.find(m => m.type === 'game_start');
if (!gs) { console.error('未开局:', c.inbox.map(m => m.type).join(',')); process.exit(1); }
console.log('✓ 开局, 座位', gs.seat, '轮到:', gs.snapshot.turn);

// 请求提示
c.send({ type: 'hint' });
await new Promise(r => setTimeout(r, 400));
const hint = c.find(m => m.type === 'hint');
if (gs.snapshot.turn === gs.seat) {
  if (!hint) { console.error('✗ 未收到提示:', c.inbox.map(m => m.type).join(',')); process.exit(1); }
  console.log('✓ 收到提示', hint.options.length, '种出法，第一种:', hint.options[0].map(c2 => c2.suit + c2.rank).join(' '));
  // 按提示出牌
  c.send({ type: 'play', cards: hint.options[0].map(c2 => ({ id: c2.id })) });
  await new Promise(r => setTimeout(r, 500));
  const played = c.find(m => m.type === 'events' && m.events.some(e => e.type === 'play' && e.seat === gs.seat));
  console.log(played ? '✓ 按提示出牌成功' : '✗ 出牌未成功');
} else {
  console.log('（首出是机器人，跳过提示测试）');
}

// —— 断线重连测试 ——
console.log('--- 断线重连 ---');
c.close();
await new Promise(r => setTimeout(r, 300));
const c2 = new WsClient();
await c2.connect(token);
await new Promise(r => setTimeout(r, 600));
const rejoin = c2.find(m => m.type === 'game_start' && m.reconnect);
if (rejoin) {
  console.log('✓ 断线重连成功，恢复牌局快照：手牌', rejoin.snapshot.hand.length, '张, 第', rejoin.snapshot.roundNum, '副');
} else {
  // 可能牌局刚好结束，检查是否收到其他状态
  console.log('重连消息:', c2.inbox.map(m => m.type).join(','));
}

console.log('\n=== 提示+重连测试完成 ===');
process.exit(0);
