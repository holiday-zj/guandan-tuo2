// 诊断：单客户端建房+机器人开局，观察消息流
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
          resolve();
          this.pump();
          return;
        }
        this.buf = Buffer.concat([this.buf, chunk]);
        this.pump();
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
  waitFor(pred, ms = 5000) {
    return new Promise((resolve, reject) => {
      const found = this.inbox.find(pred);
      if (found) return resolve(found);
      const t = setTimeout(() => reject(new Error('timeout; inbox types: ' + [...new Set(this.inbox.map(m => m.type))].join(','))), ms);
      this.handlers.push(m => { if (pred(m)) { clearTimeout(t); resolve(m); } });
    });
  }
}

const reg = await post('/api/register', { name: '诊断' + Date.now(), password: 'x' });
const c = new WsClient();
await c.connect(reg.token);
await c.waitFor(m => m.type === 'welcome');
console.log('welcome OK');

c.send({ type: 'create_room', stake: 1, botFill: true });
const rc = await c.waitFor(m => m.type === 'room_created');
console.log('room:', rc.roomId);

c.send({ type: 'start_game' });
await c.waitFor(m => m.type === 'game_start' || m.type === 'error', 5000).then(m => {
  if (m.type === 'error') { console.log('ERROR:', m.error); process.exit(1); }
  console.log('game_start seat=', m.seat, 'turn=', m.snapshot.turn, 'hand=', m.snapshot.hand.length, 'level=', m.snapshot.level);
});

// 出 3 步看响应
const snap = c.inbox.find(m => m.type === 'game_start').snapshot;
const card = snap.hand[0];
console.log('出牌:', JSON.stringify(card));
c.send({ type: 'play', cards: [{ id: card.id }] });
await new Promise(r => setTimeout(r, 800));
for (const m of c.inbox.slice(-4)) {
  console.log('←', m.type, JSON.stringify(m).slice(0, 200));
}
process.exit(0);
