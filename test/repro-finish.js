// 复现：有人出完牌后，回合是否提前结束？追踪 finish 事件与 finishOrder
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { bestInterpretation, canBeat } from '../engine/classify.js';

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
function val(c, lv){ return c.rank==='BJ'?17: c.rank==='SJ'?16: c.rank===lv?15: '23456789TJQKA'.indexOf(c.rank)+2; }

class WsClient {
  constructor(tag){ this.tag=tag; this.buf = Buffer.alloc(0); this.inbox = []; }
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
  latestSnap(){ for(let i=this.inbox.length-1;i>=0;i--){ const m=this.inbox[i]; if((m.type==='snapshot'||m.type==='game_start')&&m.snapshot) return m.snapshot; } return null; }
}

const suffix = Date.now().toString(36);
const reg = await post('/api/register', { name: `复现_${suffix}`, password: 'x' });
const c = new WsClient('me');
await c.connect(reg.token);

c.send({ type: 'create_room', stake: 1, rounds: 2, botFill: true });
await new Promise(r => setTimeout(r, 400));
c.send({ type: 'start_game' });
await new Promise(r => setTimeout(r, 600));

function decide(snap){
  const hand = snap.hand, lv = snap.level;
  const sorted = hand.slice().sort((a,b)=>val(a,lv)-val(b,lv));
  if(!snap.best){ // 领出：避免首攻拖牌
    for(const x of sorted){ if(x.rank!==snap.tug) return {type:'play',cards:[{id:x.id}]}; }
    return {type:'play',cards:[{id:sorted[0].id}]};
  }
  const target = bestInterpretation(snap.best.cards, lv);
  for(const x of sorted){ const it=bestInterpretation([x],lv); if(it&&target&&canBeat(it,target)) return {type:'play',cards:[{id:x.id}]}; }
  return {type:'pass'};
}

let finishLog = [];
let iter = 0;
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
log('开始出牌循环');
let lastTurn = -1;
while(iter < 800){
  iter++;
  // 收集 finish 事件
  for(const m of c.inbox){
    if(m.type==='events') for(const ev of m.events){
      if(ev.type==='finish') finishLog.push(`finish: seat${ev.seat} 第${ev.rank}名`);
      if(ev.type==='round_result') finishLog.push(`round_result: base=${ev.result.base} total=${ev.result.total} finishOrder=[${ev.result.ranking.first},${ev.result.ranking.second},${ev.result.ranking.third},${ev.result.ranking.fourth}]`);
      if(ev.type==='match_over') finishLog.push(`match_over`);
    }
  }
  c.inbox = c.inbox.filter(m=>m.type!=='events'); // 已处理
  const snap = c.latestSnap();
  if(!snap) { await new Promise(r=>setTimeout(r,200)); continue; }
  if(snap.turn !== lastTurn && iter % 20 === 0) log(`iter=${iter} turn=${snap.turn} mySeat=${snap.mySeat} hand=${snap.hand.length}`);
  lastTurn = snap.turn;
  if(snap.turn === snap.mySeat){
    const act = decide(snap);
    c.send(act);
    const before = c.inbox.length;
    const t0=Date.now();
    while(Date.now()-t0<4000){ if(c.inbox.length>before) break; await new Promise(r=>setTimeout(r,30)); }
  } else {
    await new Promise(r=>setTimeout(r,100));
  }
}
console.log('=== 事件序列 ===');
console.log(finishLog.join('\n'));
const finalSnap = c.latestSnap();
console.log('\n最终手牌数:', finalSnap? finalSnap.handCounts.join(',') : 'n/a');
process.exit(0);
