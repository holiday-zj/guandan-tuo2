// 服务端机器人决策
//   botDecide      —— 旧同步极简逻辑（保底，AI层异常时使用）
//   botDecideAsync —— 主决策：LLM 出牌（大模型判断）+ 启发式保底，永不阻塞
import { bestInterpretation, canBeat } from '../engine/classify.js';
import { decideAsync, hintAsync } from '../engine/ai/decide.js';

// 机器人思考时间下限（毫秒）：让节奏自然，也避免LLM未配置时刷屏
const THINK_MIN_MS = Number(process.env.BOT_THINK_MIN || 400);
// 单次 LLM 决策超时（毫秒），超时自动降级启发式
const LLM_TIMEOUT_MS = Number(process.env.BOT_LLM_TIMEOUT || 9000);
// 玩家提示的 LLM 超时（提示可稍短，玩家会等）
const HINT_TIMEOUT_MS = Number(process.env.HINT_LLM_TIMEOUT || 8000);

function valueOf(c, level) {
  return c.rank === 'BJ' ? 17 : c.rank === 'SJ' ? 16 : c.rank === level ? 15 : '23456789TJQKA'.indexOf(c.rank) + 2;
}

// 主入口：异步决策（LLM 优先，失败降级）
export async function botDecideAsync(session, seat) {
  const t0 = Date.now();
  let action;
  try {
    action = await decideAsync(session, seat, session.trackers || null, {
      timeoutMs: LLM_TIMEOUT_MS,
    });
  } catch (e) {
    action = botDecide(session, seat);
    action.via = 'exception:' + (e.message || e);
  }
  // 节奏控制：至少 THINK_MIN_MS
  const elapsed = Date.now() - t0;
  if (elapsed < THINK_MIN_MS) await new Promise(r => setTimeout(r, THINK_MIN_MS - elapsed));
  // 决策日志（便于观察AI质量；不含任何密钥）
  if (process.env.BOT_DEBUG) {
    console.log('[bot]', { seat, via: action.via, reason: action.reason, picked: action.picked, err: action.llmError });
  }
  return action;
}

// 旧同步极简逻辑（返回动作 {type:'play',cards:[{id}]} 或 {type:'pass'}）
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

// 玩家提示：调用大模型给出推荐出牌 + 理由（与机器人同一套 AI 分析）
// 返回 {action, reason, options, via}；options 为候选牌id数组（首选已置顶）
export async function playerHint(session, seat) {
  try {
    const r = await hintAsync(session, seat, session.trackers || null, { timeoutMs: HINT_TIMEOUT_MS });
    if (process.env.BOT_DEBUG) {
      console.log('[hint]', { seat, via: r.via, action: r.action, reason: r.reason, n: r.options.length });
    }
    return r;
  } catch (e) {
    // 兜底：AI层整体异常时退回旧同步逻辑，保证提示功能永远可用
    const fallback = botDecide(session, seat);
    return {
      action: fallback.type,
      reason: '',
      options: fallback.type === 'play' ? [fallback.cards] : [],
      via: 'exception:' + (e.message || e),
    };
  }
}

