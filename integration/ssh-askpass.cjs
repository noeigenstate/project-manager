const http = require('node:http');
const url = new URL(process.env.PROJECT_GRID_ASKPASS_URL);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') process.exit(1);
const body = JSON.stringify({ connectionId: process.env.PROJECT_GRID_ASKPASS_ID, prompt: process.argv.slice(2).join(' '), hint: process.env.SSH_ASKPASS_PROMPT });
const request = http.request(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.PROJECT_GRID_ASKPASS_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
  let data = '';
  response.setEncoding('utf8');
  response.on('data', chunk => { data += chunk; if (data.length > 65536) response.destroy(); });
  response.on('end', () => {
    try { const result = JSON.parse(data); if (response.statusCode !== 200 || result.canceled) process.exitCode = 1; else process.stdout.write(result.response + '\n'); }
    catch { process.exitCode = 1; }
  });
});
request.on('error', () => { process.exitCode = 1; });
request.setTimeout(300000, () => request.destroy());
request.end(body);
