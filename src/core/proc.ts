import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  out: string;
  timedOut: boolean;
}

// Arguments are never interpreted by a shell as anything but literals: reject metacharacters up front.
// On Windows the command goes through cmd.exe, which expands %VAR%, so '%' is rejected there too.
const SAFE_ARG = /^[\w@%+=:,./\\ ~-]*$/;
const SAFE_ARG_WIN = /^[\w@+=:,./\\ ~-]*$/;

export const safeArg = (a: string, win = process.platform === 'win32'): boolean => (win ? SAFE_ARG_WIN : SAFE_ARG).test(a);

// Child processes (build tools, project scripts, PlatformIO extra_scripts) are not trusted with the API keys held by this process.
// Only what toolchains need to find themselves is passed on. Anything else can be added on purpose: ALETHEON_PASS_ENV=NAME1,NAME2.
const ENV_ALLOW =
  /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|USERNAME|USER|LOGNAME|SHELL|TERM|LANG|LANGUAGE|LC_[A-Z_]+|TZ|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|NODE_EXTRA_CA_CERTS|VIRTUAL_ENV|CONDA_[A-Z_]+|MSYSTEM|PYTHONHOME|PYTHONPATH|PYTHONIOENCODING|PYTHONUTF8|PLATFORMIO_[A-Z_]+|ARDUINO_[A-Z_]+|IDF_[A-Z_]+|ESP_[A-Z_]+|ZEPHYR_[A-Z_]+|npm_config_[a-z_]+)$/i;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

export function childEnv(env: NodeJS.ProcessEnv = process.env, win = process.platform === 'win32'): NodeJS.ProcessEnv {
  const extra = new Set(
    (env.ALETHEON_PASS_ENV ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (extra.has(k.toLowerCase()) || (ENV_ALLOW.test(k) && !SECRET_NAME.test(k))) out[k] = v;
  }
  // cmd.exe looks in the current directory before PATH: a project could plant pio.bat or python.exe there. This turns that off.
  if (win) out.NoDefaultCurrentDirectoryInExePath = '1';
  return out;
}

export function run(cmd: string, args: string[], o: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  const win = process.platform === 'win32';
  const bad = args.find((a) => !safeArg(a, win));
  if (bad !== undefined) return Promise.resolve({ code: -1, out: `rejected argument: ${bad}`, timedOut: false });
  const quote = (a: string) => (win && /\s/.test(a) ? `"${a}"` : a);
  return new Promise((resolve) => {
    // Windows needs cmd.exe to resolve .cmd/.bat shims (pio, npx); the line is joined here because every arg already passed safeArg.
    const p = win
      ? spawn([cmd, ...args].map(quote).join(' '), { cwd: o.cwd, shell: true, windowsHide: true, env: childEnv() })
      : spawn(cmd, args, { cwd: o.cwd, windowsHide: true, env: childEnv() });
    let out = '';
    const cap = (d: Buffer) => {
      out += d.toString();
      if (out.length > 200_000) out = out.slice(-200_000);
    };
    p.stdout.on('data', cap);
    p.stderr.on('data', cap);
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      // With shell: true, p is cmd.exe; killing it alone would leave the real tool (pio, idf.py, a serial reader) running.
      if (win && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }).on('error', () => p.kill());
      else p.kill();
    }, o.timeoutMs ?? 120_000);
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: String(e), timedOut });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, timedOut });
    });
  });
}

export const tail = (s: string, n = 4000): string => (s.length > n ? '…' + s.slice(-n) : s);
