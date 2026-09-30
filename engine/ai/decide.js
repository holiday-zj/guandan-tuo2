// AI 出牌决策：LLM 主脑 + 启发式保底
// 设计原则：
//   1. LLM 只能从"引擎枚举出的合法候选"中选择，绝不自由生成牌 → 永不出非法牌
//   2. LLM 超时/失败/输出无效 → 自动降级为启发式决策，游戏不卡死
//   3. 决策上下文 = 确定性代码算好的牌情(算牌/牌力/拖牌策略/团队局势) + 候选列表
import { bestInterpretation, canBeat, beatScore } from '../classify.js';
import { leadOptions, followOptions } from '../hint.js';
import { orderValue, isWild, isJoker, tugRank, tugValueOf, cardLabel } from '../cards.js';
import { handStrength, tugPolicy, teamSituation, describeTable, PlayTracker } from './analyze.js';
import { askJson } from './llm.js';

export const SYSTEM_PROMPT = `你是掼蛋（安徽拖2）顶级高手AI。你与对家是一队，目标是让你们队拿高分。

# 本玩法核心规则（与标准掼蛋不同，务必记住）
- 每副牌独立结算，不存在升级。亮牌定级：本副打"级牌"，拖牌=最小点数（打2时拖3，其余拖2）
- 积分规则：双上(头游+二游同队)+3级 / 一三+2级 / 一四+1级
- 拖牌奖励：头游最后一手若为【纯拖牌】(全部是拖牌点数的单/对/三张/拖牌炸弹)，每张+1级，红桃拖牌每张+2级；双上时二游末手纯拖也计分
- 头游末手纯拖牌不可被压制，强制接风给队友——这是巨大优势
- 末游惩罚：末游手里每剩1张拖牌，给对方+1级；双下时三游+末游的剩余拖牌全算
- 首攻(本副第一手)禁止出纯拖牌
- 红桃级牌=逢人配，可配除大小王外任意牌；天王(4王)>6张炸>同花顺>5张炸>普通牌型
- 顺子只到A为止(A可作1用于A2345)，不绕回2

# 你的决策原则（按优先级）
1. 【团队观念】对家(队友)出的牌，只要没人能威胁，不要压队友！让队友走牌。对手出的牌才考虑压制
2. 【拖牌时机】根据局势判断拖牌是"留"还是"甩"：
   - 我方有望头游/二游 → 把拖牌留到最后一手打出(纯拖计分，红拖翻倍，头游纯拖还锁牌)
   - 我方牌力弱恐成末游 → 拖牌尽早甩出去(夹在顺子/三带二里出掉也算甩)，闷在手里=给对方送分
3. 【算牌】根据已出的牌推断外面剩什么：某点数外面已绝迹而你手里有 → 你是绝对控制，可放心先出小牌
4. 【手数管理】牌力强的目标是抢先出完；出牌优先消耗"手数"，别拆炸弹/同花顺(它们是压制对手的武器)
5. 【压制时机】对手只剩1-3张牌时必须全力压制(上炸弹也要压)，防止对手头游/双上
6. 【接风】你出完牌后若最后一手没人要，牌权给对家；队友剩牌少时帮他清路
7. 领出时：优先出"手数"里最难处理的散牌(小单张/小对子)，保留大牌型做后手控制
8. 跟牌时：能小压不小压大，除非必须(压制对手关键点或送队友)；炸弹留给关键时刻

# 输出格式（严格JSON，不要其他文字）
{"action":"play","candidate":<候选编号>,"reason":"<20字内理由>"}
或 {"action":"pass","reason":"<20字内理由>"}`;

// 生成候选（带编号），领出与跟牌分别处理
function buildCandidates(hand, level, best, opts = {}) {
  const list = [];
  const push = (cards, it) => {
    if (!cards.length || !it) return;
    list.push({ idx: list.length, cards, it, type: it.type });
  };
  if (!best) {
    for (const o of leadOptions(hand, level, 200)) push(o.cards, o.it);
  } else {
    for (const o of followOptions(hand, level, best.it, 40)) push(o.cards, o.it);
  }
  // 去重（同点数集合视为同一候选）
  const seen = new Set();
  const uniq = [];
  for (const c of list) {
    const key = c.cards.map(x => x.rank).sort().join('') + '|' + c.type;
    if (seen.has(key)) continue;
    seen.add(key);
    c.idx = uniq.length;
    uniq.push(c);
  }
  return uniq;
}

function candidateLabel(c, level, tug) {
  const n = c.cards.length;
  const typeCn = {
    single: '单', pair: '对', triple: '三张', triple_pair: '三带二', straight: '顺子',
    pair_straight: '三连对', triple_straight: '钢板', bomb: '炸弹', straight_flush: '同花顺', kings: '天王',
  }[c.type] || c.type;
  const pureTug = c.cards.every(x => x.rank === tug) ? '【纯拖!】' : '';
  const hasTug = c.cards.some(x => x.rank === tug) ? '(含拖)' : '';
  const hasWild = c.cards.some(x => isWild(x, level)) ? '(配)' : '';
  return `${c.idx}. ${typeCn} ${c.cards.map(cardLabel).join(' ')}${pureTug}${hasTug}${hasWild}`;
}

// ————— 启发式决策（LLM 降级保底，也用于压测）————
export function heuristicDecide(ctx) {
  const { hand, level, tug, best, candidates, strength, policy, situation, tracker } = ctx;
  const PASS = { type: 'pass' };
  const play = c => ({ type: 'play', cards: c.cards.map(x => ({ id: x.id })) });

  if (!best) {
    // —— 领出 ——
    if (!candidates.length) return PASS;
    const isFirstLead = ctx.isFirstLead;

    // 冲刺：手里全是拖牌(或≤2手) → 直接清牌
    if (strength.hands <= 2 && !isFirstLead) {
      // 优先纯拖(锁牌计分)，其次最大牌型
      const pureTug = candidates.filter(c => c.cards.every(x => x.rank === tug));
      if (pureTug.length && hand.length <= 6) return play(pureTug[pureTug.length - 1]);
    }

    // dump 策略：尽早甩拖牌——找含拖牌的候选优先出（首攻除外，首攻禁纯拖）
    if (policy.policy === 'dump') {
      const withTug = candidates.filter(c =>
        c.cards.some(x => x.rank === tug) &&
        !(isFirstLead && c.cards.every(x => x.rank === tug)));
      if (withTug.length) {
        // 拖牌夹在大牌型里出掉最好（顺子/三带二/对子），其次小牌型
        const embedded = withTug.filter(c => !c.cards.every(x => x.rank === tug));
        const pick = (embedded.length ? embedded : withTug);
        // 选张数多的（一次甩更多）
        pick.sort((a, b) => b.cards.length - a.cards.length || a.cards[0] && orderValue(a.cards[0].rank, level) - orderValue(b.cards[0].rank, level));
        return play(pick[0]);
      }
    }

    // 常规：出最小的非拖牌散牌（保留拖牌与控制张）
    const normal = candidates.filter(c =>
      !c.cards.some(x => isWild(x, level)) &&
      !['bomb', 'straight_flush', 'kings'].includes(c.type) &&
      !(c.cards.every(x => x.rank === tug)) &&
      !(isFirstLead && c.cards.some(x => x.rank === tug) && c.cards.length === 1 && c.cards[0].rank === tug));
    const pool = normal.length ? normal : candidates.filter(c => !['bomb', 'straight_flush', 'kings'].includes(c.type));
    if (!pool.length) return play(candidates[0]);
    // keep 策略：避免出含拖的牌型，除非只剩含拖选项
    let filtered = pool;
    if (policy.policy === 'keep') {
      const noTug = pool.filter(c => !c.cards.some(x => x.rank === tug));
      if (noTug.length) filtered = noTug;
    }
    // 优先小手数牌型(单/对/三张)，同型选最小
    const shapeRank = { single: 0, pair: 1, triple: 2, straight: 3, triple_pair: 4, pair_straight: 5, triple_straight: 6 };
    filtered.sort((a, b) => {
      const sa = shapeRank[a.type] ?? 9, sb = shapeRank[b.type] ?? 9;
      if (sa !== sb) return sa - sb;
      return beatScore(a.it)[2] - beatScore(b.it)[2] || a.cards.length - b.cards.length;
    });
    return play(filtered[0]);
  }

  // —— 跟牌 ——
  if (!candidates.length) return PASS;
  const byPartner = best.by === ((ctx.seat + 2) % 4);

  // 队友出的牌：默认不压（团队观念），除非队友已出完/我方能借机清牌
  if (byPartner) {
    const partnerDone = ctx.round.finishOrder.includes(best.by);
    const canDumpAll = candidates.some(c => c.cards.length === hand.length);
    if (!partnerDone && !canDumpAll) {
      // 特殊情况：policy=dump 且队友出的是小牌、我有含拖候选能顺手甩拖 → 也不压，
      // 因为压队友会浪费牌权。直接过。
      return PASS;
    }
    // 队友出完牌了 → 这圈结束就接风给我，此时若我能一手清牌则出
    if (canDumpAll) return play(candidates.find(c => c.cards.length === hand.length));
  }

  // 对手出的牌
  const opp = best.by;
  const oppRemaining = tracker ? tracker.handCounts()[opp] : 99;
  const oppUrgent = oppRemaining <= 3;

  // 我能一手清牌 → 直接出完（若清完是头游且最后一手是纯拖 → 锁牌，最佳）
  const winAll = candidates.find(c => c.cards.length === hand.length);
  if (winAll) return play(winAll);

  // 冲刺阶段（我≤5张）：能压就压，抢头游
  if (hand.length <= 5) {
    const pureTugWin = candidates.find(c => c.cards.every(x => x.rank === tug) && c.cards.length === hand.length);
    if (pureTugWin) return play(pureTugWin); // 末手纯拖=锁牌+计分
    return play(candidates[0]);
  }

  // 对手告急(≤3张)：必须压制，不惜炸弹
  if (oppUrgent) {
    // 选能压的最小牌（含炸）
    return play(candidates[0]);
  }

  // 常规压制：不用炸/同花顺/天王压普通牌，除非我是绝对控制或对手牌少
  const soft = candidates.filter(c => !['bomb', 'straight_flush', 'kings'].includes(c.type));
  const hard = candidates.filter(c => ['bomb', 'straight_flush', 'kings'].includes(c.type));

  // dump 策略：优先用"含拖"的候选压牌，顺便甩拖
  if (policy.policy === 'dump' && soft.length) {
    const withTug = soft.filter(c => c.cards.some(x => x.rank === tug) && !c.cards.every(x => x.rank === tug));
    if (withTug.length) return play(withTug[0]);
  }
  // keep 策略：避免用纯拖压牌（除非能锁牌赢），也避免拆拖牌对子
  if (soft.length) {
    let pool = soft;
    if (policy.policy === 'keep') {
      const noTug = soft.filter(c => !c.cards.some(x => x.rank === tug));
      if (noTug.length) pool = noTug;
    }
    // 不用逢人配去压普通牌（浪费万能张），除非别无选择
    const noWild = pool.filter(c => !c.cards.some(x => isWild(x, level)));
    if (noWild.length) pool = noWild;
    // 若压这手牌要付出太大代价(用A/级牌压小牌)且对手不告急 → 可以过
    const cheapest = pool[0];
    if (cheapest && !oppUrgent) {
      const cost = beatScore(cheapest.it)[2] || 0;
      const targetVal = beatScore(best.it)[2] || 0;
      // 对手出小牌(≤8)，我要用≥14的大牌压 → 不划算，过
      if (targetVal <= 8 && cost >= 14 && hand.length > 8) return PASS;
      // 对手是对家下家(我下家)出的普通小牌，且我下家牌多 → 放他走，省牌
    }
    return play(cheapest);
  }
  // 只剩炸弹类：对手不告急就过
  if (hard.length && (oppUrgent || hand.length <= 8)) return play(hard[0]);
  return PASS;
}

// ————— LLM 决策主入口（异步）————
export async function llmDecide(ctx, opts = {}) {
  const { hand, level, tug, best, candidates, strength, policy, situation, seat, round, tracker } = ctx;
  if (!candidates.length && best) {
    return { type: 'pass', via: 'no-candidates' };
  }
  if (!candidates.length && !best) {
    return { type: 'pass', via: 'no-candidates' }; // 理论上不会发生
  }

  // 组装 prompt
  const table = describeTable(round, seat, tracker, ctx.strengths);
  const candLines = candidates.map(c => candidateLabel(c, level, tug)).join('\n');
  const trickInfo = best
    ? `当前牌圈：${best.by === (seat + 2) % 4 ? '队友' : '对手'}(${best.by}号位)出了【${best.cards.map(cardLabel).join(' ')}】(${best.it.type})，你是第${ctx.turnN || '?'}个应对`
    : `轮到你【领出】(你是本圈第一个出牌)`;
  const partnerName = best && best.by === (seat + 2) % 4 ? '（这是队友的牌！）' : '';

  const user = `${table}

${trickInfo}${partnerName}

我的拖牌策略：${policy.policy}（${policy.reason}）
我的手牌(${hand.length}张)：${hand.slice().sort((a, b) => orderValue(a.rank, level) - orderValue(b.rank, level)).map(cardLabel).join(' ')}

合法候选（只能从中选，编号即答案）：
${candLines}
${best ? '（也可以选择 pass 过牌）' : '（领出必须出牌，不能pass）'}

请决策，输出JSON。`;

  const r = await askJson(SYSTEM_PROMPT, user, {
    fast: opts.fast,
    timeoutMs: opts.timeoutMs || 10000,
    temperature: 0.2,
    maxTokens: 200,
  });

  if (!r.ok) {
    const h = heuristicDecide(ctx);
    return { ...h, via: 'heuristic-fallback', llmError: r.error };
  }

  // 解析 LLM 选择
  const d = r.data;
  if (d.action === 'pass') {
    if (!best) {
      // 领出不能过 → 降级启发式
      return { ...heuristicDecide(ctx), via: 'llm-invalid(lead-pass)' };
    }
    return { type: 'pass', via: 'llm', reason: d.reason };
  }
  const pick = candidates.find(c => c.idx === d.candidate);
  if (!pick) {
    return { ...heuristicDecide(ctx), via: 'llm-invalid(bad-candidate)' };
  }
  return { type: 'play', cards: pick.cards.map(x => ({ id: x.id })), via: 'llm', reason: d.reason, picked: candidateLabel(pick, level, tug) };
}

// ————— 统一入口：构造上下文 + LLM(带保底) —————
export async function decideAsync(session, seat, trackerMap, opts = {}) {
  const round = session.match.round;
  const driver = session.driver;
  const hand = round.hands[seat];
  const level = round.level;
  const tug = round.tug;
  const best = driver.best;

  // 终极保底：领出时必须能出牌（引擎不允许领出过牌），
  // 若候选枚举为空则直接出最小单张，杜绝死锁
  const emergencyLead = () => {
    const sorted = hand.slice().sort((a, b) => orderValue(a.rank, level) - orderValue(b.rank, level));
    const pick = sorted.find(c => round.led || c.rank !== tug) || sorted[0];
    return { type: 'play', cards: [{ id: pick.id }], via: 'emergency-lead' };
  };

  // 本座位的追踪器
  const tracker = trackerMap && trackerMap[seat];
  if (tracker) {
    tracker.level = level; tracker.tug = tug;
    tracker.syncFinish(round.finishOrder);
  }

  // 各家牌力（队友的牌力用已出牌推断，简化：只算自己+记录队友出牌特征）
  const strength = handStrength(hand, level, tracker);
  const strengths = { [seat]: strength };

  const situation = teamSituation(seat, round, tracker, strengths);
  const policy = tugPolicy(hand, level, strength, {
    partnerRank: situation.partnerRank,
    myRankGuess: situation.myRankGuess,
    teammateStrong: situation.teammateStrong,
  });

  const candidates = buildCandidates(hand, level, best);

  // 领出且无任何候选 → 紧急保底出牌，绝不让牌局卡死
  if (!best && !candidates.length) return emergencyLead();
  if (!candidates.length && best) {
    return { type: 'pass', via: 'no-candidates' };
  }

  // 首攻禁纯拖过滤（引擎也会拒绝，这里提前滤掉避免 LLM 选到非法候选）
  let legal = candidates;
  if (!best && !round.led) {
    legal = candidates.filter(c => !c.cards.every(x => x.rank === tug));
    if (!legal.length) legal = candidates; // 极端情况兜底
  }
  // 锁定牌圈（头游纯拖）：只能过
  if (best && round.trick && round.trick.locked) {
    return { type: 'pass', via: 'locked-trick' };
  }

  const ctx = {
    hand, level, tug, best, candidates: legal, strength, strengths,
    policy, situation, seat, round, tracker,
    isFirstLead: !round.led,
  };

  // LLM 主决策（失败自动降级启发式，永不阻塞游戏）
  try {
    const action = await llmDecide(ctx, opts);
    action.llm = true;
    return action;
  } catch (e) {
    return { ...heuristicDecide(ctx), via: 'exception-fallback', error: String(e.message || e) };
  }
}
