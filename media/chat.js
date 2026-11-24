// Webview side of the chat. Plain JS; renders the item model the extension sends.
(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const statusEl = document.getElementById('status');
  const items = new Map(); // id -> { item, el }
  let showThoughts = false;
  let running = false;

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Tiny markdown: fenced code, inline code, bold. Everything is escaped first.
  function md(text) {
    const parts = text.split(/```/);
    return parts
      .map((p, i) => {
        if (i % 2 === 1) return '<pre><code>' + esc(p.replace(/^[^\n]*\n/, '')) + '</code></pre>';
        return esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      })
      .join('');
  }

  function stickToBottom(fn) {
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    fn();
    if (near) log.scrollTop = log.scrollHeight;
  }

  function render(item) {
    let rec = items.get(item.id);
    const fresh = !rec;
    if (fresh) {
      let el;
      if (item.type === 'tool') {
        el = document.createElement('details');
        el.className = 'card';
      } else {
        el = document.createElement('div');
      }
      rec = { item, el };
      items.set(item.id, rec);
      log.appendChild(el);
    }
    rec.item = item;
    const el = rec.el;
    switch (item.type) {
      case 'user':
        el.className = 'msg user';
        el.textContent = item.text;
        break;
      case 'agent':
        el.className = 'msg agent';
        el.innerHTML = md(item.text);
        break;
      case 'thought':
        el.className = 'msg thought';
        el.hidden = !showThoughts;
        el.textContent = item.text;
        break;
      case 'tool': {
        const open = el.open;
        el.innerHTML =
          '<summary><span class="kind">' + esc(item.kind) + '</span><span class="title">' + esc(item.title) +
          '</span><span class="badge ' + esc(item.status) + '">' + esc(item.status.replace('_', ' ')) + '</span></summary>' +
          '<div class="body">' +
          (item.locations && item.locations.length ? '<div class="loc">' + item.locations.map(esc).join(', ') + '</div>' : '') +
          (item.content ? '<pre>' + esc(item.content) + '</pre>' : '') + '</div>';
        el.open = open;
        break;
      }
      case 'notice': {
        el.className = 'notice ' + item.level;
        el.textContent = item.text;
        if (item.action === 'reauth' || item.action === 'settings') {
          const b = document.createElement('button');
          b.textContent = item.action === 'reauth' ? 'Sign in again / set token' : 'Open settings';
          b.onclick = () => vscode.postMessage({ type: 'action', action: item.action });
          el.appendChild(document.createElement('br'));
          el.appendChild(b);
        }
        break;
      }
    }
  }

  function setState(s) {
    running = s.running;
    sendBtn.disabled = running;
    stopBtn.hidden = !running;
    const label = { idle: 'not connected', connecting: 'connecting…', connected: 'connected', error: 'connection problem' }[s.connection] || s.connection;
    statusEl.innerHTML = '<span class="dot ' + esc(s.connection) + '"></span>' + esc(label + (s.agent ? ' · ' + s.agent : ''));
  }

  function reset(list, state) {
    log.innerHTML = '';
    items.clear();
    stickToBottom(() => list.forEach(render));
    setState(state);
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init':
        showThoughts = !!m.showThoughts;
        reset(m.items, m.state);
        break;
      case 'reset':
        reset(m.items, m.state);
        break;
      case 'add':
      case 'update':
        stickToBottom(() => render(m.item));
        break;
      case 'append': {
        const rec = items.get(m.id);
        if (rec) {
          rec.item.text += m.text;
          stickToBottom(() => render(rec.item));
        }
        break;
      }
      case 'state':
        setState(m.state);
        break;
    }
  });

  function send() {
    const text = input.value.trim();
    if (!text || running) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text });
  }
  sendBtn.onclick = send;
  stopBtn.onclick = () => vscode.postMessage({ type: 'stop' });
  document.getElementById('newChat').onclick = () => vscode.postMessage({ type: 'newChat' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
