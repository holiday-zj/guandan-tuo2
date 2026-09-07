// 验证：凭房间号加入房间的完整流程（A建房 → B输入房间号加入 → 双方看到座位 → 满员开局）
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
  constructor(){ this.buf = Buffer.alloc(0); this.inbox = []; }
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

const sfx = Date.now().toString(36);
const regA = await post('/api/register', { name: '房主_' + sfx, password: 'x' });
const regB = await post('/api/register', { name: '朋友_' + sfx, password: 'x' });
if (!regA.ok || !regB.ok) throw new Error('注册失败');

const A = new WsClient(), B = new WsClient();
await A.connect(regA.token); await A.waitFor(m => m.type === 'welcome');
await B.connect(regB.token); await B.waitFor(m => m.type === 'welcome');
console.log('✓ 房主与朋友均已连接');

// A 创建房间（不补机器人，等人加入）
A.send({ type: 'create_room', stake: 2, botFill: false });
const created = await A.waitFor(m => m.type === 'room_created');
console.log('✓ 房间已创建，房间号 =', created.roomId, '底注', created.stake);

// A 应收到 room_state（座位表）
const stateA = await A.waitFor(m => m.type === 'room_state');
console.log('✓ 房主看到座位:', JSON.stringify(stateA.seats));

// B 用房间号加入（模拟客户端"加入房间"输入框）
B.send({ type: 'join_room', roomId: created.roomId });
const joined = await B.waitFor(m => m.type === 'room_joined');
if (joined.roomId !== created.roomId) throw new Error('加入的房间号不一致');
console.log('✓ 朋友凭房间号加入成功，座位', joined.seat);

// A 也应收到更新后的 room_state，能看到 B 的名字
const stateA2 = await A.waitFor(m => m.type === 'room_state' && m.seats.filter(x => x && x !== '（空位）').length >= 2);
console.log('✓ 房主实时看到朋友入座:', JSON.stringify(stateA2.seats));

// 房间未满时点开始 → 应提示人不够
A.send({ type: 'start_game' });
const err = await A.waitFor(m => m.type === 'error', 3000);
console.log('✓ 未满员开局被拒绝:', err.error);

// 再补 2 个朋友凑满 4 人
const extras = [];
for (let i = 0; i < 2; i++) {
  const r = await post('/api/register', { name: `路人${i}_${sfx}`, password: 'x' });
  const c = new WsClient();
  await c.connect(r.token); await c.waitFor(m => m.type === 'welcome');
  c.send({ type: 'join_room', roomId: created.roomId });
  await c.waitFor(m => m.type === 'room_joined');
  extras.push(c);
}
console.log('✓ 又加入2人，房间满员');

const full = await A.waitFor(m => m.type === 'room_state' && m.seats.every(x => x && x !== '（空位）'));
console.log('✓ 四人座位:', JSON.stringify(full.seats));

// 房主开局 → 四人都应收到 game_start
A.send({ type: 'start_game' });
const gsA = await A.waitFor(m => m.type === 'game_start', 5000);
const gsB = await B.waitFor(m => m.type === 'game_start', 5000);
console.log('✓ 开局成功：房主座位', gsA.seat, '朋友座位', gsB.seat, '级牌', gsA.snapshot.level);

// 错误房间号应被拒绝
B.send({ type: 'leave_room' });
await B.waitFor(m => m.type === 'left_room' || m.type === 'error');
const C2 = extras[0];
C2.send({ type: 'join_room', roomId: 'r999999' });
const badJoin = await C2.waitFor(m => m.type === 'error', 3000);
console.log('✓ 错误房间号被拒绝:', badJoin.error);

console.log('\n=== 房间号加入流程测试通过 ===');
process.exit(0);
