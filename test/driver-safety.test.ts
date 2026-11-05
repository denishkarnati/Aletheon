// A vendor SVD is untrusted input. Names, access types and descriptions end up in generated C that gets compiled (and possibly flashed),
// so none of them may break out of a comment or a string literal. Run: npm run test:driver
import { generateRegsHeader } from '../src/core/driver';
import { parseSvd } from '../src/core/svd';

let failed = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};

// What a C compiler would see as code: drop comments and string/char literals.
function codeOnly(src: string): string {
  let out = '';
  for (let i = 0; i < src.length;) {
    if (src.startsWith('/*', i)) {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) return out + '<<UNTERMINATED COMMENT>>';
      i = e + 2;
    } else if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (src[i] === '"' || src[i] === "'") {
      const q = src[i++];
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\n') return out + '<<UNTERMINATED STRING>>';
        i += src[i] === '\\' ? 2 : 1;
      }
      i++;
      out += q + q;
    } else out += src[i++];
  }
  return out;
}

const EVIL_NAME = 'X*/\n#include "/etc/passwd"\nint PWNED_NAME;/*';
const xml = `<?xml version="1.0"?>
<device>
  <name>${'EVIL*/ int PWNED_DEV; /*'}</name>
  <peripherals><peripheral>
    <name>PER</name>
    <baseAddress>0x40000000</baseAddress>
    <registers>
      <register><name>${EVIL_NAME}</name><description>desc */ int PWNED_DESC; /*</description><addressOffset>0x0</addressOffset><size>32</size><access>read-write */ int PWNED_ACC; /*</access></register>
      <register><name>R2"); int PWNED_STR; ("</name><addressOffset>0x4</addressOffset><size>32</size></register>
      <register><name>OVERLAP*/ int PWNED_SKIP; /*</name><addressOffset>0x4</addressOffset><size>32</size></register>
    </registers>
  </peripheral></peripherals>
</device>`;

const dev = parseSvd('test://evil.svd', xml);
const h = generateRegsHeader(dev, dev.peripherals[0], 'E1').text;
const code = codeOnly(h);

check('the hostile SVD parsed into registers', dev.peripherals[0].registers.length >= 2);
check('no comment is left unterminated and no string runs across lines', !code.includes('<<UNTERMINATED'), code.slice(-200));
// A sanitised identifier such as the header guard ALETHEON_EVIL___INT_PWNED_DEV_..._H is harmless; an injected statement is not.
const injected = /\bint\s+PWNED|\bPWNED\w*\s*[;(=]/;
check(
  'no injected statement survives as code (device, register, description, access, string, skipped list)',
  !injected.test(code),
  code.match(/.{0,40}PWNED.{0,40}/)?.[0] ?? '',
);
check(
  "no #include other than the generator's own survives",
  (code.match(/#\s*include\s*[<"][^>"]*[>"]/g) ?? []).every((x) => /stdint|stddef/.test(x)),
  JSON.stringify(code.match(/#\s*include[^\n]*/g)),
);
check('the header still contains the register macros', /#define PER_/.test(code));

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
