// 整副牌对局驱动：管理出牌轮转、过牌、接风、终局
export function playRound(round, bots, opts = {}) {
  const r = round;
  r.finishedByPlay = {};          // seat -> 脱手牌（用于拖级判定）
  let best = null;                // {cards, by} 当前圈内最大牌
  let consecutivePasses = 0;
  let leader = r.lead;
  let turn = leader;
  let guard = 0;
  const active = s => !r.finishOrder.includes(s);
  const activeCount = () => [0, 1, 2, 3].filter(active).length;

  while (r.state === 'playing') {
    if (++guard > 20000) throw new Error('round did not terminate');
    if (!active(turn)) { turn = (turn + 1) % 4; continue; }
    r.lead = turn; // 同步引擎的出牌权
    const bot = bots[turn];
    const action = best === null ? bot.lead(r, turn) : bot.respond(r, turn, best);

    if (action === null) {
      // 过牌
      if (best === null) throw new Error('cannot pass when leading');
      consecutivePasses++;
      const needPasses = activeCount() - (active(best.by) ? 1 : 0);
      if (consecutivePasses >= needPasses) {
        // 一圈结束：最后出牌者获胜
        let next = active(best.by) ? best.by : (best.by + 2) % 4; // 接风
        if (!active(next)) {
          // 终局：补齐剩余名次（剩余者按座位序记三游/末游）
          for (let s = 0; s < 4; s++) if (!r.finishOrder.includes(s)) r.finishOrder.push(s);
          r.state = 'finished';
          break;
        }
        best = null;
        consecutivePasses = 0;
        leader = next;
        r.lead = leader;
        r.trick = null;
        turn = leader;
        continue;
      }
      turn = (turn + 1) % 4;
      continue;
    }

    const ev = r.act(turn, action);
    if (!ev.ok) {
      if (opts.strict) throw new Error(`illegal play at seat ${turn}: ${ev.error}`);
      consecutivePasses++; // 非法出牌按过牌处理
      turn = (turn + 1) % 4;
      continue;
    }
    best = { cards: action, it: ev.play, by: turn };
    consecutivePasses = 0;
    if (ev.finished) r.finishedByPlay[turn] = action.slice();
    if (r.state === 'finished') break;
    turn = (turn + 1) % 4;
  }
  return r;
}

// 极简机器人：只出单张（保证收敛，用于引擎压测）
import { bestInterpretation, canBeat } from './classify.js';

export function makeSimpleBot(seed = 1) {
  const byValue = (r, level) => (a, b) => {
    const va = a.rank === 'BJ' ? 17 : a.rank === 'SJ' ? 16 : a.rank === level ? 15 : '23456789TJQKA'.indexOf(a.rank) + 2;
    const vb = b.rank === 'BJ' ? 17 : b.rank === 'SJ' ? 16 : b.rank === level ? 15 : '23456789TJQKA'.indexOf(b.rank) + 2;
    return va - vb;
  };
  return {
    lead(r, seat) {
      const hand = r.hands[seat].slice().sort(byValue(r, r.level));
      return [hand[0]]; // 出最小单张
    },
    respond(r, seat, best) {
      const hand = r.hands[seat].slice().sort(byValue(r, r.level));
      // 只对单张响应：找最小的可压制单张（用引擎验证合法性）
      if (best.cards.length === 1) {
        for (const c of hand) {
          const it = bestInterpretation([c], r.level);
          if (it && canBeat(it, best.it)) return [c];
        }
      }
      return null; // 过
    },
  };
}
