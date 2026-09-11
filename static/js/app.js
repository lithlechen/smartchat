/* 多面体 · 前端逻辑
   负责：性格切换、每个性格一条独立对话、SSE 流式输出、Markdown 渲染、本地存档。 */
(() => {
  'use strict';

  const BOOT = window.__BOOT__ || { personas: [], defaultModel: 'deepseek-chat' };
  const STORE_KEY = 'polyface.v1';
  const S = {
    personas: [],
    custom: [],
    activeId: null,
    chats: {},                       // personaId -> { messages: [] }
    settings: { model: BOOT.defaultModel, temps: {} },
    config: null,
    stream: null,                    // { controller, msg, personaId }
    firstPaint: true,
  };

  const $ = (id) => document.getElementById(id);
  const threadEl = $('thread');

  /* ── 小工具 ─────────────────────────────────────── */

  const uid = () => Math.random().toString(36).slice(2, 9);

  function hexToRgb(hex) {
    const m = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return [201, 162, 39];
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function sigilSvg(path, extraClass) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    if (extraClass) svg.setAttribute('class', extraClass);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path || 'M12 4.5 19.5 12 12 19.5 4.5 12Z');
    svg.appendChild(p);
    return svg;
  }

  const persona = (id = S.activeId) => S.personas.find((p) => p.id === id) || S.personas[0];

  /* ── 本地存档 ───────────────────────────────────── */

  function save() {
    const chats = {};
    for (const [id, chat] of Object.entries(S.chats)) {
      chats[id] = chat.messages.map((m) => ({
        r: m.role, c: m.content, q: m.reasoning || '',
        l: m.local ? 1 : 0, e: m.error ? 1 : 0,
      }));
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, activeId: S.activeId, custom: S.custom, settings: S.settings, chats,
      }));
    } catch (err) { /* 隐私模式或超配额时静默跳过 */ }
  }

  function load() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (err) { raw = null; }
    if (raw && typeof raw === 'object') {
      S.custom = Array.isArray(raw.custom) ? raw.custom : [];
      S.activeId = raw.activeId || null;
      S.settings = Object.assign({ model: BOOT.defaultModel, temps: {} }, raw.settings || {});
      if (!S.settings.temps) S.settings.temps = {};
      S.chats = {};
      for (const [id, rows] of Object.entries(raw.chats || {})) {
        S.chats[id] = {
          messages: (rows || []).map((row) => ({
            role: row.r, content: row.c || '', reasoning: row.q || '',
            local: !!row.l, error: !!row.e,
          })),
        };
      }
    }
  }

  function chatFor(id) {
    if (!S.chats[id]) {
      const p = persona(id);
      S.chats[id] = {
        messages: p ? [{ role: 'assistant', content: greetingOf(p), local: true }] : [],
      };
    }
    return S.chats[id];
  }

  function greetingOf(p) {
    if (p.greeting) return p.greeting;
    return p.tagline ? `你好，我是${p.name}。${p.tagline}` : `你好，我是${p.name}。`;
  }

  /* ── 主色主题 ───────────────────────────────────── */

  function applyTheme(hex) {
    const [r, g, b] = hexToRgb(hex);
    const root = document.documentElement.style;
    root.setProperty('--accent', hex);
    root.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
  }

  function themeSwap(hex) {
    document.body.classList.add('switching');
    setTimeout(() => {
      applyTheme(hex);
      setTimeout(() => document.body.classList.remove('switching'), 30);
    }, 170);
  }

  /* ── 左栏渲染 ───────────────────────────────────── */

  function renderRail() {
    const list = $('personaList');
    list.innerHTML = '';
    S.personas.forEach((p, i) => {
      const [r, g, b] = hexToRgb(p.accent);
      const tile = el('button', 'persona');
      tile.type = 'button';
      tile.setAttribute('aria-pressed', String(p.id === S.activeId));
      tile.style.setProperty('--tile-accent', p.accent);
      tile.style.setProperty('--tile-rgb', `${r}, ${g}, ${b}`);
      if (S.firstPaint) {
        tile.style.animation = `tileIn .34s ease ${i * 32}ms backwards`;
      }

      const badge = el('span', 'sigil');
      badge.appendChild(sigilSvg(p.sigil));

      const copy = el('span', 'persona-copy');
      copy.appendChild(el('strong', null, p.name));
      copy.appendChild(el('span', null, p.tagline || p.desc || ''));

      tile.append(badge, copy);
      tile.addEventListener('click', () => setActive(p.id));

      if (p.editable) {
        const del = el('span', 'tile-x', '×');
        del.title = `删除「${p.name}」`;
        del.setAttribute('role', 'button');
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          removeCustom(p.id);
        });
        tile.appendChild(del);
      }

      list.appendChild(tile);
    });
  }

  function renderWho() {
    const p = persona();
    $('whoName').textContent = p.name;
    $('whoTagline').textContent = p.tagline || p.desc || '';
    const host = $('whoSigil');
    host.innerHTML = '';
    host.appendChild(sigilSvg(p.sigil));
    const [r, g, b] = hexToRgb(p.accent);
    host.style.setProperty('--tile-accent', p.accent);
    host.style.setProperty('--tile-rgb', `${r}, ${g}, ${b}`);
  }

  function renderFoot() {
    const railFoot = $('railFoot');
    const fine = $('fineprint');
    const p = persona();
    if (!S.config) {
      railFoot.innerHTML = '<b>正在检查接口…</b>';
      fine.textContent = '';
      return;
    }
    if (S.config.key_configured) {
      railFoot.innerHTML = `<b>接口正常</b><br>${escapeHtml(S.config.base_url)}<br>Key ${escapeHtml(S.config.key_hint)}`;
      fine.textContent = `回答由 DeepSeek 的 ${S.settings.model} 生成 · 性格只影响说话方式，不影响事实。`;
    } else {
      railFoot.innerHTML = '<b>没有找到 API Key</b><br>请把 Key 写进项目根目录的 .env，然后重启服务。';
      fine.textContent = '当前无法调用模型：请先配置 DEEPSEEK_API_KEY。';
    }
  }

  /* ── 对话渲染 ───────────────────────────────────── */

  function renderThread() {
    threadEl.innerHTML = '';
    const p = persona();
    const chat = chatFor(S.activeId);
    chat.messages.forEach((m) => threadEl.appendChild(buildMessage(m, p)));

    const onlyGreeting = chat.messages.length <= 1;
    if (onlyGreeting && Array.isArray(p.openers) && p.openers.length) {
      const row = el('div', 'openers');
      p.openers.forEach((text) => {
        const chip = el('button', 'chip', text);
        chip.type = 'button';
        chip.addEventListener('click', () => {
          $('input').value = text;
          autoGrow();
          $('input').focus();
        });
        row.appendChild(chip);
      });
      threadEl.appendChild(row);
    }
    scrollToBottom(true);
  }

  function buildMessage(m, p) {
    const wrap = el('div', `msg ${m.role === 'user' ? 'user' : 'assistant'}`);
    if (m.role !== 'user') {
      const av = el('span', 'avatar');
      av.appendChild(sigilSvg(p.sigil));
      wrap.appendChild(av);
    }
    const bubble = el('div', 'bubble');
    if (m.error) bubble.classList.add('notice');
    if (m.streaming) bubble.classList.add('streaming');
    wrap.appendChild(bubble);
    m._bubble = bubble;

    if (m.error) {
      bubble.innerHTML = `<strong>这条没发出去</strong>${renderMarkdown(m.content)}`;
      const retry = el('button', 'chip', '重试');
      retry.type = 'button';
      retry.addEventListener('click', retryLast);
      bubble.appendChild(retry);
      return wrap;
    }

    m._md = el('div', 'md');
    m._think = null;        // 重绘后旧引用要丢掉，否则思考面板不会再补上
    m._thinkPre = null;
    bubble.appendChild(m._md);
    paint(m);
    return wrap;
  }

  function paint(m) {
    if (!m._bubble || m.error) return;
    if (m.reasoning) {
      if (!m._think) {           // 思考过程是流动产生的，出现第一条再插入面板
        const details = el('details', 'think');
        const pre = el('pre');
        details.append(el('summary', null, '思考过程'), pre);
        m._bubble.insertBefore(details, m._md);
        m._think = details;
        m._thinkPre = pre;
      }
      m._think.hidden = false;
      m._thinkPre.textContent = m.reasoning;
    } else if (m._think) {
      m._think.hidden = true;
    }
    if (m._md) {
      m._md.innerHTML = renderMarkdown(m.content);
      if (m.interrupted) m._md.appendChild(el('p', 'cut', '（已停止）'));
    }
  }

  function isNearBottom() {
    return threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 140;
  }

  function scrollToBottom(force) {
    if (force || isNearBottom()) threadEl.scrollTop = threadEl.scrollHeight;
  }

  /* ── Markdown（够用版，不引外部库） ──────────────── */

  function inlineMd(s) {
    return s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s（(、，。；：>])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  function renderMarkdown(src) {
    const codeBlocks = [];
    let text = String(src || '').replace(/\r\n?/g, '\n');
    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (all, lang, code) => {
      codeBlocks.push({ lang: String(lang || '').trim(), code: code.replace(/\n+$/, '') });
      return `\u0000B${codeBlocks.length - 1}\u0000\n`;
    });
    text = escapeHtml(text);

    const out = [];
    const lines = text.split('\n');
    let para = [];
    let list = null;   // { tag, items }

    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${inlineMd(para.join('<br>'))}</p>`);
        para = [];
      }
    };
    const flushList = () => {
      if (list) {
        out.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join('')}</${list.tag}>`);
        list = null;
      }
    };
    const flushAll = () => { flushPara(); flushList(); };

    for (const raw of lines) {
      const line = raw.trimEnd();
      const token = /^\u0000B(\d+)\u0000$/.exec(line.trim());
      if (token) {
        flushAll();
        const b = codeBlocks[Number(token[1])];
        const label = b.lang && b.lang !== 'code' ? b.lang : '代码';
        out.push(
          `<div class="code-block"><div class="code-head"><span>${escapeHtml(label)}</span>` +
          `<button type="button" data-copy>复制</button></div>` +
          `<pre><code>${escapeHtml(b.code)}</code></pre></div>`
        );
        continue;
      }
      if (!line.trim()) { flushAll(); continue; }

      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        flushAll();
        const level = Math.min(h[1].length + 1, 4);
        out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
        continue;
      }
      if (/^(---+|\*\*\*+|___+)$/.test(line.trim())) { flushAll(); out.push('<hr>'); continue; }
      if (/^&gt;\s?/.test(line)) {
        flushAll();
        out.push(`<blockquote>${inlineMd(line.replace(/^&gt;\s?/, ''))}</blockquote>`);
        continue;
      }
      const ul = /^[-*+]\s+(.*)$/.exec(line.trim());
      const ol = /^\d+[.)]\s+(.*)$/.exec(line.trim());
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((ul ? ul[1] : ol[1]));
        continue;
      }
      flushList();
      para.push(line.trim());
    }
    flushAll();
    return out.join('');
  }

  threadEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-copy]');
    if (!btn) return;
    const block = btn.closest('.code-block');
    const code = block ? block.querySelector('code') : null;
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(
      () => { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1400); },
      () => { btn.textContent = '复制失败'; setTimeout(() => { btn.textContent = '复制'; }, 1400); }
    );
  });

  /* ── 发送与流式接收 ─────────────────────────────── */

  function getTemp(p) {
    const t = S.settings.temps[p.id];
    return typeof t === 'number' ? t : (typeof p.temperature === 'number' ? p.temperature : 0.8);
  }

  function syncControls() {
    const p = persona();
    const t = getTemp(p);
    $('temp').value = String(t);
    $('tempOut').value = t.toFixed(2);
    $('model').value = S.settings.model;
    $('input').placeholder = `跟「${p.name}」说点什么……（Enter 发送，Shift + Enter 换行）`;
  }

  function setBusy(busy) {
    const btn = $('send');
    btn.textContent = busy ? '停止' : '发送';
    btn.classList.toggle('stop', busy);
    $('newChat').disabled = false;
  }

  async function send(text) {
    const content = text.trim();
    if (!content || S.stream) return;
    const chat = chatFor(S.activeId);
    chat.messages.push({ role: 'user', content });
    $('input').value = '';
    autoGrow();
    save();
    renderThread();
    await runCompletion();
  }

  async function runCompletion() {
    const p = persona();
    const chat = chatFor(S.activeId);
    const history = chat.messages
      .filter((m) => !m.local && !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    if (!history.length) return;

    const assistant = { role: 'assistant', content: '', reasoning: '', streaming: true };
    chat.messages.push(assistant);
    chat.messages.forEach((m) => { delete m._md; delete m._bubble; delete m._think; delete m._thinkPre; });
    renderThread();

    const controller = new AbortController();
    S.stream = { controller, msg: assistant, personaId: S.activeId };
    setBusy(true);

    const paintSoon = throttle(() => {
      paint(assistant);
      scrollToBottom(false);
    }, 60);

    const onEvent = (evt) => {
      if (evt.type === 'delta') assistant.content += evt.text;
      else if (evt.type === 'reasoning') assistant.reasoning += evt.text;
      else if (evt.type === 'error') assistant.error = evt.message;
      else return;
      paintSoon();
    };

    try {
      await postStream('/api/chat', {
        persona: p.id,
        custom: p.custom || null,
        model: S.settings.model,
        temperature: getTemp(p),
        messages: history,
      }, onEvent, controller.signal);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        assistant.interrupted = true;
      } else {
        assistant.error = (err && err.message) || '连接服务失败。';
      }
    } finally {
      assistant.streaming = false;
      S.stream = null;
      if (!assistant.content && !assistant.error && !assistant.interrupted) {
        assistant.error = '模型这次没吐出内容，再发一次试试。';
      }
      setBusy(false);
      save();
      renderThread();
    }
  }

  function retryLast() {
    if (S.stream) return;
    const chat = chatFor(S.activeId);
    while (chat.messages.length && chat.messages[chat.messages.length - 1].error) chat.messages.pop();
    renderThread();
    runCompletion();
  }

  function stopStreaming() {
    if (!S.stream) return;
    S.stream.controller.abort();
    S.stream.msg.streaming = false;
  }

  async function postStream(url, payload, onEvent, signal) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      let msg = `服务返回 ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error) msg = data.error;
      } catch (err) { /* 保持默认提示 */ }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, cut).trim();
        buf = buf.slice(cut + 2);
        if (!frame.startsWith('data:')) continue;
        const data = frame.slice(5).trim();
        if (data === '[DONE]') return;
        try { onEvent(JSON.parse(data)); } catch (err) { /* 忽略坏帧 */ }
      }
    }
  }

  function throttle(fn, ms) {
    let last = 0, timer = null;
    return function () {
      const now = Date.now();
      const wait = Math.max(0, ms - (now - last));
      clearTimeout(timer);
      timer = setTimeout(() => { last = Date.now(); fn(); }, wait);
    };
  }

  /* ── 性格切换 ───────────────────────────────────── */

  function setActive(id) {
    if (id === S.activeId) return;
    if (S.stream) stopStreaming();
    S.activeId = id;
    themeSwap(persona(id).accent);
    save();
    renderRail();
    renderWho();
    renderFoot();
    syncControls();
    renderThread();
  }

  /* ── 自定义性格 ─────────────────────────────────── */

  const DEFAULT_SIGIL = 'M12 3.4c4.8 0 8.6 3.9 8.6 8.6S16.8 20.6 12 20.6 3.4 16.8 3.4 12 7.2 3.4 12 3.4Zm0 5.2v6.8m-3.4-3.4h6.8';

  function addCustom(personaDef) {
    S.custom.push(personaDef);
    S.personas = BOOT.personas.concat(S.custom.map((c) => Object.assign({ editable: true }, c)));
    save();
    renderRail();
    setActive(personaDef.id);
  }

  function removeCustom(id) {
    S.custom = S.custom.filter((c) => c.id !== id);
    delete S.chats[id];
    S.personas = BOOT.personas.concat(S.custom.map((c) => Object.assign({ editable: true }, c)));
    if (S.activeId === id) {
      S.activeId = S.personas[0] ? S.personas[0].id : null;
      applyTheme(persona().accent);
    }
    save();
    renderRail();
    renderWho();
    syncControls();
    renderThread();
  }

  function wireModal() {
    const modal = $('personaModal');
    $('addPersona').addEventListener('click', () => {
      $('personaForm').reset();
      $('cpAccent').value = '#C9A227';
      modal.showModal();
      $('cpName').focus();
    });
    $('cpCancel').addEventListener('click', () => modal.close());
    $('personaForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = $('cpName').value.trim();
      if (!name) return;
      const tagline = $('cpTagline').value.trim();
      const desc = $('cpDesc').value.trim();
      const style = $('cpStyle').value.trim();
      const accent = $('cpAccent').value || '#C9A227';
      const def = {
        id: 'custom:' + uid(),
        name,
        tagline: tagline || '自定义性格',
        desc: desc || '',
        accent,
        sigil: DEFAULT_SIGIL,
        temperature: 0.9,
        greeting: tagline ? `你好，我是${name}。${tagline}` : `你好，我是${name}。`,
        openers: ['先随便聊聊', '帮我个忙，我卡住了', '你觉得我该怎么做'],
        custom: { name, desc, style },
      };
      modal.close();
      addCustom(def);
    });
  }

  /* ── 输入框 ─────────────────────────────────────── */

  function autoGrow() {
    const box = $('input');
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 190) + 'px';
  }

  function wireComposer() {
    $('input').addEventListener('input', autoGrow);
    $('input').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        send($('input').value);
      }
    });
    $('composerForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (S.stream) stopStreaming();
      else send($('input').value);
    });
    $('send').addEventListener('click', (ev) => {
      if (S.stream) { ev.preventDefault(); stopStreaming(); }
    });
    $('newChat').addEventListener('click', () => {
      if (S.stream) stopStreaming();
      S.chats[S.activeId] = { messages: [{ role: 'assistant', content: greetingOf(persona()), local: true }] };
      save();
      renderThread();
      $('input').focus();
    });
    $('temp').addEventListener('input', () => {
      const v = Number($('temp').value);
      S.settings.temps[S.activeId] = v;
      $('tempOut').value = v.toFixed(2);
      save();
    });
    $('model').addEventListener('change', () => {
      S.settings.model = $('model').value;
      save();
      renderFoot();
    });
  }

  /* ── 启动 ───────────────────────────────────────── */

  async function fetchConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) S.config = await res.json();
    } catch (err) { S.config = null; }
    renderFoot();
  }

  function init() {
    load();
    S.personas = BOOT.personas.concat(S.custom.map((c) => Object.assign({ editable: true }, c)));
    if (!S.personas.length) return;
    if (!S.activeId || !S.personas.some((p) => p.id === S.activeId)) S.activeId = S.personas[0].id;
    Object.keys(S.chats).forEach((id) => {
      if (!S.personas.some((p) => p.id === id)) delete S.chats[id];
    });
    chatFor(S.activeId);

    applyTheme(persona().accent);
    renderRail();
    renderWho();
    syncControls();
    renderThread();
    wireModal();
    wireComposer();
    autoGrow();
    fetchConfig();
    S.firstPaint = false;

    requestAnimationFrame(() => document.body.classList.remove('is-booting'));
    $('input').focus();
  }

  init();
})();
