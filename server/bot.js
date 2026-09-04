// 服务端机器人：轮到 bot 座位时自动出牌（领出最小单张，能压则压）
import { bestInterpretation, canBeat } from '../engine/classify.js';

function valueOf(c, level) {
  return c.rank === 'BJ' ? 17 : c.rank === 'SJ' ? 16 : c.rank === level ? 15 : '23456789TJQKA'.indexOf(c.rank) + 2;
}

// 返回动作 {type:'play',cards:[{id}]} 或 {type:'pass'}
export function botDecide(session, seat) {
  const r = session.match.round;
  const d = session.driver;
  const hand = r.hands[seat];
  const level = r.level;
  const sorted = hand.slice().sort((a, b) => valueOf(a, level) - valueOf(b, level));

  // 领出：出最小的单张（首攻不允许纯拖牌，跳过拖牌）
  if (!d.best) {
    for (const c of sorted) {
      if (!r.led && c.rank === r.tug) continue; // 首攻禁拖
      return { type: 'play', cards: [{ id: c.id }] };
    }
    return { type: 'play', cards: [{ id: sorted[0].id }] };
  }
  // 锁定牌圈（头游纯拖）：只能过
  if (r.trick && r.trick.locked) return { type: 'pass' };
  // 跟牌：只对单张尝试压制，找最小的能压的单张
  if (d.best.cards.length === 1) {
    const target = bestInterpretation(d.best.cards, level);
    for (const c of sorted) {
      const it = bestInterpretation([c], level);
      if (it && target && canBeat(it, target)) return { type: 'play', cards: [{ id: c.id }] };
    }
  }
  return { type: 'pass' };
}
