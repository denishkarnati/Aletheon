// SSRF guard: URLs chosen by a model must not reach private networks, including via redirects. Run: npm run test:net
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertPublicHttpUrl, isPrivateIp, readSource, safeGet } from '../src/core/net';

let failed = 0;
const check = (label: string, ok: boolean): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
};
const blocked = async (u: string): Promise<boolean> =>
  assertPublicHttpUrl(u).then(
    () => false,
    () => true,
  );

async function main(): Promise<void> {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.9',
    '172.16.5.5',
    '172.31.255.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    // the forms the URL parser produces for IPv4-in-IPv6, and other ranges that must never be reachable
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::',
    'fec0::1',
    'ff02::1',
    '2001::1',
    '2001:db8::1',
    '100::1',
    '0.0.0.0',
    '192.0.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ])
    check(`private ip ${ip}`, isPrivateIp(ip));
  for (const ip of [
    '8.8.8.8',
    '172.32.0.1',
    '151.101.1.1',
    '2606:4700::1111',
    '2a00:1450:4001::1',
    '2001:4860:4860::8888',
    '64:ff9b::808:808',
    '2002:808:808::',
    '::ffff:808:808',
  ])
    check(`public ip ${ip}`, !isPrivateIp(ip));
  check('an unparseable address is treated as private (fail closed)', isPrivateIp('not-an-ip') && isPrivateIp('1.2.3'));
  for (const u of [
    'http://localhost:11434/x',
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::7f00:1]/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://user:secret@example.com/',
    'http://printer.local/',
    'http://db.internal/',
    'file:///etc/passwd',
    'ftp://example.com/x',
  ])
    check(`blocked ${u}`, await blocked(u));
  check('public https allowed', !(await blocked('https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf')));
  process.env.ALETHEON_ALLOW_PRIVATE_URLS = '1';
  check('override env allows an internal mirror', !(await blocked('http://localhost:8080/ds.pdf')));

  // ---- bounded fetching, against a local server (allowed only because the override env is set above)
  const server = http.createServer((req, res) => {
    if (req.url === '/small') return void res.end('hello');
    if (req.url === '/big') return void res.end(Buffer.alloc(5000, 1)); // content-length: 5000
    if (req.url === '/stream') {
      res.write(Buffer.alloc(3000, 1)); // no content-length: only the running total can stop it
      return void setTimeout(() => res.end(Buffer.alloc(3000, 1)), 20);
    }
    if (req.url === '/hang') return; // never answers
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      return void res.end();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const rejects = async (p: Promise<unknown>, re: RegExp): Promise<boolean> =>
    p.then(
      () => false,
      (e: Error) => re.test(e.message),
    );
  const small = await safeGet(`${base}/small`);
  check('safeGet returns status and body', small.status === 200 && small.body.toString() === 'hello');
  check('response over the size limit (content-length) is refused', await rejects(safeGet(`${base}/big`, { maxBytes: 1000 }), /too large/));
  check('response over the size limit (streamed, no content-length) is refused', await rejects(safeGet(`${base}/stream`, { maxBytes: 4000 }), /too large/));
  check('a server that never answers is cut off by the timeout', await rejects(safeGet(`${base}/hang`, { timeoutMs: 200 }), /timed out/));
  check('a redirect loop ends with an error', await rejects(safeGet(`${base}/loop`, { maxRedirects: 3 }), /too many redirects/));
  check('a 404 is returned as a status, not hidden', (await safeGet(`${base}/nope`)).status === 404);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheon-net-'));
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'abc');
  check('readSource reads a regular local file', (await readSource(path.join(tmp, 'a.txt'))).bytes.toString() === 'abc');
  check('readSource refuses a directory (and so a device or FIFO)', await rejects(readSource(tmp), /not a regular file/));
  check('readSource turns an HTTP error into an error', await rejects(readSource(`${base}/nope`), /HTTP 404/));
  delete process.env.ALETHEON_ALLOW_PRIVATE_URLS;
  check('without the override, a local server is refused again', await rejects(safeGet(`${base}/small`), /blocked/));
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}
main();
