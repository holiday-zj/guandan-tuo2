// 牌型识别（支持逢人配通配）
import { RANK_ORDER, isWild, isJoker } from './cards.js';

// 牌型类别
export const SHAPE = {
  SINGLE: 'single', PAIR: 'pair', TRIPLE: 'triple', TRIPLE_PAIR: 'triple_pair',
  STRAIGHT: 'straight', PAIR_STRAIGHT: 'pair_straight', TRIPLE_STRAIGHT: 'triple_straight',
  BOMB: 'bomb', STRAIGHT_FLUSH: 'straight_flush', KINGS: 'kings',
};

// 牌型"形状"（同形状才能互压）
export function shapeClass(it) {
  if (it.type === 'bomb') return 'bomb';
  if (it.type === 'straight_flush') return 'straight_flush';
  if (it.type === 'kings') return 'kings';
  return it.type;
}

// 用于压制比较的得分（越大越强）
// 天王(9) > 炸弹:6+张(8,长度>值) > 同花顺(7) > 炸弹:<=5张(6,值) > 普通牌型(值,同形状才可比)
export function beatScore(it) {
  switch (it.type) {
    case 'kings': return [9, 0];
    case 'bomb': return it.len >= 6 ? [8, it.len, it.value] : [6, it.len, it.value];
    case 'straight_flush': return [7, it.value];
    default: return [0, 0, it.value];
  }
}

function cmpScore(a, b) {
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? -1, y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

function seqStart(vals, len) {
  // vals: 升序去重的自然点数数组；返回合法连续序列的起点，否则 0
  if (vals.length !== len) return 0;
  if (vals[len - 1] - vals[0] === len - 1) return vals[0];
  // A2345 特例：必须严格是 {2,3,4,5,14}
  if (len === 5 && vals.join(',') === '2,3,4,5,14') return 1;
  return 0;
}

// 纯自然牌（无逢人配参与）的牌型识别，返回数组（同花顺+炸弹可同时成立等情形）
export function classifyNatural(cards, level) {
  const n = cards.length;
  if (n === 0) return [];
  const out = [];
  if (n === 4 && cards.every(c => c.rank === 'BJ' || c.rank === 'SJ')) {
    const bj = cards.filter(c => c.rank === 'BJ').length;
    if (bj === 2) out.push({ type: 'kings', cards });
  }
  const counts = new Map(); // rank -> count
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
  const groups = [...counts.entries()];
  const jokerIn = cards.some(isJoker);

  if (!jokerIn) {
    const vals = groups.filter(([r]) => r !== 'BJ' && r !== 'SJ')
      .map(([r]) => RANK_ORDER[r]).sort((a, b) => a - b);
    const uniq = [...new Set(vals)];
    // 顺子 / 同花顺（5张）
    if (n === 5 && uniq.length === 5) {
      const start = seqStart(uniq, 5);
      if (start) {
        const top = start === 1 ? 5 : start + 4;
        const suits = new Set(cards.map(c => c.suit));
        if (suits.size === 1) out.push({ type: 'straight_flush', value: top, cards });
        else out.push({ type: 'straight', value: top, cards });
      }
    }
    // 三连对
    if (n === 6 && groups.length === 3 && groups.every(([, c]) => c === 2)) {
      const start = seqStart(uniq, 3);
      if (start) out.push({ type: 'pair_straight', value: start + 2, cards });
    }
    // 钢板（两组连续三张）
    if (n === 6 && groups.length === 2 && groups.every(([, c]) => c === 3)) {
      const start = seqStart(uniq, 2);
      if (start) out.push({ type: 'triple_straight', value: start + 1, cards });
    }
  }
  // 单/对/三/三带二/炸弹（按点数分组）
  if (groups.length === 1) {
    const [rank, cnt] = groups[0];
    const value = rank === 'BJ' ? 17 : rank === 'SJ' ? 16 : rank === level ? 15 : RANK_ORDER[rank];
    if (cnt === 1) out.push({ type: 'single', value, cards });
    else if (cnt === 2) out.push({ type: 'pair', value, cards });
    else if (cnt === 3) out.push({ type: 'triple', value, cards });
    else if (cnt >= 4) out.push({ type: 'bomb', len: cnt, value, cards });
  } else if (groups.length === 2 && n === 5 && !jokerIn) {
    const sorted = groups.slice().sort((a, b) => b[1] - a[1]);
    if (sorted[0][1] === 3 && sorted[1][1] === 2) {
      const [r3] = sorted[0];
      const value = r3 === level ? 15 : RANK_ORDER[r3];
      out.push({ type: 'triple_pair', value, cards });
    }
  }
  return out;
}

const ALL_SUB = (() => {
  const subs = [];
  const suits = ['♠', '♥', '♣', '♦'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  for (const s of suits) for (const r of ranks) subs.push({ suit: s, rank: r });
  return subs;
})();

// 一手牌的全部可能牌型解释（逢人配穷举替换，通配数≤3，量级可控）
export function interpret(cards, level) {
  const wilds = cards.filter(c => isWild(c, level));
  const naturals = cards.filter(c => !isWild(c, level));
  const results = [];

  function walk(i, current) {
    if (i === wilds.length) {
      // 必须传副本：current 会被后续 push/pop 复用，
      // 若直接传引用，返回结果里的 cards 最终都会变成空数组，
      // 导致 canBeat 比较 cards.length 时把逢人配牌型误判为"压不过"
      for (const it of classifyNatural(current.slice(), level)) results.push(it);
      return;
    }
    for (const sub of ALL_SUB) {
      current.push(sub);
      walk(i + 1, current);
      current.pop();
    }
  }
  walk(0, naturals.slice());
  return results;
}

// 该手牌能形成的"最强"解释（用于展示/出牌成立判定）
export function bestInterpretation(cards, level) {
  let best = null, bestScore = null;
  for (const it of interpret(cards, level)) {
    const s = beatScore(it);
    if (!best || cmpScore(s, bestScore) > 0) { best = it; bestScore = s; }
  }
  return best;
}

// 压制判定：playB 是否压过 playA（均为 interpret 结果）
export function canBeat(b, a) {
  if (!a) return true;
  const sb = beatScore(b), sa = beatScore(a);
  if (sb[0] !== 0 || sa[0] !== 0) return cmpScore(sb, sa) > 0; // 含炸弹/天王/同花顺
  if (shapeClass(b) !== shapeClass(a)) return false;
  if (b.cards.length !== a.cards.length) return false;
  return b.value > a.value;
}
