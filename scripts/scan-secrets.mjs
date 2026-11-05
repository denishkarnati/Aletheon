// Fails when a committed file contains something shaped like a credential. Run: npm run scan:secrets   (CI runs it on every push)
// It reads the files git tracks, so it sees exactly what would be published. It prints the file, line and kind of a match, never the value.
// This is a safety net, not a replacement for GitHub's own secret scanning and push protection (turn both on in the repository settings).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const RULES = [
  ['OpenAI/Anthropic-style API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/],
  ['Stripe live or restricted key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ['Private key block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  // example.com/.org/.net are reserved for fake data, so a test fixture such as http://user:pw@example.com/ is not a leak.
  ['Credentials inside a URL', /\bhttps?:\/\/[^\s/:@]+:[^\s/@]{3,}@(?!example\.(?:com|org|net)\b)[a-z0-9.-]+/i],
];
const SKIP_FILE = /(^|\/)(package-lock\.json)$|\.(png|gif|jpg|jpeg|ico|pdf|zip|vsix)$/i;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean);
let hits = 0;
for (const f of files) {
  if (SKIP_FILE.test(f) || !fs.existsSync(f)) continue;
  const text = fs.readFileSync(f, 'utf8');
  if (text.includes('\0')) continue; // binary
  text.split('\n').forEach((line, i) => {
    if (line.length > 5000) line = line.slice(0, 5000); // generated data files have enormous lines
    for (const [kind, re] of RULES) {
      if (re.test(line)) {
        hits++;
        console.log(`${f}:${i + 1}  ${kind}`);
      }
    }
  });
}
console.log(
  hits
    ? `\n${hits} possible secret(s) found. Remove them from the files, rotate the credential, and commit again.`
    : `No secrets found in ${files.length} tracked files.`,
);
process.exit(hits ? 1 : 0);
