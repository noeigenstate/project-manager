const net = require('node:net');
const { randomUUID } = require('node:crypto');

// A per-launch local pipe; the renderer never receives session credentials.
async function createEventServer(onEvent) {
  const name = `project-grid-${randomUUID()}`;
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : require('node:path').join(require('node:os').tmpdir(), `${name}.sock`);
  const connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(1500, () => socket.destroy());
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 65536) return socket.destroy();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const event = JSON.parse(buffer.slice(0, newline));
        if (event && typeof event.projectId === 'string' && typeof event.sessionKey === 'string' && typeof event.type === 'string') onEvent(event);
      } catch { /* Invalid messages never affect a terminal. */ }
      socket.end();
    });
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
  return { name, address, close() { for (const socket of connections) socket.destroy(); server.close(); } };
}

module.exports = { createEventServer };
