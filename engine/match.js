// 整局比赛（多副牌，2→A）流程编排：翻牌定级定队、进贡/还贡/抗贡、升级
import { Round } from './game.js';
import { RANKS, RANK_ORDER } from './cards.js';

// 级数序列表：2,3,…,K,A,过A(A+)
export const LEVEL_SEQ = [...RANKS, 'A+'];

export function nextLevel(level, steps) {
  let i = LEVEL_SEQ.indexOf(level);
  if (i < 0) i = 0;
  const j = Math.min(i + steps, LEVEL_SEQ.length - 1);
  return LEVEL_SEQ[j];
}

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

export class Match {
  constructor(seatNames, opts = {}) {
    this.seatNames = seatNames;           // ['P0','P1','P2','P3']
    this.rng = opts.rng || Math.random;
    this.defaultTeamOf = opts.defaultTeamOf || [0, 1, 0, 1]; // 首局队伍：0/2 vs 1/3
    this.levels = [null, null];           // [队伍0级数, 队伍1级数]，null 表示未开始
    this.roundNo = 0;
    this.history = [];
    this.lastResult = null;               // 上一副牌结算
    this.round = null;
    this.matchOver = false;
    this.winnerTeam = null;
  }

  teamName(t) { return t === 0 ? `${this.seatNames[0]}/${this.seatNames[2]}` : `${this.seatNames[1]}/${this.seatNames[3]}`; }

  // 开始新一副牌：发牌 + 亮牌
  newRound() {
    this.roundNo++;
    const prevTeamOf = this.round ? this.round.teamOf : null;
    const r = new Round(this.seatNames, this.lastRoundTeam(), this.rng);
    r.deal();
    const flipInfo = r.flip();
    this.round = r;

    // 进贡判定（首副无贡）
    let tributes = [];
    let tribute = { type: 'none' };
    if (this.lastResult) {
      const { losers, winners, ranking } = this.lastResult;
      const doubleDown = prevTeamOf && prevTeamOf[ranking.second] === prevTeamOf[ranking.first];
      const antiTribute = this.checkAntiTribute(r, losers);
      if (antiTribute) {
        tribute = { type: 'anti' };
      } else if (doubleDown) {
        // 双贡：两输家各进一张最大牌给两赢家（交叉：三游→头游，末游→二游）
        const g1 = pickTributeCard(r.hands[ranking.third], r.level);
        const g2 = pickTributeCard(r.hands[ranking.fourth], r.level);
        tributes = [
          { from: ranking.third, to: ranking.first, card: g1 },
          { from: ranking.fourth, to: ranking.second, card: g2 },
        ];
        tribute = { type: 'double', tributes };
      } else {
        // 单贡：末游向头游进贡
        const g = pickTributeCard(r.hands[ranking.fourth], r.level);
        tributes = [{ from: ranking.fourth, to: ranking.first, card: g }];
        tribute = { type: 'single', tributes };
      }
    }
    r.tributeInfo = tribute;
    if (tributes.length) r.applyTributes(tributes.filter(t => t.card));
    return { round: r, flipInfo, tribute };
  }

  lastRoundTeam() {
    return this.round ? this.round.teamOf : this.defaultTeamOf;
  }

  checkAntiTribute(round, losers) {
    // 进贡方（输队两人）合计握有 2 张大王即可抗贡
    let bj = 0;
    for (const s of losers) for (const c of round.hands[s]) if (c.rank === 'BJ') bj++;
    return bj >= 2;
  }

  // 提交本副牌结算，升级
  applyResult(result) {
    const t = result.winTeam;
    if (this.levels[t] === null) this.levels[t] = '2';
    if (this.levels[1 - t] === null) this.levels[1 - t] = '2';
    const before = this.levels[t];
    this.levels[t] = nextLevel(before, result.total);
    this.lastResult = { ...result, roundNo: this.roundNo, doubleDown: result.base === 3 };
    this.history.push({ roundNo: this.roundNo, level: this.round.level, result: this.lastResult });
    if (this.levels[t] === 'A+') {
      this.matchOver = true;
      this.winnerTeam = t;
    }
    return this.lastResult;
  }

  status() {
    return {
      roundNo: this.roundNo,
      levels: this.levels,
      teamOf: this.round ? this.round.teamOf : null,
      level: this.round ? this.round.level : null,
      matchOver: this.matchOver,
      winnerTeam: this.winnerTeam,
    };
  }
}

// 是否双下：二游与头游同队
export function isDoubleDown(result, teamOf) {
  return teamOf[result.ranking.first] === teamOf[result.ranking.second];
}
