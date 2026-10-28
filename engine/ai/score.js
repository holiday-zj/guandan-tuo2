// AI 评分层：候选打分排序 + 硬事实注入 + 违规校验
// 设计原则：
//   1. 引擎比 LLM 更清楚"事实"（谁告急/过牌后牌权归谁/能否清牌）——事实由代码算好钉进 prompt
//   2. 候选按结构评分排序，最优者标 [★引擎推荐]，LLM 做选择题而非推理题
//   3. LLM 输出过校验器：违反硬规则 → 带纠正提示重问一次 → 仍违规 → 引擎改判
import { isWild, orderValue, RANKS } from '../cards.js';
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

const NEXT_RANK = { '2': '3', '3': '4', '4': '5', '5': '6', '6': '7', '7': '8', '8': '9', '9': 'T', 'T': 'J', 'J': 'Q', 'Q': 'K', 'K': 'A' };
const SUITS4 = ['♠', '♥', '♣', '♦'];

// 数炸弹手数：炸弹/同花顺/天王 + 逢人配(红桃级牌)可补成的潜在炸（3张+配=4炸；同花4连+配=同花顺）
// 用户规则："炸弹要考虑同花顺，同花顺要考虑红桃级牌"
export function bombHandsCount(strength, hand, level) {
  const d = strength && strength.decompose;
  if (!d) return 0;
  let n = d.controls.length;
  const wilds = d.wilds || [];
  if (wilds.length) {
    const byRank = {};
    for (const c of hand) {
      if (isWild(c, level) || c.rank === 'BJ' || c.rank === 'SJ') continue;
      byRank[c.rank] = (byRank[c.rank] || 0) + 1;
    }
    let potential = 0;
    if (Object.values(byRank).some(v => v >= 3)) potential++; // 配+3张=4炸
    if (!potential) {
      // 同花4连张+配=同花顺（自然5连同花已在controls里）
      for (const suit of SUITS4) {
        const set = new Set();
        for (const c of hand) if (!isWild(c, level) && c.rank !== 'BJ' && c.rank !== 'SJ' && c.suit === suit) set.add(c.rank);
        for (let i = 0; i < RANKS.length; i++) {
          let run = 0, r = RANKS[i];
          while (r && set.has(r)) { run++; r = NEXT_RANK[r]; }
          if (run >= 4) { potential++; break; }
        }
        if (potential) break;
      }
    }
    n += Math.min(potential, wilds.length);
  }
  return n;
}

// 组合数对数表（U≤108，直接预算）
const LOGF = (() => { const a = [0, 0]; for (let i = 2; i <= 220; i++) a[i] = a[i - 1] + Math.log(i); return a; })();
// 超几何概率 P(X>=k)：从 U 张未知牌中，某对手抓 h 张，其中特定点数有 n 张，抓到≥k张的概率
function hyperTail(n, k, h, U) {
  if (n <= 0 || h <= 0 || U <= 0 || k <= 0) return k <= 0 ? 1 : 0;
  const maxI = Math.min(n, h);
  const minI = Math.max(k, h - (U - n));
  if (minI > maxI) return 0;
  const logDenom = LOGF[U] - LOGF[h] - LOGF[U - h];
  let p = 0;
  for (let i = minI; i <= maxI; i++) {
    const logTerm = (LOGF[n] - LOGF[i] - LOGF[n - i]) + (LOGF[U - n] - LOGF[h - i] - LOGF[U - n - h + i]) - logDenom;
    p += Math.exp(logTerm);
  }
  return Math.min(1, p);
}

/**
 * 估算对手要得起队友这手牌的概率：'low'|'mid'|'high'
 * 基于算牌(remainingOutside)+各家剩余张数的超几何分布，逐对手计算（炸弹不会跨两家拼）
 */
export function estimateOppBeatRisk(best, ctx) {
  const { level, tracker, hand, round, seat } = ctx;
  if (!best || !best.it || !tracker) return 'mid';
  const it = best.it;
  const bs = beatScore(it);
  if (bs[0] >= 9) return 'low'; // 天王无人能压
  const remaining = tracker.remainingOutside(hand);
  const U = Object.values(remaining).reduce((a, b) => a + b, 0);
  const partner = (seat + 2) % 4;
  const finished = round.finishOrder || [];
  const hc = tracker.handCounts();
  const oppHands = [];
  for (let s = 0; s < 4; s++) {
    if (s === seat || s === partner || finished.includes(s)) continue;
    const n = hc[s] || 0;
    if (n > 0) oppHands.push(n);
  }
  if (!U || !oppHands.length) return 'mid';
  const classify = p => (p < 0.15 ? 'low' : p < 0.5 ? 'mid' : 'high');
  // 单家对手持有某点数≥k张的概率（各对手独立算后相加，封顶0.95）
  const pRank = (rank, k) => {
    const n = remaining[rank] || 0;
    if (n < k) return 0;
    let p = 0;
    for (const h of oppHands) p += hyperTail(n, k, h, U);
    return Math.min(0.95, p);
  };
  const ALL_RANKS = [...RANKS, 'SJ', 'BJ'];

  if (bs[0] >= 6) {
    // —— 炸弹类 ——
    const len = it.len || (it.cards ? it.cards.length : 4);
    let pNot = 1;
    if (bs[0] === 7) {
      // 同花顺：被6+张炸或天王压
      for (const rank of RANKS) pNot *= (1 - pRank(rank, 6));
    } else {
      // 普通炸弹：被更长炸 / 同长更大点数炸 压
      for (const rank of RANKS) {
        const pLonger = pRank(rank, len + 1);
        let pr = pLonger;
        if (orderValue(rank, level) > (it.value || 0)) {
          pr += Math.max(0, pRank(rank, len) - pLonger); // 恰好len张且更大
        }
        pNot *= (1 - Math.min(0.95, pr));
      }
    }
    // 天王(4王)
    const pKings = Math.min(0.9, pRank('BJ', 2) * 1.2) * Math.min(0.9, pRank('SJ', 2) * 1.2);
    pNot *= (1 - Math.min(0.5, pKings));
    // 同花顺可压4/5张炸（粗估概率）
    if (bs[0] === 6 && len <= 5) pNot *= (1 - 0.12);
    return classify(1 - pNot);
  }

  // —— 普通牌型 ——
  const v = bs[2] || it.value || 0;
  if (['straight', 'pair_straight', 'triple_straight'].includes(it.type)) {
    // 长牌型难凑：数外面更大点数的可用性，粗估
    const need = it.cards ? it.cards.length : 5;
    let threats = 0;
    for (const rank of ALL_RANKS) {
      if (orderValue(rank, level) <= v) continue;
      if ((remaining[rank] || 0) >= Math.ceil(need / 2)) threats++;
    }
    return threats === 0 ? 'low' : threats <= 2 ? 'mid' : 'high';
  }
  // 单/对/三张/三带二：需要更大点数的 k 张
  const k = it.type === 'single' ? 1 : it.type === 'pair' ? 2 : 3;
  let pNot = 1;
  for (const rank of ALL_RANKS) {
    if (orderValue(rank, level) <= v) continue;
    pNot *= (1 - pRank(rank, k));
  }
  return classify(1 - pNot);
}

// 估算某家剩余手牌的"手数"（未知手牌只能按张数粗估：平均一手4张）
export function estimateHands(n) {
  if (n <= 0) return 0;
  if (n <= 3) return 1;
  return Math.max(1, Math.ceil(n / 4));
}

export function buildFacts(ctx) {
  const { hand, best, seat, round, tracker, driver, strength } = ctx;
  const partner = (seat + 2) % 4;
  const finished = round.finishOrder || [];
  const active = s => !finished.includes(s);
  const hc = tracker ? tracker.handCounts() : (round.hands || []).map(h => (h ? h.length : 0));

  // 队友是否正持有当前牌圈牌权（他刚出的牌还没被人压）——此时他不需要"夺牌权"
  const partnerLeading = !!(best && best.by === partner && active(partner));

  // —— 连续拿牌权追踪（守门/追赶规则，用户规则）——
  // streakOpp: 当前牌圈主打者若是"连续赢圈后又出牌"的对手 → 需要防守
  // 已连赢 streakCount 圈 + 本圈又出 = 连续出牌 streakCount+1 次
  //   >1次(即streakCount>=1) → 他的上家(守门方)务必尽量压
  //   >2次(即streakCount>=2) → 他的下家也要能压就压
  const streak = (driver && driver.streakInfo) || { lastWinner: -1, winStreak: 0 };
  let streakOpp = -1, streakCount = 0;
  if (best && streak.lastWinner >= 0 && best.by === streak.lastWinner && active(best.by)) {
    streakOpp = best.by;
    streakCount = streak.winStreak || 1;
  }
  const streakIsOpp = streakOpp >= 0 && streakOpp !== partner;
  const amGatekeeper = streakIsOpp && seat === (streakOpp + 3) % 4 && streakCount >= 1; // 上家守门
  const amChaser = streakIsOpp && seat === (streakOpp + 1) % 4 && streakCount >= 2;     // 下家追赶

  const facts = {
    isLead: !best,
    byPartner: best ? best.by === partner : false,
    partnerLeading,
    partnerDone: finished.includes(partner),
    partnerRemaining: hc[partner] ?? 0,
    // 队友只剩1张且牌权在对手手上：必须夺牌权再送小牌（送他走）
    // ⚠ 队友自己正在领牌(如刚出炸弹)时不适用——三家不要他就继续走，过牌即可
    partnerNeedLead: active(partner) && (hc[partner] ?? 99) <= 1 && !partnerLeading,
    partnerUrgent: active(partner) && (hc[partner] ?? 99) <= 2 && !partnerLeading,
    partnerBeatRisk: 'mid',   // 队友这手牌对手要得起的风险（estimateOppBeatRisk）
    partnerBigPlay: false,    // 队友出的是炸弹类
    myHands: strength ? strength.hands : 99,
    sprint: hand.length <= 5 || (strength ? strength.hands <= 2 : false),
    canWinAll: false, winAllIdx: -1,
    oppUrgentNow: false, oppUrgentNowSeat: -1, oppUrgentNowCount: 0,
    oppLastCard: false,   // 牌圈主只剩≤1张：这手不压他就走
    oppEndgame: false,    // 牌圈主(对手)估计≤3手：拦截窗口，结构无损就该接
    oppHandsEst: 99,
    anyOppUrgent: false,
    // —— 守门/追赶 ——
    streakOpp, streakCount,
    mustGate: amGatekeeper,   // 我是连赢对手的上家：务必尽量压
    mustChase: amChaser,      // 我是连赢对手(≥2次)的下家：能压就压
    // —— 唯一炸弹规则 ——
    bombHands: bombHandsCount(strength, hand, ctx.level),
    soleBomb: bombHandsCount(strength, hand, ctx.level) === 1, // 手里只剩一手炸(含同花顺/红桃级牌可补的潜在炸)
    oppNearDone: false,       // 有对手估计只剩≤2手 → 唯一炸弹值得炸他
  };

  // 对手接近走完（估计≤2手）：唯一炸弹的启用条件
  for (let s = 0; s < 4; s++) {
    if (s === seat || s === partner || !active(s)) continue;
    if (estimateHands(hc[s] ?? 99) <= 2) { facts.oppNearDone = true; break; }
  }

  if (best && facts.byPartner) {
    facts.partnerBeatRisk = estimateOppBeatRisk(best, ctx);
    const bs = beatScore(best.it);
    facts.partnerBigPlay = bs[0] >= 6;
  }

  // 当前牌圈主打者告急判定
  if (best && active(best.by)) {
    const n = hc[best.by] ?? 99;
    facts.oppUrgentNowCount = n;
    if (best.by !== partner) {
      facts.oppHandsEst = estimateHands(n);
      if (n <= 3) { facts.oppUrgentNow = true; facts.oppUrgentNowSeat = best.by; }
      if (n <= 1) facts.oppLastCard = true;
      // 拦截窗口：对手估计只剩≤3手（且未到"必压"级），该接就接
      if (facts.oppHandsEst <= 3) facts.oppEndgame = true;
    }
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
  const RISK_CN = { low: '低(对手大概率要不起)', mid: '中', high: '高(对手很可能压得住)' };
  const L = [];
  if (facts.isLead) {
    L.push('【局面】你领出（本圈第一家）。');
  } else if (facts.byPartner) {
    if (facts.partnerDone) L.push('【局面】这是队友出完前的最后一手！你过牌且其余家都不要 → 接风给你。能一手清牌就清，否则过牌等接风。');
    else if (facts.partnerLeading) {
      L.push(`【局面】队友刚出这手牌、正握着牌权（他还剩${facts.partnerRemaining}张）。三家都不要 → 他继续领出。`
        + (facts.partnerRemaining <= 1 ? '他只剩1张：只要对手压不过，他下一手就直接走掉——坚决过牌，绝不能压队友！' : '默认过牌让他走。'));
      L.push(`对手要得起这手牌的概率：${RISK_CN[facts.partnerBeatRisk] || '中'}。`
        + (facts.partnerBigPlay ? '这是炸弹级大牌，别接。' : facts.partnerBeatRisk === 'low' ? '对手大概率接不上，不需要你保。' : ''));
      if (facts.partnerRemaining <= 2 && facts.partnerBeatRisk === 'high' && !facts.partnerBigPlay) {
        L.push('⚠队友快出完且对手很可能压他：若你压过后能改出小牌送他走(不破坏自己结构)，可考虑接过来保他；否则过牌。');
      }
    } else {
      L.push(`【局面】这是队友的牌（队友还剩${facts.partnerRemaining}张）。默认不压让他走；只有你能一手清牌或你正冲刺(≤2手)才压。`);
    }
  } else {
    L.push('【局面】这是对手的牌。');
    if (facts.oppEndgame && !facts.oppUrgentNow) {
      L.push(`🚧拦截窗口：牌圈主估计只剩约${facts.oppHandsEst}手牌(≤3手)。在不破坏自己结构(手数不增、不拆成型牌)的前提下要接，打乱他的出牌节奏；若接牌代价太大(拆牌/耗炸)才放过。`);
    }
  }
  if (facts.oppLastCard) L.push(`🚨牌圈主只剩${facts.oppUrgentNowCount}张——这手放过去他就出完！必须压（炸弹/天王也值得），除非你压不住。`);
  else if (facts.oppUrgentNow && !facts.byPartner) L.push(`🚨牌圈主只剩${facts.oppUrgentNowCount}张，随时可能走掉：压制优先，别吝惜大牌。`);
  if (facts.mustGate && !facts.byPartner) L.push(`🛡守门警报：对手${facts.streakOpp}号位已连续拿${facts.streakCount + 1}次牌权！你是他的上家(守门方)，务必尽量压住这手牌，别让他再连拿。`);
  else if (facts.mustChase && !facts.byPartner) L.push(`🏃追赶警报：对手${facts.streakOpp}号位已连续拿${facts.streakCount + 1}次牌权(超过2次)！你是他的下家，能压就压，不能让他走得太轻松。`);
  if (facts.soleBomb && !facts.oppLastCard && !facts.oppNearDone) L.push('💣你手里只剩这一手炸(含同花顺/红桃级牌可补的潜在炸)——留到最后！对手估计只剩≤2手牌时再用它炸，现在别动。');
  else if (facts.soleBomb && facts.oppNearDone) L.push('💣有对手估计只剩≤2手牌：你唯一的那手炸弹现在值得用了，炸他！');
  if (facts.partnerNeedLead && !facts.byPartner) L.push(`🚨队友只剩${facts.partnerRemaining}张且牌权在对手手上！你过牌他永远拿不到牌权。必须夺牌权（能压就压），夺到后领最小单张送他走。注意：过牌≠接风给他，接风只在"出完牌的人"最后一手三家都不要时才发生。`);
  else if (facts.partnerUrgent && !facts.byPartner) L.push(`队友只剩${facts.partnerRemaining}张(牌权不在他手上)，考虑夺牌权送他。`);
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
    if (facts.byPartner && !facts.partnerDone) {
      // 队友正握牌权且只剩1张(即将直接走掉)：无论我是否冲刺都坚决不压
      if (facts.partnerLeading && facts.partnerRemaining <= 1 && !winAll) s -= 2000;
      else if (!facts.sprint) {
        s -= 900; // 压队友重罚
        // 例外：队友快出完但对手很可能压他(高风险)且这手不是炸弹 → 保队友可轻罚
        if (facts.partnerLeading && facts.partnerRemaining <= 2 && facts.partnerBeatRisk === 'high' && !facts.partnerBigPlay) s += 700;
      }
    }
    const isBombCand = HARD_TYPES.includes(c.type);
    // 结构无损判定：手数不增且无拆散 = "正常压牌"区；破坏后手数增/拆散 = "一般不压"区
    const structureSafe = after ? (after.dh <= 0 && !after.breaks.length) : true;
    const mustGateChase = (facts.mustGate || facts.mustChase) && !facts.byPartner;
    if (isBombCand) {
      // 炸类：必须压时用；唯一炸弹要留到对手≤2手/告急才动
      if (facts.soleBomb && !winAll) {
        if (facts.oppLastCard || facts.oppNearDone || mustGateChase && facts.streakCount >= 3) s -= 20; // 值得炸
        else s -= 220; // 留住唯一炸弹
      } else {
        s -= mustBeat ? 10 : urgent ? 60 : facts.oppEndgame ? 100 : mustGateChase ? 90 : 160;
      }
    } else {
      const v = bs[2] || 0;
      if (structureSafe) {
        // 结构无损 → 正常压牌：小压优先但大牌也敢用（用户规则：不能放对手走太轻松）
        s -= v * (mustBeat ? 0.5 : urgent ? 1 : mustGateChase ? 1.2 : facts.oppEndgame ? 1.5 : 2);
      } else {
        // 破坏结构 → 一般不压：重罚（除非必须压的局面）
        s -= v * (mustBeat ? 0.5 : urgent ? 1 : 2.5);
        if (!mustBeat && !urgent) s -= 60;
      }
      if (v >= 15 && !urgent && !mustBeat && !facts.oppEndgame && !mustGateChase) s -= 25;
    }
    if (urgent) s += 110;
    if (mustBeat) s += 130;
    if (facts.mustGate && !facts.byPartner) s += 150;  // 守门方务必尽量压
    if (facts.mustChase && !facts.byPartner) s += 110;  // 下家能压就压
    // 拦截窗口：对手估计≤3手，结构无损(dh≤0且无拆牌)的候选加分去接
    if (facts.oppEndgame && !facts.byPartner && structureSafe && !isBombCand) s += 70;
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
  if (facts.byPartner) {
    if (facts.partnerDone) return 600;
    // 队友正握牌权且只剩1张：过牌让他直接走，坚决过
    if (facts.partnerLeading && facts.partnerRemaining <= 1) return 1500;
    return 500;
  }
  let s = -20; // 基线：小牌跟小牌(得分≈-10)应该出，大牌/拆牌(得分<-20)才过
  if (facts.oppLastCard) s -= 500;
  else if (facts.oppUrgentNow) s -= 420;
  else if (facts.oppEndgame) s -= 100; // 拦截窗口：对手≤3手，倾向去接
  if (facts.partnerNeedLead) s -= 400;
  // 守门/追赶（用户规则）：对手连续拿牌权时倾向压牌，不让对手走太轻松
  if (facts.mustGate) s -= 130;
  if (facts.mustChase) s -= 95;
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
  // 守门/追赶：对手连续拿牌权，有结构无损候选(不含唯一炸弹) → 务必压
  if ((facts.mustGate || facts.mustChase) && !facts.byPartner) {
    const clean = candidates.filter(c =>
      c.after && c.after.dh <= 0 && !c.after.breaks.length &&
      !c.cards.some(x => isWild(x, ctx.level)) &&
      !(facts.soleBomb && !facts.oppNearDone && HARD_TYPES.includes(c.type)));
    if (clean.length) {
      const alt = clean.reduce((a, b) => (b.score > a.score ? b : a), clean[0]);
      return { action: 'play', idx: alt.idx, score: alt.score, hard: facts.mustGate ? 'gate' : 'chase' };
    }
  }
  if (facts.byPartner && !facts.partnerDone) {
    // 队友握牌权且只剩1张：即使我冲刺也过牌（他先走=我方头游）
    if (facts.partnerLeading && facts.partnerRemaining <= 1) {
      return { action: 'pass', score: ps, hard: 'partner-last-card' };
    }
    if (!facts.sprint) return { action: 'pass', score: ps, hard: 'partner-lead' };
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
      return `队友只剩${facts.partnerRemaining}张且牌权在对手手上，过牌他永远走不了——必须夺牌权（注意：此时过牌不是接风，接风只发生在"已出完牌的人"的最后一手三家都不要时）`;
    }
    // 拦截窗口：对手估计≤3手，有结构无损的候选却过牌 → 该接不接
    if (facts.oppEndgame && !facts.byPartner && candidates.length) {
      const clean = candidates.filter(c =>
        c.after && c.after.dh <= 0 && !c.after.breaks.length &&
        !HARD_TYPES.includes(c.type) && !c.cards.some(x => isWild(x, ctx.level)));
      if (clean.length) {
        const alt = clean.reduce((a, b) => (b.score > a.score ? b : a), clean[0]);
        return `对手估计只剩约${facts.oppHandsEst}手牌(≤3手)进入拦截窗口，候选#${alt.idx}接牌不破坏你的结构，应该接住打乱他节奏——除非你有明确战术理由(留绝对控制/送队友)`;
      }
    }
    // 守门/追赶（用户规则）：对手连续拿牌权，有结构无损候选却过牌 → 该压不压
    if ((facts.mustGate || facts.mustChase) && !facts.byPartner && candidates.length) {
      const clean = candidates.filter(c =>
        c.after && c.after.dh <= 0 && !c.after.breaks.length &&
        !c.cards.some(x => isWild(x, ctx.level)) &&
        !(facts.soleBomb && !facts.oppNearDone && HARD_TYPES.includes(c.type))); // 唯一炸弹留最后，不强迫守门用它
      if (clean.length) {
        const alt = clean.reduce((a, b) => (b.score > a.score ? b : a), clean[0]);
        const role = facts.mustGate ? '守门方(上家)' : '追赶方(下家)';
        return `对手${facts.streakOpp}号位已连续拿${facts.streakCount + 1}次牌权，你是${role}——务必压住！候选#${alt.idx}结构无损，压它（不能放对手走太轻松）`;
      }
    }
    if (/接风/.test(d.reason || '')) {
      // 声称"等接风"但引擎事实不支持：过牌不会把牌权给我/队友
      const windOk = facts.passWindsToMe || (facts.passEndsTrick && facts.passNextIsPartner)
        || (facts.byPartner && facts.partnerLeading); // 队友握牌权，三家不要他继续领——说"让他走"合理
      if (!windOk && !(facts.byPartner && facts.partnerDone)) {
        return `你说"等接风"但事实是：${facts.passEndsTrick ? `过牌后牌权归${facts.passNextOwner}号位` : '过牌后本圈未结束，牌权不在你/队友手上'}。接风只在"已出完牌的人"的最后一手三家都不要时才发生，重新决策`;
      }
    }
    return null;
  }
  if (d.action === 'play') {
    const pick = candidates.find(c => c.idx === d.candidate);
    if (!pick) return `候选编号${d.candidate}不存在（合法编号0~${candidates.length - 1}）`;
    // 压队友（非清牌）
    if (facts.byPartner && !facts.partnerDone && pick.cards.length !== hand.length) {
      // 队友握牌权且只剩1张：即使冲刺也不许压（他先走=我方头游）
      if (facts.partnerLeading && facts.partnerRemaining <= 1) {
        return `队友正握牌权且只剩${facts.partnerRemaining}张——对手压不过他这手牌的话，他下一手直接走掉(头游)。压队友=毁掉他的大牌，必须过牌！`;
      }
      if (!facts.sprint) {
        // 例外：队友快出完但对手很可能压他(高风险小牌) → 允许接过牌权保队友
        const guardPartner = facts.partnerLeading && facts.partnerRemaining <= 2
          && facts.partnerBeatRisk === 'high' && !facts.partnerBigPlay;
        if (!guardPartner) {
          return '这是队友的牌且队友未出完，压队友浪费牌权——除非你能一手清牌，否则过牌';
        }
      }
    }
    const winAll = pick.cards.length === hand.length;
    const mustBeat = facts.oppLastCard || facts.oppUrgentNow || facts.partnerNeedLead;
    // 唯一炸弹纪律（用户规则）：只剩一手炸时，非告急/对手≤2手/连拿≥4次/末手清牌 不许动用
    const isBombPick = HARD_TYPES.includes(pick.type);
    if (isBombPick && facts.soleBomb && !winAll) {
      const allowed = facts.oppLastCard || facts.oppNearDone
        || ((facts.mustGate || facts.mustChase) && facts.streakCount >= 3);
      if (!allowed) {
        return `你手里只剩这一手炸(炸弹含同花顺、同花顺含红桃级牌可配的)——要留到最后！一般在对手估计只剩≤2手牌时才用它炸。当前没有告急，改用其他候选或过牌`;
      }
    }
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
