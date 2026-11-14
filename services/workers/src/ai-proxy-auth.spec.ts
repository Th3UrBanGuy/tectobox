import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync, spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PROXY_SERVER_PY = path.join(REPO_ROOT, 'services/ai-proxy/gemini_web2api/server.py');
const PROXY_MAIN_PY = path.join(REPO_ROOT, 'services/ai-proxy/gemini_web2api.py');

describe('H16 Gemini Proxy Auth — Fail Closed', () => {
  it('unset GEMINI_PROXY_SECRET -> proxy refuses to start (test the guard)', () => {
    // 1. Test server.py check_proxy_secret guard
    const resServer = spawnSync(
      'python3',
      [
        '-c',
        `import sys; sys.path.insert(0, '${path.join(REPO_ROOT, 'services/ai-proxy')}'); from gemini_web2api.server import check_proxy_secret; check_proxy_secret()`,
      ],
      {
        env: { ...process.env, GEMINI_PROXY_SECRET: '' },
        encoding: 'utf8',
      }
    );
    assert.notStrictEqual(resServer.status, 0, 'server.py guard should fail when GEMINI_PROXY_SECRET is empty');
    assert.match(
      resServer.stderr,
      /GEMINI_PROXY_SECRET environment variable is unset; refusing to start \(fail closed\)/
    );

    // 2. Test gemini_web2api.py check_proxy_secret guard
    const resMain = spawnSync(
      'python3',
      [
        PROXY_MAIN_PY,
      ],
      {
        env: { ...process.env, GEMINI_PROXY_SECRET: '' },
        encoding: 'utf8',
      }
    );
    assert.notStrictEqual(resMain.status, 0, 'gemini_web2api.py guard should fail when GEMINI_PROXY_SECRET is empty');
    assert.match(
      resMain.stderr,
      /GEMINI_PROXY_SECRET environment variable is unset; refusing to start \(fail closed\)/
    );
  });

  it('proxy request without secret header or with ?key= returns 401; valid header succeeds', async () => {
    // Start proxy server on random test port with a test secret
    const testSecret = 'test-proxy-secret-h16-auth';
    const testPort = 18880 + Math.floor(Math.random() * 1000);

    const proc = spawn(
      'python3',
      [
        '-c',
        `
import os, sys
os.environ['GEMINI_PROXY_SECRET'] = '${testSecret}'
sys.path.insert(0, '${path.join(REPO_ROOT, 'services/ai-proxy')}')
from gemini_web2api.server import GeminiHandler, ThreadedServer
server = ThreadedServer(('127.0.0.1', ${testPort}), GeminiHandler)
server.serve_forever()
`,
      ],
      {
        stdio: 'inherit',
      }
    );

    try {
      // Wait for server to bind
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          await fetch(`http://127.0.0.1:${testPort}/v1/models`);
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.ok(ready, 'proxy server should be reachable');

      // 1. Request without secret header -> 401
      const resNoHeader = await fetch(`http://127.0.0.1:${testPort}/v1/models`);
      assert.strictEqual(resNoHeader.status, 401, 'request without X-Proxy-Secret must be 401');

      // 2. Request with ?key= param instead of header -> 401
      const resQueryKey = await fetch(`http://127.0.0.1:${testPort}/v1/models?key=${testSecret}`);
      assert.strictEqual(resQueryKey.status, 401, 'request with ?key= query param must be 401');

      // 3. Request with wrong secret header -> 401
      const resWrongHeader = await fetch(`http://127.0.0.1:${testPort}/v1/models`, {
        headers: { 'X-Proxy-Secret': 'wrong-secret' },
      });
      assert.strictEqual(resWrongHeader.status, 401, 'request with invalid secret header must be 401');

      // 4. Request with valid X-Proxy-Secret header -> 200 OK
      const resValid = await fetch(`http://127.0.0.1:${testPort}/v1/models`, {
        headers: { 'X-Proxy-Secret': testSecret },
      });
      assert.strictEqual(resValid.status, 200, 'request with valid X-Proxy-Secret header must be 200 OK');
    } finally {
      proc.kill('SIGTERM');
    }
  });
});
