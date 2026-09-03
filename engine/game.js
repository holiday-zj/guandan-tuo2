// 一局（一副牌）的流程状态机：发牌 → 亮牌定级定队 → 进贡/还贡 → 出牌 → 结算
import {
  makeDeck, shuffle, levelFromFlip, tugRank, tugValueOf, orderValue, isWild,
} from './cards.js';
import { interpret, bestInterpretation, canBeat } from './classify.js';

export class Round {
  // seats: 4 个玩家槽（0..3，逆时针出牌；0 的搭档是 2，1 的搭档是 3）
  // teamOf: 每局的队伍分配（由亮牌决定），数组长度4，值为队号 0/1
  constructor(seats, teamOf, rng = Math.random) {
    this.seats = seats;
    this.teamOf = teamOf;
    this.rng = rng;
    this.state = 'created'; // created → flipped → tribute → playing → finished
    this.flipCard = null;
    this.level = null;
    this.tug = null;
    this.hands = [null, null, null, null];
    this.tribute = { required: false, pending: [], done: {} }; // pending: [{from,to,card}]
    this.finishOrder = []; // 出完牌的座位顺序（头游..末游）
    this.lead = null;       // 当前出牌权
    this.trick = null;      // {cards, interpretation, by}
    this.lastTrickWinner = null;
    this.passes = 0;
    this.result = null;
  }

  deal() {
    const deck = shuffle(makeDeck(), this.rng);
    for (let s = 0; s < 4; s++) this.hands[s] = deck.slice(s * 27, s * 27 + 27);
    this.state = 'dealt';
    return this;
  }

  // 亮牌：随机翻出一张，级别=亮牌+1；两张相同亮牌所在玩家结队
  // 纯函数：不修改 Round 状态（座位重排由上层在定队后统一处理）
  flip() {
    if (!this.hands[0]) this.deal();
    const deck = makeDeck().filter(c => c.suit !== 'X'); // 亮牌只从普通牌中翻
    const pick = deck[Math.floor(this.rng() * deck.length)];
    const holders = [];
    for (let s = 0; s < 4; s++) {
      const n = this.hands[s].filter(c => c.suit === pick.suit && c.rank === pick.rank).length;
      if (n > 0) holders.push(s);
    }
    // 两张同牌必然分布在 1 或 2 名玩家手中
    let teams;
    const newLevel = levelFromFlip(pick.rank);
    if (holders.length === 2) {
      teams = [0, 0, 0, 0];
      teams[holders[0]] = 0; teams[holders[1]] = 0;
      for (let s = 0; s < 4; s++) if (s !== holders[0] && s !== holders[1]) teams[s] = 1;
    } else {
      teams = this.teamOf.slice(); // 两张在同一人 → 队伍不变
    }
    return { flip: pick, level: newLevel, tug: tugRank(newLevel), teamOf: teams, holders };
  }

  // 应用亮牌结果（座位重排后调用）
  applyFlip(info) {
    this.flipCard = info.flip;
    this.level = info.level;
    this.tug = info.tug;
    this.teamOf = info.teamOf;
    this.state = 'flipped';
    return info;
  }

  // 上局结束后由 Game 调用：进贡与还贡（双贡/单贡/抗贡）
  // tributes: [{from, to, card}] —— 服务端按规则直接计算确定
  applyTributes(tributes) {
    for (const t of tributes) {
      const idx = this.hands[t.from].findIndex(c => c.id === t.card.id);
      if (idx < 0) throw new Error('tribute card not in hand');
      this.hands[t.from].splice(idx, 1);
      this.hands[t.to].push(t.card);
    }
    this.tribute.done = tributes;
    this.state = 'tributed';
  }

  // 还贡：收贡方向进贡方返还一张点数 ≤10 的牌
  returnCard(fromSeat, toSeat, cardId) {
    const hand = this.hands[fromSeat];
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx < 0) return { ok: false, error: 'no such card' };
    const card = hand[idx];
    if (isWild(card, this.level) || card.suit === 'X' || orderValue(card.rank, this.level) > 10)
      return { ok: false, error: 'return card must be ≤10' };
    hand.splice(idx, 1);
    this.hands[toSeat].push(card);
    return { ok: true };
  }

  // 首出牌权：上局双贡则两贡方中先摸到贡牌者…简化：进贡方先出（单贡：进贡者；双贡：进贡方中较小座位）
  startPlay(leadSeat) {
    this.lead = leadSeat;
    this.state = 'playing';
  }

  // 出牌/过牌。返回 {ok, ...}
  act(seat, cards) {
    if (this.state !== 'playing') return { ok: false, error: 'not playing' };
    if (seat !== this.lead) return { ok: false, error: 'not your turn' };
    if (this.finishOrder.includes(seat)) return { ok: false, error: 'already finished' };

    // —— 过牌 ——
    if (cards === null) {
      if (!this.trick) return { ok: false, error: 'cannot pass when leading' };
      this.passes++;
      return { ok: true, pass: true };
    }

    // —— 出牌：牌必须在手 ——
    const hand = this.hands[seat];
    const ids = new Set(cards.map(c => c.id));
    if (ids.size !== cards.length) return { ok: false, error: 'duplicate card id' };
    for (const c of cards) if (!hand.some(h => h.id === c.id)) return { ok: false, error: 'card not in hand' };

    const it = bestInterpretation(cards, this.level);
    if (!it) return { ok: false, error: 'invalid combination' };
    if (this.trick && !canBeat(it, this.trick.interpretation))
      return { ok: false, error: 'cannot beat' };

    // 出牌成立：从手牌移除
    this.hands[seat] = hand.filter(h => !ids.has(h.id));
    this.trick = { cards, interpretation: it, by: seat };
    this.lastTrickWinner = seat;
    this.passes = 0;
    const event = { ok: true, play: it, remaining: this.hands[seat].length };

    if (this.hands[seat].length === 0) {
      this.finishOrder.push(seat);
      event.finished = true;
      if (this.finishOrder.length === 3) {
        // 剩最后一人自动末游
        const last = [0, 1, 2, 3].find(s => !this.finishOrder.includes(s));
        this.finishOrder.push(last);
        this.state = 'finished';
      } else if (this.finishOrder.length === 2 || this.finishOrder.length === 1) {
        // 接风：若其余未出完者全过，出牌权给对家（由 advance 处理）
      }
    }
    return event;
  }

  // 推进到下一个出牌者。调用时机：当前领出者出完一手且其余各家都过，或有人过牌后需要轮转
  // 返回下一个领出座位
  nextLeader() {
    const alive = s => !this.finishOrder.includes(s);
    // 从当前领出者的下家开始找第一个还在局内的人
    let s = (this.lead + 1) % 4;
    for (let i = 0; i < 4; i++, s = (s + 1) % 4) if (alive(s)) break;
    return s;
  }

  // 一圈结束（其余三家全过）：领出权回到最后出牌者的下家；若其已出完则接风给对家
  resolveTrick() {
    const winner = this.lastTrickWinner;
    const alive = s => !this.finishOrder.includes(s);
    let next = (winner + 1) % 4;
    if (!alive(next)) {
      // 接风：对家承接
      const partner = (winner + 2) % 4;
      next = alive(partner) ? partner : null;
    }
    this.trick = null;
    if (next === null) { this.state = 'finished'; return null; }
    this.lead = next;
    return next;
  }

  // —— 结算（安徽拖2算法）——
  // 返回 {ranking, base, tugBonus, leftover, total, payPerLoser}
  settle(finishedByPlay = {}) {
    if (this.state !== 'finished') throw new Error('round not finished');
    const [first, second, third, fourth] = this.finishOrder;
    const winTeam = this.teamOf[first];
    // 基础级
    let base;
    if (this.teamOf[second] === winTeam) base = 3;      // 双下
    else if (this.teamOf[third] === winTeam) base = 2;   // 一三
    else base = 1;                                        // 一四

    // 头游/二游脱手的最后一手若是纯拖牌 → 拖级（红拖×2）
    let tugBonus = 0;
    for (const s of [first, second]) {
      const lastPlay = finishedByPlay[s];
      if (lastPlay && lastPlay.every(c => c.rank === this.tug)) {
        tugBonus += lastPlay.reduce((sum, c) => sum + tugValueOf(c, this.level), 0);
      }
    }

    // 三游/末游手中剩余拖牌 → 加级（红拖×2）
    let leftover = 0;
    for (const s of [third, fourth]) {
      for (const c of this.hands[s]) leftover += tugValueOf(c, this.level);
    }

    const total = base + tugBonus + leftover;
    const losers = [0, 1, 2, 3].filter(s => this.teamOf[s] !== winTeam);
    const winners = [0, 1, 2, 3].filter(s => this.teamOf[s] === winTeam);
    this.result = {
      ranking: { first, second, third, fourth },
      winTeam, base, tugBonus, leftover, total, losers, winners,
    };
    return this.result;
  }
}
