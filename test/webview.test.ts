import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// Loads the real media/chat.js into jsdom with a fake acquireVsCodeApi().
function load() {
  const posted: any[] = [];
  const dom = new JSDOM(
    `<body><div id="status"></div><div id="log"></div><textarea id="input"></textarea>
     <button id="newChat"></button><button id="stop" hidden></button><button id="send"></button></body>`,
    { runScripts: 'outside-only' },
  );
  const w = dom.window as any;
  w.acquireVsCodeApi = () => ({ postMessage: (m: any) => posted.push(m) });
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8'));
  const send = (m: any) => w.dispatchEvent(new w.MessageEvent('message', { data: m }));
  return { w, doc: w.document as Document, posted, send };
}

const idle = { running: false, connection: 'idle' };

describe('chat webview', () => {
  it('announces itself, streams text, renders tool cards, and toggles Stop', () => {
    const { doc, posted, send } = load();
    expect(posted).toEqual([{ type: 'ready' }]);
    send({ type: 'init', items: [], state: idle, showThoughts: false });

    send({ type: 'state', state: { running: true, connection: 'connected', agent: 'mock-agent' } });
    expect((doc.getElementById('stop') as HTMLElement).hidden).toBe(false);
    expect((doc.getElementById('send') as HTMLButtonElement).disabled).toBe(true);
    expect(doc.getElementById('status')!.textContent).toContain('connected · mock-agent');

    send({ type: 'add', item: { id: 'i1', type: 'agent', text: 'Hello ' } });
    send({ type: 'append', id: 'i1', text: '**world** `x`' });
    expect(doc.querySelector('.msg.agent')!.innerHTML).toBe('Hello <b>world</b> <code>x</code>');

    send({ type: 'add', item: { id: 'i2', type: 'tool', toolCallId: 't', kind: 'execute', title: 'hostname && pwd', status: 'pending', content: '', locations: [] } });
    send({ type: 'update', item: { id: 'i2', type: 'tool', toolCallId: 't', kind: 'execute', title: 'hostname && pwd', status: 'completed', content: 'myhost\n/proj', locations: [] } });
    const card = doc.querySelector('details.card')!;
    expect(card.querySelector('.title')!.textContent).toBe('hostname && pwd');
    expect(card.querySelector('.badge')!.className).toContain('completed');
    expect(card.querySelector('pre')!.textContent).toBe('myhost\n/proj');
    expect(doc.querySelectorAll('details.card')).toHaveLength(1);

    send({ type: 'state', state: { running: false, connection: 'connected' } });
    expect((doc.getElementById('stop') as HTMLElement).hidden).toBe(true);
  });

  it('escapes HTML from the agent', () => {
    const { doc, send } = load();
    send({ type: 'init', items: [{ id: 'i1', type: 'agent', text: '<img src=x onerror=alert(1)>' }], state: idle });
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('.msg.agent')!.textContent).toContain('<img');
  });

  it('Enter sends, Shift+Enter does not; Stop and New chat post messages; notice offers re-auth', () => {
    const { w, doc, posted, send } = load();
    send({ type: 'init', items: [], state: idle });
    const input = doc.getElementById('input') as HTMLTextAreaElement;
    input.value = 'run hostname';
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    expect(posted.filter((p) => p.type === 'send')).toHaveLength(0);
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(posted).toContainEqual({ type: 'send', text: 'run hostname' });
    expect(input.value).toBe('');

    (doc.getElementById('stop') as HTMLElement).click();
    (doc.getElementById('newChat') as HTMLElement).click();
    expect(posted).toContainEqual({ type: 'stop' });
    expect(posted).toContainEqual({ type: 'newChat' });

    send({ type: 'add', item: { id: 'n1', type: 'notice', level: 'error', text: 'rejected (4401)', action: 'reauth' } });
    (doc.querySelector('.notice button') as HTMLElement).click();
    expect(posted).toContainEqual({ type: 'action', action: 'reauth' });
  });

  it('shows thoughts only when enabled', () => {
    const a = load();
    a.send({ type: 'init', items: [{ id: 'i1', type: 'thought', text: 'hmm' }], state: idle, showThoughts: false });
    expect((a.doc.querySelector('.thought') as HTMLElement).hidden).toBe(true);
    const b = load();
    b.send({ type: 'init', items: [{ id: 'i1', type: 'thought', text: 'hmm' }], state: idle, showThoughts: true });
    expect((b.doc.querySelector('.thought') as HTMLElement).hidden).toBe(false);
  });
});
