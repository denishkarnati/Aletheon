import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { runAgent } from '../core/agent';
import { ProviderConfig, Turn } from '../core/providers';
import { ToolCtx } from '../core/tools';
import { errorMessage } from '../core/util';

export class ChatView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private history: Turn[] = [];
  private abort?: AbortController;

  constructor(
    private getCtx: () => ToolCtx | undefined,
    private getCfg: () => Promise<ProviderConfig>,
  ) {}

  reset(): void {
    this.history = [];
    this.view?.webview.postMessage({ type: 'reset' });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'stop') return this.abort?.abort();
      if (m.type === 'send' && typeof m.text === 'string') await this.send(m.text);
    });
  }

  // Also used by commands (e.g. "Generate Driver") to start a conversation turn programmatically.
  async send(text: string, echo = false): Promise<void> {
    if (!text.trim()) return;
    const ctx = this.getCtx();
    if (!ctx) return this.post({ type: 'warn', text: 'Open a folder first: Aletheon needs a workspace for its evidence ledger.' });
    if (echo) this.post({ type: 'user', text });
    this.abort = new AbortController();
    this.post({ type: 'busy', value: true });
    try {
      await runAgent({
        cfg: await this.getCfg(),
        ctx,
        history: this.history,
        userText: text,
        signal: this.abort.signal,
        onEvent: (e) => this.post(e),
      });
    } catch (e) {
      this.post({ type: 'warn', text: errorMessage(e) });
    } finally {
      this.post({ type: 'ledger', items: ctx.ledger.items.slice(-30) });
      this.post({ type: 'busy', value: false });
    }
  }

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }
}

function html(): string {
  const nonce = randomBytes(16).toString('hex'); // unguessable: it is what lets exactly our script and style run in the webview
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:8px;display:flex;flex-direction:column;height:100vh;box-sizing:border-box;margin:0}
#log{flex:1;overflow:auto}.m{white-space:pre-wrap;margin:6px 0;padding:6px 8px;border-radius:4px}
.u{background:var(--vscode-input-background)}.a{background:var(--vscode-editor-background)}
.t{font-family:var(--vscode-editor-font-family);font-size:.85em;opacity:.8;border-left:3px solid var(--vscode-charts-blue);padding-left:8px}
.w{border-left:3px solid var(--vscode-editorWarning-foreground);padding-left:8px}
#led{font-size:.8em;opacity:.8;max-height:20%;overflow:auto;border-top:1px solid var(--vscode-panel-border);padding-top:4px}
textarea{width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);resize:none}
button{margin-top:4px}
</style></head><body>
<div id="log"></div><div id="led"></div>
<textarea id="in" rows="3" placeholder="Ask about your board, a datasheet, or your firmware…"></textarea>
<div><button id="go">Send</button> <button id="stop" disabled>Stop</button></div>
<script nonce="${nonce}">
const vs=acquireVsCodeApi(),log=document.getElementById('log'),led=document.getElementById('led'),inp=document.getElementById('in');
const add=(cls,text)=>{const d=document.createElement('div');d.className='m '+cls;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d};
const send=()=>{const t=inp.value.trim();if(!t)return;add('u',t);vs.postMessage({type:'send',text:t});inp.value=''};
document.getElementById('go').onclick=send;
document.getElementById('stop').onclick=()=>vs.postMessage({type:'stop'});
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
let live=null;
window.addEventListener('message',({data:m})=>{
 if(m.type!=='delta'&&m.type!=='text')live=null;
 if(m.type==='delta'){if(!live)live=add('a','');live.textContent+=m.text;log.scrollTop=log.scrollHeight}
 else if(m.type==='text'){if(!m.streamed)add('a',m.text);live=null}
 else if(m.type==='usage'){const u=m.usage;add('t','tokens: '+u.input+' in, '+u.output+' out'+(u.cacheRead||u.cacheWrite?', cache '+u.cacheRead+' read / '+u.cacheWrite+' written':'')+' over '+m.steps+' step'+(m.steps===1?'':'s'))}
 else if(m.type==='user')add('u',m.text);
 else if(m.type==='tool')add('t','▸ '+m.name+' '+JSON.stringify(m.args)+'\\n'+m.result);
 else if(m.type==='warn')add('w','⚠ '+m.text);
 else if(m.type==='reset'){log.textContent='';led.textContent=''}
 else if(m.type==='busy'){document.getElementById('go').disabled=m.value;document.getElementById('stop').disabled=!m.value}
 else if(m.type==='ledger'){led.textContent='Evidence ledger (latest):\\n'+m.items.map(e=>'['+e.id+'] '+e.kind+' — '+e.source).join('\\n')}
});
</script></body></html>`;
}
