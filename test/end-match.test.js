// 验证：提前结束比赛（申请 → 2人同意 → 终止，全员回大厅）
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
  find(pred) { return this.inbox.find(pred); }
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
// 2 真人 + 2 机器人
const players = [];
for (let i = 0; i < 2; i++) {
  const reg = await post('/api/register', { name: `结束测试${i}_${suffix}`, password: 'x' });
  if (!reg.ok) throw new Error('注册失败');
  players.push({ name: reg.profile.name, token: reg.token, before: reg.profile.coins });
}

const ws = [];
for (const p of players) {
  const c = new WsClient();
  await c.connect(p.token);
  await c.waitFor(m => m.type === 'welcome');
  ws.push(c);
}
console.log('✓ 2 名真人连接成功');

// 建房（机器人补位），打 8 副
ws[0].send({ type: 'create_room', stake: 5, rounds: 8, botFill: true });
await ws[0].waitFor(m => m.type === 'room_created');
ws[1].send({ type: 'join_room', roomId: ws[0].find(m => m.type === 'room_created').roomId });
await ws[1].waitFor(m => m.type === 'room_joined');
ws[0].send({ type: 'start_game' });
await ws[0].waitFor(m => m.type === 'game_start');
await ws[1].waitFor(m => m.type === 'game_start');
console.log('✓ 对局开始（2真人+2机器人，8副制）');

// 玩家1 发起结束申请（带原因）
ws[0].send({ type: 'end_request', reason: '测试提前结束' });
const prop0 = await ws[0].waitFor(m => m.type === 'end_proposal');
console.log('✓ 收到申请广播：', prop0.byName, '原因:', prop0.reason, '票数:', prop0.votes + '/' + prop0.need);

// 玩家2 也收到广播
const prop1 = await ws[1].waitFor(m => m.type === 'end_proposal');
if (prop1.votes !== 1) throw new Error('玩家2收到的票数应为1');

// 玩家2 同意 → 达到2票，比赛终止
ws[1].send({ type: 'end_vote', agree: true });
const over0 = await ws[0].waitFor(m => m.type === 'match_over');
const over1 = await ws[1].waitFor(m => m.type === 'match_over');
const ev0 = over0;
console.log('✓ 比赛已终止：', ev0.terminated ? '是' : '否', '原因:', ev0.reason);
console.log('✓ 个人积分排名:', ev0.ranking.map(r => `${r.name}(${r.score >= 0 ? '+' : ''}${r.score})`).join(' '));
if (!ev0.terminated) throw new Error('应标记为提前结束');
if (ev0.ranking.length !== 4) throw new Error('排名应有4人');
// 积分守恒：四人积分和为0（每副赢家+total×2，输家−total×2，个人制也守恒）
const sum = ev0.ranking.reduce((a, r) => a + r.score, 0);
if (sum !== 0) throw new Error('个人积分应守恒(和为0)，实际=' + sum);
console.log('✓ 个人积分守恒（四人总和为0）');

// 回到大厅后应可重新建房
const beforeCount = ws[0].inbox.length;
ws[0].send({ type: 'create_room', stake: 1, botFill: true });
const rc = await ws[0].waitFor(m => m.type === 'room_created' && ws[0].inbox.indexOf(m) >= beforeCount);
console.log('✓ 已回大厅，可重新建房:', rc.roomId);

console.log('\n=== 提前结束比赛测试通过 ===');
process.exit(0);
