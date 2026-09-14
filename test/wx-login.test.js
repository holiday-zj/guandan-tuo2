// 微信登录链路测试（无资质配置时应优雅降级，不崩溃）
const BASE = 'http://127.0.0.1:8080';

(async () => {
  // 1. 未配置 WX_APPID 时，/api/wx/login 应返回明确错误而非崩溃
  const r = await fetch(BASE + '/api/wx/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake_code_123' }),
  });
  const body = await r.json();
  console.log('status:', r.status);
  console.log('body:', JSON.stringify(body));
  if (r.status !== 400 || !body.error) throw new Error('应返回400+错误信息');
  if (!/未配置|AppID/i.test(body.error)) throw new Error('错误信息应说明未配置资质');
  console.log('✓ 未配置微信资质时优雅降级，返回明确错误');

  // 2. health 接口暴露 payEnabled 状态（运维监控用）
  const h = await (await fetch(BASE + '/api/health')).json();
  console.log('✓ health.payEnabled =', h.payEnabled, '(false=免费合规模式)');

  console.log('\n=== 微信登录降级测试通过 ===');
})();
