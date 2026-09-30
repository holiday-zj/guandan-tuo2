// 出牌提示：枚举手牌能组成的所有合法牌型
// lead(): 领出候选；follow(target): 能压过 target 的候选（按从小到大排序）
import { RANK_ORDER, isWild, isJoker, orderValue } from './cards.js';
import { classifyNatural, canBeat, beatScore } from './classify.js';

const SUITS = ['♠', '♥', '♣', '♦'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
// 注意：A 不连回 2（掼蛋顺子只允许 A2345 特例与 10JQKA，其余牌型不允许绕 A）
const NEXT = { '2': '3', '3': '4', '4': '5', '5': '6', '6': '7', '7': '8', '8': '9', '9': 'T', 'T': 'J', 'J': 'Q', 'Q': 'K', 'K': 'A' };

function byValueDesc(level) {
  return (a, b) => orderValue(b.rank, level) - orderValue(a.rank, level);
}

// 将手牌按"自然点数分组"，逢人配单独成池
function group(hand, level) {
  const wilds = hand.filter(c => isWild(c, level));
  const groups = new Map(); // rank -> cards[]
  let bj = [], sj = [];
  for (const c of hand) {
    if (isWild(c, level)) continue;
    if (c.rank === 'BJ') { bj.push(c); continue; }
    if (c.rank === 'SJ') { sj.push(c); continue; }
    if (!groups.has(c.rank)) groups.set(c.rank, []);
    groups.get(c.rank).push(c);
  }
  return { wilds, groups, bj, sj };
}

// 领出候选枚举
export function leadOptions(hand, level, cap = 120) {
  const out = [];
  const { wilds, groups, bj, sj } = group(hand, level);
  const rankList = RANKS.filter(r => groups.has(r));

  function push(cards) {
    const it = classifyNatural(cards, level)[0];
    if (it) out.push({ cards, it });
    if (out.length >= cap) return true;
    return false;
  }

  // —— 单张：每种点数一张（从小到大）——
  const singles = [];
  for (const r of RANKS) if (groups.has(r)) singles.push(groups.get(r)[0]);
  if (sj.length) singles.push(sj[0]);
  if (bj.length) singles.push(bj[0]);
  // 逢人配也可单独作为级牌单张打出（否则手里只剩逢人配时无任何候选 → 死锁）
  if (wilds.length) singles.push(wilds[0]);
  singles.sort((a, b) => orderValue(a.rank, level) - orderValue(b.rank, level));
  for (const c of singles) { if (push([c])) return done(out); }

  // —— 对子 / 三张 / 炸弹（按点数）——
  for (const r of RANKS) {
    const cs = groups.get(r);
    if (!cs) continue;
    if (cs.length >= 2) { if (push(cs.slice(0, 2))) return done(out); }
    if (cs.length >= 3) { if (push(cs.slice(0, 3))) return done(out); }
    if (cs.length >= 4) { if (push(cs.slice(0, cs.length))) return done(out); }
  }
  // 逢人配补对（与单张配成对）：把逢人配替换成该点数
  if (wilds.length) {
    for (const r of RANKS) {
      const cs = groups.get(r);
      if (cs && cs.length === 1) {
        const sub = { id: wilds[0].id, suit: wilds[0].suit, rank: r };
        if (push([cs[0], sub])) return done(out);
      }
    }
  }

  // —— 三带二 ——
  for (const r3 of RANKS) {
    const t = groups.get(r3);
    if (!t || t.length < 3) continue;
    for (const r2 of RANKS) {
      if (r2 === r3) continue;
      const p = groups.get(r2);
      if (p && p.length >= 2) { if (push([...t.slice(0, 3), ...p.slice(0, 2)])) return done(out); break; }
    }
  }

  // —— 顺子（5张自然连）——
  const runs5 = straightRuns(rankList, 5);
  for (const run of runs5) {
    const cards = run.map(r => groups.get(r)[0]);
    if (push(cards)) return done(out);
    // 同花顺
    for (const suit of SUITS) {
      const sf = run.map(r => groups.get(r).find(c => c.suit === suit)).filter(Boolean);
      if (sf.length === 5) { if (push(sf)) return done(out); }
    }
  }

  // —— 三连对 ——
  for (let i = 0; i < RANKS.length; i++) {
    const run = [RANKS[i], NEXT[RANKS[i]]];
    // 3 连对需 3 个连续点数，每个≥2张
    const r1 = RANKS[i], r2 = NEXT[r1], r3 = NEXT[r2];
    if (!r3) continue;
    const cs = [groups.get(r1), groups.get(r2), groups.get(r3)];
    if (cs.every(c => c && c.length >= 2)) {
      if (push([...cs[0].slice(0, 2), ...cs[1].slice(0, 2), ...cs[2].slice(0, 2)])) return done(out);
    }
  }

  // —— 钢板（两组连续三张）——
  for (const r1 of RANKS) {
    const r2 = NEXT[r1];
    if (!r2) continue;
    const c1 = groups.get(r1), c2 = groups.get(r2);
    if (c1 && c1.length >= 3 && c2 && c2.length >= 3) {
      if (push([...c1.slice(0, 3), ...c2.slice(0, 3)])) return done(out);
    }
  }

  // —— 四大天王 ——
  if (bj.length === 2 && sj.length === 2) {
    if (push([...bj, ...sj])) return done(out);
  }

  // —— 炸弹（含逢人配）：4+张同点数 ——
  if (wilds.length) {
    for (const r of RANKS) {
      const cs = groups.get(r) || [];
      const need = 4 - cs.length;
      if (cs.length >= 2 && need > 0 && wilds.length >= need) {
        if (push([...cs, ...wilds.slice(0, need)])) return done(out);
      }
    }
  }

  return done(out);
}

function straightRuns(rankList, len) {
  const set = new Set(rankList);
  const runs = [];
  for (let i = 0; i < RANKS.length; i++) {
    const run = [];
    let r = RANKS[i];
    while (run.length < len && r && set.has(r)) { run.push(r); r = NEXT[r]; }
    if (run.length === len) runs.push(run);
  }
  // A2345 特例
  if (['A', '2', '3', '4', '5'].every(r => set.has(r))) runs.push(['A', '2', '3', '4', '5']);
  return runs;
}

function done(out) {
  return out;
}

// 跟牌候选：能压过 target 的（target 为 interpretation），从小到大
export function followOptions(hand, level, target, cap = 60) {
  const opts = leadOptions(hand, level, 400);
  const fits = [];
  for (const o of opts) {
    if (canBeat(o.it, target)) fits.push(o);
  }
  fits.sort((a, b) => {
    const sa = beatScore(a.it), sb = beatScore(b.it);
    for (let i = 0; i < 3; i++) {
      const x = sa[i] ?? 0, y = sb[i] ?? 0;
      if (x !== y) return x - y;
    }
    return 0;
  });
  return fits.slice(0, cap);
}
