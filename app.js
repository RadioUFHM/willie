const PROJECTS = ['Troopers', 'Elf Realm', 'Poetry', "Children's Books"];

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');

const S = {
  view: 'home',
  token: null,
  tokenClient: null,
  fcit: [], opf: [], creative: [],
  gmail: { unread: [], starred: [], pipeline: [] },
  gmailError: null,
  calendar: [],
  contextDoc: '',
  briefData: null,
  chatHistory: [],
  news: { regulatory: [], crypto: [], ethPrice: null },
  filter: { fcit: 'all', opf: 'all', creative: 'all' },
};

// ── Date/Time ─────────────────────────────────────────────────────────────────
function todays() { return new Date().toISOString().split('T')[0]; }

function fmtDate(d) {
  if (!d) return '';
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function dueStat(d) {
  if (!d) return '';
  const t = todays();
  if (d < t) return 'overdue';
  if (d === t) return 'today';
  return '';
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function fullDate() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function initAuth() {
  if (!window.google?.accounts) { setTimeout(initAuth, 300); return; }
  S.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: resp => {
      if (resp.error) { toast('Auth failed: ' + resp.error); return; }
      S.token = resp.access_token;
      loadAll();
      renderView();
    },
  });
}

function requestAuth() {
  if (S.tokenClient) S.tokenClient.requestAccessToken({ prompt: 'consent' });
}

function on401() {
  S.token = null;
  toast('Session expired — tap Connect');
  renderView();
}

// ── Generic fetch ─────────────────────────────────────────────────────────────
async function gGet(url) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + S.token } });
  if (r.status === 401) { on401(); throw new Error('auth'); }
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.json();
}

// ── Sheets ────────────────────────────────────────────────────────────────────
const SH = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}`;

async function shGet(range) { return gGet(`${SH}/values/${enc(range)}`); }

async function shAppend(range, values) {
  const r = await fetch(`${SH}/values/${enc(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!r.ok) throw new Error(await r.text());
}

async function shPut(range, values) {
  const r = await fetch(`${SH}/values/${enc(range)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!r.ok) throw new Error(await r.text());
}

async function shClear(range) {
  await fetch(`${SH}/values/${enc(range)}:clear`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + S.token },
  });
}

// ── Gmail ─────────────────────────────────────────────────────────────────────
async function gmailSearch(q, max) {
  try {
    const data = await gGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${enc(q)}&maxResults=${max}`);
    const ids = (data.messages || []).map(m => m.id);
    if (!ids.length) return [];
    return (await Promise.all(ids.map(gmailMeta))).filter(Boolean);
  } catch (e) {
    console.error('Gmail search failed:', e.message, '\nQuery:', q);
    S.gmailError = e.message;
    return [];
  }
}

async function gmailMeta(id) {
  try {
    const data = await gGet(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
      `?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
    );
    const h = {};
    (data.payload?.headers || []).forEach(x => { h[x.name] = x.value; });
    const raw = h.From || '';
    const m = raw.match(/^"?([^"<]+?)"?\s*(?:<([^>]+)>)?$/);
    const from = m ? { name: m[1].trim(), email: m[2] || m[1].trim() } : { name: raw, email: raw };
    const threadId = data.threadId || data.id;
    return {
      id: data.id, threadId, from,
      subject: h.Subject || '(no subject)',
      snippet: (data.snippet || '').slice(0, 400),
      link: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
    };
  } catch { return null; }
}

async function loadGmail() {
  const unread   = await gmailSearch('is:unread newer_than:1d label:inbox -category:promotions -category:social', 8);
  const starred  = await gmailSearch('is:starred is:unread', 5);
  const names    = S.fcit.map(e => e.name).filter(Boolean).slice(0, 15);
  let pipeline   = [];
  if (names.length) {
    pipeline = await gmailSearch(`from:(${names.map(n => `"${n}"`).join(' OR ')}) newer_than:7d`, 5);
  }
  const seen = new Set();
  const dedup = arr => arr.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
  S.gmail = { unread: dedup(unread), starred: dedup(starred), pipeline: dedup(pipeline) };
}

// ── Calendar ──────────────────────────────────────────────────────────────────
async function loadCalendar() {
  try {
    const now   = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const data  = await gGet(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
      `?timeMin=${enc(start)}&timeMax=${enc(end)}&singleEvents=true&orderBy=startTime&maxResults=20`
    );
    S.calendar = (data.items || []).map(ev => ({
      id: ev.id,
      title: ev.summary || '(no title)',
      start: ev.start?.dateTime || ev.start?.date || '',
      allDay: !ev.start?.dateTime,
      attendees: (ev.attendees || []).filter(a => !a.self).map(a => a.displayName || a.email).slice(0, 3),
      calLink: ev.htmlLink || '',
      meetLink: ev.hangoutLink || ev.conferenceData?.entryPoints?.[0]?.uri || '',
    }));
  } catch (e) { console.error('Calendar:', e); }
}

// ── Drive context doc ─────────────────────────────────────────────────────────
async function loadContextDoc() {
  if (!CONFIG.CONTEXT_DOC_ID || CONFIG.CONTEXT_DOC_ID.startsWith('PASTE_')) return;
  try {
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${CONFIG.CONTEXT_DOC_ID}/export?mimeType=text/plain`,
      { headers: { Authorization: 'Bearer ' + S.token } }
    );
    if (r.status === 401) { on401(); return; }
    if (r.ok) S.contextDoc = await r.text();
  } catch (e) { console.error('Drive:', e); }
}

// ── News ──────────────────────────────────────────────────────────────────────
async function loadNews() {
  const [regulatory, crypto, ethPrice] = await Promise.all([
    loadRegulatoryNews(),
    loadCryptoNews(),
    loadEthPrice(),
  ]);
  S.news = { regulatory, crypto, ethPrice };
}

async function fetchRSS(feedUrl, source, max = 4) {
  const api = `https://api.rss2json.com/v1/api.json?rss_url=${enc(feedUrl)}&count=${max}`;
  const r = await fetch(api);
  const d = await r.json();
  if (d.status !== 'ok') throw new Error(`rss2json error: ${d.message}`);
  return (d.items || []).map(item => ({
    title: item.title?.trim() || '',
    link:  item.link || '',
    source,
  })).filter(i => i.title);
}

async function loadRegulatoryNews() {
  try {
    const [sec, doj] = await Promise.allSettled([
      fetchRSS('https://www.sec.gov/rss/litigation/litreleases.xml', 'SEC', 3),
      fetchRSS('https://www.justice.gov/feeds/opa/justice-news.xml', 'DOJ', 3),
    ]);
    const secItems = sec.status === 'fulfilled' ? sec.value : [];
    const dojItems = doj.status === 'fulfilled' ? doj.value : [];
    return [...secItems, ...dojItems];
  } catch (e) { console.error('Regulatory news:', e); return []; }
}

async function loadCryptoNews() {
  try {
    const r = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=ETH&sortOrder=popular&api_key=');
    const d = await r.json();
    if (!d.Data) throw new Error('CryptoCompare no Data');
    return d.Data.slice(0, 5).map(n => ({
      title: n.title, link: n.url, source: n.source_info?.name || 'Crypto',
    }));
  } catch (e) { console.error('Crypto news:', e); return []; }
}

async function loadEthPrice() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true');
    const d = await r.json();
    const eth = d.ethereum;
    if (!eth) throw new Error('CoinGecko no eth');
    return { price: eth.usd, change: eth.usd_24h_change ?? null };
  } catch (e) { console.error('ETH price:', e); return null; }
}

// ── Load all ──────────────────────────────────────────────────────────────────
async function loadAll() {
  await Promise.all([loadFCIT(), loadOPF(), loadCreative()]);
  await Promise.all([loadGmail(), loadCalendar(), loadContextDoc(), loadPrecomputedBrief(), loadNews()]);
  renderView();
}

async function loadPrecomputedBrief() {
  try {
    const d = await shGet('WillieBrief!A1:A2');
    const rows = d.values || [];
    if (!rows[0]?.[0]) return;
    const brief = JSON.parse(rows[0][0]);
    const generatedAt = new Date(rows[1]?.[0] || brief.generatedAt);
    const ageHours = (Date.now() - generatedAt) / 3600000;
    if (ageHours < 20) {
      S.briefData = injectCalendarLinks(brief);
      S.briefSource = 'precomputed';
    }
  } catch (e) { console.error('loadPrecomputedBrief:', e); }
}

// ── Sheet loaders ─────────────────────────────────────────────────────────────
async function loadFCIT() {
  try {
    const d = await shGet('FCIT!A1:G500');
    S.fcit = (d.values || []).slice(1).map((r, i) => ({
      ri: i + 2, name: r[0]||'', org: r[1]||'', stage: (r[2]||'prospect').toLowerCase(),
      lastContact: r[3]||'', nextAction: r[4]||'', dueDate: r[5]||'', notes: r[6]||'',
    })).filter(e => e.name);
  } catch (e) { console.error('FCIT:', e); }
}

async function loadOPF() {
  try {
    const d = await shGet('OPF!A1:F500');
    S.opf = (d.values || []).slice(1).map((r, i) => ({
      ri: i + 2, task: r[0]||'', category: r[1]||'', priority: (r[2]||'medium').toLowerCase(),
      dueDate: r[3]||'', status: (r[4]||'todo').toLowerCase(), notes: r[5]||'',
    })).filter(e => e.task);
  } catch (e) { console.error('OPF:', e); }
}

async function loadCreative() {
  try {
    const d = await shGet('Creative!A1:F500');
    S.creative = (d.values || []).slice(1).map((r, i) => ({
      ri: i + 2, project: r[0]||PROJECTS[0], task: r[1]||'', priority: (r[2]||'medium').toLowerCase(),
      dueDate: r[3]||'', status: (r[4]||'todo').toLowerCase(), notes: r[5]||'',
    })).filter(e => e.task);
  } catch (e) { console.error('Creative:', e); }
}

// ── Saves / Deletes ───────────────────────────────────────────────────────────
async function saveFCIT(e, isNew) {
  const row = [e.name, e.org, e.stage, e.lastContact, e.nextAction, e.dueDate, e.notes];
  if (isNew) await shAppend('FCIT!A:G', [row]); else await shPut(`FCIT!A${e.ri}:G${e.ri}`, [row]);
  await loadFCIT();
}
async function delFCIT(e)  { await shClear(`FCIT!A${e.ri}:G${e.ri}`);  await loadFCIT(); }

async function saveOPF(e, isNew) {
  const row = [e.task, e.category, e.priority, e.dueDate, e.status, e.notes];
  if (isNew) await shAppend('OPF!A:F', [row]); else await shPut(`OPF!A${e.ri}:F${e.ri}`, [row]);
  await loadOPF();
}
async function delOPF(e)   { await shClear(`OPF!A${e.ri}:F${e.ri}`);   await loadOPF(); }

async function saveCreative(e, isNew) {
  const row = [e.project, e.task, e.priority, e.dueDate, e.status, e.notes];
  if (isNew) await shAppend('Creative!A:F', [row]); else await shPut(`Creative!A${e.ri}:F${e.ri}`, [row]);
  await loadCreative();
}
async function delCreative(e) { await shClear(`Creative!A${e.ri}:F${e.ri}`); await loadCreative(); }

// ── Ask Willie ────────────────────────────────────────────────────────────────
async function askWillie() {
  const btn  = document.getElementById('wb');
  const area = document.getElementById('ba');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  area.style.display = 'block';
  area.innerHTML = '<div class="brief-thinking">Reading your day...</div>';

  const t         = todays();
  const followUps = S.fcit.filter(e => e.dueDate && e.dueDate <= t).sort((a,b) => a.dueDate.localeCompare(b.dueDate));
  const opfDue    = S.opf.filter(e => e.dueDate && e.dueDate <= t && e.status !== 'done');
  const creativeDue = S.creative.filter(e => e.dueDate && e.dueDate <= t && e.status !== 'done');
  const allEmails = [...S.gmail.unread, ...S.gmail.starred, ...S.gmail.pipeline];

  // Compute pipeline staleness
  const now = new Date();
  const daysSince = d => d ? Math.floor((now - new Date(d)) / 86400000) : 999;
  const staleProspects = S.fcit.filter(e => e.stage === 'prospect' && daysSince(e.lastContact) >= 7);
  const staleWarm      = S.fcit.filter(e => e.stage === 'warm'     && daysSince(e.lastContact) >= 14);
  const staleProposal  = S.fcit.filter(e => e.stage === 'proposal' && daysSince(e.lastContact) >= 2);

  // Calendar with attendee/pipeline cross-reference
  const calData = S.calendar.map(ev => {
    const match = S.fcit.find(p =>
      ev.attendees.some(a => a.toLowerCase().includes(p.name.toLowerCase().split(' ')[0]))
    );
    return {
      time: ev.allDay ? 'All day' : fmtTime(ev.start),
      title: ev.title,
      attendees: ev.attendees.join(', '),
      pipelineMatch: match ? `[PIPELINE: ${match.name}, ${match.stage}, last contact ${match.lastContact||'unknown'}]` : '',
      calLink: ev.calLink,
      meetLink: ev.meetLink,
    };
  });

  // Email with pipeline cross-reference
  const emailData = allEmails.map(m => {
    const match = S.fcit.find(p =>
      p.name.toLowerCase().split(' ').some(w => m.from.name.toLowerCase().includes(w))
    );
    return {
      from: m.from.name,
      subject: m.subject,
      snippet: m.snippet,
      link: m.link,
      pipelineMatch: match ? `[PIPELINE: ${match.org}, ${match.stage}]` : '',
    };
  });

  const context = [
    `Today is ${fullDate()}.`,
    '',
    '## Calendar',
    calData.length
      ? calData.map(e => `  [${e.time}] ${e.title}${e.attendees ? ` | with: ${e.attendees}` : ''}${e.pipelineMatch ? ` ${e.pipelineMatch}` : ''} | calLink: ${e.calLink}${e.meetLink ? ` | meetLink: ${e.meetLink}` : ''}`)
      : ['  No events.'],
    '',
    '## Inbox',
    emailData.length
      ? emailData.map(m => `  From: ${m.from}${m.pipelineMatch ? ` ${m.pipelineMatch}` : ''} | Subject: ${m.subject} | Content: "${m.snippet}" | link: ${m.link}`)
      : ['  Inbox clear.'],
    '',
    '## FCIT pipeline — full state',
    S.fcit.length
      ? S.fcit.map(e => `  ${e.name} (${e.org}) [${e.stage}] last contact: ${e.lastContact||'never'} | days since: ${daysSince(e.lastContact)} | next: ${e.nextAction||'—'}`)
      : ['  Empty.'],
    '',
    '## Stale pipeline (needs action)',
    staleProposal.length ? staleProposal.map(e => `  [RED] PROPOSAL STALE ${daysSince(e.lastContact)}d: ${e.name} (${e.org})`) : [],
    staleWarm.length     ? staleWarm.map(e =>     `  [WARN] WARM STALE ${daysSince(e.lastContact)}d: ${e.name} (${e.org}) — next: ${e.nextAction||'?'}`) : [],
    staleProspects.length ? staleProspects.map(e => `  [NOTE] PROSPECT ${daysSince(e.lastContact)}d quiet: ${e.name} (${e.org})`) : [],
    (staleProposal.length + staleWarm.length + staleProspects.length === 0) ? ['  All contacts current.'] : [],
    '',
    '## Tasks overdue/due today',
    [...followUps.map(e => `  [FCIT] ${e.name} — ${e.nextAction}`),
     ...opfDue.map(e => `  [OPF] ${e.task}`),
     ...creativeDue.map(e => `  [Creative] ${e.task} (${e.project})`),
    ].length ? [...followUps.map(e => `  [FCIT] ${e.name} — ${e.nextAction}`), ...opfDue.map(e => `  [OPF] ${e.task}`), ...creativeDue.map(e => `  [Creative] ${e.task} (${e.project})`)]
             : ['  None.'],
  ].flat().join('\n');

  const system = `You are Willie — Rio Miner's sharp, trusted EA. You have already read his inbox, calendar, and pipeline before he woke up. You know his context cold.

${S.contextDoc ? `## Rio's context:\n${S.contextDoc.slice(0, 4000)}\n\n` : ''}---

## How to analyze each section

**Email:** For every email, ask: what specific thing does this require from Rio today? Look for:
- A document waiting for his signature
- A commitment he made that someone is following up on
- Something waiting on him (access, a draft, a decision, a reply)
- A deadline he is about to miss
- A warm lead or active client who needs a response
Only surface emails where the answer is concrete and urgent. Ignore everything else.

**Calendar:** For every meeting, ask: who is this with and what is at stake? Look for:
- A pipeline contact (flagged [PIPELINE]) — note their stage and what needs to happen
- A first meeting vs. recurring — first meetings need intro prep, recurring need "what did I promise last time"
- A decision or deliverable expected at this meeting
If a meeting attendee also appears in the inbox this week, flag the connection explicitly.

**BD action:** Look at the stale pipeline data. Identify the single highest-leverage move Rio can make today to advance a deal. Be specific: name the person, the org, the action, and why today. "Call [name] at [org] — proposal has been out 4 days with no reply" not "follow up with prospects."

---

Return ONLY valid JSON, no markdown fences, no other text:
{
  "calendar": [{"title": "string", "link": "string", "analysis": "string", "priority": "high|medium|low"}],
  "email": [{"title": "string", "from": "string", "link": "string", "analysis": "string", "priority": "high|medium|low"}],
  "actions": [{"title": "string", "analysis": "string", "priority": "high|medium|low"}],
  "bd": {"action": "string", "analysis": "string"}
}

Limits: calendar max 3, email max 4, actions max 3, bd exactly 1.
analysis fields: 1-2 sentences max. Punchy. Tell Rio what to DO.
priority: high = act now, medium = today, low = be aware.
Empty array if a section has nothing urgent — never pad.
For calendar items: set link to the meetLink if present (prefer it — lets Rio join the call), else calLink. Both are in the calendar context above.
For email items: set link to the gmail thread link provided in the context.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CONFIG.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: `Here is Rio's board:\n\n${context}\n\nGive him his brief as JSON.` }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `API ${resp.status}`);
    }

    const data = await resp.json();
    const raw  = data.content?.[0]?.text || '';

    let brief;
    try {
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      brief = JSON.parse(match ? match[1].trim() : raw.trim());
    } catch {
      area.innerHTML = `<div class="brief-text">${esc(raw)}</div>`;
      return;
    }

    S.briefData = injectCalendarLinks(brief);
    area.innerHTML = renderBrief(S.briefData);
  } catch (err) {
    area.innerHTML = `<div class="brief-thinking">Willie couldn't connect: ${esc(err.message)}</div>`;
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '✦ Ask Willie';
  }
}

function injectCalendarLinks(brief) {
  if (!brief?.calendar?.length || !S.calendar.length) return brief;
  brief.calendar = brief.calendar.map(item => {
    if (item.link) return item;
    const match = S.calendar.find(ev => {
      const a = ev.title.toLowerCase(), b = (item.title || '').toLowerCase();
      return a.includes(b.slice(0, 10)) || b.includes(a.slice(0, 10));
    });
    if (match) item.link = match.meetLink || match.calLink || '';
    return item;
  });
  return brief;
}

function renderBrief(brief) {
  const sections = [
    { key: 'calendar', label: 'Calendar',  icon: '◈' },
    { key: 'email',    label: 'Inbox',     icon: '✉' },
    { key: 'actions',  label: 'Do today',  icon: '→' },
  ];
  const body = sections.map(({ key, label, icon }) => {
    const items = (brief[key] || []);
    if (!items.length) return '';
    return `<div class="brief-section">
      <div class="brief-section-head">${icon} ${label}</div>
      ${items.map(item => `
        <div class="brief-card bc-${item.priority || 'medium'}">
          ${item.link
            ? `<a class="brief-title" href="${escA(item.link)}" target="_blank" rel="noopener">${esc(item.title || item.from || '')}</a>`
            : `<div class="brief-title no-link">${esc(item.title || '')}</div>`}
          <div class="brief-analysis">${esc(item.analysis || '')}</div>
        </div>`).join('')}
    </div>`;
  }).join('');

  const bd = brief.bd;
  const bdHtml = bd ? `<div class="brief-section">
    <div class="brief-section-head">★ BD move</div>
    <div class="brief-card bc-high">
      <div class="brief-title no-link">${esc(bd.action || '')}</div>
      <div class="brief-analysis">${esc(bd.analysis || '')}</div>
    </div>
  </div>` : '';

  return body + bdHtml;
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigate(v) {
  S.view = v;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  renderView();
}

function renderView() {
  const el = document.getElementById('view');
  switch (S.view) {
    case 'home':     el.innerHTML = homeHTML();     break;
    case 'fcit':     el.innerHTML = fcitHTML();     break;
    case 'opf':      el.innerHTML = opfHTML();      break;
    case 'creative': el.innerHTML = creativeHTML(); break;
  }
  bindViewEvents();
}

// ── Home ──────────────────────────────────────────────────────────────────────
function homeHTML() {
  const followUps     = S.fcit.filter(e => e.dueDate && e.dueDate <= todays()).sort((a,b) => a.dueDate.localeCompare(b.dueDate));
  const opfActive     = S.opf.filter(e => e.status !== 'done').length;
  const creativeActive = S.creative.filter(e => e.status !== 'done').length;
  const emailCount    = S.gmail.unread.length + S.gmail.starred.length + S.gmail.pipeline.length;

  return `
    <div class="home-header">
      <div class="home-header-row">
        <div>
          <div class="greeting">${greeting()}</div>
          <div class="greeting-name">Rio.</div>
          <div class="greeting-date">${fullDate()}</div>
        </div>
        ${S.token ? `<button class="btn-icon" id="home-refresh" title="Refresh">↻</button>` : ''}
      </div>
    </div>

    <div class="stat-row">
      <div class="stat-chip" data-nav="fcit">
        <div class="stat-num">${S.fcit.length}</div>
        <div class="stat-label">FCIT</div>
      </div>
      <div class="stat-chip" data-nav="opf">
        <div class="stat-num">${opfActive}</div>
        <div class="stat-label">OPF</div>
      </div>
      <div class="stat-chip" data-nav="creative">
        <div class="stat-num">${creativeActive}</div>
        <div class="stat-label">Creative</div>
      </div>
    </div>

    ${!S.token ? authBanner() : ''}

    <button class="willie-btn" id="wb" onclick="openWillieChat()">✦ Say Hey, Willie</button>
    <div class="brief-area" id="ba"${S.briefData ? '' : ' style="display:none"'}>
      ${S.briefData && S.briefSource === 'precomputed' ? `<div style="font-size:11px;color:var(--t3);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.08em">✦ Ready at ${new Date(S.briefData.generatedAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</div>` : ''}
      ${S.briefData ? renderBrief(S.briefData) : ''}
    </div>

    <div class="section">
      <div class="section-title">Today · ${S.calendar.length} event${S.calendar.length !== 1 ? 's' : ''}</div>
      ${S.calendar.length === 0
        ? `<div class="dim-note">${S.token ? 'No events scheduled.' : 'Connect Google to load your calendar.'}</div>`
        : S.calendar.map(ev => `
          <div class="cal-event">
            <div class="cal-time">${ev.allDay ? 'All day' : fmtTime(ev.start)}</div>
            <div class="cal-body">
              ${ev.calLink
                ? `<a class="cal-title" href="${escA(ev.calLink)}" target="_blank" rel="noopener">${esc(ev.title)}</a>`
                : `<div class="cal-title">${esc(ev.title)}</div>`}
              ${ev.attendees.length ? `<div class="cal-attendees">${esc(ev.attendees.join(', '))}</div>` : ''}
            </div>
            ${ev.meetLink ? `<a class="cal-join" href="${escA(ev.meetLink)}" target="_blank" rel="noopener">Join</a>` : ''}
          </div>`).join('')}
    </div>

    <div class="section">
      <div class="section-title">Inbox · ${emailCount} highlight${emailCount !== 1 ? 's' : ''}</div>
      ${emailCount === 0
        ? `<div class="dim-note">${
            !S.token ? 'Connect Google to load your inbox.' :
            S.gmailError ? `Gmail error: ${esc(S.gmailError)} — check the console and ensure the Gmail API is enabled in Google Cloud Console, then <button class="inline-reconnect" onclick="requestAuth()">reconnect</button>.` :
            'Inbox clear.'
          }</div>`
        : `
          ${S.gmail.unread.length ? `<div class="signal-label">Recent unread</div>${S.gmail.unread.map(emailRowHTML).join('')}` : ''}
          ${S.gmail.starred.length ? `<div class="signal-label">Starred</div>${S.gmail.starred.map(emailRowHTML).join('')}` : ''}
          ${S.gmail.pipeline.length ? `<div class="signal-label">From pipeline</div>${S.gmail.pipeline.map(emailRowHTML).join('')}` : ''}
        `}
    </div>

    <div class="section">
      <div class="section-title">Follow-ups · ${followUps.length}</div>
      ${followUps.length === 0
        ? `<div class="dim-note">${S.token ? 'Clear board.' : 'Connect Google to see your queue.'}</div>`
        : followUps.map(e => `
          <div class="followup-card" data-fcit-row="${e.ri}">
            <div class="followup-name">${esc(e.name)}</div>
            <div class="followup-org">${esc(e.org)}${e.stage ? `<span class="badge badge-${e.stage}">${e.stage}</span>` : ''}</div>
            ${e.nextAction ? `<div class="followup-action">${esc(e.nextAction)}</div>` : ''}
            ${e.dueDate ? `<div class="card-due ${dueStat(e.dueDate)}">${dueStat(e.dueDate)==='overdue'?'⚠ Overdue · ':dueStat(e.dueDate)==='today'?'◈ Today · ':''}${fmtDate(e.dueDate)}</div>` : ''}
          </div>`).join('')}
    </div>

    ${newsHTML()}
  `;
}

function emailRowHTML(m) {
  const inner = `
    <div class="email-from">${esc(m.from.name)}</div>
    <div class="email-subject">${esc(m.subject)}</div>
    ${m.snippet ? `<div class="email-snippet">${esc(m.snippet)}</div>` : ''}`;
  return m.link
    ? `<a class="email-row email-row-link" href="${escA(m.link)}" target="_blank" rel="noopener">${inner}</a>`
    : `<div class="email-row">${inner}</div>`;
}

function authBanner() {
  return `<div class="auth-banner">
    <div class="auth-banner-text">Connect Google to sync Sheets, Gmail &amp; Calendar.</div>
    <button class="auth-banner-btn" onclick="requestAuth()">Connect</button>
  </div>`;
}

function newsHTML() {
  const { regulatory, crypto, ethPrice } = S.news;
  const ethTicker = ethPrice?.price ? `
    <div class="eth-ticker">
      <span class="eth-price-val">$${ethPrice.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
      ${ethPrice.change != null ? `<span class="eth-change-val" style="color:${ethPrice.change >= 0 ? 'var(--green)' : 'var(--red)'}">${ethPrice.change >= 0 ? '▲' : '▼'} ${Math.abs(ethPrice.change).toFixed(2)}%</span>` : ''}
    </div>` : '';
  return `
    <div class="section">
      <div class="section-title">Regulatory & Enforcement</div>
      ${regulatory.length
        ? regulatory.map(newsRowHTML).join('')
        : '<div class="dim-note">No regulatory news loaded</div>'}
    </div>
    <div class="section">
      <div class="section-title">Ethereum</div>
      ${ethTicker}
      ${crypto.length
        ? crypto.map(newsRowHTML).join('')
        : '<div class="dim-note">No crypto news loaded</div>'}
    </div>`;
}

function newsRowHTML(n) {
  const inner = `
    <div class="email-from">${esc(n.source)}</div>
    <div class="email-subject">${esc(n.title)}</div>`;
  return n.link
    ? `<a class="email-row email-row-link" href="${escA(n.link)}" target="_blank" rel="noopener">${inner}</a>`
    : `<div class="email-row">${inner}</div>`;
}

// ── FCIT view ─────────────────────────────────────────────────────────────────
function fcitHTML() {
  const f = S.filter.fcit;
  const t = todays();
  const stagePri = {proposal:0, warm:1, prospect:2, closed:3};
  const items = S.fcit
    .filter(e => f === 'all' || e.stage === f)
    .sort((a, b) => {
      const aUrgent = a.dueDate && a.dueDate <= t ? 0 : 1;
      const bUrgent = b.dueDate && b.dueDate <= t ? 0 : 1;
      if (aUrgent !== bUrgent) return aUrgent - bUrgent;
      return (stagePri[a.stage]??4) - (stagePri[b.stage]??4);
    });
  return `
    <div class="page-header">
      <div class="page-title">FCIT</div>
      <button class="btn-icon" id="add-fcit">+</button>
    </div>
    ${!S.token ? authBanner() : ''}
    <div class="filters">
      ${['all','prospect','warm','proposal','closed'].map(s =>
        `<button class="filter-chip${f===s?' active':''}" data-lane="fcit" data-val="${s}">${s==='all'?'All':cap(s)}</button>`
      ).join('')}
    </div>
    <div class="list-items">
      ${items.length === 0
        ? `<div class="empty">${S.token ? 'No contacts yet.<br>Tap + to add one.' : 'Connect Google to load contacts.'}</div>`
        : items.map(e => `
          <div class="card" data-row="${e.ri}">
            <div class="card-row">
              <div class="card-name">${esc(e.name)}</div>
              <span class="badge badge-${e.stage}">${e.stage}</span>
            </div>
            ${e.org ? `<div class="card-sub">${esc(e.org)}</div>` : ''}
            ${e.nextAction ? `<div class="card-action">${esc(e.nextAction)}</div>` : ''}
            ${e.dueDate ? `<div class="card-due ${dueStat(e.dueDate)}">${dueStat(e.dueDate)==='overdue'?'⚠ ':dueStat(e.dueDate)==='today'?'◈ ':''}${fmtDate(e.dueDate)}</div>` : ''}
            ${e.stage !== 'closed' ? `<div class="card-quick"><button class="quick-btn" data-contacted="${e.ri}">✓ Contacted</button></div>` : ''}
          </div>`).join('')}
    </div>`;
}

// ── OPF view ──────────────────────────────────────────────────────────────────
function opfHTML() {
  const f = S.filter.opf;
  const statusPri = {todo:0,'in-progress':1,blocked:2,done:3};
  const priorityPri = {high:0,medium:1,low:2};
  const items = S.opf
    .filter(e => f === 'all' || e.status === f)
    .sort((a, b) => {
      const sd = (statusPri[a.status]??4) - (statusPri[b.status]??4);
      if (sd) return sd;
      const pd = (priorityPri[a.priority]??3) - (priorityPri[b.priority]??3);
      if (pd) return pd;
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      return a.dueDate ? -1 : b.dueDate ? 1 : 0;
    });
  return `
    <div class="page-header">
      <div class="page-title">OPF</div>
      <button class="btn-icon" id="add-opf">+</button>
    </div>
    ${!S.token ? authBanner() : ''}
    <div class="filters">
      ${['all','todo','in-progress','done','blocked'].map(s =>
        `<button class="filter-chip${f===s?' active':''}" data-lane="opf" data-val="${s}">${s==='all'?'All':cap(s)}</button>`
      ).join('')}
    </div>
    <div class="list-items">
      ${items.length === 0
        ? `<div class="empty">${S.token ? 'No tasks yet.<br>Tap + to add one.' : 'Connect Google to load tasks.'}</div>`
        : items.map(e => `
          <div class="card" data-row="${e.ri}">
            <div class="card-row">
              <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
                <div class="dot dot-${e.priority}"></div>
                <div class="card-name">${esc(e.task)}</div>
              </div>
              <span class="badge badge-${e.status}">${e.status}</span>
            </div>
            ${e.category ? `<div class="card-sub">${esc(e.category)}</div>` : ''}
            ${e.dueDate ? `<div class="card-due ${dueStat(e.dueDate)}">${dueStat(e.dueDate)==='overdue'?'⚠ ':dueStat(e.dueDate)==='today'?'◈ ':''}${fmtDate(e.dueDate)}</div>` : ''}
            ${e.status !== 'done' ? `<div class="card-quick"><button class="quick-btn done-btn" data-done-row="${e.ri}">✓ Done</button></div>` : ''}
          </div>`).join('')}
    </div>`;
}

// ── Creative view ─────────────────────────────────────────────────────────────
function creativeHTML() {
  const f = S.filter.creative;
  const statusPri = {todo:0,'in-progress':1,blocked:2,done:3};
  const priorityPri = {high:0,medium:1,low:2};
  const items = S.creative
    .filter(e => f === 'all' || e.project === f)
    .sort((a, b) => {
      const sd = (statusPri[a.status]??4) - (statusPri[b.status]??4);
      if (sd) return sd;
      const pd = (priorityPri[a.priority]??3) - (priorityPri[b.priority]??3);
      if (pd) return pd;
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      return a.dueDate ? -1 : b.dueDate ? 1 : 0;
    });
  return `
    <div class="page-header">
      <div class="page-title">Creative</div>
      <button class="btn-icon" id="add-creative">+</button>
    </div>
    ${!S.token ? authBanner() : ''}
    <div class="filters">
      ${['all', ...PROJECTS].map(s =>
        `<button class="filter-chip${f===s?' active':''}" data-lane="creative" data-proj="${escA(s)}">${s==='all'?'All':esc(s)}</button>`
      ).join('')}
    </div>
    <div class="list-items">
      ${items.length === 0
        ? `<div class="empty">${S.token ? 'No tasks yet.<br>Tap + to add one.' : 'Connect Google to load tasks.'}</div>`
        : items.map(e => `
          <div class="card" data-row="${e.ri}">
            <div class="project-tag">${esc(e.project)}</div>
            <div class="card-row">
              <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
                <div class="dot dot-${e.priority}"></div>
                <div class="card-name">${esc(e.task)}</div>
              </div>
              <span class="badge badge-${e.status}">${e.status}</span>
            </div>
            ${e.dueDate ? `<div class="card-due ${dueStat(e.dueDate)}">${dueStat(e.dueDate)==='overdue'?'⚠ ':dueStat(e.dueDate)==='today'?'◈ ':''}${fmtDate(e.dueDate)}</div>` : ''}
            ${e.status !== 'done' ? `<div class="card-quick"><button class="quick-btn done-btn" data-done-row="${e.ri}">✓ Done</button></div>` : ''}
          </div>`).join('')}
    </div>`;
}

// ── Event binding ─────────────────────────────────────────────────────────────
function bindViewEvents() {
  const v = S.view;

  document.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.proj !== undefined) {
        S.filter.creative = btn.dataset.proj === 'all' ? 'all' : btn.dataset.proj;
      } else {
        S.filter[btn.dataset.lane] = btn.dataset.val;
      }
      renderView();
    });
  });

  document.querySelectorAll('.card[data-row]').forEach(card => {
    const ri = parseInt(card.dataset.row, 10);
    card.addEventListener('click', () => {
      if (v === 'fcit')     openFCIT(ri);
      else if (v === 'opf') openOPF(ri);
      else                  openCreative(ri);
    });
  });

  document.querySelectorAll('.followup-card[data-fcit-row]').forEach(card => {
    const ri = parseInt(card.dataset.fcitRow, 10);
    card.addEventListener('click', () => { navigate('fcit'); setTimeout(() => openFCIT(ri), 60); });
  });

  document.querySelectorAll('.stat-chip[data-nav]').forEach(chip => {
    chip.addEventListener('click', () => navigate(chip.dataset.nav));
  });

  const addFcit = document.getElementById('add-fcit');
  if (addFcit) addFcit.addEventListener('click', () => openFCIT(null));
  const addOpf = document.getElementById('add-opf');
  if (addOpf) addOpf.addEventListener('click', () => openOPF(null));
  const addCreative = document.getElementById('add-creative');
  if (addCreative) addCreative.addEventListener('click', () => openCreative(null));

  const homeRefresh = document.getElementById('home-refresh');
  if (homeRefresh) homeRefresh.addEventListener('click', () => { loadAll(); toast('Refreshing...'); });

  document.querySelectorAll('[data-contacted]').forEach(btn => {
    btn.addEventListener('click', async ev => {
      ev.stopPropagation();
      const ri = parseInt(btn.dataset.contacted, 10);
      await markContacted(ri);
    });
  });

  document.querySelectorAll('[data-done-row]').forEach(btn => {
    btn.addEventListener('click', async ev => {
      ev.stopPropagation();
      const ri = parseInt(btn.dataset.doneRow, 10);
      await markTaskDone(v === 'opf' ? 'opf' : 'creative', ri);
    });
  });
}

// ── Quick actions ─────────────────────────────────────────────────────────────
async function markContacted(ri) {
  const e = S.fcit.find(x => x.ri === ri);
  if (!e) return;
  if (!S.token) { toast('Connect Google to save'); return; }
  try { await saveFCIT({...e, lastContact: todays()}, false); renderView(); toast('Marked contacted'); }
  catch (err) { toast('Failed: ' + err.message); }
}

async function markTaskDone(view, ri) {
  if (!S.token) { toast('Connect Google to save'); return; }
  try {
    if (view === 'opf') {
      const e = S.opf.find(x => x.ri === ri);
      if (!e) return;
      await saveOPF({...e, status:'done'}, false);
    } else {
      const e = S.creative.find(x => x.ri === ri);
      if (!e) return;
      await saveCreative({...e, status:'done'}, false);
    }
    renderView();
    toast('Done');
  } catch (err) { toast('Failed: ' + err.message); }
}

// ── Forms ─────────────────────────────────────────────────────────────────────
function showModal(html, bindFn) {
  const modal = document.getElementById('modal');
  modal.classList.remove('hidden');
  modal.innerHTML = `<div class="modal-sheet">${html}</div>`;
  modal.onclick = e => { if (e.target === modal) closeModal(); };
  if (bindFn) bindFn();
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  if (recognition) { recognition.stop(); recognition = null; }
}

function formActions(isNew) {
  return `<div class="form-actions">
    <button class="btn-save" id="f-save">Save</button>
    ${!isNew ? `<button class="btn-del" id="f-del">Delete</button>` : ''}
    <button class="btn-cancel" onclick="closeModal()">Cancel</button>
  </div>`;
}

function notesField(val) {
  return `<div class="field">
    <label class="field-label">Notes</label>
    <div class="voice-wrap">
      <textarea class="field-textarea" id="fi-notes" rows="3" placeholder="Notes...">${esc(val)}</textarea>
      <button class="voice-btn" id="vb" type="button" title="Voice input">🎤</button>
    </div>
  </div>`;
}

function openFCIT(ri) {
  const entry = ri ? S.fcit.find(e => e.ri === ri) : null;
  const isNew = !entry;
  const e = entry || { ri:null, name:'', org:'', stage:'prospect', lastContact:'', nextAction:'', dueDate:'', notes:'' };
  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${isNew ? 'Add Contact' : 'Edit Contact'}</div>
    <div class="field"><label class="field-label">Name</label>
      <input class="field-input" id="fi-name" type="text" value="${escA(e.name)}" placeholder="Full name" autocomplete="name"></div>
    <div class="field"><label class="field-label">Organization</label>
      <input class="field-input" id="fi-org" type="text" value="${escA(e.org)}" placeholder="Company or org"></div>
    <div class="field"><label class="field-label">Stage</label>
      <select class="field-select" id="fi-stage">
        ${['prospect','warm','proposal','closed'].map(s => `<option value="${s}"${e.stage===s?' selected':''}>${cap(s)}</option>`).join('')}
      </select></div>
    <div class="field"><label class="field-label">Last Contact</label>
      <input class="field-input" id="fi-last" type="date" value="${escA(e.lastContact)}"></div>
    <div class="field"><label class="field-label">Next Action</label>
      <input class="field-input" id="fi-action" type="text" value="${escA(e.nextAction)}" placeholder="What needs to happen"></div>
    <div class="field"><label class="field-label">Due Date</label>
      <input class="field-input" id="fi-due" type="date" value="${escA(e.dueDate)}"></div>
    ${notesField(e.notes)}
    ${formActions(isNew)}
  `, () => {
    document.getElementById('vb').addEventListener('click', () => voice('fi-notes', 'vb'));
    document.getElementById('f-save').addEventListener('click', async () => {
      const data = { ri:e.ri, name:v('fi-name'), org:v('fi-org'), stage:v('fi-stage'),
        lastContact:v('fi-last'), nextAction:v('fi-action'), dueDate:v('fi-due'), notes:v('fi-notes') };
      if (!data.name) { toast('Name is required'); return; }
      closeModal();
      if (!S.token) { toast('Connect Google to save'); return; }
      try { await saveFCIT(data, isNew); renderView(); toast('Saved'); }
      catch (err) { toast('Save failed: ' + err.message); }
    });
    if (!isNew) {
      document.getElementById('f-del').addEventListener('click', async () => {
        if (!confirm('Delete this contact?')) return;
        closeModal();
        try { await delFCIT(e); renderView(); toast('Deleted'); }
        catch (err) { toast('Delete failed: ' + err.message); }
      });
    }
  });
}

function openOPF(ri) {
  const entry = ri ? S.opf.find(e => e.ri === ri) : null;
  const isNew = !entry;
  const e = entry || { ri:null, task:'', category:'', priority:'medium', dueDate:'', status:'todo', notes:'' };
  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${isNew ? 'Add Task' : 'Edit Task'}</div>
    <div class="field"><label class="field-label">Task</label>
      <input class="field-input" id="fi-task" type="text" value="${escA(e.task)}" placeholder="What needs to be done"></div>
    <div class="field"><label class="field-label">Category</label>
      <input class="field-input" id="fi-cat" type="text" value="${escA(e.category)}" placeholder="e.g. Operations, Finance"></div>
    <div class="field"><label class="field-label">Priority</label>
      <select class="field-select" id="fi-priority">
        ${['high','medium','low'].map(p => `<option value="${p}"${e.priority===p?' selected':''}>${cap(p)}</option>`).join('')}
      </select></div>
    <div class="field"><label class="field-label">Due Date</label>
      <input class="field-input" id="fi-due" type="date" value="${escA(e.dueDate)}"></div>
    <div class="field"><label class="field-label">Status</label>
      <select class="field-select" id="fi-status">
        ${['todo','in-progress','done','blocked'].map(s => `<option value="${s}"${e.status===s?' selected':''}>${cap(s)}</option>`).join('')}
      </select></div>
    ${notesField(e.notes)}
    ${formActions(isNew)}
  `, () => {
    document.getElementById('vb').addEventListener('click', () => voice('fi-notes', 'vb'));
    document.getElementById('f-save').addEventListener('click', async () => {
      const data = { ri:e.ri, task:v('fi-task'), category:v('fi-cat'), priority:v('fi-priority'),
        dueDate:v('fi-due'), status:v('fi-status'), notes:v('fi-notes') };
      if (!data.task) { toast('Task is required'); return; }
      closeModal();
      if (!S.token) { toast('Connect Google to save'); return; }
      try { await saveOPF(data, isNew); renderView(); toast('Saved'); }
      catch (err) { toast('Save failed: ' + err.message); }
    });
    if (!isNew) {
      document.getElementById('f-del').addEventListener('click', async () => {
        if (!confirm('Delete this task?')) return;
        closeModal();
        try { await delOPF(e); renderView(); toast('Deleted'); }
        catch (err) { toast('Delete failed: ' + err.message); }
      });
    }
  });
}

function openCreative(ri) {
  const entry = ri ? S.creative.find(e => e.ri === ri) : null;
  const isNew = !entry;
  const e = entry || { ri:null, project:PROJECTS[0], task:'', priority:'medium', dueDate:'', status:'todo', notes:'' };
  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${isNew ? 'Add Task' : 'Edit Task'}</div>
    <div class="field"><label class="field-label">Project</label>
      <select class="field-select" id="fi-project">
        ${PROJECTS.map(p => `<option value="${escA(p)}"${e.project===p?' selected':''}>${esc(p)}</option>`).join('')}
      </select></div>
    <div class="field"><label class="field-label">Task</label>
      <input class="field-input" id="fi-task" type="text" value="${escA(e.task)}" placeholder="What needs to be done"></div>
    <div class="field"><label class="field-label">Priority</label>
      <select class="field-select" id="fi-priority">
        ${['high','medium','low'].map(p => `<option value="${p}"${e.priority===p?' selected':''}>${cap(p)}</option>`).join('')}
      </select></div>
    <div class="field"><label class="field-label">Due Date</label>
      <input class="field-input" id="fi-due" type="date" value="${escA(e.dueDate)}"></div>
    <div class="field"><label class="field-label">Status</label>
      <select class="field-select" id="fi-status">
        ${['todo','in-progress','done','blocked'].map(s => `<option value="${s}"${e.status===s?' selected':''}>${cap(s)}</option>`).join('')}
      </select></div>
    ${notesField(e.notes)}
    ${formActions(isNew)}
  `, () => {
    document.getElementById('vb').addEventListener('click', () => voice('fi-notes', 'vb'));
    document.getElementById('f-save').addEventListener('click', async () => {
      const data = { ri:e.ri, project:v('fi-project'), task:v('fi-task'), priority:v('fi-priority'),
        dueDate:v('fi-due'), status:v('fi-status'), notes:v('fi-notes') };
      if (!data.task) { toast('Task is required'); return; }
      closeModal();
      if (!S.token) { toast('Connect Google to save'); return; }
      try { await saveCreative(data, isNew); renderView(); toast('Saved'); }
      catch (err) { toast('Save failed: ' + err.message); }
    });
    if (!isNew) {
      document.getElementById('f-del').addEventListener('click', async () => {
        if (!confirm('Delete this task?')) return;
        closeModal();
        try { await delCreative(e); renderView(); toast('Deleted'); }
        catch (err) { toast('Delete failed: ' + err.message); }
      });
    }
  });
}

// ── Voice input ───────────────────────────────────────────────────────────────
let recognition = null;

function voice(fieldId, btnId) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Voice input not supported on this browser'); return; }
  const field = document.getElementById(fieldId);
  const btn   = document.getElementById(btnId);
  if (recognition) { recognition.stop(); return; }
  recognition = new SR();
  recognition.continuous = true; recognition.interimResults = true; recognition.lang = 'en-US';
  const base = field.value;
  btn.classList.add('rec'); btn.textContent = '⏹';
  recognition.onresult = ev => {
    let t = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) t += ev.results[i][0].transcript;
    field.value = (base ? base + ' ' : '') + t;
  };
  const done = () => { recognition = null; btn.classList.remove('rec'); btn.textContent = '🎤'; };
  recognition.onend = done;
  recognition.onerror = e => { done(); if (e.error !== 'no-speech') toast('Voice: ' + e.error); };
  recognition.start();
}

// ── Willie Chat ───────────────────────────────────────────────────────────────
function openWillieChat() {
  if (!S.chatHistory.length) {
    const daysSince = d => d ? Math.floor((Date.now() - new Date(d)) / 86400000) : 999;
    const stale = S.fcit.filter(e => e.stage !== 'closed' && daysSince(e.lastContact) >= 7);
    const due   = S.opf.filter(e => e.status !== 'done' && e.dueDate && e.dueDate <= todays()).length;
    const intro  = S.briefData
      ? `Good ${greeting().split(' ')[1].toLowerCase()}, Rio. Brief is ready — ${S.briefData.calendar?.length || 0} calendar item${S.briefData.calendar?.length !== 1 ? 's' : ''}, ${S.briefData.email?.length || 0} email${S.briefData.email?.length !== 1 ? 's' : ''} worth your attention${due ? `, ${due} task${due !== 1 ? 's' : ''} due today` : ''}${stale.length ? `, ${stale.length} stale pipeline contact${stale.length !== 1 ? 's' : ''}` : ''}. What do you want to dig into?`
      : `Hey Rio — no brief loaded yet. What's on your mind?`;
    S.chatHistory.push({ role: 'assistant', content: intro });
  }

  showModal(`
    <div class="modal-handle"></div>
    <div class="chat-header"><div class="chat-title">✦ Willie</div></div>
    <div class="chat-messages" id="chat-msgs">
      ${S.chatHistory.map(chatMsgHTML).join('')}
    </div>
    <div class="chat-input-row">
      <div class="voice-wrap" style="flex:1">
        <textarea class="field-textarea chat-textarea" id="chat-input" rows="1" placeholder="Ask Willie anything..."></textarea>
        <button class="voice-btn" id="chat-vb" type="button">🎤</button>
      </div>
      <button class="chat-send" id="chat-send">↑</button>
    </div>
  `, () => {
    const input = document.getElementById('chat-input');
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendWillieMessage(); }
    });
    document.getElementById('chat-send').addEventListener('click', sendWillieMessage);
    document.getElementById('chat-vb').addEventListener('click', () => voice('chat-input', 'chat-vb'));
    scrollChatToBottom();
  });
}

function chatMsgHTML(m) {
  return `<div class="chat-msg chat-msg-${m.role}">
    ${m.role === 'assistant' ? '<div class="chat-msg-label">Willie</div>' : ''}
    <div class="chat-msg-text">${esc(m.content)}</div>
  </div>`;
}

function scrollChatToBottom() {
  const el = document.getElementById('chat-msgs');
  if (el) el.scrollTop = el.scrollHeight;
}

async function sendWillieMessage() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = ''; input.style.height = 'auto';

  S.chatHistory.push({ role: 'user', content: msg });
  const msgs = document.getElementById('chat-msgs');
  msgs.insertAdjacentHTML('beforeend', chatMsgHTML({ role: 'user', content: msg }));

  const tid = 'typing-' + Date.now();
  msgs.insertAdjacentHTML('beforeend',
    `<div class="chat-msg chat-msg-assistant" id="${tid}">
       <div class="chat-msg-label">Willie</div>
       <div class="chat-msg-text chat-typing">...</div>
     </div>`);
  scrollChatToBottom();

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CONFIG.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: buildWillieContext(),
        messages: S.chatHistory,
      }),
    });
    const data = await resp.json();
    const reply = data.content?.[0]?.text || 'Something went wrong — try again.';
    S.chatHistory.push({ role: 'assistant', content: reply });
    const el = document.getElementById(tid);
    if (el) el.outerHTML = chatMsgHTML({ role: 'assistant', content: reply });
  } catch (err) {
    const el = document.getElementById(tid);
    if (el) el.outerHTML = chatMsgHTML({ role: 'assistant', content: 'Connection error — try again.' });
  }
  scrollChatToBottom();
}

function buildWillieContext() {
  const t = todays();
  const daysSince = d => d ? Math.floor((Date.now() - new Date(d)) / 86400000) : 999;
  return `You are Willie — Rio Miner's sharp, trusted executive assistant. Today is ${fullDate()}.

${S.briefData ? `## Today's brief
Calendar: ${JSON.stringify(S.briefData.calendar || [])}
Email: ${JSON.stringify(S.briefData.email || [])}
Actions: ${JSON.stringify(S.briefData.actions || [])}
BD move: ${JSON.stringify(S.briefData.bd || {})}
` : ''}## FCIT Pipeline
${S.fcit.map(e => `${e.name} (${e.org}) [${e.stage}] last contact: ${e.lastContact||'never'} (${daysSince(e.lastContact)}d ago) next: ${e.nextAction||'—'}`).join('\n') || 'Empty.'}

## Active OPF Tasks
${S.opf.filter(e=>e.status!=='done').map(e=>`[${e.priority}] ${e.task} — ${e.status}${e.dueDate?` due ${e.dueDate}`:''}`).join('\n') || 'None.'}

## Active Creative Tasks
${S.creative.filter(e=>e.status!=='done').map(e=>`[${e.project}] ${e.task} — ${e.status}`).join('\n') || 'None.'}

## Calendar today
${S.calendar.map(ev=>`${ev.allDay?'All day':fmtTime(ev.start)} — ${ev.title}${ev.attendees.length?` (with ${ev.attendees.join(', ')})`:''}`).join('\n') || 'No events.'}

Rio can ask you anything: dig into his brief, get advice, draft a message, prioritize his day, or tell you what to focus on in future briefs. Be direct, specific, action-oriented. No fluff. One clear answer at a time unless he asks for more.`;
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function v(id)   { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function enc(s)  { return encodeURIComponent(s); }
function esc(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escA(s) { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function cap(s)  { return s.charAt(0).toUpperCase() + s.slice(1).replace('-', ' '); }

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  if (typeof CONFIG === 'undefined') {
    document.getElementById('view').innerHTML = '<div class="empty" style="padding:60px 24px">⚠ config.js not found.<br><br>Add your API keys to config.js.</div>';
    return;
  }
  renderView();
  initAuth();
  if ('serviceWorker' in navigator && location.hostname !== 'localhost') navigator.serviceWorker.register('./sw.js').catch(console.error);
});
