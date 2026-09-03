// 扑克牌 Canvas 绘制（文字版牌面，无需图片素材）
const SUIT_CHAR = { '♠': '♠', '♥': '♥', '♣': '♣', '♦': '♦' };
const SUIT_COLOR = { '♠': '#222', '♥': '#d43f3f', '♣': '#222', '♦': '#d43f3f' };
const RANK_CHAR = { '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', 'T': '10', 'J': 'J', 'Q': 'Q', 'K': 'K', 'A': 'A', 'SJ': '小', 'BJ': '大' };

export function drawCard(ctx, card, x, y, w, h, opts = {}) {
  const { faceDown = false, selected = false, highlight = false, wild = false } = opts;
  // 阴影
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;
  // 卡面
  const oy = selected ? -18 : 0;
  roundRect(ctx, x, y + oy, w, h, 8);
  ctx.fillStyle = faceDown ? '#3a5f8a' : '#fff';
  ctx.fill();
  ctx.restore();

  roundRect(ctx, x, y + oy, w, h, 8);
  ctx.lineWidth = selected ? 3 : 1.5;
  ctx.strokeStyle = selected ? '#ffcf3f' : (highlight ? '#4fc3f7' : '#bbb');
  ctx.stroke();

  if (faceDown) {
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    roundRect(ctx, x + w * 0.15, y + oy + h * 0.15, w * 0.7, h * 0.7, 5);
    ctx.fill();
    return;
  }

  const suit = card.suit;
  const rank = card.rank;
  if (suit === 'X') {
    // 王
    const isBig = rank === 'BJ';
    ctx.fillStyle = isBig ? '#d43f3f' : '#333';
    ctx.font = 'bold ' + Math.floor(h * 0.22) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isBig ? '大' : '小', x + w / 2, y + oy + h * 0.4);
    ctx.font = Math.floor(h * 0.16) + 'px sans-serif';
    ctx.fillText('王', x + w / 2, y + oy + h * 0.62);
  } else {
    const color = SUIT_COLOR[suit];
    ctx.fillStyle = color;
    ctx.font = 'bold ' + Math.floor(h * 0.24) + 'px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(RANK_CHAR[rank], x + 6, y + oy + Math.floor(h * 0.28));
    ctx.font = Math.floor(h * 0.2) + 'px sans-serif';
    ctx.fillText(SUIT_CHAR[suit], x + 6, y + oy + Math.floor(h * 0.5));
    // 中央大花色
    ctx.font = Math.floor(h * 0.34) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.globalAlpha = 0.25;
    ctx.fillText(SUIT_CHAR[suit], x + w * 0.66, y + oy + h * 0.72);
    ctx.globalAlpha = 1;
  }
  // 逢人配标记
  if (wild) {
    ctx.fillStyle = '#ff9800';
    ctx.font = 'bold ' + Math.floor(h * 0.18) + 'px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('配', x + w - 5, y + oy + h - 6);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
