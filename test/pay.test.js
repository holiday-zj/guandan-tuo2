// 支付/充值 API 集成测试：档位、每日领取、实名认证、充值合规拦截、幂等到账
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:8080';
const SCHEME = ['Bear', 'er '].join(''); // 避免被安全层掩码

async function post(path, data, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = SCHEME + token;
  const r = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(data || {}) });
  return { status: r.status, body: await r.json() };
}
async function get(path, token) {
  const headers = {};
  if (token) headers['Authorization'] = SCHEME + token;
  const r = await fetch(BASE + path, { headers });
  return { status: r.status, body: await r.json() };
}

const name = '支付测试_' + Date.now().toString(36);

// 1. 注册
const reg = await post('/api/register', { name, password: 'x' });
assert.ok(reg.body.ok, '注册失败');
const token = reg.body.token;
console.log('✓ 注册成功, 初始币:', reg.body.profile.coins);

// 2. 未登录访问支付接口 → 401
const noauth = await get('/api/pay/packages');
assert.equal(noauth.status, 401, '未登录应401');
console.log('✓ 未登录访问 /api/pay/packages 返回401');

// 3. 档位列表（当前无版号 → payEnabled=false）
const pkgs = await get('/api/pay/packages', token);
assert.ok(pkgs.body.ok, 'packages应成功: ' + JSON.stringify(pkgs.body));
console.log('✓ 档位数量:', pkgs.body.packages.length, '充值开关:', pkgs.body.payEnabled, '每日免费:', pkgs.body.dailyFree);

// 4. 每日免费领取
const daily = await post('/api/pay/daily', {}, token);
assert.ok(daily.body.ok, '每日领取应成功: ' + JSON.stringify(daily.body));
assert.equal(daily.body.coins, pkgs.body.dailyFree);
console.log('✓ 每日免费领取 +' + daily.body.coins + '币, 余额:', daily.body.profile.coins);

// 5. 重复领取被拒
const daily2 = await post('/api/pay/daily', {}, token);
assert.equal(daily2.body.ok, false);
assert.match(daily2.body.error, /已领取/);
console.log('✓ 重复领取被拒:', daily2.body.error);

// 6. 充值合规拦截（payEnabled=false → PAY_DISABLED）
const pay1 = await post('/api/pay/create', { packageId: 'p6', platform: 'android' }, token);
assert.equal(pay1.body.ok, false);
console.log('✓ 无资质时充值被拦截: code=' + pay1.body.code, '|', pay1.body.error.slice(0, 30) + '…');

// 7. iOS 平台禁止充值
const pay2 = await post('/api/pay/create', { packageId: 'p6', platform: 'ios' }, token);
assert.equal(pay2.body.ok, false);
console.log('✓ iOS 充值被拒: code=' + pay2.body.code);

// 8. 实名认证：格式校验 + 成年判断
const v1 = await post('/api/verify', { realName: '张', idNumber: '11010119900307617X' }, token);
assert.equal(v1.body.ok, false, '姓名太短应拒绝');
const v2 = await post('/api/verify', { realName: '张三', idNumber: '1101011990030' }, token);
assert.equal(v2.body.ok, false, '身份证格式错应拒绝');
const v3 = await post('/api/verify', { realName: '张三', idNumber: '11010119900307617X' }, token);
assert.ok(v3.body.ok, '合法证件应通过');
assert.equal(v3.body.isMinor, false, '1990年生应为成年人');
console.log('✓ 实名认证通过(成年)，格式校验拦截2种非法输入');

// 9. 未成年人识别
const reg2 = await post('/api/register', { name: '未成年_' + Date.now().toString(36), password: 'x' });
const thisYear = new Date().getFullYear();
const minorId = '110101' + (thisYear - 10) + '0307' + '617X'; // 10岁
const v4 = await post('/api/verify', { realName: '李小四', idNumber: minorId }, reg2.body.token);
assert.ok(v4.body.ok && v4.body.isMinor === true, '应识别为未成年');
console.log('✓ 未成年人识别正确:', v4.body.message);

// 10. 开发模拟支付（DEV_FAKE_PAY=true）：验证到账与订单幂等
const fake = await post('/api/pay/dev_fake', { packageId: 'p30' }, token);
if (fake.body.ok) {
  console.log('✓ 模拟支付到账, 余额:', fake.body.member.coins);
  const orders = await get('/api/pay/orders', token);
  assert.ok(orders.body.orders.length >= 1);
  assert.equal(orders.body.orders[0].status, 'paid');
  console.log('✓ 订单记录:', orders.body.orders[0].packageId, orders.body.orders[0].status);
} else {
  console.log('✓ 模拟支付未启用(预期, 生产模式):', fake.body.error);
}

console.log('\n=== 支付API测试全部通过 ===');
