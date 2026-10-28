// AI 评分层：候选打分排序 + 硬事实注入 + 违规校验
// 设计原则：
//   1. 引擎比 LLM 更清楚"事实"（谁告急/过牌后牌权归谁/能否清牌）——事实由代码算好钉进 prompt
//   2. 候选按结构评分排序，最优者标 [★引擎推荐]，LLM 做选择题而非推理题
//   3. LLM 输出过校验器：违反硬规则 → 带纠正提示重问一次 → 仍违规 → 引擎改判
import { isWild, orderValue } from '../cards.js';
import { beatScore } from '../classify.js';
import { decompose } from './analyze.js';

const HARD_TYPES = ['bomb', 'straight_flush', 'kings'];
const SHAPE_RANK = { single: 0, pair: 1, triple: 2, straight: 3, triple_pair: 4, pair_straight: 5, triple_straight: 6, bomb: 7, straight_flush: 8, kings: 9 };

/* ============ 1. 候选"出牌后"结构标注（从 decide.js 移入，修复语义） ============ */
// breaks 只记"部分拆散"（真破坏结构）；整组打出是中性/好棋，记 fullPlays
export function annotateCandidates(candidates, hand, level, strength) {
  const base = strength.decompose;
  const baseHands = strength.hands;
  const baseCombos = base.combos.filter(c => c.cards.length >= 2);
  for (const cand of candidates) {
    const ids = new Set(cand.cards.map(x => x.id));
    const rest = hand.filter(c => !ids.has(c.id));
    if (!rest.length) { cand.after = { hands: 0, baseHands, breaks: [], fullPlays: [], lostControls: [], dh: -baseHands }; continue; }
    const d2 = decompose(rest, level);
    const breaks = [];
    const fullPlays = [];
    for (const combo of baseCombos) {
      const used = combo.cards.filter(c => ids.has(c.id)).length;
      if (used > 0 && used < combo.cards.length) breaks.push(combo.type + combo.cards.length + '张用' + used);
      else if (used === combo.cards.length && combo.cards.length >= 3) fullPlays.push(combo.type);
    }
    const lostControls = [];
    for (const ctrl of base.controls) {
      const used = ctrl.cards.filter(c => ids.has(c.id)).length;
      if (used > 0) lostControls.push(used === ctrl.cards.length ? ctrl.type + '(整用)' : ctrl.type + `(拆${used}/${ctrl.cards.length})`);
    }
    cand.after = {
      hands: d2.hands, baseHands, dh: d2.hands - baseHands,
      breaks: [...new Set(breaks)], fullPlays: [...new Set(fullPlays)],
      lostControls: [...new Set(lostControls)],
    };
  }
  return candidates;
}

/* ============ 2. 硬事实（引擎确定知道、不该让 LLM 推理的） ============ */
export function buildFacts(ctx) {
  const { hand, best, seat, round, tracker, driver, strength } = ctx;
  const partner = (seat + 2) % 4;
  const finished = round.finishOrder || [];
  const active = s => !finished.includes(s);
  const hc = tracker ? tracker.handCounts() : (round.hands || []).map(h => (h ? h.length : 0));

  const facts = {
    isLead: !best,
    byPartner: best ? best.by === partner : false,
    partnerDone: finished.includes(partner),
    partnerRemaining: hc[partner] ?? 0,
    // 队友只剩1张且未出完：必须夺牌权再送小牌（送他走）
    partnerNeedLead: active(partner) && (hc[partner] ?? 99) <= 1,
    partnerUrgent: active(partner) && (hc[partner] ?? 99) <= 2,
    myHands: strength ? strength.hands : 99,
    sprint: hand.length <= 5 || (strength ? strength.hands <= 2 : false),
    canWinAll: false, winAllIdx: -1,
    oppUrgentNow: false, oppUrgentNowSeat: -1, oppUrgentNowCount: 0,
    oppLastCard: false,   // 牌圈主只剩≤1张：这手不压他就走
    anyOppUrgent: false,
  };

  // 当前牌圈主打者告急判定
  if (best && active(best.by)) {
    const n = hc[best.by] ?? 99;
    facts.oppUrgentNowCount = n;
    if (best.by !== partner && n <= 3) { facts.oppUrgentNow = true; facts.oppUrgentNowSeat = best.by; }
    if (best.by !== partner && n <= 1) facts.oppLastCard = true;
  }
  for (let s = 0; s < 4; s++) {
    if (s === seat || s === partner || !active(s)) continue;
    if ((hc[s] ?? 99) <= 3) facts.anyOppUrgent = true;
  }

  // 过牌后果：这一圈是否因我过牌而结束、结束后牌权归谁（接风的唯一真相）
  facts.passEndsTrick = false;
  facts.passNextOwner = -1;
  facts.passNextIsPartner = false;
  facts.passWindsToOpp = false;   // 过牌导致对手队接风（best.by已出完→接风给其队友）
  facts.passWindsToMe = false;    // 过牌导致我接风（队友出完最后一手）
  if (best && driver) {
    const activeCount = [0, 1, 2, 3].filter(active).length;
    const needPasses = activeCount - (active(best.by) ? 1 : 0);
    const passesAfterMine = (driver.consecutivePasses || 0) + 1;
    if (passesAfterMine >= needPasses) {
      facts.passEndsTrick = true;
      const next = active(best.by) ? best.by : (best.by + 2) % 4;
      facts.passNextOwner = next;
      facts.passNextIsPartner = next === partner;
      if (!active(best.by)) {
        // best.by 已出完 → 接风给其对家
        if (next === seat) facts.passWindsToMe = true;
        else if (next !== partner) facts.passWindsToOpp = true;
      }
    }
  }
  return facts;
}

// 把硬事实渲染成 prompt 文本（简短、结论式，不让模型自己推）
export function factsToText(facts, seat) {
  const L = [];
  if (facts.isLead) {
    L.push('【局面】你领出（本圈第一家）。');
  } else if (facts.byPartner) {
    if (facts.partnerDone) L.push('【局面】这是队友出完前的最后一手！你过牌且其余家都不要 → 接风给你。能一手清牌就清，否则过牌等接风。');
    else L.push(`【局面】这是队友的牌（队友还剩${facts.partnerRemaining}张）。默认不压让他走；只有你能一手清牌或你正冲刺(≤2手)才压。`);
  } else {
    L.push('【局面】这是对手的牌。');
  }
  if (facts.oppLastCard) L.push(`🚨牌圈主只剩${facts.oppUrgentNowCount}张——这手放过去他就出完！必须压（炸弹/天王也值得），除非你压不住。`);
  else if (facts.oppUrgentNow) L.push(`🚨牌圈主只剩${facts.oppUrgentNowCount}张，随时可能走掉：压制优先，别吝惜大牌。`);
  if (facts.partnerNeedLead && !facts.byPartner) L.push(`🚨队友只剩${facts.partnerRemaining}张！你过牌他永远拿不到牌权。必须夺牌权（能压就压），夺到后领最小单张送他走。注意：过牌≠接风给他，接风只在"出完牌的人"最后一手三家都不要时才发生。`);
  else if (facts.partnerUrgent && !facts.byPartner) L.push(`队友只剩${facts.partnerRemaining}张，考虑夺牌权送他。`);
  if (!facts.isLead && facts.passEndsTrick) {
    if (facts.passWindsToMe) L.push('【过牌后果】你过牌后本圈结束 → 接风给你，你将领出。');
    else if (facts.passWindsToOpp) L.push('⚠【过牌后果】你过牌后本圈结束 → 对手队接风领出！别让对手白拿牌权，能压就压。');
    else if (facts.passNextIsPartner) L.push('【过牌后果】你过牌后本圈结束 → 牌权归队友，他将领出（对队友有利）。');
    else L.push(`⚠【过牌后果】你过牌后本圈结束 → 牌权回到对手${facts.passNextOwner}号位。过牌不是"送队友"，队友拿不到牌权！`);
  } else if (!facts.isLead && !facts.passEndsTrick) {
    L.push('【过牌后果】你过牌后本圈还没结束，后面还有家要表态，牌权可能易手。');
  }
  if (facts.canWinAll) L.push(`✅候选#${facts.winAllIdx}可一手清完全部手牌——除非清完反而送对手双上，否则直接出它！`);
  return L.join('\n');
}

/* ============ 3. 候选评分（越高越好；引擎推荐的依据） ============ */
export function scoreCandidate(c, ctx, facts) {
  const { hand, level, tug, best, policy, strength } = ctx;
  const after = c.after;
  const winAll = c.cards.length === hand.length;
  const pureTug = c.cards.every(x => x.rank === tug);
  const hasTug = c.cards.some(x => x.rank === tug);
  const wilds = c.cards.filter(x => isWild(x, level)).length;
  const urgent = facts.oppUrgentNow;
  const mustBeat = facts.oppLastCard || facts.partnerNeedLead;

  let s = 0;
  if (winAll) {
    // 一手清牌压倒一切；末手纯拖再加分（锁牌+计分）
    s = 10000 + (pureTug ? 800 : 0) + (facts.passWindsToOpp ? 0 : 0);
    c.scoreNotes = '一手清牌' + (pureTug ? '+纯拖锁牌' : '');
    return s;
  }

  // 结构：手数变化（最重要）
  if (after) {
    s -= after.dh * 60;
    s -= after.breaks.length * 25;          // 真拆散（部分用）
    if (after.fullPlays.length) s += 8;     // 整组打出略优（消手数）
    // 控制张消耗：告急/冲刺/清牌邻近时便宜，否则昂贵
    if (after.lostControls.length) {
      const pen = mustBeat ? 5 : urgent ? 25 : facts.sprint ? 40 : 90;
      s -= after.lostControls.length * pen;
    }
  }
  // 逢人配：非清牌不打
  if (wilds) s -= wilds * 60;

  // 拖牌
  if (pureTug) {
    const lateKeep = after && after.hands <= 1; // 出完纯拖只剩≤1手 = 末手锁牌局面
    if (policy.policy === 'keep') s += lateKeep ? 150 : -50;
    else if (policy.policy === 'dump') s += 60;
    else s += lateKeep ? 120 : -15;
  } else if (hasTug) {
    s += policy.policy === 'dump' ? 25 : policy.policy === 'keep' ? -12 : 8;
  }

  const bs = beatScore(c.it) || [0, 0, 0];
  if (best) {
    // —— 跟牌 ——
    if (facts.byPartner && !facts.partnerDone && !facts.sprint) s -= 900; // 压队友重罚
    if (HARD_TYPES.includes(c.type)) {
      s -= mustBeat ? 10 : urgent ? 60 : 160; // 炸类：必须压时用，平时昂贵
    } else {
      const v = bs[2] || 0;
      s -= v * (mustBeat ? 0.5 : urgent ? 1 : 2.5); // 能小压不大压
      if (v >= 15 && !urgent && !mustBeat) s -= 25;  // 级牌/王/A 压普通牌额外罚
    }
    if (urgent) s += 110;
    if (mustBeat) s += 130;
    if (facts.passWindsToMe) s -= 30;             // 过牌接风给我 → 过牌也是好选择
    else if (facts.passWindsToOpp) s += 45; // 过牌会送对手接风 → 出牌加分
    else if (facts.passEndsTrick && facts.passNextIsPartner) s -= 40; // 过牌正好送队友牌权 → 出牌减分
    else if (facts.passEndsTrick) s += 25;        // 过牌后牌权回对手 → 出牌加分
  } else {
    // —— 领出 ——
    s -= (SHAPE_RANK[c.type] ?? 5) * 10;           // 小牌型优先（散牌先走）
    const maxV = Math.max(...c.cards.map(x => orderValue(x.rank, level)));
    s -= maxV * 2.5;                                // 小点数优先
    if (facts.anyOppUrgent && HARD_TYPES.includes(c.type)) s -= 40; // 告急期别领炸
    if (facts.passWindsToMe) s -= 0;                // 领出局面无关
  }
  c.scoreNotes = null;
  return Math.round(s);
}

// pass 的等价分数（跟牌时与候选最高分比较）
// 基线取负值：掼蛋常规应"能小压就小压"顶掉对手小牌，只有代价过高(拆牌/A级牌王/炸)才过
export function passScore(ctx, facts) {
  if (facts.byPartner) return facts.partnerDone ? 600 : 500; // 队友的牌默认过
  let s = -20; // 基线：小牌跟小牌(得分≈-10)应该出，大牌/拆牌(得分<-20)才过
  if (facts.oppLastCard) s -= 500;
  else if (facts.oppUrgentNow) s -= 420;
  if (facts.partnerNeedLead) s -= 400;
  if (facts.passWindsToMe) s += 220;              // 过牌接风给我，很好
  else if (facts.passWindsToOpp) s -= 180;        // 过牌送对手队接风，很亏
  else if (facts.passEndsTrick && facts.passNextIsPartner) s += 160; // 过牌接风给队友，很好
  else if (facts.passEndsTrick) s -= 60;          // 过牌后对手继续领，略亏
  if (facts.sprint) s -= 60;            // 冲刺期积极出牌
  return s;
}

/* ============ 4. 引擎推荐 + 校验器 ============ */
// 返回 {action:'play', idx, score} 或 {action:'pass', score}
export function engineRecommend(ctx, facts) {
  const { candidates, best } = ctx;
  if (!best) {
    // 领出必出牌
    let top = null;
    for (const c of candidates) if (!top || c.score > top.score) top = c;
    return top ? { action: 'play', idx: top.idx, score: top.score } : { action: 'pass', score: -1e9 };
  }
  // 硬规则优先
  const winAll = candidates.find(c => c.cards.length === ctx.hand.length);
  if (winAll) return { action: 'play', idx: winAll.idx, score: winAll.score, hard: 'win-all' };
  let top = null;
  for (const c of candidates) if (!top || c.score > top.score) top = c;
  const ps = passScore(ctx, facts);
  if ((facts.oppUrgentNow || facts.partnerNeedLead) && top) {
    return { action: 'play', idx: top.idx, score: top.score, hard: 'must-beat' };
  }
  if (facts.byPartner && !facts.partnerDone && !facts.sprint) {
    return { action: 'pass', score: ps, hard: 'partner-lead' };
  }
  if (top && top.score > ps) return { action: 'play', idx: top.idx, score: top.score };
  return { action: 'pass', score: ps };
}

/**
 * 校验 LLM 决策是否违反硬规则
 * @returns {string|null} 违规描述（null=通过）
 */
export function validateDecision(d, ctx, facts) {
  const { candidates, best, hand } = ctx;
  if (!d) return '无输出';
  if (d.action === 'pass') {
    if (!best) return '领出不能过牌，必须出牌';
    if (facts.oppLastCard || facts.oppUrgentNow) {
      if (candidates.length) return `牌圈主只剩${facts.oppUrgentNowCount}张随时出完，你有${candidates.length}个合法候选却过牌——必须压制`;
    }
    if (facts.partnerNeedLead && candidates.length) {
      return `队友只剩${facts.partnerRemaining}张急需牌权，过牌他永远走不了——必须夺牌权（注意：此时过牌不是接风，接风只发生在"已出完牌的人"的最后一手三家都不要时）`;
    }
    if (/接风/.test(d.reason || '')) {
      // 声称"等接风"但引擎事实不支持：过牌不会把牌权给我/队友
      const windOk = facts.passWindsToMe || (facts.passEndsTrick && facts.passNextIsPartner);
      if (!windOk && !(facts.byPartner && facts.partnerDone)) {
        return `你说"等接风"但事实是：${facts.passEndsTrick ? `过牌后牌权归${facts.passNextOwner}号位` : '过牌后本圈未结束，牌权不在你/队友手上'}。接风只在"已出完牌的人"的最后一手三家都不要时才发生，重新决策`;
      }
    }
    return null;
  }
  if (d.action === 'play') {
    const pick = candidates.find(c => c.idx === d.candidate);
    if (!pick) return `候选编号${d.candidate}不存在（合法编号0~${candidates.length - 1}）`;
    // 压队友（非清牌非冲刺）
    if (facts.byPartner && !facts.partnerDone && !facts.sprint && pick.cards.length !== hand.length) {
      return '这是队友的牌且队友未出完，压队友浪费牌权——除非你能一手清牌，否则过牌';
    }
    const winAll = pick.cards.length === hand.length;
    const mustBeat = facts.oppLastCard || facts.oppUrgentNow || facts.partnerNeedLead;
    if (!winAll && !mustBeat && pick.after) {
      // 有"结构无损且引擎评分更高"的替代时，不许拆牌/手数增加
      const pickBad = pick.after.dh > 0 || pick.after.breaks.length > 0;
      const clean = candidates.filter(c =>
        c !== pick && c.after && c.after.dh <= 0 && !c.after.breaks.length &&
        !c.cards.some(x => isWild(x, ctx.level)) &&
        c.score > pick.score);
      if (pickBad && clean.length) {
        const alt = clean.reduce((a, b) => (b.score > a.score ? b : a), clean[0]);
        return `候选#${pick.idx}会${pick.after.dh > 0 ? '让手数增加' : '拆散成型牌'}，而#${alt.idx}结构无损且引擎评分更高。除非有明确战术理由（送队友/算牌确认），否则改选#${alt.idx}`;
      }
    }
    return null;
  }
  return '未知action: ' + d.action;
}

/* ============ 5. 汇总：给 ctx 里的候选打分排序，返回 {facts, recommend} ============ */
export function prepareDecision(ctx) {
  const facts = buildFacts(ctx);
  const winAll = ctx.candidates.find(c => c.cards.length === ctx.hand.length);
  if (winAll) { facts.canWinAll = true; }
  annotateCandidates(ctx.candidates, ctx.hand, ctx.level, ctx.strength);
  for (const c of ctx.candidates) c.score = scoreCandidate(c, ctx, facts);
  // 按分数降序重排并重新编号（模型看到的顺序=引擎优先级）
  ctx.candidates.sort((a, b) => b.score - a.score);
  ctx.candidates.forEach((c, i) => { c.idx = i; });
  const rec = engineRecommend(ctx, facts);
  if (rec.action === 'play') {
    const rc = ctx.candidates.find(c => c.idx === rec.idx);
    if (rc && rc.cards.length === ctx.hand.length) facts.winAllIdx = rc.idx;
  }
  if (winAll) { const w = ctx.candidates.find(c => c.cards.length === ctx.hand.length); if (w) facts.winAllIdx = w.idx; }
  ctx.facts = facts;
  ctx.recommend = rec;
  return { facts, recommend: rec };
}
