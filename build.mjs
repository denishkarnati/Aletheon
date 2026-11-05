import { build } from 'esbuild';
const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: true, logLevel: 'info' };
await build({ ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] });
await build({ ...common, entryPoints: ['src/mcp/server.ts'], outfile: 'dist/mcp.js', banner: { js: '#!/usr/bin/env node' } });
