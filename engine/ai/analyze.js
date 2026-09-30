// AI 分析层：算牌（牌张计数推断）、手数分解、牌力评估、拖牌策略
// 全部为确定性计算——不依赖大模型，可单测、可压测
import { RANKS, SUITS, isWild, isJoker, orderValue, tugRank, tugValueOf } from '../cards.js';
import { classifyNatural, beatScore } from '../classify.js';

// 两副牌：每个点数 8 张（2副×4花色），大小王各 2 张
export const TOTAL_OF_RANK = (() => {
  const m = {};
  for (const r of RANKS) m[r] = 8;
  m.SJ = 2; m.BJ = 2;
  return m;
})();

/* ============ 1. 出牌追踪器：算牌的唯一信息来源（只用公开信息）============ */
export class PlayTracker {
  constructor() { this.reset(null, null); }

  reset(level, tug) {
    this.level = level;
    this.tug = tug || (level ? tugRank(level) : null);
    this.plays = [];          // [{seat, cards|null, shape}]  null=过牌
    this.playedBySeat = [0, 0, 0, 0];   // 各家已打出的张数
    this.passCount = [0, 0, 0, 0];      // 各家过牌次数（判断"压不动"的信号）
    this.seenRank = {};                 // rank -> 已公开张数
    this.finishOrder = [];
  }

  // 记录一次公开动作（cards=null 表示过牌）
  record(seat, cards, shape) {
    if (!cards || !cards.length) {
      this.passCount[seat] = (this.passCount[seat] || 0) + 1;
      this.plays.push({ seat, cards: null, shape: 'pass' });
      return;
    }
    this.plays.push({ seat, cards, shape });
    this.playedBySeat[seat] += cards.length;
    for (const c of cards) this.seenRank[c.rank] = (this.seenRank[c.rank] || 0) + 1;
  }

  syncFinish(finishOrder) { this.finishOrder = finishOrder.slice(); }

  // 剩余未知张数（全场总数 - 已公开）。注意：不含自己手牌，调用方需再减
  unseenOf(rank) {
    return (TOTAL_OF_RANK[rank] || 0) - (this.seenRank[rank] || 0);
  }

  /**
   * 从"我"的视角算牌：扣除自己手牌后，其余三家合计还可能持有的张数
   * @returns {rank: n}  n>0 表示对手/队友手中可能还有
   */
  remainingOutside(myHand) {
    const mine = {};
    for (const c of myHand) mine[c.rank] = (mine[c.rank] || 0) + 1;
    const out = {};
    for (const rank of Object.keys(TOTAL_OF_RANK)) {
      const n = this.unseenOf(rank) - (mine[rank] || 0);
      out[rank] = Math.max(0, n);
    }
    return out;
  }

  // 各家剩余手牌张数（发牌27张 + 进贡还贡微调，用已打出张数反推）
  handCounts(initial = 27) {
    return this.playedBySeat.map(p => Math.max(0, initial - p));
  }
}

/* ============ 2. 手牌分解：估算"手数"（清空手牌所需最少出牌次数）============ */
// 掼蛋里手数越少牌力越强，是判断"该抢头游还是该弃疗"的核心指标
const NEXT = { '2': '3', '3': '4', '4': '5', '5': '6', '6': '7', '7': '8', '8': '9', '9': 'T', 'T': 'J', 'J': 'Q', 'Q': 'K', 'K': 'A' };

export function decompose(hand, level) {
  const cards = hand.slice();
  const wilds = cards.filter(c => isWild(c, level));
  const pools = new Map();   // rank -> cards[]
  const jokers = [];
  for (const c of cards) {
    if (isWild(c, level)) continue;
    if (isJoker(c)) { jokers.push(c); continue; }
    if (!pools.has(c.rank)) pools.set(c.rank, []);
    pools.get(c.rank).push(c);
  }

  const combos = [];      // 普通牌型（要出的）
  const controls = [];    // 控制张（炸弹/同花顺/天王，留着压人）

  const take = (rank, n) => {
    const arr = pools.get(rank) || [];
    const got = arr.splice(0, n);
    if (!arr.length) pools.delete(rank);
    else pools.set(rank, arr);
    return got;
  };
  const count = rank => (pools.get(rank) || []).length;

  // 2.1 天王炸（4王）
  if (jokers.filter(c => c.rank === 'BJ').length === 2 && jokers.filter(c => c.rank === 'SJ').length === 2) {
    controls.push({ type: 'kings', cards: jokers.splice(0, 4), power: 99 });
  }

  // 2.2 炸弹（4+张同点）与同花顺：优先识别，作为控制张
  for (const rank of RANKS) {
    while (count(rank) >= 4) {
      const cs = take(rank, count(rank) >= 5 ? count(rank) : 4);
      controls.push({ type: 'bomb', cards: cs, power: 40 + cs.length * 4 + orderValue(rank, level) });
    }
  }
  // 同花顺：5张同花连续（从剩余牌里找）
  for (const suit of SUITS) {
    for (let i = 0; i < RANKS.length; i++) {
      const run = [];
      let r = RANKS[i];
      while (run.length < 5 && r && (pools.get(r) || []).some(c => c.suit === suit)) {
        run.push(r); r = NEXT[r];
      }
      if (run.length === 5) {
        const cs = run.map(rr => {
          const arr = pools.get(rr) || [];
          const idx = arr.findIndex(c => c.suit === suit);
          return idx >= 0 ? arr.splice(idx, 1)[0] : null;
        }).filter(Boolean);
        if (cs.length === 5) {
          for (const rr of run) { const a = pools.get(rr); if (a && !a.length) pools.delete(rr); }
          controls.push({ type: 'straight_flush', cards: cs, power: 70 + orderValue(run[4], level) });
        }
      }
    }
  }
  // A2345 同花顺特例
  for (const suit of SUITS) {
    const need = ['A', '2', '3', '4', '5'];
    if (need.every(rr => (pools.get(rr) || []).some(c => c.suit === suit))) {
      const cs = need.map(rr => {
        const arr = pools.get(rr) || [];
        const idx = arr.findIndex(c => c.suit === suit);
        return arr.splice(idx, 1)[0];
      });
      for (const rr of need) { const a = pools.get(rr); if (a && !a.length) pools.delete(rr); }
      controls.push({ type: 'straight_flush', cards: cs, power: 68 });
    }
  }

  // 2.3 钢板（两组连续三张）
  for (const r1 of RANKS) {
    const r2 = NEXT[r1];
    if (!r2) continue;
    if (count(r1) >= 3 && count(r2) >= 3) {
      combos.push({ type: 'triple_straight', cards: [...take(r1, 3), ...take(r2, 3)] });
    }
  }
  // 2.4 三连对（木板）
  for (const r1 of RANKS) {
    const r2 = NEXT[r1], r3 = r2 && NEXT[r2];
    if (!r3) continue;
    if (count(r1) >= 2 && count(r2) >= 2 && count(r3) >= 2) {
      combos.push({ type: 'pair_straight', cards: [...take(r1, 2), ...take(r2, 2), ...take(r3, 2)] });
    }
  }
  // 2.5 顺子（5张）
  outer: for (let i = 0; i < RANKS.length; i++) {
    const run = [];
    let r = RANKS[i];
    while (run.length < 5 && r && count(r) >= 1) { run.push(r); r = NEXT[r]; }
    if (run.length === 5) {
      combos.push({ type: 'straight', cards: run.map(rr => take(rr, 1)) });
      // 同一起点可能还有第二副顺子（两副牌），继续找
      i--;
      if (combos.length > 40) break outer;
    }
  }
  // A2345 顺子特例
  if (['A', '2', '3', '4', '5'].every(rr => count(rr) >= 1)) {
    combos.push({ type: 'straight', cards: ['A', '2', '3', '4', '5'].map(rr => take(rr, 1)) });
  }
  // 2.6 三带二
  for (const rank of RANKS) {
    if (count(rank) >= 3) {
      const tri = take(rank, 3);
      let pair = null;
      // 找最小的对子做搭配（保留大牌）
      const sortedRanks = RANKS.slice().sort((a, b) => orderValue(a, level) - orderValue(b, level));
      for (const rr of sortedRanks) {
        if (rr === rank) continue;
        if (count(rr) >= 2) { pair = take(rr, 2); break; }
      }
      if (pair) combos.push({ type: 'triple_pair', cards: [...tri, ...pair] });
      else combos.push({ type: 'triple', cards: tri });
    }
  }
  // 2.7 剩余三张
  for (const rank of RANKS) if (count(rank) >= 3) combos.push({ type: 'triple', cards: take(rank, 3) });
  // 2.8 剩余对子
  for (const rank of RANKS) while (count(rank) >= 2) combos.push({ type: 'pair', cards: take(rank, 2) });
  // 2.9 剩余单张（从小到大）
  const leftoverRanks = RANKS.slice().sort((a, b) => orderValue(a, level) - orderValue(b, level));
  for (const rank of leftoverRanks) while (count(rank) >= 1) combos.push({ type: 'single', cards: take(rank, 1) });
  // 2.10 剩余王：同点王成对（大王对/小王对都是强对子），否则单出
  for (const jr of ['BJ', 'SJ']) {
    let same = jokers.filter(c => c.rank === jr);
    while (same.length >= 2) {
      const a = same.shift(), b = same.shift();
      jokers.splice(jokers.indexOf(a), 1);
      jokers.splice(jokers.indexOf(b), 1);
      combos.push({ type: 'pair', cards: [a, b] });
    }
  }
  for (const c of jokers) combos.push({ type: 'single', cards: [c] });
  // 逢人配单独作为万能张保留（不占手数，用于补关键牌型）
  const wildList = wilds.slice();

  // 手数 = 普通牌型数（逢人配可抵消一手）
  const hands = Math.max(1, combos.length - wildList.length);
  return { combos, controls, wilds: wildList, hands };
}

/* ============ 3. 牌力评估 ============ */
export function handStrength(hand, level, tracker, ctx = {}) {
  const d = decompose(hand, level);
  const remaining = tracker ? tracker.remainingOutside(hand) : null;

  // 控制张实力
  let controlPower = 0;
  for (const c of d.controls) controlPower += c.power;

  // 顶张（级牌/王/A）数量：单张压制力
  let topCards = 0;
  for (const c of hand) {
    const v = orderValue(c.rank, level);
    if (v >= 14 && !isWild(c, level)) topCards++;
  }

  // 手数越少越强：27张起手，手数≤5 极强，≥10 极弱
  const handsScore = Math.max(0, 12 - d.hands) * 6;

  const score = handsScore + controlPower * 0.55 + topCards * 3 + d.wilds.length * 8;

  // 我方可控的关键牌：我出的某点数，外面已经没有了 → 绝对控制
  const sureWins = [];
  if (remaining) {
    for (const rank of RANKS) {
      if (remaining[rank] === 0 && hand.some(c => c.rank === rank && !isWild(c, level))) {
        sureWins.push(rank);
      }
    }
    if (remaining.SJ === 0 && hand.some(c => c.rank === 'SJ')) sureWins.push('SJ');
    if (remaining.BJ === 0 && hand.some(c => c.rank === 'BJ')) sureWins.push('BJ');
  }

  let label;
  if (score >= 95) label = '极强';
  else if (score >= 72) label = '强';
  else if (score >= 50) label = '中等';
  else if (score >= 32) label = '偏弱';
  else label = '弱';

  return {
    score: Math.round(score), label, hands: d.hands,
    controls: d.controls, controlCount: d.controls.length,
    topCards, wildCount: d.wilds.length, sureWins, decompose: d,
  };
}

/* ============ 4. 拖牌策略：留还是早出（核心需求）============ */
/**
 * @returns {{policy:'keep'|'dump'|'partial', tugsInHand:number, tugValue:number, reason:string}}
 *
 * keep   —— 牌力强，争头游/二游：把拖牌留到最后一手打出（纯拖计分，红拖×2；
 *           头游末手纯拖还不可压+强制接风队友）
 * dump   —— 牌力弱，大概率末游：尽早把拖牌甩出去。末游手里每剩一张拖牌
 *           就给对方 +1 级，闷在手里等于送分
 * partial—— 中等：留少量搏一把，其余早出
 */
export function tugPolicy(hand, level, strength, ctx = {}) {
  const tug = tugRank(level);
  const tugs = hand.filter(c => c.rank === tug);
  const tugValue = tugs.reduce((s, c) => s + tugValueOf(c, level), 0);
  const { partnerRank, myRankGuess, teammateStrong, handCounts } = ctx;

  if (!tugs.length) return { policy: 'keep', tugsInHand: 0, tugValue: 0, reason: '手中无拖牌' };

  // 已经是头游/二游在望（手牌很少）→ 死留拖牌到末手
  const myCount = hand.length;
  if (myCount <= tugs.length + 2 && strength.score >= 45) {
    return { policy: 'keep', tugsInHand: tugs.length, tugValue,
      reason: `仅剩${myCount}张，冲刺头游，拖牌留作末手计分(+${tugValue}级)` };
  }

  // 牌力强 → 留
  if (strength.score >= 72) {
    return { policy: 'keep', tugsInHand: tugs.length, tugValue,
      reason: `牌力${strength.label}(${strength.score}分,${strength.hands}手数)，争头游，拖牌留末手(+${tugValue}级)` };
  }

  // 牌力弱 → 尽早甩掉，避免当末游被算罚分
  if (strength.score < 45) {
    return { policy: 'dump', tugsInHand: tugs.length, tugValue,
      reason: `牌力${strength.label}(${strength.score}分)，恐成末游，拖牌早出以免被罚(每张+1级给对方)` };
  }

  // 中等：看队友。队友强 → 我拖牌留着没意义（双上才两人都计分，但我成不了头游），
  //        不如早出减轻负担；队友弱 → 我搏一把
  if (teammateStrong) {
    return { policy: 'dump', tugsInHand: tugs.length, tugValue,
      reason: `牌力中等且队友更强，我难拿头游，拖牌早出避免末游罚分` };
  }
  return { policy: 'partial', tugsInHand: tugs.length, tugValue,
    reason: `牌力中等(${strength.score}分)，留${Math.ceil(tugs.length / 2)}张搏头游，其余早出` };
}

/* ============ 5. 团队局势判断 ============ */
export function teamSituation(seat, round, tracker, strengths) {
  const r = round;
  const partner = (seat + 2) % 4;
  const opps = [(seat + 1) % 4, (seat + 3) % 4];
  const teamOf = r.teamOf;
  const finished = r.finishOrder;
  const alive = s => !finished.includes(s);

  const myTeam = teamOf[seat];
  const partnerSameTeam = teamOf[partner] === myTeam;

  // 名次态势
  const myRankGuess = finished.includes(seat) ? finished.indexOf(seat) + 1 : null;
  const partnerRank = finished.includes(partner) ? finished.indexOf(partner) + 1 : null;
  const myTeamFinishCount = finished.filter(s => teamOf[s] === myTeam).length;
  const oppFinishCount = finished.filter(s => teamOf[s] !== myTeam).length;

  // 双上机会：我队已拿头游，我或队友有望二游
  const doubleWinChance = myTeamFinishCount === 1 && finished[0] !== undefined
    && teamOf[finished[0]] === myTeam && alive(seat) || (myTeamFinishCount === 1 && alive(partner));

  return {
    partner, opps, myTeam, partnerSameTeam,
    partnerRank, myRankGuess,
    myTeamFinishCount, oppFinishCount,
    doubleWinChance: !!doubleWinChance,
    // 对手是否快要出完（需要压制/上炸）
    oppUrgent: opps.some(s => alive(s) && tracker && tracker.handCounts()[s] <= 3),
    partnerUrgent: alive(partner) && tracker && tracker.handCounts()[partner] <= 3,
    teammateStrong: partnerSameTeam && strengths && strengths[partner]
      ? strengths[partner].score > (strengths[seat] ? strengths[seat].score : 0) : false,
  };
}

/* ============ 6. 文本化牌情（供大模型阅读）============ */
export function describeTable(round, seat, tracker, strengths) {
  const r = round;
  const level = r.level, tug = r.tug;
  const teamOf = r.teamOf;
  const names = ['下家(对手)', '对家(队友)', '上家(对手)'];
  const rel = s => ((s - seat + 4) % 4);  // 0=我 1=下家 2=对家 3=上家
  const handCounts = tracker ? tracker.handCounts() : [27, 27, 27, 27];
  const remaining = tracker ? tracker.remainingOutside(r.hands[seat]) : null;
  const st = strengths && strengths[seat];
  const lines = [];

  lines.push(`本副打${level}(级牌${level})，拖牌=${tug}(红桃${tug}算2级)`);
  lines.push(`座位：我=${seat}队${teamOf[seat]}；对家=${(seat + 2) % 4}队${teamOf[(seat + 2) % 4]}${teamOf[(seat + 2) % 4] === teamOf[seat] ? '(同队)' : '(注意:非同队!)'}`);

  // 各家剩余张数与已得名次
  const parts = [];
  for (let s = 0; s < 4; s++) {
    const rankIdx = r.finishOrder.indexOf(s);
    const tag = s === seat ? '我' : rel(s) === 2 ? '对家(队友)' : rel(s) === 1 ? '下家(对手)' : '上家(对手)';
    parts.push(`${tag}${s}: ${rankIdx >= 0 ? ['头游', '二游', '三游', '末游'][rankIdx] : `剩${handCounts[s]}张`}`);
  }
  lines.push('进度：' + parts.join(' | '));

  // 我的牌力
  if (st) {
    lines.push(`我的牌力：${st.label}(${st.score}分)，手数≈${st.hands}，控制张${st.controlCount}个`
      + (st.controls.length ? '(' + st.controls.map(c => c.type === 'kings' ? '天王' : c.type === 'bomb' ? `${c.cards.length}炸` : '同花顺').join(',') + ')' : '')
      + (st.wildCount ? `，逢人配${st.wildCount}张` : '')
      + (st.sureWins.length ? `，绝对控制点数:${st.sureWins.join('/')}` : ''));
  }

  // 算牌结论：外面还剩哪些关键牌
  if (remaining) {
    const key = [];
    for (const rank of ['BJ', 'SJ', level, tug, 'A', 'K']) {
      const n = remaining[rank];
      if (n !== undefined) key.push(`${rank === 'BJ' ? '大王' : rank === 'SJ' ? '小王' : rank === level ? '级牌' + level : rank === tug ? '拖牌' + tug : rank}×${n}`);
    }
    lines.push('外面剩余(三家合计)：' + key.join(' '));
    const bombThreat = RANKS.filter(rk => remaining[rk] >= 4);
    if (bombThreat.length) lines.push(`⚠ 对手可能成炸的点数：${bombThreat.join(',')}`);
  }

  // 过牌信号
  if (tracker) {
    const sig = [];
    for (let s = 0; s < 4; s++) {
      if (s === seat) continue;
      if (tracker.passCount[s] >= 3) sig.push(`${rel(s) === 2 ? '对家' : rel(s) === 1 ? '下家' : '上家'}已过${tracker.passCount[s]}次(牌力弱或压不动)`);
    }
    if (sig.length) lines.push('信号：' + sig.join('；'));
  }
  return lines.join('\n');
}
