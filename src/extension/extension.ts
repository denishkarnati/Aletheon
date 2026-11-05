import * as path from 'node:path';
import * as vscode from 'vscode';
import { BOARDS, findBoard } from '../core/boards';
import { verifyUrl } from '../core/docs';
import { Embedder, resolveEmbedder } from '../core/embeddings';
import { ProviderConfig } from '../core/providers';
import { Host, ToolCtx, callTool, createToolCtx } from '../core/tools';
import { errorMessage } from '../core/util';
import { ChatView } from './chatView';

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Aletheon');
  const cfg = () => vscode.workspace.getConfiguration('aletheon');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'aletheon.selectBoard';
  context.subscriptions.push(out, status);

  const boardId = () => context.workspaceState.get<string>('board');
  const refreshStatus = () => {
    status.text = `$(circuit-board) ${findBoard(boardId())?.name ?? 'Select board'}`;
    status.show();
  };
  refreshStatus();

  let embedder: Promise<Embedder | undefined> | undefined;
  let embedderKey = '';
  let cached: { root: string; ctx: ToolCtx } | undefined;
  const getCtx = (): ToolCtx | undefined => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return undefined;
    if (cached?.root === root) return cached.ctx;
    const host: Host = {
      root,
      storeDir: path.join(root, '.aletheon'),
      getBoard: () => findBoard(boardId()),
      getToolchain: () => cfg().get('toolchain', 'auto'),
      getEmbedder: async () => {
        const c = vscode.workspace.getConfiguration('aletheon.embeddings');
        const key = `${c.get('provider')}|${c.get('model')}|${c.get('baseUrl')}`;
        if (embedderKey !== key) {
          embedderKey = key;
          const provider = c.get<'auto' | 'off' | 'ollama' | 'openai-compatible' | 'local'>('provider', 'auto');
          embedder = resolveEmbedder({
            provider,
            model: c.get<string>('model') || undefined,
            baseUrl: c.get<string>('baseUrl') || undefined,
            apiKey: (await context.secrets.get('aletheon.key.openai-compatible')) ?? process.env.OPENAI_API_KEY,
          });
        }
        return embedder;
      },
      confirm: async (msg) => (await vscode.window.showWarningMessage(`Aletheon: ${msg}`, { modal: true }, 'Approve')) === 'Approve',
      log: (l) => out.appendLine(l),
    };
    const ctx = createToolCtx(host);
    cached = { root, ctx };
    return ctx;
  };

  const getCfg = async (): Promise<ProviderConfig> => {
    const provider = cfg().get<'anthropic' | 'openai-compatible'>('provider', 'anthropic');
    const stored = await context.secrets.get(`aletheon.key.${provider}`);
    const env = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
    return { provider, model: cfg().get('model', 'claude-sonnet-5-5'), baseUrl: cfg().get('baseUrl') || undefined, apiKey: stored ?? env };
  };

  const chat = new ChatView(getCtx, getCfg);
  // Command handler that needs a workspace; warns instead of running when no folder is open.
  const withCtx = (fn: (ctx: ToolCtx) => Promise<unknown>) => async () => {
    const ctx = getCtx();
    if (!ctx) return void vscode.window.showWarningMessage('Aletheon: open a folder first.');
    await fn(ctx);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aletheon.chat', chat),
    vscode.commands.registerCommand('aletheon.newChat', () => chat.reset()),
    vscode.commands.registerCommand('aletheon.selectBoard', async () => {
      const pick = await vscode.window.showQuickPick(
        BOARDS.map((b) => ({ label: b.name, description: `${b.vendor} · ${b.mcu}`, id: b.id })),
        { placeHolder: 'Target board' },
      );
      if (pick) {
        await context.workspaceState.update('board', pick.id);
        refreshStatus();
      }
    }),
    vscode.commands.registerCommand('aletheon.setApiKey', async () => {
      const provider = cfg().get<string>('provider', 'anthropic');
      const key = await vscode.window.showInputBox({ prompt: `API key for ${provider}`, password: true, ignoreFocusOut: true });
      if (key) await context.secrets.store(`aletheon.key.${provider}`, key.trim());
    }),
    vscode.commands.registerCommand(
      'aletheon.detectBoards',
      withCtx(async (ctx) => {
        out.show(true);
        out.appendLine(await callTool('detect_boards', {}, ctx));
      }),
    ),
    vscode.commands.registerCommand(
      'aletheon.indexDatasheet',
      withCtx(async (ctx) => {
        const board = findBoard(boardId());
        const choices = [
          ...(board?.docs.map((d) => ({ label: d.title, description: d.url, source: d.url })) ?? []),
          { label: 'Enter URL or path…', description: '', source: '' },
        ];
        const pick = await vscode.window.showQuickPick(choices, { placeHolder: 'Datasheet to index' });
        if (!pick) return;
        const source = pick.source || (await vscode.window.showInputBox({ prompt: 'Datasheet URL or workspace-relative path' }));
        if (!source) return;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Indexing datasheet…' }, async () => {
          const r = await callTool('index_datasheet', { source }, ctx);
          vscode.window.showInformationMessage(r.slice(0, 200));
        });
      }),
    ),
    vscode.commands.registerCommand(
      'aletheon.indexSvd',
      withCtx(async (ctx) => {
        const board = findBoard(boardId());
        let source: string | undefined = board?.svd;
        if (!source || (await vscode.window.showQuickPick([board!.svd!, 'Enter URL or path…'], { placeHolder: 'SVD register map' })) === 'Enter URL or path…') {
          source = await vscode.window.showInputBox({ prompt: 'SVD / CMSIS-Pack URL or workspace-relative path' });
        }
        if (!source) return;
        const entry = /\.(pack|zip)(\?|$)/i.test(source)
          ? await vscode.window.showInputBox({ prompt: 'Name (substring) of the .svd inside the pack, e.g. STM32F401' })
          : undefined;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Parsing SVD…' }, async () => {
          vscode.window.showInformationMessage((await callTool('index_svd', { source, entry }, ctx)).slice(0, 300));
        });
      }),
    ),
    vscode.commands.registerCommand(
      'aletheon.generateDriver',
      withCtx(async (ctx) => {
        if (!ctx.svd.list().length)
          return void vscode.window.showWarningMessage('Index a register map first: "Aletheon: Index Register Map (SVD / CMSIS-Pack)".');
        const name = await vscode.window.showInputBox({ prompt: 'Peripheral to write a driver for (exact SVD name, e.g. UART0)' });
        if (!name) return;
        const goal = await vscode.window.showInputBox({ prompt: 'What should the driver do?', value: 'polled init and byte transmit/receive' });
        if (!goal) return;
        await vscode.commands.executeCommand('aletheon.chat.focus');
        await chat.send(`Write a driver for ${name}: ${goal}. Follow the driver workflow and report which steps were verified.`, true);
      }),
    ),
    vscode.commands.registerCommand(
      'aletheon.buildSemanticIndex',
      withCtx(async (ctx) => {
        const emb = await ctx.host.getEmbedder();
        if (!emb)
          return void vscode.window.showWarningMessage('No embedding model available. Start Ollama with nomic-embed-text, or configure aletheon.embeddings.*.');
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Embedding datasheets (${emb.id})…` }, async (progress) => {
          try {
            const r = await ctx.docs.ensureEmbedded(emb, (m) => progress.report({ message: m }));
            vscode.window.showInformationMessage(`Semantic index ready: ${r.embedded} chunks embedded, ${r.reused} reused.`);
          } catch (e) {
            vscode.window.showErrorMessage(`Embedding failed: ${errorMessage(e)}`);
          }
        });
      }),
    ),
    vscode.commands.registerCommand('aletheon.verifyDocs', async () => {
      out.show(true);
      for (const b of BOARDS)
        for (const u of [...b.docs.map((d) => d.url), ...(b.svd ? [b.svd] : [])]) {
          const r = await verifyUrl(u);
          out.appendLine(`${r.ok ? 'OK  ' : 'FAIL'} ${r.status}  ${b.name}: ${u}`);
        }
    }),
    vscode.commands.registerCommand(
      'aletheon.showLedger',
      withCtx(async (ctx) => {
        const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(ctx.ledger.items, null, 2) });
        vscode.window.showTextDocument(doc, { preview: true });
      }),
    ),
  );
}

export function deactivate(): void {}
