// Claim audit of a draft answer against the evidence ledger.
import { auditClaims, formatAudit } from '../audit';
import { Tool, obj, str } from './context';

export const auditTools: Tool[] = [
  {
    name: 'audit_claims',
    description:
      'Audit a draft answer: every sentence stating a hardware value (hex address, voltage/current/frequency/timing, pin) must cite an [E#] whose excerpt actually contains that value. Returns unsupported/uncited/unknown-citation claims and notes claims resting only on community-mirror sources. Run it on your final answer and fix what it flags.',
    input_schema: obj({ text: str('the draft answer') }, ['text']),
    async run(a, ctx) {
      return formatAudit(auditClaims(String(a.text ?? ''), ctx.ledger));
    },
  },
];
