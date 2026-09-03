// 最小 WS 握手调试
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';

function post(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request({ host: '127.0.0.1', port: 8080, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.end(body);
  });
}

const reg = await post('/api/register', { name: '握手测试' + Date.now(), password: 'x' });
console.log('token:', reg.token.slice(0, 16) + '...');

const socket = net.connect(8080, '127.0.0.1', () => {
  const key = crypto.randomBytes(16).toString('base64');
  const req = `GET /?token=${reg.token} HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
  console.log('发送升级请求...');
  socket.write(req);
});
socket.on('data', chunk => {
  console.log('收到数据(' + chunk.length + '字节):', JSON.stringify(chunk.slice(0, 200).toString('binary')));
  socket.destroy();
  process.exit(0);
});
socket.on('error', e => { console.error('socket error:', e.message); process.exit(1); });
socket.on('close', () => console.log('连接关闭'));
setTimeout(() => { console.error('10秒无响应，超时'); process.exit(2); }, 10000);
