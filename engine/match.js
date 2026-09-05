// 整场比赛编排（多副牌，无升级）
// 每副牌独立：亮牌决定本副打几、拖几、谁和谁一队（持亮相牌者结队并坐对角）
import { Round } from './game.js';
import { RANK_ORDER } from './cards.js';

// 进贡牌：手中除红桃级牌外的最大牌（红桃级牌不可进贡）
export function pickTributeCard(hand, level) {
  let best = null;
  for (const c of hand) {
    if (c.suit === '♥' && c.rank === level) continue;
    const v = c.rank === 'BJ' ? 17 : c.rank === 'SJ' ? 16 : c.rank === level ? 15 : RANK_ORDER[c.rank];
    if (!best || v > best.v) best = { card: c, v };
  }
  return best ? best.card : null;
}

// 座位重排：给定各旧座位的队伍归属，返回 perm（perm[新座位] = 旧座位），
// 使队伍0坐 0/2（对角）、队伍1坐 1/3（对角）。若已对角则不动任何人。
export function seatPermutation(teamOf) {
  const t0 = [0, 1, 2, 3].filter(s => teamOf[s] === 0);
  const t1 = [0, 1, 2, 3].filter(s => teamOf[s] === 1);
  const diag = (a, b) => Math.abs(a - b) === 2;
  if (diag(t0[0], t0[1])) return [0, 1, 2, 3]; // 已对角，全员不动
  // 需重排：队伍0对角坐 0/2（已在 0/2 位的成员不动），队伍1坐 1/3
  const anchor0 = t0.find(s => s === 0 || s === 2) ?? t0[0];
  const other0 = t0.find(s => s !== anchor0);
  const anchor1 = t1.find(s => s === 1 || s === 3) ?? t1[0];
  const other1 = t1.find(s => s !== anchor1);
  return [anchor0, anchor1, other0, other1]; // 新座位 0,1,2,3 分别由谁入座
}

export class Match {
  // occupants: 初始座位上的玩家标识（memberId 或 'bot:N'），长度4
  // 积分绑定到个人（每副牌队伍都可能变化，不存在队伍累计分）
  constructor(occupants, opts = {}) {
    this.occupants = occupants.slice();   // 当前引擎座位序（每副牌可能重排）
    this.rng = opts.rng || Math.random;
    this.totalRounds = opts.totalRounds || 8; // 一场打几副
    this.roundNo = 0;
    this.history = [];
    this.lastResult = null;
    this.lastTeamOf = null;
    this.round = null;
    this.matchOver = false;
    this.scoresByPlayer = new Map();      // 玩家标识 -> 个人积分（级数累计，可负）
    occupants.forEach(id => this.scoresByPlayer.set(id, 0));
  }

  // 个人积分（按当前引擎座位序对齐）
  scores() {
    return this.occupants.map(id => this.scoresByPlayer.get(id) || 0);
  }

  // 个人排名（积分从高到低）
  ranking() {
    return this.occupants
      .map(id => ({ id, score: this.scoresByPlayer.get(id) || 0 }))
      .sort((a, b) => b.score - a.score);
  }

  // 开始新一副牌：发牌 → 亮牌定级定队 → 重排座位（队友对角）→ 进贡
  newRound() {
    this.roundNo++;
    const r = new Round(this.occupants, [0, 1, 0, 1], this.rng);
    r.deal();
    const info = r.flip(); // 纯计算：亮牌、级别、拖、队伍归属（按旧座位）

    // —— 重排座位：队友必须对角 ——
    const oldOccupants = this.occupants.slice();
    const perm = seatPermutation(info.teamOf);
    r.hands = perm.map(old => r.hands[old]);
    this.occupants = perm.map(old => oldOccupants[old]);
    r.applyFlip({ ...info, teamOf: [0, 1, 0, 1] });
    this.round = r;

    // —— 进贡（上一副输家向赢家进贡；首副无贡）——
    let tribute = { type: 'none' };
    if (this.lastResult) {
      const { ranking, losers } = this.lastResult;
      const toNew = oldSeat => this.occupants.indexOf(oldOccupants[oldSeat]);
      const doubleDown = this.lastTeamOf && this.lastTeamOf[ranking.second] === this.lastTeamOf[ranking.first];
      const newLosers = losers.map(toNew);
      if (this.checkAntiTribute(r, newLosers)) {
        tribute = { type: 'anti' };
      } else if (doubleDown) {
        // 双贡：三游→头游，末游→二游
        const tributes = [
          { from: toNew(ranking.third), to: toNew(ranking.first), card: pickTributeCard(r.hands[toNew(ranking.third)], r.level) },
          { from: toNew(ranking.fourth), to: toNew(ranking.second), card: pickTributeCard(r.hands[toNew(ranking.fourth)], r.level) },
        ];
        r.applyTributes(tributes.filter(t => t.card));
        tribute = { type: 'double', tributes };
      } else {
        // 单贡：末游→头游
        const tributes = [{ from: toNew(ranking.fourth), to: toNew(ranking.first), card: pickTributeCard(r.hands[toNew(ranking.fourth)], r.level) }];
        r.applyTributes(tributes.filter(t => t.card));
        tribute = { type: 'single', tributes };
      }
    }
    r.tributeInfo = tribute;
    return { round: r, flipInfo: info, tribute, perm };
  }

  checkAntiTribute(round, losers) {
    // 进贡方（输队两人）合计握有 2 张大王即可抗贡
    let bj = 0;
    for (const s of losers) for (const c of round.hands[s]) if (c.rank === 'BJ') bj++;
    return bj >= 2;
  }

  // 本副结算入账（积分归个人：赢家每人 +total，输家每人 -total）
  applyResult(result) {
    for (const s of result.winners) {
      const id = this.occupants[s];
      this.scoresByPlayer.set(id, (this.scoresByPlayer.get(id) || 0) + result.total);
    }
    for (const s of result.losers) {
      const id = this.occupants[s];
      this.scoresByPlayer.set(id, (this.scoresByPlayer.get(id) || 0) - result.total);
    }
    this.lastTeamOf = this.round.teamOf.slice();
    this.lastResult = { ...result, roundNo: this.roundNo };
    this.history.push({ roundNo: this.roundNo, level: this.round.level, result: this.lastResult });
    if (this.roundNo >= this.totalRounds) {
      this.matchOver = true;
    }
    return this.lastResult;
  }

  status() {
    return {
      roundNo: this.roundNo,
      totalRounds: this.totalRounds,
      scores: this.scores(),
      teamOf: this.round ? this.round.teamOf : null,
      level: this.round ? this.round.level : null,
      matchOver: this.matchOver,
    };
  }
}

// 是否双下：二游与头游同队
export function isDoubleDown(result, teamOf) {
  return teamOf[result.ranking.first] === teamOf[result.ranking.second];
}
