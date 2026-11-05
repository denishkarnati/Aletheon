// Optional reverse-engineering via the pinned REA CLI.
import { run, tail } from '../proc';
import { Tool, obj } from './context';

const REA_VERSION = '6.7.0'; // reviewed release of github.com/morluto/rea (MIT); bump deliberately

export const reaTools: Tool[] = [
  {
    name: 'rea_run',
    description:
      'Run the REA reverse-engineering CLI (github.com/morluto/rea) for firmware/binary/pcap/logic-capture analysis, e.g. args ["--help"]. Output is recorded as evidence.',
    input_schema: obj({ args: { type: 'array', items: { type: 'string' }, description: 'arguments after `rea`' } }, ['args']),
    async run(a, ctx) {
      const args: string[] = (a.args ?? []).map(String);
      const useGlobal = (await run('rea', ['--version'], { timeoutMs: 15_000 })).code === 0;
      // Pinned: never fetch "latest" code on a model's say-so.
      const [cmd, full] = useGlobal ? ['rea', args] : ['npx', ['-y', `rea-agents@${REA_VERSION}`, ...args]];
      if (!(await ctx.host.confirm(`Run ${cmd} ${full.join(' ')}${useGlobal ? '' : ' (downloads the rea-agents npm package and executes it)'}?`)))
        return 'User declined running REA.';
      const r = await run(cmd, full, { cwd: ctx.host.root, timeoutMs: 300_000 });
      const e = ctx.ledger.add('rea', `${cmd} ${full.join(' ')}`, tail(r.out, 1400));
      return `[${e.id}] rea exit ${r.code}\n${tail(r.out)}`;
    },
  },
];
