// Isolated smoke backend. No dependencies; bounded RFC 6455 text-frame echo.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

function frame(opcode, payload) {
  const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([head, payload]);
}
const ports = (process.env.DCI_SMOKE_PORTS || '8080,8081').split(',').map(Number);
for (const port of ports) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ service: 'dci-smoke-backend', port }));
  });
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') return socket.destroy();
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.setTimeout(15000, () => socket.destroy());
    const consume = data => {
      buffered = Buffer.concat([buffered, data]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15;
        if (!(buffered[0] & 128) || !(buffered[1] & 128)) return socket.destroy();
        let size = buffered[1] & 127, offset = 2;
        if (size === 127) return socket.destroy();
        if (size === 126) {
          if (buffered.length < 4) return;
          size = buffered.readUInt16BE(2); offset = 4;
        }
        if (size > 4096) return socket.destroy();
        if (buffered.length < offset + 4 + size) return;
        const mask = buffered.subarray(offset, offset + 4);
        const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + size));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buffered = buffered.subarray(offset + 4 + size);
        if (opcode === 8) { socket.end(frame(8, payload)); return; }
        if (opcode === 9) socket.write(frame(10, payload));
        else if (opcode === 1) socket.write(frame(1, payload));
        else if (opcode !== 10) return socket.destroy();
      }
    };
    socket.on('data', consume);
    if (head.length) consume(head);
  });
  server.listen(port, process.env.DCI_SMOKE_BIND || '0.0.0.0');
}
