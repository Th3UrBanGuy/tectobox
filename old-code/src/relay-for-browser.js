// Local no-auth relay → authed egress proxy, for headless Chromium.
// The VM's egress proxy needs auth; Chromium headless-shell struggles with it
// directly, so this relay adds the auth and forwards.
const http = require('http');
const net = require('net');

const EGRESS = process.env.https_proxy || process.env.http_proxy;
if (!EGRESS) { console.error('no egress proxy in env'); process.exit(1); }
const egressUrl = new URL(EGRESS);
const EGRESS_HOST = egressUrl.hostname;
const EGRESS_PORT = +(egressUrl.port || 3128);
const AUTH = 'Basic ' + Buffer.from(
  decodeURIComponent(egressUrl.username) + ':' + decodeURIComponent(egressUrl.password)
).toString('base64');

const server = http.createServer((req, res) => {
  // Plain HTTP forwarding (rare; most traffic is CONNECT).
  const fwdHeaders = { ...req.headers };
  delete fwdHeaders['host']; // let Node set Host for the egress proxy authority
  fwdHeaders['Proxy-Authorization'] = AUTH;
  const opts = {
    host: EGRESS_HOST, port: EGRESS_PORT, method: req.method, path: req.url,
    headers: fwdHeaders,
  };
  const pr = http.request(opts, (prx) => { res.writeHead(prx.statusCode, prx.headers); prx.pipe(res); });
  pr.on('error', () => res.writeHead(502).end());
  req.pipe(pr);
});

server.on('connect', (req, sock, head) => {
  const [host, port] = req.url.split(':');
  const c = net.connect(EGRESS_PORT, EGRESS_HOST, () => {
    c.write(`CONNECT ${host}:${port || 443} HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: ${AUTH}\r\n\r\n`);
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        c.removeListener('data', onData);
        if (/^HTTP\/1\.[01] 200/.test(buf)) {
          sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) c.write(head);
          const rest = Buffer.from(buf.split('\r\n\r\n').slice(1).join('\r\n\r\n'), 'latin1');
          if (rest.length) sock.write(rest);
          sock.pipe(c).pipe(sock);
        } else { sock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); sock.destroy(); c.destroy(); }
      }
    };
    c.on('data', onData);
    c.on('error', () => { sock.destroy(); });
  });
  c.on('error', () => sock.destroy());
  sock.on('error', () => c.destroy());
});

const PORT = 18080;
server.listen(PORT, '127.0.0.1', () => console.log('relay on 127.0.0.1:' + PORT));
