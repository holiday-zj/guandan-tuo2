// 服务端配置：全部来自环境变量，缺省值保证开发环境可跑
// ⚠️ 合规要点：PAY_ENABLED 只有在拿到 游戏版号 + 微信虚拟支付开通 + 商户号 之后才允许置 true
//    没有资质时必须保持 false（客户端自动降级为"每日免费金币"模式），否则违反微信平台规则与法规
export const config = {
  port: parseInt(process.env.PORT || '8080', 10),

  // —— 微信小程序/小游戏 ——
  wxAppId: process.env.WX_APPID || '',          // 需要：小游戏 AppID
  wxSecret: process.env.WX_SECRET || '',        // 需要：AppSecret

  // —— 虚拟支付（米大师 midas，仅安卓可用；iOS 禁止虚拟支付）——
  payEnabled: process.env.PAY_ENABLED === 'true' && !!process.env.WX_APPID && !!process.env.WX_MIDAS_APPKEY,
  midasAppKey: process.env.WX_MIDAS_APPKEY || '',   // 需要：虚拟支付 AppKey
  midasOfferId: process.env.WX_MIDAS_OFFER_ID || '', // 需要：虚拟支付 offerId

  // —— 免费模式（合规兜底）——
  dailyFreeCoins: parseInt(process.env.DAILY_FREE_COINS || '500', 10),  // 每日赠送
  registerBonus: 1000,   // 注册赠送（db.js 中初始 coins）

  // —— 充值档位（单位：分；1元=10币，可按运营调整）——
  packages: [
    { id: 'p6',    name: '60 游戏币',    coins: 60,    amountFen: 600 },
    { id: 'p30',   name: '300 游戏币',   coins: 300,   amountFen: 3000 },
    { id: 'p68',   name: '680 游戏币',   coins: 680,   amountFen: 6800 },
    { id: 'p128',  name: '1280 游戏币',  coins: 1280,  amountFen: 12800 },
    { id: 'p328',  name: '3280 游戏币',  coins: 3280,  amountFen: 32800 },
    { id: 'p648',  name: '6480 游戏币',  coins: 6480,  amountFen: 64800 },
  ],
};

export function packageById(id) {
  return config.packages.find(p => p.id === id) || null;
}
