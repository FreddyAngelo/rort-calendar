#!/usr/bin/env node
// Fetches Rört's schedule from the Yogo API and writes one CSV per week into data/.
// Runs daily via GitHub Actions. Requires Node 20+ (built-in fetch).

const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.yogo.dk/classes';
const BRANCH_ID = 94; // Rört Copenhagen
const HEADERS = {
  Origin: 'https://rort.yogo.dk',
  Referer: 'https://rort.yogo.dk/',
};
// 11 weeks guarantees ~10 full weeks of future content regardless of which day
// the cron runs (current week is partly in the past, so we fetch one extra).
const WEEKS_AHEAD = 11;
const OUT_DIR = path.join(__dirname, '..', 'data');

function mondayOfCurrentWeekCopenhagen() {
  // Copenhagen-local "today" → Monday of that ISO week, returned as YYYY-MM-DD.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const todayISO = `${parts.year}-${parts.month}-${parts.day}`;
  const weekdayIdx = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[parts.weekday];
  return addDays(todayISO, -weekdayIdx);
}

function addDays(yyyyMmDd, n) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function dayName(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][
    new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  ];
}

function durationMin(start, end) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function apiGet(pathname, params) {
  const url = new URL('https://api.yogo.dk' + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
    else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Yogo ${pathname} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchWeek(startDate) {
  const endDate = addDays(startDate, 6);
  const common = { startDate, endDate, branch: BRANCH_ID };

  const classesBody = await apiGet('/classes', {
    ...common,
    'populate[]': ['teachers', 'class_type', 'room'],
  });
  const classRows = (classesBody.classes || [])
    .filter(c => !c.cancelled)
    .map(c => ({
      Date: c.date,
      Day: dayName(c.date),
      Start: (c.start_time || '').slice(0, 5),
      End: (c.end_time || '').slice(0, 5),
      Duration_min: durationMin(c.start_time, c.end_time),
      Room: c.room?.name || '',
      Class: c.class_type?.name || '',
      Instructor: (c.teachers || []).map(t => t.first_name).filter(Boolean).join('/'),
    }));

  const slotsBody = await apiGet('/event-time-slots', {
    ...common,
    'populate[]': ['event', 'event.teachers', 'event.room'],
  });
  const slots = Array.isArray(slotsBody) ? slotsBody : (slotsBody.eventTimeSlots || []);
  const eventRows = slots
    .filter(s => s.event && !s.event.archived)
    .map(s => ({
      Date: s.date,
      Day: dayName(s.date),
      Start: (s.start_time || '').slice(0, 5),
      End: (s.end_time || '').slice(0, 5),
      Duration_min: durationMin(s.start_time, s.end_time),
      Room: s.event.room?.name || '',
      Class: s.event.name || '',
      Instructor: (s.event.teachers || []).map(t => t.first_name).filter(Boolean).join('/'),
    }));

  return [...classRows, ...eventRows];
}

function rowsToCsv(rows) {
  const cols = ['Date', 'Day', 'Start', 'End', 'Duration_min', 'Room', 'Class', 'Instructor'];
  const header = cols.join(',');
  const lines = rows.map(r => cols.map(c => csvField(r[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const monday = mondayOfCurrentWeekCopenhagen();
  console.log(`Fetching ${WEEKS_AHEAD} weeks starting ${monday}`);

  for (let i = 0; i < WEEKS_AHEAD; i++) {
    const weekStart = addDays(monday, i * 7);
    const rows = (await fetchWeek(weekStart)).sort((a, b) =>
      a.Date.localeCompare(b.Date) ||
      a.Start.localeCompare(b.Start) ||
      a.Room.localeCompare(b.Room) ||
      a.Class.localeCompare(b.Class)
    );
    const file = path.join(OUT_DIR, `rort_schedule_week${i + 1}.csv`);
    fs.writeFileSync(file, rowsToCsv(rows));
    console.log(`  week${i + 1} ${weekStart} → ${rows.length} classes → ${path.basename(file)}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
