// AI 出牌决策：LLM 主脑 + 启发式保底
// 设计原则：
//   1. LLM 只能从"引擎枚举出的合法候选"中选择，绝不自由生成牌 → 永不出非法牌
//   2. LLM 超时/失败/输出无效 → 自动降级为启发式决策，游戏不卡死
//   3. 决策上下文 = 确定性代码算好的牌情(算牌/牌力/拖牌策略/团队局势) + 候选列表
import { bestInterpretation, canBeat, beatScore } from '../classify.js';
import { leadOptions, followOptions } from '../hint.js';
import { orderValue, isWild, isJoker, tugRank, tugValueOf, cardLabel } from '../cards.js';
import { handStrength, tugPolicy, teamSituation, describeTable, PlayTracker, decompose } from './analyze.js';
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

# 决策前必做的推演（最重要！）
每个候选都标了"⟶出后"，说明出这手牌后你剩余手牌的结构变化。选牌前，先在脑中把候选打出去，看剩下的牌还好不好走：
1. **手数优先**：出完后"手数"(把手牌全部打完需要的最少次数)越少越好。同样能应对当前牌圈时，永远选手数减少或不变、且不带⚠的那个。
2. **绝不无谓拆牌**：手里有对子/三张/炸弹时，若某候选标了"⚠拆散[对2张用1]"这类警告，说明它把成型牌拆散了，会让剩下的牌变零散难走——除非有明确战术理由(残局冲刺/送队友)，否则不选拆牌候选。
   - 典型错误：手里有"三个3"，候选里既有"单个3"又有"三个3整出"，无脑选单个3会把三张拆成2张散牌，手数不降反升。应优先整组出，或干脆留着当控制。
3. **控制张是武器不是消耗品**：炸弹/同花顺/天王/大王标了"⚠消耗控制张"的，只有在压制告急对手、抢头游、或残局清牌时才动用。中前盘为压一手普通牌就上炸=亏。
4. **逢人配(红桃级牌)极珍贵**：能配任意牌补成炸弹/同花顺/钢板。除非能一举奠定胜局，否则不要单独当小牌打掉。

# 团队与算牌
5. 【团队观念】队友(对家)出的牌默认不压，让他走。只有"你要冲头游"或"队友明显走不动需要你接风"时才压队友。
6. 【推断队友手牌】看"各家出牌画像"：队友密集出过的点数他手里估计不多了；队友从没出过、而外面还有的大点数(如A/王/级牌)他可能捏着当后手。若判断队友能压住当前对手、或队友快走完了，你就过牌让路、或用大牌帮他清障。
7. 【送队友】当队友只剩很少牌(尤其≤3张)且这手牌权能交到他手上时，优先出他压得住的小牌把牌权送给他，让他先走成头游/二游。
8. 【算牌绝对控制】某点数外面已全部出光而你手里有→你是该点数的绝对控制，可放心先甩别的小牌，把它留作后手稳赢一手。

# 残局（关键！最后关头别送对手）
9. 对手只剩1~3张牌时：这是最高优先级。必须全力压制，能压就压(哪怕动用炸弹/天王)，绝不能让对手轻松走掉拿头游或凑成双上。此时"别浪费控制张"的原则让位于"拦住对手"。
10. 对手牌少且当前是他领出小牌时，警惕他在"清最后一手"，你有大牌就顶上。
11. 反过来，我方(你或队友)只剩很少牌时，目标是抢先出完：能一次清完就清完；最后一手尽量是纯拖牌(计分+头游锁牌)。

# 拖牌时机
12. 我方有望头游/二游 → 拖牌留到最后一手打纯拖(计分翻倍+头游锁牌)；此时别把拖牌夹在小牌里早早出掉。
13. 我方牌力弱恐成末游 → 拖牌尽早甩出去(夹在顺子/三带二里出掉也算)，闷在手里=当末游给对方送分。

# 出牌方式细节
14. 领出：优先出最难处理的散牌(小单张/小对子)，把大牌型和成型牌留作后手控制；但同样要看出后手数，别为出散牌反而拆了成型牌。
15. 跟牌：能小压不用大压，省着大牌；压不住且不必要时宁可过牌保留实力。

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

function candidateLabel(c, level, tug, after) {
  const typeCn = {
    single: '单', pair: '对', triple: '三张', triple_pair: '三带二', straight: '顺子',
    pair_straight: '三连对', triple_straight: '钢板', bomb: '炸弹', straight_flush: '同花顺', kings: '天王',
  }[c.type] || c.type;
  const pureTug = c.cards.every(x => x.rank === tug) ? '【纯拖!】' : '';
  const hasTug = c.cards.some(x => x.rank === tug) ? '(含拖)' : '';
  const hasWild = c.cards.some(x => isWild(x, level)) ? '(配)' : '';
  let afterStr = '';
  if (after) {
    // 结构变化：手数增减 + 拆掉了哪些成型牌 + 控制张是否被消耗
    const bits = [];
    const dh = after.hands - after.baseHands;
    if (dh < 0) bits.push(`手数${after.baseHands}→${after.hands}(减${-dh})`);
    else if (dh > 0) bits.push(`手数${after.baseHands}→${after.hands}(增${dh}!)`);
    else bits.push(`手数不变(${after.hands})`);
    if (after.breaks.length) bits.push('⚠拆散[' + after.breaks.join(',') + ']');
    if (after.lostControls.length) bits.push('⚠消耗控制张[' + after.lostControls.join(',') + ']');
    afterStr = ' ⟶出后: ' + bits.join(' ');
  }
  return `${c.idx}. ${typeCn} ${c.cards.map(cardLabel).join(' ')}${pureTug}${hasTug}${hasWild}${afterStr}`;
}

// 预计算每个候选"出牌后"的手牌结构（相对基线的变化）
function annotateCandidates(candidates, hand, level, strength) {
  const base = strength.decompose;
  const baseHands = strength.hands;
  // 基线里的成型牌（对子及以上）：出牌把它们拆散 = 破坏结构
  const baseCombos = base.combos.filter(c => c.cards.length >= 2);
  for (const cand of candidates) {
    const ids = new Set(cand.cards.map(x => x.id));
    const rest = hand.filter(c => !ids.has(c.id));
    if (!rest.length) { cand.after = { hands: 0, baseHands, breaks: [], lostControls: [] }; continue; }
    const d2 = decompose(rest, level);
    const breaks = [];
    for (const combo of baseCombos) {
      const used = combo.cards.filter(c => ids.has(c.id)).length;
      if (used > 0 && used < combo.cards.length) breaks.push(combo.type + combo.cards.length + '张用' + used);
      else if (used === combo.cards.length && combo.cards.length >= 3) breaks.push('整组' + combo.type);
    }
    const lostControls = [];
    for (const ctrl of base.controls) {
      const used = ctrl.cards.filter(c => ids.has(c.id)).length;
      if (used > 0) lostControls.push(used === ctrl.cards.length ? ctrl.type + '(整用)' : ctrl.type + `(拆${used}/${ctrl.cards.length})`);
    }
    cand.after = { hands: d2.hands, baseHands, breaks: [...new Set(breaks)], lostControls: [...new Set(lostControls)] };
  }
  return candidates;
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
  // 为每个候选标注"出牌后"的结构变化（手数增减/拆牌警告/控制张消耗）——核心防拆牌信息
  annotateCandidates(candidates, hand, level, strength);
  const candLines = candidates.map(c => candidateLabel(c, level, tug, c.after)).join('\n');
  const trickInfo = best
    ? `当前牌圈：${best.by === (seat + 2) % 4 ? '队友' : '对手'}(${best.by}号位)出了【${best.cards.map(cardLabel).join(' ')}】(${best.it.type})`
    : `轮到你【领出】(你是本圈第一个出牌)`;
  const partnerName = best && best.by === (seat + 2) % 4 ? '（这是队友的牌！默认不压，除非能帮队友或你要冲牌）' : '';

  // 残局警报：任何人剩牌≤5张都单独强调
  const endgame = [];
  const hc = tracker ? tracker.handCounts() : round.hands.map(h => (h ? h.length : 0));
  for (let s = 0; s < 4; s++) {
    if (s === seat || round.finishOrder.includes(s)) continue;
    const rel = ((s - seat + 4) % 4);
    const who = rel === 2 ? '队友' : rel === 1 ? '下家(对手)' : '上家(对手)';
    if (hc[s] <= 5) endgame.push(`🚨${who}${s}只剩${hc[s]}张！${who === '队友' ? '考虑送牌帮他先走' : '他随时可能走掉，压制优先级最高'}`);
  }
  const endgameStr = endgame.length ? endgame.join('\n') : '';

  // 对局记忆：早期回顾(已压缩) + 最近出牌流水 + 我自己此前的计划
  const memoryStr = ctx.memory ? ctx.memory.buildFor(seat) : '';

  const user = `${table}

${memoryStr ? memoryStr + '\n\n' : ''}${endgameStr}
${trickInfo}${partnerName}

我的拖牌策略：${policy.policy}（${policy.reason}）
我的手牌(${hand.length}张，手数≈${strength.hands})：${hand.slice().sort((a, b) => orderValue(a.rank, level) - orderValue(b.rank, level)).map(cardLabel).join(' ')}

合法候选（只能从中选，编号即答案；⟶出后 是该选择对剩余手牌结构的影响）：
${candLines}
${best ? '（也可以选择 pass 过牌）' : '（领出必须出牌，不能pass）'}

请先评估各候选出后剩余结构（手数最少、不拆成型牌、不浪费控制张者优先），结合各家画像与我此前的计划决定，输出JSON。`;

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
  if (!best && !candidates.length) return { ctx: null, early: emergencyLead() };
  if (!candidates.length && best) {
    return { ctx: null, early: { type: 'pass', via: 'no-candidates' } };
  }

  // 首攻禁纯拖过滤（引擎也会拒绝，这里提前滤掉避免 LLM 选到非法候选）
  let legal = candidates;
  if (!best && !round.led) {
    legal = candidates.filter(c => !c.cards.every(x => x.rank === tug));
    if (!legal.length) legal = candidates; // 极端情况兜底
  }
  // 锁定牌圈（头游纯拖）：只能过
  if (best && round.trick && round.trick.locked) {
    return { ctx: null, early: { type: 'pass', via: 'locked-trick' } };
  }

  const ctx = {
    hand, level, tug, best, candidates: legal, strength, strengths,
    policy, situation, seat, round, tracker,
    memory: session.memory || null,
    isFirstLead: !round.led,
  };
  return { ctx, early: null };
}

// ————— 玩家提示：用大模型给出推荐出牌 + 理由（与机器人同一套分析）—————
// 返回 {action, reason, options}：options 为候选牌（id列表数组，供客户端循环高亮）
export async function hintAsync(session, seat, trackerMap, opts = {}) {
  const { ctx, early } = buildDecisionContext(session, seat, trackerMap);
  // 无候选/锁牌圈等确定局面：直接返回结论，不调用大模型
  if (early) {
    const options = early.type === 'play' ? [early.cards] : [];
    return {
      action: early.type, reason: early.type === 'pass' ? '没有能压的牌或牌圈已锁定，建议过' : '',
      options, via: early.via,
    };
  }
  // 候选牌的 id 列表（客户端据此高亮/选中）
  const options = ctx.candidates.map(c => c.cards.map(x => ({ id: x.id })));

  // 大模型推荐（超时/失败则用启发式结果，保证提示永远有值）
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
      // 首选放最前（大模型推荐），其余候选跟随，客户端可循环切换
      options: chosen ? [chosen[0], ...options.filter(o => o !== chosen[0])] : options,
      via: action ? (action.via || 'llm') : 'heuristic-fallback',
    };
  } catch (e) {
    const h = heuristicDecide(ctx);
    const chosen = h.type === 'play' && h.cards ? [h.cards] : null;
    return {
      action: h.type, reason: '',
      options: chosen ? [chosen[0], ...options.filter(o => o !== chosen[0])] : options,
      via: 'exception-fallback',
    };
  }
}

// ————— 统一入口：构造上下文 + LLM(带保底) —————
export async function decideAsync(session, seat, trackerMap, opts = {}) {
  const { ctx, early } = buildDecisionContext(session, seat, trackerMap);
  if (early) return early;

  // 决策后把自己的判断记入记忆（计划连续性，供后续决策参考）
  const rememberPlan = (action) => {
    if (session.memory && action && action.reason) {
      session.memory.addPlan(seat, action.reason);
    }
    return action;
  };

  // LLM 主决策（失败自动降级启发式，永不阻塞游戏）
  // 双保险：除 askJson 内部超时外，这里再加一层硬性总超时——
  // 任何原因（含未预见的挂起）超过 HARD_TIMEOUT 立即走启发式，牌局绝不卡死
  const HARD_TIMEOUT = Number(process.env.BOT_LLM_TIMEOUT || 9000) + 3000;
  try {
    const action = await Promise.race([
      llmDecide(ctx, opts),
      new Promise(resolve => setTimeout(() => resolve(null), HARD_TIMEOUT)),
    ]);
    if (!action) {
      return rememberPlan({ ...heuristicDecide(ctx), via: 'hard-timeout-fallback' });
    }
    action.llm = true;
    return rememberPlan(action);
  } catch (e) {
    return rememberPlan({ ...heuristicDecide(ctx), via: 'exception-fallback', error: String(e.message || e) });
  }
}
