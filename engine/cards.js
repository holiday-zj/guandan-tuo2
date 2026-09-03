// 掼蛋（安徽拖2）基础牌张工具
export const SUITS = ['♠', '♥', '♣', '♦'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
// 自然点数：'2'→2 … 'A'→14（顺子等牌型使用自然点数，级牌也按牌点插入）
export const RANK_ORDER = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));

// 两副牌共 108 张（含大小王各两张）
export function makeDeck() {
  const cards = [];
  let id = 0;
  for (let d = 0; d < 2; d++) {
    for (const suit of SUITS)
      for (const rank of RANKS)
        cards.push({ id: id++, suit, rank });
    cards.push({ id: id++, suit: 'X', rank: 'SJ' }); // 小王
    cards.push({ id: id++, suit: 'X', rank: 'BJ' }); // 大王
  }
  return cards;
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 亮牌是几就打几+1（亮A打2，亮K打A）
export function levelFromFlip(flipRank) {
  return RANKS[(RANKS.indexOf(flipRank) + 1) % 13];
}

// 拖（全场最小的牌）：打2拖3，其余一律拖2
export function tugRank(level) {
  return level === '2' ? '3' : '2';
}

// 牌力值：大王17 > 小王16 > 级牌15 > A(14) > K … > 2
export function orderValue(rank, level) {
  if (rank === 'BJ') return 17;
  if (rank === 'SJ') return 16;
  if (rank === level) return 15;
  return RANK_ORDER[rank];
}

// 逢人配：红桃级牌，可搭配除大小王外的任意牌
export function isWild(card, level) {
  return card.suit === '♥' && card.rank === level;
}

export function isJoker(card) {
  return card.suit === 'X';
}

// 一张拖牌贡献的级数：红拖=2级，普通拖=1级，非拖牌=0
export function tugValueOf(card, level) {
  if (card.rank !== tugRank(level)) return 0;
  return card.suit === '♥' ? 2 : 1;
}

export function cardLabel(card) {
  const R = { T: '10', SJ: '小王', BJ: '大王' };
  const r = R[card.rank] || card.rank;
  return card.suit === 'X' ? r : card.suit + r;
}
