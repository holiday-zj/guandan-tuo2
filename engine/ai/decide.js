// AI 出牌决策：引擎评分锚定 + LLM 主脑 + 违规校验自纠 + 引擎改判保底
// 设计原则：
//   1. LLM 只能从"引擎枚举出的合法候选"中选择，绝不自由生成牌 → 永不出非法牌
//   2. 引擎先算好一切"事实"（谁告急/过牌后牌权归谁/能否清牌）并给候选打分排序，
//      LLM 做的是"带推荐的选择题"，不是"从2600字里自己找线索的推理题"
//   3. LLM 输出过校验器：违反硬规则 → 带纠正提示重问一次 → 仍违规 → 引擎改判
//   4. LLM 超时/失败 → 直接用引擎推荐（比旧启发式更强），游戏永不卡死
import { bestInterpretation, canBeat, beatScore } from '../classify.js';
import { leadOptions, followOptions } from '../hint.js';
import { orderValue, isWild, isJoker, tugRank, tugValueOf, cardLabel } from '../cards.js';
import { handStrength, tugPolicy, teamSituation, describeTable, PlayTracker, decompose } from './analyze.js';
import { prepareDecision, factsToText, validateDecision, engineRecommend, passScore, annotateCandidates } from './score.js';
import { askJson, logDecision } from './llm.js';

export const SYSTEM_PROMPT = `你是掼蛋（安徽拖2）顶级高手AI。你与对家是一队，目标：让你们队本副拿高分。

# 规则要点（与标准掼蛋不同）
- 每副独立结算不升级。亮牌定级，拖牌=最小点数(打2时拖3，其余拖2)
- 计分：双上(头游+二游同队)+3级 / 一三+2级 / 一四+1级
- 头游末手若为纯拖牌(全部是拖牌点数)：每张+1级、红桃拖每张+2级，且不可被压、强制接风给队友
- 末游手里每剩1张拖牌给对方+1级(双下时三游+末游全算)；首攻禁纯拖
- 逢人配(红桃级牌)可配除大小王外任意牌；天王(4王)>6张炸>同花顺>5张炸>4张炸>普通牌型；顺子只到A(A2345可，不绕回2)
- 接风只在"某家打完最后一手牌且其余三家都不要"时发生，牌权给其对家。【过牌后果】段已由引擎算好，以它为准，不要自己猜

# 决策流程（按顺序检查，命中即停）
1. 【局面】说你能一手清牌 → 出清牌候选(末手纯拖最佳，锁牌+计分)。
2. 残局警报：🚨牌圈主/对手告急(剩牌≤3张) → 必须压制，不惜炸弹天王。压不住才过。
3. 残局警报：🚨队友剩1~2张且牌权在对手手上 → 必须夺牌权再送队友小牌(送队友走是残局第一要务)。注意：过牌≠接风给他，他拿不到牌权！
4. 队友的牌(队友正握牌权、未出完) → 默认过牌让他走。尤其队友只剩1张时坚决过牌：对手压不过他这手，他下一手直接走掉拿头游。引擎给出的"对手要得起概率"低 → 更没必要接；只有队友快出完且对手很可能压他时，你才考虑接过来改送小牌保他。
5. 🚧拦截窗口(对手估计≤3手牌)：在不破坏自己结构(手数不增、不拆成型牌)的前提下去接，打乱对手节奏；接牌要拆牌/耗炸则放过。
6. 常规跟牌对手 → 从引擎推荐[★]开始考虑：能小压不大压；要用A/级牌/炸去压小牌且无任何警报 → 过牌保留实力。
7. 领出 → 出结构无损的小散牌(手数减少的成型牌优先)，控制张和逢人配留作后手；拖牌按【策略】处理。
8. 算牌：某点数外面已出光而你手里有 = 绝对控制，可放心先甩小牌把它留作稳赢后手。

# 候选使用规则（重要）
- 候选已按引擎评分从高到低排列，#0标[★引擎推荐]。无明确战术理由不要偏离推荐。
- 标注含义：⟶出后=出这手后剩余手牌结构变化(手数越少越好)；⚠拆散=破坏成型牌；⚠消耗控制张=用掉炸弹/同花顺/天王/逢人配。
- 存在干净候选(无⚠且手数不增)时，绝不选⚠候选——除非战术理由：拦告急对手、送队友、末手纯拖、算牌确认的绝对控制。
- 手数增加(增N!)的候选是坏棋，除非一手清牌否则不选。

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

function candidateLabel(c, level, tug, after, isRec = false) {
  const typeCn = {
    single: '单', pair: '对', triple: '三张', triple_pair: '三带二', straight: '顺子',
    pair_straight: '三连对', triple_straight: '钢板', bomb: '炸弹', straight_flush: '同花顺', kings: '天王',
  }[c.type] || c.type;
  const pureTug = c.cards.every(x => x.rank === tug) ? '【纯拖!】' : '';
  const hasTug = c.cards.some(x => x.rank === tug) ? '(含拖)' : '';
  const hasWild = c.cards.some(x => isWild(x, level)) ? '(配)' : '';
  let afterStr = '';
  if (after) {
    const bits = [];
    if (after.dh < 0) bits.push(`手数${after.baseHands}→${after.hands}(减${-after.dh})`);
    else if (after.dh > 0) bits.push(`手数${after.baseHands}→${after.hands}(增${after.dh}!)`);
    else bits.push(`手数不变(${after.hands})`);
    if (after.breaks.length) bits.push('⚠拆散[' + after.breaks.join(',') + ']');
    if (after.lostControls.length) bits.push('⚠消耗控制张[' + after.lostControls.join(',') + ']');
    afterStr = ' ⟶出后: ' + bits.join(' ');
  }
  return `${isRec ? '★' : ''}${c.idx}. ${typeCn} ${c.cards.map(cardLabel).join(' ')}${pureTug}${hasTug}${hasWild}${afterStr}`;
}

// ————— 启发式决策（最后保底，也用于压测；有评分时优先 engineDecide）————
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
      const pureTug = candidates.filter(c => c.cards.every(x => x.rank === tug));
      if (pureTug.length && hand.length <= 6) return play(pureTug[pureTug.length - 1]);
    }

    // dump 策略：尽早甩拖牌（首攻除外，首攻禁纯拖）
    if (policy.policy === 'dump') {
      const withTug = candidates.filter(c =>
        c.cards.some(x => x.rank === tug) &&
        !(isFirstLead && c.cards.every(x => x.rank === tug)));
      if (withTug.length) {
        const embedded = withTug.filter(c => !c.cards.every(x => x.rank === tug));
        const pick = (embedded.length ? embedded : withTug);
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
    let filtered = pool;
    if (policy.policy === 'keep') {
      const noTug = pool.filter(c => !c.cards.some(x => x.rank === tug));
      if (noTug.length) filtered = noTug;
    }
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
  if (byPartner) {
    const partnerDone = ctx.round.finishOrder.includes(best.by);
    const canDumpAll = candidates.some(c => c.cards.length === hand.length);
    if (!partnerDone && !canDumpAll) return PASS;
    if (canDumpAll) return play(candidates.find(c => c.cards.length === hand.length));
  }

  const opp = best.by;
  const oppRemaining = tracker ? tracker.handCounts()[opp] : 99;
  const oppUrgent = oppRemaining <= 3;

  const winAll = candidates.find(c => c.cards.length === hand.length);
  if (winAll) return play(winAll);

  if (hand.length <= 5) {
    const pureTugWin = candidates.find(c => c.cards.every(x => x.rank === tug) && c.cards.length === hand.length);
    if (pureTugWin) return play(pureTugWin);
    return play(candidates[0]);
  }
  if (oppUrgent) return play(candidates[0]);

  const soft = candidates.filter(c => !['bomb', 'straight_flush', 'kings'].includes(c.type));
  const hard = candidates.filter(c => ['bomb', 'straight_flush', 'kings'].includes(c.type));
  if (policy.policy === 'dump' && soft.length) {
    const withTug = soft.filter(c => c.cards.some(x => x.rank === tug) && !c.cards.every(x => x.rank === tug));
    if (withTug.length) return play(withTug[0]);
  }
  if (soft.length) {
    let pool = soft;
    if (policy.policy === 'keep') {
      const noTug = soft.filter(c => !c.cards.some(x => x.rank === tug));
      if (noTug.length) pool = noTug;
    }
    const noWild = pool.filter(c => !c.cards.some(x => isWild(x, level)));
    if (noWild.length) pool = noWild;
    const cheapest = pool[0];
    if (cheapest && !oppUrgent) {
      const cost = beatScore(cheapest.it)[2] || 0;
      const targetVal = beatScore(best.it)[2] || 0;
      if (targetVal <= 8 && cost >= 14 && hand.length > 8) return PASS;
    }
    return play(cheapest);
  }
  if (hard.length && (oppUrgent || hand.length <= 8)) return play(hard[0]);
  return PASS;
}

// ————— 引擎决策：评分层的直接结论（LLM 失败时的主保底，比启发式更强）————
export function engineDecide(ctx) {
  const rec = ctx.recommend || engineRecommend(ctx, ctx.facts || {});
  if (rec.action === 'play') {
    const c = ctx.candidates.find(x => x.idx === rec.idx);
    if (c) {
      return {
        type: 'play', cards: c.cards.map(x => ({ id: x.id })),
        via: 'engine', reason: c.scoreNotes || '引擎评分最优',
        picked: candidateLabel(c, ctx.level, ctx.tug, c.after),
      };
    }
  }
  return { type: 'pass', via: 'engine', reason: '引擎判定过牌' };
}

// ————— LLM 决策主入口（异步）：锚定 + 校验自纠一次 + 引擎改判 —————
export async function llmDecide(ctx, opts = {}) {
  const { hand, level, tug, best, candidates, strength, policy, seat, round, tracker } = ctx;
  if (!candidates.length) return { type: 'pass', via: 'no-candidates' };

  // 引擎预处理：事实计算 + 候选打分排序 + 推荐（幂等，重复调用无害）
  const { facts, recommend } = ctx.facts ? { facts: ctx.facts, recommend: ctx.recommend } : prepareDecision(ctx);

  const table = describeTable(round, seat, tracker, ctx.strengths);
  const factsStr = factsToText(facts, seat);
  const candLines = candidates.map(c =>
    candidateLabel(c, level, tug, c.after, recommend.action === 'play' && recommend.idx === c.idx)).join('\n');
  const recHint = recommend.action === 'play'
    ? `[★引擎推荐 #${recommend.idx}]`
    : '[★引擎推荐：过牌]';
  const memoryStr = ctx.memory ? ctx.memory.buildFor(seat) : '';

  const user = `${factsStr}

${table}
${memoryStr ? '\n' + memoryStr + '\n' : ''}
【策略】拖牌：${policy.policy}（${policy.reason}）
我的手牌(${hand.length}张，手数≈${strength.hands})：${hand.slice().sort((a, b) => orderValue(a.rank, level) - orderValue(b.rank, level)).map(cardLabel).join(' ')}

合法候选（已按引擎评分降序，只能从中选，编号即答案）${recHint}：
${candLines}
${best ? '（也可以 pass 过牌，过牌后果见【过牌后果】）' : '（领出必须出牌，不能pass）'}

按系统提示的决策流程核对【局面】和🚨警报，输出JSON。`;

  const askOpts = {
    fast: opts.fast,
    timeoutMs: opts.timeoutMs || 10000,
    temperature: 0.2,
    maxTokens: 200,
    // 机器可读审计信息（写入 llm-io.log 的 AUDIT 行，供 scripts/llm-audit.js 统计）
    audit: {
      seat, isLead: !best,
      byPartner: best ? best.by === (seat + 2) % 4 : null,
      trickBy: best ? best.by : null,
      oppUrgentNow: !!facts.oppUrgentNow, oppUrgentCount: facts.oppUrgentNowCount,
      partnerNeedLead: !!facts.partnerNeedLead, partnerUrgent: !!facts.partnerUrgent,
      partnerDone: !!facts.partnerDone,
      passEndsTrick: !!facts.passEndsTrick, passNextOwner: facts.passNextOwner,
      passWindsToOpp: !!facts.passWindsToOpp, passNextIsPartner: !!facts.passNextIsPartner,
      canWinAll: !!facts.canWinAll, winAllIdx: facts.winAllIdx,
      handCount: hand.length, myHands: strength.hands,
      recAction: recommend.action, recIdx: recommend.idx ?? null,
      passScore: best ? passScore(ctx, facts) : null,
      candScores: candidates.map(c => [c.idx, c.score]),
    },
  };

  // 第一次询问
  let r = await askJson(SYSTEM_PROMPT, user, askOpts);
  if (!r.ok) {
    return { ...engineDecide(ctx), via: 'engine-fallback', llmError: r.error };
  }

  // 解析 + 校验；违规 → 带纠正提示重问一次（自纠）；仍违规 → 引擎改判
  let d = r.data;
  let violation = validateDecision(d, ctx, facts);
  if (violation) {
    const correction = `${user}

⚠你刚才的决策【${JSON.stringify(d).slice(0, 150)}】违反规则：${violation}。
请严格按照【局面】【过牌后果】和🚨警报重新决策，输出JSON。`;
    const r2 = await askJson(SYSTEM_PROMPT, correction, { ...askOpts, audit: { ...askOpts.audit, retry: 1 }, timeoutMs: Math.max(4000, askOpts.timeoutMs / 2) });
    if (r2.ok) {
      const v2 = validateDecision(r2.data, ctx, facts);
      if (!v2) {
        d = r2.data;
        violation = null;
        return toAction(d, ctx, 'llm-corrected');
      }
      violation = v2;
    }
    // 自纠失败 → 引擎改判
    return { ...engineDecide(ctx), via: 'engine-override', violation };
  }
  return toAction(d, ctx, 'llm');
}

function toAction(d, ctx, via) {
  if (d.action === 'pass') {
    return { type: 'pass', via, reason: d.reason };
  }
  const pick = ctx.candidates.find(c => c.idx === d.candidate);
  if (!pick) return { ...engineDecide(ctx), via: 'engine-override', violation: 'bad-candidate:' + d.candidate };
  return {
    type: 'play', cards: pick.cards.map(x => ({ id: x.id })), via, reason: d.reason,
    picked: candidateLabel(pick, ctx.level, ctx.tug, pick.after),
  };
}

// ————— 构造决策上下文（机器人决策与玩家提示共用同一套 AI 分析）—————
// 返回 {ctx, early}：early 非空表示已有确定结论（无候选/锁牌圈/紧急保底），无需再问大模型
export function buildDecisionContext(session, seat, trackerMap) {
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

  const tracker = trackerMap && trackerMap[seat];
  if (tracker) {
    tracker.level = level; tracker.tug = tug;
    tracker.syncFinish(round.finishOrder);
  }

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
  if (!best && !candidates.length) return { ctx: null, early: emergencyLead() };
  if (!candidates.length && best) {
    return { ctx: null, early: { type: 'pass', via: 'no-candidates' } };
  }

  // 首攻禁纯拖过滤（引擎也会拒绝，这里提前滤掉避免 LLM 选到非法候选）
  let legal = candidates;
  if (!best && !round.led) {
    legal = candidates.filter(c => !c.cards.every(x => x.rank === tug));
    if (!legal.length) legal = candidates;
  }
  // 锁定牌圈（头游纯拖）：只能过
  if (best && round.trick && round.trick.locked) {
    return { ctx: null, early: { type: 'pass', via: 'locked-trick' } };
  }

  const ctx = {
    hand, level, tug, best, candidates: legal, strength, strengths,
    policy, situation, seat, round, tracker, driver,
    memory: session.memory || null,
    isFirstLead: !round.led,
  };
  // 引擎预处理：候选打分排序 + 硬事实 + 推荐（LLM锚定与校验都依赖它）
  prepareDecision(ctx);
  return { ctx, early: null };
}

// ————— 玩家提示：用大模型给出推荐出牌 + 理由（与机器人同一套分析）—————
// 返回 {action, reason, options}：options 为候选牌（id列表数组，供客户端循环高亮）
export async function hintAsync(session, seat, trackerMap, opts = {}) {
  const { ctx, early } = buildDecisionContext(session, seat, trackerMap);
  if (early) {
    const options = early.type === 'play' ? [early.cards] : [];
    return {
      action: early.type, reason: early.type === 'pass' ? '没有能压的牌或牌圈已锁定，建议过' : '',
      options, via: early.via,
    };
  }
  // 候选已按引擎评分降序 → options 本身就是"从优到劣"，即使 LLM 失败顺序也有意义
  const options = ctx.candidates.map(c => c.cards.map(x => ({ id: x.id })));

  const HARD_TIMEOUT = Number(process.env.HINT_LLM_TIMEOUT || 8000);
  try {
    const action = await Promise.race([
      llmDecide(ctx, { ...opts, timeoutMs: Math.min(opts.timeoutMs || 8000, HARD_TIMEOUT) }),
      new Promise(resolve => setTimeout(() => resolve(null), HARD_TIMEOUT + 1500)),
    ]);
    const chosen = (action && action.type === 'play' && action.cards)
      ? [action.cards] : null;
    return {
      action: action ? action.type : 'play',
      reason: action && action.reason ? action.reason : '',
      options: chosen ? [chosen[0], ...options.filter(o => o !== chosen[0])] : options,
      via: action ? (action.via || 'llm') : 'engine-fallback',
    };
  } catch (e) {
    const h = engineDecide(ctx);
    const chosen = h.type === 'play' && h.cards ? [h.cards] : null;
    return {
      action: h.type, reason: '',
      options: chosen ? [chosen[0], ...options.filter(o => o !== chosen[0])] : options,
      via: 'exception-fallback',
    };
  }
}

// ————— 统一入口：构造上下文 + LLM(锚定+自纠) + 引擎保底 —————
export async function decideAsync(session, seat, trackerMap, opts = {}) {
  const { ctx, early } = buildDecisionContext(session, seat, trackerMap);
  if (early) return early;

  // 决策后把自己的判断记入记忆（计划连续性，供后续决策参考）
  const rememberPlan = (action) => {
    if (session.memory && action && action.reason) {
      session.memory.addPlan(seat, action.reason);
    }
    // 终局决策日志：供 scripts/llm-audit.js 统计实际执行动作与拦截率
    try {
      logDecision({
        seat, via: action && action.via, type: action && action.type,
        reason: action && action.reason, violation: action && action.violation,
        cards: action && action.cards ? action.cards.map(c => c.id).length : 0,
        picked: action && action.picked, rec: ctx && ctx.recommend,
      });
    } catch { /* 日志不影响游戏 */ }
    return action;
  };

  // LLM 主决策（校验自纠一次，失败引擎改判，永不阻塞游戏）
  // 双保险：除 askJson 内部超时外，这里再加一层硬性总超时
  const HARD_TIMEOUT = Number(process.env.BOT_LLM_TIMEOUT || 9000) + 3000;
  try {
    const action = await Promise.race([
      llmDecide(ctx, opts),
      new Promise(resolve => setTimeout(() => resolve(null), HARD_TIMEOUT)),
    ]);
    if (!action) {
      return rememberPlan({ ...engineDecide(ctx), via: 'engine-hard-timeout' });
    }
    action.llm = /llm/.test(action.via || '');
    return rememberPlan(action);
  } catch (e) {
    return rememberPlan({ ...engineDecide(ctx), via: 'engine-exception', error: String(e.message || e) });
  }
}
