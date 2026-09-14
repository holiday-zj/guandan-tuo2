// 微信小程序登录 + 虚拟支付（米大师）服务
// ⚠️ 合规：payEnabled=false 时所有充值接口返回"未开放"，客户端自动降级为每日免费币模式
import crypto from 'node:crypto';
import { config, packageById } from './config.js';
import { store, publicProfile } from './db.js';

// —— 微信登录：code2session ——
export async function wxLogin(code) {
  const appid = config.wxAppId;
  const appsecret = config.wxSecret; // 从环境变量 WX_SECRET 读取
  if (!appid || !appsecret) {
    return { ok: false, error: '未配置微信 AppID/AppSecret，无法使用微信登录' };
  }
  const sec = appsecret;
  const qs = new URLSearchParams({
    appid,
    secret: sec,
    js_code: code,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://api.weixin.qq.com/sns/jscode2session?' + qs.toString());
  const data = await res.json();
  if (!data.openid) return { ok: false, error: '微信登录失败: ' + (data.errmsg || 'unknown') };

  const r = store.loginByOpenid(data.openid, data.nickname || null);
  const token = store.issueToken(r.member.id);
  return { ok: true, token, profile: publicProfile(r.member), isNew: r.isNew };
}

// —— 创建充值订单：返回给客户端调起 wx.requestMidasPayment 的参数 ——
export function createRecharge(member, packageId, platform) {
  if (!config.payEnabled) {
    return { ok: false, code: 'PAY_DISABLED', error: '充值功能暂未开放（合规要求：需游戏版号+虚拟支付资质）。可每日免费领取游戏币。' };
  }
  // iOS 全面禁止虚拟支付
  if (platform === 'ios') {
    return { ok: false, code: 'IOS_FORBIDDEN', error: '苹果政策限制，iOS 设备不支持充值，请使用安卓设备' };
  }
  // 未成年人禁止充值（防沉迷法定要求）
  if (member.isMinor) return { ok: false, code: 'MINOR_FORBIDDEN', error: '未成年人不得充值' };
  if (!member.isVerified) return { ok: false, code: 'NEED_VERIFY', error: '请先完成实名认证' };
  const pkg = packageById(packageId);
  if (!pkg) return { ok: false, error: '无效档位' };
  // 成年用户单月充值限额（防沉迷规定）：累计 ¥500
  const monthPaid = member.totalPaidFen || 0;
  if (monthPaid + pkg.amountFen > 50000) {
    return { ok: false, code: 'LIMIT', error: '已达本月充值上限（¥500）' };
  }

  const outTradeNo = store.createOrder(member.id, pkg, 'wechat');
  return {
    ok: true,
    order: {
      outTradeNo,
      // wx.requestMidasPayment 参数（sig 由 /api/pay/sign 接口用会话密钥签名）
      mode: 'game',
      env: 0,
      offerId: config.midasOfferId,
      currencyType: 'CNY',
      platform: 'android',
      buyQuantity: Math.max(1, Math.round(pkg.amountFen / 100)),
      zoneId: '1',
    },
    pkg,
  };
}

// —— 米大师签名（wx.requestMidasPayment 前调用）——
// sig  = HMAC-SHA256(AppKey, uri + '&' + postData)
// sig2 = HMAC-SHA256(sessionKey, uri + '&' + postData)
export function midasSign(params, sessionKey) {
  const uri = params.uri || '/xpay/query_user_balance';
  const postData = JSON.stringify(params.postData || {});
  const plain = uri + '&' + postData;
  return {
    sig: crypto.createHmac('sha256', config.midasAppKey).update(plain).digest('hex'),
    sig2: crypto.createHmac('sha256', sessionKey || config.midasAppKey).update(plain).digest('hex'),
  };
}

// —— 支付结果回调（米大师服务器通知，需验签）——
export function handlePayNotify(body, signature) {
  if (!config.payEnabled) return { ok: false, error: 'pay disabled' };
  // 生产接入：按米大师文档用 AppKey 验证 signature（HMAC-SHA256），验签失败必须拒绝
  const outTradeNo = body && (body.bill_no || body.outTradeNo);
  if (!outTradeNo) return { ok: false, error: 'missing bill_no' };
  return store.payOrder(outTradeNo, body.txn_id || body.transaction_id || null);
}

// —— 开发模式：模拟支付成功（仅 DEV_FAKE_PAY=true 时可用，方便无资质联调）——
export function devFakePay(member, packageId) {
  if (process.env.DEV_FAKE_PAY !== 'true') {
    return { ok: false, error: '模拟支付未启用' };
  }
  const pkg = packageById(packageId);
  if (!pkg) return { ok: false, error: '无效档位' };
  const outTradeNo = store.createOrder(member.id, pkg, 'free');
  const r = store.payOrder(outTradeNo, 'DEV_FAKE');
  return { ok: true, member: publicProfile(r.member) };
}

// —— 每日免费领取 ——
export function claimDailyFree(member) {
  const r = store.claimDaily(member.id, config.dailyFreeCoins);
  return r.ok ? { ok: true, coins: r.coins, profile: publicProfile(r.member) } : { ok: false, error: r.error };
}

// —— 实名认证（格式校验+成年判断；生产必须接国家新闻出版署权威核验接口）——
export function verifyIdentity(member, realName, idNumber) {
  if (!realName || realName.length < 2) return { ok: false, error: '姓名格式不对' };
  if (!/^\d{17}[\dXx]$/.test(idNumber || '')) return { ok: false, error: '身份证号格式不对' };
  const r = store.verifyIdentity(member.id, realName, idNumber);
  if (r.isMinor) return { ok: true, isMinor: true, message: '已认证为未成年人：不可充值，游戏时长受限' };
  return { ok: true, isMinor: false, profile: publicProfile(store.memberById(member.id)) };
}
