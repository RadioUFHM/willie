// ── Willie Morning Prep — Google Apps Script ──────────────────────────────────
// Paste this entire file into script.google.com (New Project).
// Run createTrigger() once manually to schedule the daily 5:30 AM Pacific run.
// Grant permissions when prompted (Gmail, Calendar, Sheets, external fetch).

const SHEET_ID      = 'PASTE_YOUR_SHEET_ID_HERE';   // from config.js
const ANTHROPIC_KEY = 'PASTE_YOUR_ANTHROPIC_API_KEY_HERE'; // from config.js

// ── Entry point ───────────────────────────────────────────────────────────────
function runMorningPrep() {
  try {
    const emails  = getRecentEmails();
    const events  = getTodaysEvents();
    const fcit    = getFCITPipeline();
    const opf     = getActiveTasks('OPF',      ['task','category','priority','dueDate','status','notes']);
    const creative = getActiveTasks('Creative', ['project','task','priority','dueDate','status','notes']);

    const brief = analyzeWithGemini(emails, events, fcit, opf, creative);
    saveToSheet(brief);
    Logger.log('Willie morning prep done: ' + new Date());
  } catch (e) {
    Logger.log('runMorningPrep error: ' + e.message + '\n' + e.stack);
  }
}

// ── Gmail — full body ─────────────────────────────────────────────────────────
function getRecentEmails() {
  const threads = GmailApp.search(
    'is:unread newer_than:1d label:inbox -category:promotions -category:social', 0, 20
  );
  const starred = GmailApp.search('is:starred is:unread', 0, 5);
  const all = [...threads, ...starred];
  const seen = new Set();
  return all
    .filter(t => { if (seen.has(t.getId())) return false; seen.add(t.getId()); return true; })
    .map(thread => {
      const msg = thread.getMessages().slice(-1)[0];
      return {
        from:    msg.getFrom(),
        subject: msg.getSubject(),
        date:    msg.getDate().toISOString(),
        body:    msg.getPlainBody().slice(0, 3000),
        link:    `https://mail.google.com/mail/u/0/#inbox/${thread.getId()}`,
      };
    });
}

// ── Calendar ──────────────────────────────────────────────────────────────────
function getTodaysEvents() {
  const today = new Date();
  return CalendarApp.getDefaultCalendar()
    .getEventsForDay(today)
    .map(ev => {
      const desc = ev.getDescription() || '';
      const meetMatch = desc.match(/https:\/\/meet\.google\.com\/[\w-]+/);
      const meetLink = meetMatch ? meetMatch[0] : (ev.getLocation() || '');
      return {
        title:     ev.getTitle(),
        start:     ev.getStartTime().toISOString(),
        allDay:    ev.isAllDayEvent(),
        attendees: ev.getGuestList().map(g => g.getName() || g.getEmail()),
        link:      meetLink,
        notes:     desc.slice(0, 300),
      };
    });
}

// ── Sheets ────────────────────────────────────────────────────────────────────
function getFCITPipeline() {
  const rows = SpreadsheetApp.openById(SHEET_ID)
    .getSheetByName('FCIT').getDataRange().getValues().slice(1);
  return rows.filter(r => r[0]).map(r => ({
    name: r[0], org: r[1], stage: r[2],
    lastContact: r[3] ? Utilities.formatDate(new Date(r[3]), 'UTC', 'yyyy-MM-dd') : '',
    nextAction: r[4], dueDate: r[5] ? Utilities.formatDate(new Date(r[5]), 'UTC', 'yyyy-MM-dd') : '',
    notes: r[6],
    daysSinceContact: r[3] ? Math.floor((Date.now() - new Date(r[3])) / 86400000) : 999,
  }));
}

function getActiveTasks(tabName, fields) {
  const rows = SpreadsheetApp.openById(SHEET_ID)
    .getSheetByName(tabName).getDataRange().getValues().slice(1);
  return rows
    .filter(r => r[0] && r[fields.indexOf('status')] !== 'done')
    .map(r => Object.fromEntries(fields.map((f, i) => [f, r[i] || ''])));
}

// ── Gemini ────────────────────────────────────────────────────────────────────
function analyzeWithGemini(emails, events, fcit, opf, creative) {
  const today = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'EEEE, MMMM d, yyyy');

  const prompt = `You are Willie — Rio Miner's sharp, trusted executive assistant. Today is ${today} (Pacific time). You have already read his inbox, calendar, and all active data before he woke up.

## FCIT Pipeline (Business Development contacts)
${JSON.stringify(fcit)}

## OPF Tasks (Operations & Projects — active only)
${JSON.stringify(opf)}

## Creative Tasks (active only)
${JSON.stringify(creative)}

## Today's Calendar
${JSON.stringify(events)}

## Recent Emails (with full body text)
${JSON.stringify(emails)}

---

Analyze everything above and return ONLY valid JSON — no markdown fences, no explanation, no preamble.

For each email: read the full body. Ask what specific action this requires from Rio TODAY. Ignore newsletters, FYIs, and anything that doesn't need a response or decision.

For each calendar event: identify what Rio needs to prepare, decide, or bring to this meeting. Flag any attendee who also appears in the FCIT pipeline.

For BD: name the single highest-leverage pipeline move Rio can make today. Be specific — name the person, org, and exact action. Reference daysSinceContact.

Return this exact structure:
{
  "generatedAt": "${new Date().toISOString()}",
  "calendar": [{"title":"","link":"","analysis":"","priority":"high|medium|low"}],
  "email":    [{"title":"","from":"","link":"","analysis":"","priority":"high|medium|low"}],
  "actions":  [{"title":"","analysis":"","priority":"high|medium|low"}],
  "bd":       {"action":"","analysis":""}
}

Limits: calendar ≤3, email ≤4, actions ≤3, bd exactly 1.
analysis: 1–2 punchy sentences. Tell Rio what to DO.
priority: high=act now, medium=today, low=be aware.
Empty array [] if a section has nothing urgent — never pad.
For calendar link: copy the event's link field exactly as provided — it is the Google Meet URL.
For email link: copy the email's link field exactly as provided — it is the Gmail thread URL.`;

  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const raw = JSON.parse(resp.getContentText())?.content?.[0]?.text || '';
  const clean = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(clean);
}

// ── Write to Sheet ────────────────────────────────────────────────────────────
function saveToSheet(brief) {
  const ss  = SpreadsheetApp.openById(SHEET_ID);
  let   tab = ss.getSheetByName('WillieBrief');
  if (!tab) {
    tab = ss.insertSheet('WillieBrief');
    tab.hideSheet();
  }
  tab.clearContents();
  tab.getRange('A1').setValue(JSON.stringify(brief));
  tab.getRange('A2').setValue(new Date().toISOString());
}

// ── Schedule — run once manually to set up the daily trigger ─────────────────
function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  // 13:30 UTC = 5:30 AM Pacific Standard / 6:30 AM Pacific Daylight
  ScriptApp.newTrigger('runMorningPrep')
    .timeBased()
    .atHour(13)
    .nearMinute(30)
    .everyDays(1)
    .create();
  Logger.log('Trigger created: runMorningPrep daily at 13:30 UTC (5:30 AM PST)');
}
