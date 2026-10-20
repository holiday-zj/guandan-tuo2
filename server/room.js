// 房间与大厅管理 + 单场对局编排（基于 engine）
import crypto from 'node:crypto';
import { Match } from '../engine/match.js';
import { cardLabel, orderValue } from '../engine/cards.js';
import { PlayTracker } from '../engine/ai/analyze.js';
import { botDecide, botDecideAsync } from './bot.js';

let roomSeq = 100;

// —— 房间 ——
export class Room {
  constructor(id, opts = {}) {
    this.id = id;
    this.isPrivate = !!opts.private;
    this.stake = opts.stake || 1;          // 每级游戏币
    this.rounds = opts.rounds || 8;        // 一场打几副牌（每副独立亮牌定级，不升级）
    this.botFill = !!opts.botFill;
    this.seats = [null, null, null, null]; // memberId or 'bot:N'
    this.state = 'waiting';                // waiting → playing → finished
    this.match = null;
    this.createdAt = Date.now();
  }

  addPlayer(memberId) {
    const idx = this.seats.findIndex(s => s === null);
    if (idx < 0) return { ok: false, error: '房间已满' };
    this.seats[idx] = memberId;
    return { ok: true, seat: idx };
  }

  removePlayer(memberId) {
    const idx = this.seats.indexOf(memberId);
    if (idx >= 0) this.seats[idx] = null;
  }

  playerCount() { return this.seats.filter(Boolean).length; }
  isFull() { return this.playerCount() === 4; }
  // 座位显示名：真人显示昵称（需要 nameOf 解析器），机器人显示编号
  names(nameOf = null) {
    return this.seats.map(s => {
      if (!s) return '（空位）';
      if (String(s).startsWith('bot:')) return '机器人' + String(s).slice(4);
      if (nameOf) { const n = nameOf(s); if (n) return n; }
      return String(s);
    });
  }
}

// —— 大厅（自由组队快速匹配队列）——
export class Lobby {
  constructor() {
    this.rooms = new Map();       // roomId -> Room
    this.queue = [];              // memberId[]
  }

  createPrivateRoom(memberId, opts) {
    const room = new Room('r' + (++roomSeq), { private: true, ...opts });
    room.addPlayer(memberId);
    this.rooms.set(room.id, room);
    return room;
  }

  joinRoom(roomId, memberId) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };
    if (room.state !== 'waiting') return { ok: false, error: '对局已开始' };
    return room.addPlayer(memberId);
  }

  enqueue(memberId) {
    if (!this.queue.includes(memberId)) this.queue.push(memberId);
    return this.queue.slice();
  }

  dequeue(memberId) {
    this.queue = this.queue.filter(m => m !== memberId);
  }

  // 尝试从队列凑一桌（4人）
  tryFormTable() {
    if (this.queue.length < 4) return null;
    const four = this.queue.splice(0, 4);
    const room = new Room('r' + (++roomSeq), { private: false });
    for (const m of four) room.addPlayer(m);
    this.rooms.set(room.id, room);
    return room;
  }

  publicList() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (room.isPrivate || room.state !== 'waiting') continue;
      list.push({ id: room.id, players: room.playerCount(), stake: room.stake });
    }
    return list;
  }
}

// —— 一场完整对局的编排 ——
export class GameSession {
  constructor(room, membersById) {
    this.room = room;
    this.membersById = membersById;
    this.events = [];          // 推送给客户端的事件流（每座位有私密过滤）
    this.roundNum = 0;
    this.driver = null;        // 当前副牌的出牌驱动状态
    this.started = false;
    this.over = false;
    this.winnerTeam = null;
    this.endVote = null;   // {by, byName, reason, votes:Set, expiresAt}
    this.lastPlays = {};   // seat -> {pass} 或 {cards:[...]} 当前圈内各家最近动作
    this.turnStartedAt = Date.now();
    this._finishNotified = new Set(); // 已发过 finish 事件的座位（含自动判定的名次）
    this.trackers = null;             // 每座位一个 PlayTracker（AI算牌用，只记公开信息）
  }

  seatNames() {
    return this.match.occupants.map((id, i) => {
      if (!id) return '空位';
      if (String(id).startsWith('bot:')) return '机器人' + String(id).slice(4);
      const m = this.membersById(id);
      return m ? m.name : ('玩家' + i);
    });
  }

  // 玩家（房间座位身份）→ 当前副牌的引擎座位（每副牌可能因亮牌重排）
  engineSeat(occupantId) {
    return this.match ? this.match.occupants.indexOf(occupantId) : -1;
  }

  start(matchOpts = {}) {
    this.match = new Match(this.room.seats, { totalRounds: this.room.rounds, ...matchOpts });
    this.started = true;
    this.room.state = 'playing';
    this.nextRound();
    return this;
  }

  nextRound() {
    const info = this.match.newRound();
    const round = this.match.round;
    this.roundNum = this.match.roundNo;

    // 出牌驱动状态
    let lead = 0;
    const t = info.tribute;
    if (t.type === 'single' || t.type === 'double') lead = t.tributes[0].from;
    round.startPlay(lead);

    this.driver = {
      best: null,               // {cards, it, by}
      consecutivePasses: 0,
      turn: lead,
      trickSeq: 0,              // 本圈是第几手（供AI判断局势）
    };
    this.lastPlays = {};
    this.turnStartedAt = Date.now();
    // AI 算牌追踪器：每个座位一份，只记录公开信息（谁出了什么/过牌几次）
    this.trackers = [new PlayTracker(), new PlayTracker(), new PlayTracker(), new PlayTracker()];
    for (const t of this.trackers) t.reset(round.level, round.tug);
    this._finishNotified = new Set();
    return info;
  }

  active(s) { return !this.match.round.finishOrder.includes(s); }
  activeCount() { return [0, 1, 2, 3].filter(s => this.active(s)).length; }

  // 给所有新确定名次的玩家发 finish 事件（含自动判定的三游/末游），
  // 保证每个人的客户端都能看到自己的名次
  emitFinishes(events) {
    const r = this.match.round;
    for (const s of r.finishOrder) {
      if (!this._finishNotified.has(s)) {
        this._finishNotified.add(s);
        events.push({ type: 'finish', seat: s, rank: r.finishOrder.indexOf(s) + 1 });
      }
    }
  }

  // 处理玩家动作：{type:'play', cards} 或 {type:'pass'}
  handleAction(seat, action) {
    const r = this.match.round;
    const d = this.driver;
    if (r.state !== 'playing') return { ok: false, error: '本副已结束' };
    if (seat !== d.turn) return { ok: false, error: '还没轮到你' };
    if (!this.active(seat)) return { ok: false, error: '你已出完' };

    const events = [];

    if (action.type === 'pass') {
      if (!d.best) return { ok: false, error: '领出不能过' };
      d.consecutivePasses++;
      this.lastPlays[seat] = { pass: true };
      if (this.trackers) for (const t of this.trackers) t.record(seat, null, 'pass');
      events.push({ type: 'pass', seat });
      const needPasses = this.activeCount() - (this.active(d.best.by) ? 1 : 0);
      if (d.consecutivePasses >= needPasses) {
        const endEvents = this.endTrick();
        events.push(...endEvents);
      } else {
        this.advanceTurn();
      }
      return { ok: true, events };
    }

    // 出牌
    if (action.type !== 'play') return { ok: false, error: 'unknown action' };
    const cards = action.cards.map(c => r.hands[seat].find(h => h.id === c.id)).filter(Boolean);
    if (cards.length !== action.cards.length) return { ok: false, error: '牌不在手中' };

    const ev = r.act(seat, cards);
    if (!ev.ok) return { ok: false, error: ev.error };

    d.best = { cards, it: ev.play, by: seat };
    d.consecutivePasses = 0;
    d.trickSeq = (d.trickSeq || 0) + 1;
    this.lastPlays[seat] = { pass: false, cards: cards.map(c => ({ id: c.id, suit: c.suit, rank: c.rank })) };
    // 公开出牌记入所有座位的追踪器（算牌依据，不含任何手牌隐私）
    if (this.trackers) {
      const pub = cards.map(c => ({ id: c.id, suit: c.suit, rank: c.rank }));
      for (const t of this.trackers) t.record(seat, pub, ev.play.type);
    }
    this.turnStartedAt = Date.now();
    events.push({
      type: 'play', seat,
      cards: cards.map(cardLabel),
      shape: ev.play.type,
      remaining: r.hands[seat].length,
    });
    if (ev.finished) {
      if (!r.finishedByPlay) r.finishedByPlay = {};
      r.finishedByPlay[seat] = cards.slice(); // 记录脱手牌（拖牌计分依据）
      if (ev.tugLocked) events.push({ type: 'tug_locked', seat, tip: '头游纯拖牌，不可压制，强制接风队友' });
      // 双上（本队包揽头游+二游）：本副立即结束，剩余两人自动三游/末游
      if (r.state === 'playing' && r.finishOrder.length === 2) {
        const [a, b] = r.finishOrder;
        if (r.teamOf[a] === r.teamOf[b]) {
          for (let s = 0; s < 4; s++) if (!r.finishOrder.includes(s)) r.finishOrder.push(s);
          r.state = 'finished';
        }
      }
    }
    this.emitFinishes(events); // 出完者 + 自动判定名次者，全部通知
    if (r.state === 'finished') {
      events.push(...this.finishRound());
    } else {
      this.advanceTurn();
    }
    return { ok: true, events };
  }

  advanceTurn() {
    const d = this.driver;
    let s = (d.turn + 1) % 4;
    for (let i = 0; i < 4; i++, s = (s + 1) % 4) if (this.active(s)) break;
    d.turn = s;
    this.match.round.lead = s;
    this.turnStartedAt = Date.now();
  }

  endTrick() {
    const r = this.match.round;
    const d = this.driver;
    const events = [];
    let next = this.active(d.best.by) ? d.best.by : (d.best.by + 2) % 4; // 接风
    if (!this.active(next)) {
      // 终局
      for (let s = 0; s < 4; s++) if (!r.finishOrder.includes(s)) r.finishOrder.push(s);
      r.state = 'finished';
      this.emitFinishes(events);
      events.push(...this.finishRound());
      return events;
    }
    d.best = null;
    d.consecutivePasses = 0;
    d.turn = next;
    r.lead = next;
    r.trick = null; // 关键：清空引擎层的当前牌圈，否则下一圈领出会被旧牌圈压制判定卡住
    this.lastPlays = {}; // 新一圈清空各家出牌展示
    this.turnStartedAt = Date.now();
    events.push({ type: 'new_trick', lead: next });
    return events;
  }

  finishRound() {
    const r = this.match.round;
    if (!r.finishedByPlay) r.finishedByPlay = {};
    const result = r.settle(r.finishedByPlay);
    const applied = this.match.applyResult(result);
    const events = [{ type: 'round_result', result: { ...result, scores: this.match.scores() } }];
    if (this.match.matchOver) {
      this.over = true;
      this.room.state = 'finished';
      const names = this.seatNames();
      const nameOf = {};
      this.match.occupants.forEach((id, i) => nameOf[String(id)] = names[i]);
      events.push({
        type: 'match_over',
        ranking: this.match.ranking().map(r => ({ id: r.id, name: nameOf[String(r.id)], score: r.score })),
        scores: this.match.scores(),
      });
    } else {
      // 下一副（会重新发牌、亮牌、重排座位）
      this.nextRound();
      events.push({ type: 'next_round', roundNum: this.roundNum, level: this.match.round.level, perm: this.match.occupants.slice() });
    }
    return events;
  }

  // 机器人驱动：只要当前出牌权在机器人座位上，就持续自动出牌，
  // 直到轮到一个真人座位、或本副牌结束。返回收集到的事件列表。
  // 异步版本：机器人可调用大模型决策（每次决策带超时，失败降级启发式）
  // onFlush: 每完成一步立即回调推送事件——LLM 决策每手1~2秒，机器人连续行动阶段
  // 若攒到循环结束才推送，客户端会几十秒收不到任何快照，表现为"牌局冻结"
  async driveBots(onFlush = null) {
    const events = [];
    let guard = 0;
    this._botProgressAt = Date.now(); // 每推进一步刷新；外部用"距上次进展时长"判断循环是否真挂起
    const trace = process.env.BOT_TRACE ? (...a) => console.log('[trace]', ...a) : () => {};
    for (;;) {
      if (++guard > 5000) { trace('break: guard'); break; } // 保险
      const r = this.match.round;
      if (r.state !== 'playing') { trace('break: round state=' + r.state); break; }
      const seat = this.driver.turn;
      const occupant = this.match.occupants[seat];
      if (!occupant || !String(occupant).startsWith('bot:')) { trace(`break: seat${seat} 非机器人(${occupant})`); break; } // 轮到真人或空位
      if (!this.active(seat)) { trace(`break: seat${seat} 已出完但牌权在其手上 → 死锁!`); break; }
      let action;
      try {
        const td = Date.now();
        if (process.env.BOT_TRACE) console.log(`[trace ${new Date().toISOString().slice(11, 23)}] seat${seat} 决策开始`);
        action = await botDecideAsync(this, seat);
        if (process.env.BOT_TRACE) console.log(`[trace] seat${seat} 决策结束 耗时${Date.now() - td}ms via=${action && action.via}`);
      } catch (e) {
        action = botDecide(this, seat); // 双保险：AI层异常时用旧同步逻辑
      }
      const res = this.handleAction(seat, action);
      if (!res.ok) {
        console.error('[driveBots] 机器人动作被拒', { seat, error: res.error, via: action && action.via, best: !!this.driver.best, handSize: this.match.round.hands[seat] && this.match.round.hands[seat].length });
        if (!this.driver.best) {
          // 领出被拒 → 终极保底：直接出手里最小的一张（首攻避开纯拖），绝不死锁
          const hand = r.hands[seat].slice().sort((a, b) => orderValue(a.rank, r.level) - orderValue(b.rank, r.level));
          const pick = hand.find(c => r.led || c.rank !== r.tug) || hand[0];
          if (pick) {
            const res2 = this.handleAction(seat, { type: 'play', cards: [{ id: pick.id }] });
            if (res2.ok) { events.push(...res2.events); continue; }
            console.error('[driveBots] 保底单张也被拒', { seat, error: res2.error });
          }
        }
        // 跟牌被拒 → 兜底过牌
        const pass = this.handleAction(seat, { type: 'pass' });
        if (!pass.ok) {
          console.error('[driveBots] 兜底过牌也失败 → 牌局将卡死', { seat, error: pass.error });
          break;
        }
        events.push(...pass.events);
        continue;
      }
      events.push(...res.events);
      this._botProgressAt = Date.now();
      if (onFlush) { try { onFlush(res.events); } catch (e) { console.error('[driveBots] onFlush异常', e.message || e); } }
      trace(`seat${seat} ${action.type} ok, turn→${this.driver.turn}, round=${r.state}`);
    }
    return events;
  }

  // 面向某玩家的快照（按玩家身份定位，隐藏他人手牌）
  snapshotFor(occupantId) {
    const r = this.match.round;
    const seat = this.engineSeat(occupantId);
    if (seat < 0) return null;
    return {
      roundNum: this.roundNum,
      totalRounds: this.match.totalRounds,
      level: r.level,
      tug: r.tug,
      led: r.led,           // 本副首攻是否已出（首攻禁止纯拖牌，客户端据此提示）
      flip: r.flipCard ? cardLabel(r.flipCard) : null,
      teamOf: r.teamOf,
      names: this.seatNames(),
      mySeat: seat,
      hand: r.hands[seat] ? r.hands[seat].map(c => ({ id: c.id, suit: c.suit, rank: c.rank })) : [],
      handCounts: r.hands.map(h => (h ? h.length : 0)),
      turn: this.driver ? this.driver.turn : null,
      best: this.driver && this.driver.best
        ? {
            by: this.driver.best.by,
            cards: this.driver.best.cards.map(c => ({ id: c.id, suit: c.suit, rank: c.rank })),
            shape: this.driver.best.it ? this.driver.best.it.type : null,
          }
        : null,
      finishOrder: r.finishOrder,
      scores: this.match.scores(),
      lastPlays: this.lastPlays,
      turnDeadline: this.turnStartedAt + 30000,
      tribute: r.tributeInfo || null,
    };
  }
}
