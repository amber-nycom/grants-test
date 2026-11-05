const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── HELPERS ──────────────────────────────────────────────────
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Check grant status and extract deadline using Puppeteer
async function checkGrantStatus(browserPage, url) {
  try {
    await browserPage.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const result = await browserPage.evaluate(() => {
      const main = document.querySelector('main, #main, #main-content, [role="main"], .main-content, article');
      const el = main || document.body;
      const text = (el.innerText || '').toLowerCase();
      const rawText = el.innerText || '';

      // Extract deadline - look for date patterns near deadline keywords
      let dueDate = '';
      const deadlinePatterns = [
        /(?:deadline|due date|applications? due|close[sd]?|submit by|apply by)[^\n]{0,60}((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4})/i,
        /(?:deadline|due date|applications? due|close[sd]?|submit by|apply by)[^\n]{0,30}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
        /((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4})(?:[^\n]{0,40}deadline|[^\n]{0,40}due|[^\n]{0,40}close)/i,
      // Fallback: abbreviated month and/or no year, e.g. "Applications are due by 4 p.m. on Jan. 29."
        /(?:deadline|due date|due by|due on|applications? (?:are )?due|submit by|apply by|close[sd]?)[^\n]{0,80}?\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?!\d)(?:st|nd|rd|th)?(?:,?\s*\d{4})?)/i,
      ];
      for (const re of deadlinePatterns) {
        const m = rawText.match(re);
        if (m) { dueDate = m[1].trim(); break; }
      }

      // Explicit rolling/continuous-basis language — distinct from "no info
      // found." If the source says this directly, say so directly too,
      // rather than falling through to a generic "no deadline listed."
      const isRolling = !dueDate && (
        text.includes('rolling basis') ||
        text.includes('accepted on a continuous basis') ||
        text.includes('continuously accepted') ||
        text.includes('ongoing basis') ||
        text.includes('no application deadline'));
      if (isRolling) dueDate = 'Rolling';

      // Open language that can override a known-closed default
      const isExplicitlyOpen = isRolling ||
        text.includes('applications are now open') ||
        text.includes('applications are open') ||
        text.includes('now accepting applications') ||
        text.includes('apply now') ||
        text.includes('application period is open') ||
        text.includes('submit your application');

      // Closed detection
      const isClosed = !isExplicitlyOpen && (
        text.includes('grant recipients') ||
        text.includes('award recipients') ||
        (text.includes('grant awards') && text.includes('awarded')) ||
        text.includes('round 2 awards') ||
        text.includes('application period is closed') ||
        text.includes('applications are closed') ||
        text.includes('not currently accepting') ||
        text.includes('this program is closed') ||
        text.includes('closed for applications') ||
        text.includes('no longer accepting') ||
        text.includes('program is not currently') ||
        text.includes('applications are not currently') ||
        text.includes('deadline has passed') ||
        text.includes('currently closed') ||
        text.includes('not accepting applications') ||
        text.includes('funding is not available') ||
        text.includes('not available at this time') ||
        text.includes('applications have closed') ||
        text.includes('this round is closed') ||
        text.includes('round is now closed') ||
        text.includes('awards have been made') ||
        text.includes('awards were announced'));

      // Return 'Open' (not 'Available') when explicitly confirmed open,
      // so caller can distinguish "confirmed open" from "couldn't tell"
      const status = isClosed ? 'Closed' : (isExplicitlyOpen ? 'Open' : 'Available');
      return { status, dueDate };
    });

    result.dueDate = normalizeDeadline(result.dueDate);   // "Jan. 29" -> "January 29" (no year guessed)
    console.log('  [REACHABLE] ' + url + ' status=' + result.status + (result.dueDate ? ' due=' + result.dueDate : ''));
    return { ...result, reachable: true };
  } catch(e) {
    console.log('  [UNREACHABLE] ' + url + ' — ' + e.message);
    return { status: 'Available', dueDate: '', reachable: false };
  }
}

function stripHtml(str) {
  return (str || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function resolveUrl(href, base) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  try { return new URL(href, base).href; } catch { return null; }
}

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
// "Nov. 2, 2028" / "Sept 5 2027" / "Jan 8th, 2027" -> "November 2, 2028".
// Anything that isn't a month-name date ("Continuous", "Closed", "04/15/2027") is returned unchanged.
function normalizeDeadline(s) {
  // Pulls the month-name date out of a cell: "Nov. 2, 2028" -> "November 2, 2028";
  // "...due by 4 p.m. on Jan. 29." -> "January 29" (NO year is guessed: see noYear below).
  // If there's no month-name date ("Continuous", "Closed", "04/15/2027") the text is returned unchanged.
  const m = String(s || '').match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
  if (!m) return s;
  const mo = MONTHS.findIndex(n => n.startsWith(m[1].toLowerCase().slice(0, 3)));
  return MONTHS[mo][0].toUpperCase() + MONTHS[mo].slice(1) + ' ' + parseInt(m[2], 10) + (m[3] ? ', ' + m[3] : '');
}
// True for a month-name date with no year ("January 29"). Those can't be judged past or upcoming.
function isYearless(s) {
  const t = String(s || '');
  return /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(t) && !/\b\d{4}\b/.test(t);
}

function isPast(dateStr) {
  if (!dateStr) return false;
  const s = dateStr.toLowerCase();
  if (s.includes('rolling') || s.includes('ongoing')) return false;
  if (isYearless(dateStr)) return false;   // no year given: can't tell, so don't call it past
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return false;
  return parsed < new Date();
}

const NAV_JUNK = [
  'main navigation', 'custom log in', 'cloudflare', 'investor relations',
  'rfps & bids', 'rfps and bids', 'services', 'public information',
  'connect with us', 'careers', 'contact us', 'about', 'news', 'events',
  'log in', 'log out', 'sign in', 'toggle navigation', 'skip to',
  'capital grant programs administered by dasny:',
  'grant programs administered with other state',
  'grant administration',
];

function isJunk(title) {
  if (!title || title.length < 5) return true;
  const t = title.toLowerCase().trim();
  return NAV_JUNK.some(j => t === j || t.startsWith(j));
}

// ── EFC ──────────────────────────────────────────────────────
async function scrapeEFC() {
  console.log('Scraping EFC...');
  try {
    const html = await fetchHtml('https://efc.ny.gov/apply');
    console.log('  EFC html length: ' + html.length);

    const grants = [];
    const seen = new Set();

    // Each row: <tr><td><a href="...">Title</a></td><td>Description</td><td>Deadline</td></tr>
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(html)) !== null) {
      const row = rowMatch[0];
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      while ((cm = cellRe.exec(row)) !== null) cells.push(cm[1]);
      if (cells.length < 2) continue;

      const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const lm = linkRe.exec(cells[0]);
      if (!lm) continue;

      const title = stripHtml(lm[2]);
      const url = resolveUrl(lm[1], 'https://efc.ny.gov');
      const desc = stripHtml(cells[1]);
      const dueRaw = cells[2] ? stripHtml(cells[2]) : '';
      const dueDate = normalizeDeadline(dueRaw);

      if (isJunk(title) || seen.has(title)) continue;
      seen.add(title);
      if (desc.toLowerCase().includes('low-cost financing') || desc.toLowerCase().includes('revolving fund')) continue;
      if (isPast(dueDate)) { console.log('  EFC SKIP past: ' + title); continue; }
      if (dueRaw.toLowerCase().includes('currently closed') ||
          dueRaw.toLowerCase().includes('application period is currently closed')) {
        console.log('  EFC SKIP closed: ' + title); continue;
      }
      // Skip programs for individuals/homeowners, not direct municipal grants
      const titleLower = title.toLowerCase();
      if (titleLower.includes('septic') || titleLower.includes('vessel') && desc.toLowerCase().includes('marina')) {
        // Keep vessel (marinas are eligible) but skip septic (individual homeowners)
        if (titleLower.includes('septic')) { console.log('  EFC SKIP individual: ' + title); continue; }
      }

      const dueLower = dueRaw.toLowerCase();
      const efcStatus = (dueLower.includes('closed') || dueLower.includes('not available') || dueLower.includes('not accepting')) ? 'Closed' : 'Available';
      // Only keep dueDate if it contains an actual date value
      const hasDate = /\d{1,2}[\/.\-]\d{1,2}|(january|february|march|april|may|june|july|august|september|october|november|december)/i.test(dueDate);
      grants.push({
        id: 'efc-' + title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
        title, agency: 'NYS Environmental Facilities Corporation',
        status: efcStatus,
        dueDate: hasDate ? dueDate.slice(0, 120) : '',
        description: desc.slice(0, 300),
        link: url || 'https://efc.ny.gov/apply',
        source: 'EFC',
      });
    }
    // WIIA deadline lives on its own page (efc.ny.gov/wiia), not the /apply table.
    // Add it here so the Puppeteer check pass can visit that page and extract the date.
    if (!seen.has('Water Infrastructure Improvement and Intermunicipal Grants')) {
      grants.push({
        id: 'efc-water-infrastructure-improvement-an',
        title: 'Water Infrastructure Improvement and Intermunicipal Grants',
        agency: 'NYS Environmental Facilities Corporation',
        status: 'Available',
        dueDate: '',
        description: 'Competitive grants to help municipalities undertake critical wastewater and drinking water infrastructure projects.',
        link: 'https://efc.ny.gov/wiia',
        source: 'EFC',
      });
    }

    console.log('  EFC: ' + grants.length + ' grants');
    return grants;
  } catch(e) {
    console.log('  EFC error: ' + e.message);
    return [];
  }
}

// ── NYS PARKS ────────────────────────────────────────────────
// Hardcoded to known open programs — Parks pages require heavy JS rendering
// and their closed language varies too much for reliable keyword detection.
// Status is still verified via Puppeteer on each run (checkGrantStatus, in
// the MAIN block below) — same as EFC's dedicated-page pass. NOTE: this
// Puppeteer pass hits parks.ny.gov directly, which is the same request path
// that's been getting blocked by Cloudflare bot-protection on GitHub Actions
// runner IPs. Restoring this function does not fix that; it re-exposes the
// scraper to it. If you re-enable this, remove the corresponding manual
// Parks entries from agency-grants.json first to avoid duplicate cards.
async function scrapeParks() {
  console.log('Scraping NYS Parks...');
  const known = [
    { title: 'Environmental Protection Fund', link: 'https://parks.ny.gov/grants/environmental-protection-fund' },
    { title: 'Municipal Parks and Recreation Grant', link: 'https://parks.ny.gov/grants/municipal-parks-recreation-grant' },
    { title: 'Recreational Trails Program', link: 'https://parks.ny.gov/grants/recreational-trails-program' },
    { title: 'African American Heritage Grant', link: 'https://parks.ny.gov/grants/african-american-heritage-grant' },
    { title: 'LWCF Outdoor Recreation Legacy Partnership Program', link: 'https://parks.ny.gov/grants/lwcf-outdoor-recreation-legacy-partnership-program' },
    { title: 'Boating Infrastructure Grant Program', link: 'https://parks.ny.gov/grants/boating-infrastructure-grant-program' },
    { title: 'Maritime Heritage Subgrant Program', link: 'https://parks.ny.gov/grants/maritime-heritage-subgrant-program' },
    { title: 'ZBGA Capital Grant Program', link: 'https://parks.ny.gov/grants/zbga-capital-grant-program' },
    { title: 'ZBGA Operational Support Grant Program', link: 'https://parks.ny.gov/grants/zoos-botanical-gardens-aquaria-operational-support-grant-program' },
    { title: 'Snowmobile Trail Grant Program', link: 'https://parks.ny.gov/activities/snowmobiling/snowmobile-grant-program' },
    // NY PLAYS isn't included here — it's a DASNY program, and DASNY isn't scraped
  ];

  // Programs confirmed closed — Puppeteer will override to Available if they reopen
  const knownClosed = new Set([
    'https://parks.ny.gov/grants/environmental-protection-fund',
    'https://parks.ny.gov/grants/lwcf-outdoor-recreation-legacy-partnership-program',
    'https://parks.ny.gov/grants/boating-infrastructure-grant-program',
    'https://parks.ny.gov/grants/zbga-capital-grant-program',
    'https://parks.ny.gov/grants/zoos-botanical-gardens-aquaria-operational-support-grant-program',
    'https://parks.ny.gov/grants/african-american-heritage-grant',
    'https://parks.ny.gov/grants/maritime-heritage-subgrant-program',
  ]);

  return known.map(k => ({
    id: 'parks-' + k.title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40),
    title: k.title,
    agency: 'NYS Office of Parks, Recreation & Historic Preservation',
    status: knownClosed.has(k.link) ? 'Closed' : 'Available',
    dueDate: '',
    link: k.link,
    source: 'NYS Parks',
  }));
}

// DASNY is NOT scraped. Unlike DEC, DASNY's page has no eligibility column
// to filter on, so scraping every program heading pulled in non-municipal
// programs too (e.g. VNCP — nonprofit veterans orgs, not municipalities;
// 4CFP — child care providers). One program's "link" also resolved to an
// Outlook safelink wrapping a YouTube video rather than a real program
// page. DASNY grants are entered manually instead — see NY BRICKS in
// agency-grants.json as the current example.

// ── DEC ──────────────────────────────────────────────────────
async function scrapeDEC() {
  console.log('Scraping DEC...');
  try {
    const html = await fetchHtml('https://dec.ny.gov/get-involved/grant-applications');
    const grants = [];
    const seen = new Set();

    // Parse all table rows
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(html)) !== null) {
      const row = rowMatch[0];
      // Skip header rows
      if (/<th/i.test(row)) continue;

      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      while ((cm = cellRe.exec(row)) !== null) cells.push(cm[1]);
      if (cells.length < 3) continue;

      // cells[0] = Program Name (with link), cells[1] = Eligible Parties, cells[2] = Deadline, cells[3] = Awarded By
      const eligText = stripHtml(cells[1]).toUpperCase();
      // Only include grants that municipalities (MUNI) are eligible for
      if (!eligText.includes('MUNI')) continue;

      const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const lm = linkRe.exec(cells[0]);
      if (!lm) continue;

      const title = stripHtml(lm[2]);
      if (!title || title.length < 5 || seen.has(title)) continue;
      seen.add(title);

      const rawUrl = lm[1];
      const url = resolveUrl(rawUrl, 'https://dec.ny.gov');
      const deadlineText = stripHtml(cells[2]).trim();
      const deadlineRaw = normalizeDeadline(deadlineText);
      const deadlineLower = deadlineText.toLowerCase();

      // Determine status from deadline column
      let status = 'Available';
      if (deadlineLower === 'closed' || deadlineLower.includes('closed')) {
        status = 'Closed';
      } else if (deadlineLower === 'continuous' || deadlineLower === 'rolling') {
        status = 'Available';
      } else if (isPast(deadlineRaw)) {
        status = 'Closed';
      }

      const hasDate = /\d{1,2}[\/.\-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d/i.test(deadlineRaw);
      let dueDate = '';
      if (deadlineLower === 'continuous' || deadlineLower === 'rolling') {
        dueDate = 'Rolling';
      } else if (hasDate) {
        dueDate = deadlineRaw;
      }

      grants.push({
        id: 'dec-' + title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40),
        title,
        agency: 'NYS Department of Environmental Conservation',
        status,
        dueDate,
        eligibility: stripHtml(cells[1]),
        link: url || 'https://dec.ny.gov/get-involved/grant-applications',
        source: 'DEC',
      });
      console.log('  DEC [' + status + '] ' + title + (dueDate ? ' · ' + dueDate : ''));
    }

    console.log('  DEC: ' + grants.length + ' MUNI-eligible grants');
    return grants;
  } catch(e) {
    console.log('  DEC error: ' + e.message);
    return [];
  }
}

// ── MAIN ──────────────────────────────────────────────────────
(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // HCR is NOT scraped — hcr.ny.gov sits behind the same Cloudflare bot
  // challenge on GitHub Actions runners, so any automated attempt either
  // gets nothing or silently returns a generic "Available" for everything —
  // exactly the kind of confidently-wrong data we don't want to show
  // municipal officials. HCR grants are maintained entirely by hand as
  // manual: true entries in agency-grants.json (see below).
  //
  // Parks IS scraped and now goes LIVE into the dashboard (previously
  // diagnostic-only while we confirmed Cloudflare wasn't blocking the
  // runner IP). Manual entries are still preserved from agency-grants.json
  // as a safety net, but any manual entry whose title matches a freshly
  // scraped title is SUPERSEDED (dropped) further down — the scraper wins
  // when it succeeds. If Cloudflare blocks Parks again on some future run
  // and scrapeParks() comes back empty/incomplete for a given program, the
  // old manual entry for that title is still there and takes over
  // automatically — no code change needed to fall back.
  const [efc, parks, dec] = await Promise.all([scrapeEFC(), scrapeParks(), scrapeDEC()]);

  // Deduplicate across all sources by title
  const seenTitles = new Set();
  const dedupe = (arr) => arr.filter(g => {
    const key = g.title.toLowerCase().trim();
    if (seenTitles.has(key)) { console.log('DEDUP: ' + g.title); return false; }
    seenTitles.add(key);
    return true;
  });
  const efcDeduped = dedupe(efc);
  const parksDeduped = dedupe(parks);
  const decDeduped = dedupe(dec);

  // Check status of EFC grants using Puppeteer (JS-rendered pages).
  // EFC grants with dedicated pages (like WIIA) have their deadlines there, not on /apply.
  // Skip the generic /apply page itself since it won't have per-grant deadline info.
  const efcNeedsCheck = efcDeduped.filter(g => g.link && g.link.startsWith('http') && g.link !== 'https://efc.ny.gov/apply');
  const needsCheck = [...efcNeedsCheck, ...parksDeduped].filter(g => g.link && g.link.startsWith('http'));
  console.log('\nChecking status of ' + needsCheck.length + ' EFC/Parks grants...');
  const statusMap = {};
  for (const g of needsCheck) {
    const result = await checkGrantStatus(page, g.link);
    statusMap[g.id] = result;
    if (result.status === 'Closed') console.log('  CLOSED: [' + g.source + '] ' + g.title);
  }
  const efcChecked = efcDeduped.map(g => {
    const checked = statusMap[g.id] || {};
    const raw = g.status === 'Closed' && checked.status !== 'Open'
      ? 'Closed' : checked.status || g.status;
    return { ...g, status: raw === 'Open' ? 'Available' : raw, dueDate: checked.dueDate || g.dueDate };
  });
  // Reachability log — kept from the diagnostic-only period since it's
  // still useful signal each run, even though Parks now feeds the
  // dashboard live below.
  console.log('\nParks reachability:');
  let parksReachableCount = 0;
  parksDeduped.forEach(g => {
    const checked = statusMap[g.id];
    if (checked && checked.reachable) {
      parksReachableCount++;
      console.log('  [REACHABLE] ' + g.title + ' -> status=' + checked.status + (checked.dueDate ? ' due=' + checked.dueDate : ''));
    } else {
      console.log('  [UNREACHABLE] ' + g.title + ' (' + g.link + ')');
    }
  });
  console.log('Parks: ' + parksReachableCount + '/' + parksDeduped.length + ' pages reachable');

  const parksChecked = parksDeduped.map(g => {
    const checked = statusMap[g.id] || {};
    // Only override a known-closed status if Puppeteer explicitly found it open
    const raw = g.status === 'Closed' && checked.status !== 'Open'
      ? 'Closed' : checked.status || g.status;
    return { ...g, status: raw === 'Open' ? 'Available' : raw, dueDate: checked.dueDate || g.dueDate };
  });

  await browser.close();

  const scraped = [...efcChecked, ...parksChecked, ...decDeduped];
  console.log('\nTotal agency grants: ' + scraped.length);
  scraped.forEach(g => console.log(' [' + g.source + '] ' + g.title + (g.dueDate ? ' · ' + g.dueDate : '')));

  // Grants whose deadline has no year (e.g. "January 29") are marked noYear. The sheet sync loads
  // them as Hidden with sync_flag "No year - verify" so you confirm the year before they go live.
  scraped.forEach(g => { if (isYearless(g.dueDate)) { g.noYear = true; console.log('  NO YEAR: ' + g.title + ' · ' + g.dueDate); } else { delete g.noYear; } });

  const outputPath = path.join(process.cwd(), 'agency-grants.json');
  let manualGrants = [];
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      const allManual = (existing.grants || []).filter(g => g.manual === true);

      // A manual entry is a fallback, not a permanent fixture. If this run's
      // scraper produced a grant with the exact same title, the scraped
      // version is fresher (live status/dueDate) and wins — the manual
      // entry is superseded and dropped for this run. If the scraper
      // didn't produce that title (site down, Cloudflare block, page
      // structure changed, or it's an HCR/other title that was never
      // scraped in the first place), the manual entry survives untouched.
      // This is what lets Parks run live without deleting the old manual
      // rows by hand: overlap resolves itself automatically, every run.
      const scrapedTitles = new Set(scraped.map(g => g.title.toLowerCase().trim()));
      manualGrants = allManual.filter(g => !scrapedTitles.has(g.title.toLowerCase().trim()));
      const superseded = allManual.filter(g => scrapedTitles.has(g.title.toLowerCase().trim()));

      console.log('Preserving ' + manualGrants.length + ' manual entries (no matching scraped title this run)');
      if (superseded.length) {
        console.log('Superseded ' + superseded.length + ' manual entries with fresher scraped data:');
        superseded.forEach(g => console.log('  - ' + g.title));
      }
    } catch(e) { console.log('Could not read existing file:', e.message); }
  }

  const allGrants = [...scraped, ...manualGrants];
  const output = {
    grants: allGrants, fetched: new Date().toISOString(), count: allGrants.length,
    sources: { efc: efcChecked.length, parks: parksChecked.length, dec: dec.length, manual: manualGrants.length },
    // Plain metadata field, not part of "grants" — purely so it's obvious when
    // scanning the raw file in GitHub where hand-maintained entries start.
    // Lives outside the array on purpose: nothing reads or renders this key,
    // so it needs zero filtering in index.html and can't ever show up on the
    // dashboard by accident.
    _manualEntriesNote: manualGrants.length
      ? `Grants ${allGrants.length - manualGrants.length + 1}-${allGrants.length} in the array above (marked "manual": true) are hand-maintained entries (HCR always; Parks only when this run's scraper didn't return a matching title) — preserved as a fallback, superseded automatically whenever the scraper produces the same title fresh.`
      : 'No manual entries currently present.',
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Saved to agency-grants.json');
})();
