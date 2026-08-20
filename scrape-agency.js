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

    console.log('  [' + url.split('/').pop() + '] status=' + result.status + (result.dueDate ? ' due=' + result.dueDate : ''));
    return result;
  } catch(e) {
    return { status: 'Available', dueDate: '' };
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

function isPast(dateStr) {
  if (!dateStr) return false;
  const s = dateStr.toLowerCase();
  if (s.includes('rolling') || s.includes('ongoing')) return false;
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
      const dueDate = cells[2] ? stripHtml(cells[2]) : '';

      if (isJunk(title) || seen.has(title)) continue;
      seen.add(title);
      if (desc.toLowerCase().includes('low-cost financing') || desc.toLowerCase().includes('revolving fund')) continue;
      if (isPast(dueDate)) { console.log('  EFC SKIP past: ' + title); continue; }
      if (dueDate.toLowerCase().includes('currently closed') ||
          dueDate.toLowerCase().includes('application period is currently closed')) {
        console.log('  EFC SKIP closed: ' + title); continue;
      }
      // Skip programs for individuals/homeowners, not direct municipal grants
      const titleLower = title.toLowerCase();
      if (titleLower.includes('septic') || titleLower.includes('vessel') && desc.toLowerCase().includes('marina')) {
        // Keep vessel (marinas are eligible) but skip septic (individual homeowners)
        if (titleLower.includes('septic')) { console.log('  EFC SKIP individual: ' + title); continue; }
      }

      const dueLower = dueDate.toLowerCase();
      const efcStatus = (dueLower.includes('closed') || dueLower.includes('not available') || dueLower.includes('not accepting')) ? 'Closed' : 'Available';
      // Only keep dueDate if it contains an actual date value
      const hasDate = /\d{1,2}[\/.\-]\d{1,2}|(january|february|march|april|may|june|july|august|september|october|november|december)/i.test(dueDate);
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

// ── DASNY ─────────────────────────────────────────────────────
async function scrapeDASNY(page) {
  console.log('Scraping DASNY...');
  try {
    await page.goto('https://www.dasny.org/about/what-we-do/grants-administration', {
      waitUntil: 'networkidle0', timeout: 30000
    });
    await new Promise(r => setTimeout(r, 3000));

    // Log raw headings for debugging
    const debug = await page.evaluate(() => {
      const hs = Array.from(document.querySelectorAll('h2, h3'));
      return hs.map(h => h.innerText.trim()).filter(t => t.length > 2);
    });
    console.log('  DASNY headings found: ' + JSON.stringify(debug));

    const grants = await page.evaluate((NAV_JUNK) => {
      function isJunk(title) {
        if (!title || title.length < 5) return true;
        const t = title.toLowerCase().trim();
        return NAV_JUNK.some(j => t === j || t.startsWith(j));
      }

      const results = [];
      const seen = new Set();
      const main = document.querySelector('main, .main-content, #main-content, [role="main"], article') || document.body;
      const headings = Array.from(main.querySelectorAll('h3'));

      for (const h of headings) {
        const title = (h.innerText || '').trim();
        if (isJunk(title) || seen.has(title)) continue;
        seen.add(title);

        let dueDate = '';
        let link = 'https://www.dasny.org/about/what-we-do/grants-administration';
        let el = h.nextElementSibling;

        for (let i = 0; i < 8 && el; i++) {
          const text = el.innerText || '';
          const dateMatch = text.match(/([A-Z][a-z]+ \d{1,2},? \d{4})/);
          if (dateMatch && !dueDate) dueDate = dateMatch[1];

          const anchors = Array.from(el.querySelectorAll('a[href]'));
          for (const a of anchors) {
            if (a.href && a.href.startsWith('http') &&
                !a.href.includes('javascript') &&
                !a.href.includes('/about/what-we-do') &&
                !a.href.includes('/opportunities') &&
                !a.href.includes('/news') &&
                !a.href.includes('grantsmanagement.ny.gov/register') &&
                link.includes('/grants-administration')) {
              link = a.href;
            }
          }
          el = el.nextElementSibling;
        }
        results.push({ title, dueDate, link });
      }
      return results;
    }, NAV_JUNK);

    const now = new Date();
    const formatted = grants
      .filter(g => !isJunk(g.title))
      .filter(g => {
        if (!g.dueDate) return true;
        const d = new Date(g.dueDate);
        if (isNaN(d.getTime())) return true;
        if (d < now) { console.log('  DASNY SKIP past: ' + g.title + ' (' + g.dueDate + ')'); return false; }
        return true;
      })
      .map(g => ({
        id: 'dasny-' + g.title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
        title: g.title, agency: 'DASNY',
        status: 'Available', dueDate: g.dueDate,
        link: g.link, source: 'DASNY',
      }));

    console.log('  DASNY: ' + formatted.length + ' grants');
    return formatted;
  } catch (e) {
    console.log('  DASNY error: ' + e.message);
    return [];
  }
}

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
      const deadlineRaw = stripHtml(cells[2]).trim();
      const deadlineLower = deadlineRaw.toLowerCase();

      // Determine status from deadline column
      let status = 'Available';
      if (deadlineLower === 'closed' || deadlineLower.includes('closed')) {
        status = 'Closed';
      } else if (deadlineLower === 'continuous' || deadlineLower === 'rolling') {
        status = 'Available';
      } else if (isPast(deadlineRaw)) {
        status = 'Closed';
      }

      const hasDate = /\d{1,2}[\/.\-]\d{1,2}|(january|february|march|april|may|june|july|august|september|october|november|december)/i.test(deadlineRaw);
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

  // NYS Parks and HCR are NOT scraped. Both sites sit behind Cloudflare's
  // bot challenge on GitHub Actions runners, so any automated attempt either
  // gets nothing or silently returns a generic "Available" for everything —
  // exactly the kind of confidently-wrong data we don't want to show
  // municipal officials. Parks and HCR grants are maintained entirely by
  // hand as manual: true entries in agency-grants.json (see below) — the
  // same mechanism already used for one-off manual additions.
  const [efc, dec] = await Promise.all([scrapeEFC(), scrapeDEC()]);
  const dasny = await scrapeDASNY(page);

  // Deduplicate across all sources by title
  const seenTitles = new Set();
  const dedupe = (arr) => arr.filter(g => {
    const key = g.title.toLowerCase().trim();
    if (seenTitles.has(key)) { console.log('DEDUP: ' + g.title); return false; }
    seenTitles.add(key);
    return true;
  });
  const efcDeduped = dedupe(efc);
  const decDeduped = dedupe(dec);
  // Add dasny titles to seen so NY PLAYS/BRICKS/SWIMS don't duplicate DASNY's
  dasny.forEach(g => seenTitles.add(g.title.toLowerCase().trim()));

  // Check status of EFC grants using Puppeteer (JS-rendered pages).
  // EFC grants with dedicated pages (like WIIA) have their deadlines there, not on /apply.
  // Skip the generic /apply page itself since it won't have per-grant deadline info.
  const efcNeedsCheck = efcDeduped.filter(g => g.link && g.link.startsWith('http') && g.link !== 'https://efc.ny.gov/apply');
  console.log('\nChecking status of ' + efcNeedsCheck.length + ' EFC grants...');
  const statusMap = {};
  for (const g of efcNeedsCheck) {
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

  await browser.close();

  const scraped = [...efcChecked, ...dasny, ...decDeduped];
  console.log('\nTotal agency grants: ' + scraped.length);
  scraped.forEach(g => console.log(' [' + g.source + '] ' + g.title + (g.dueDate ? ' · ' + g.dueDate : '')));

  const outputPath = path.join(process.cwd(), 'agency-grants.json');
  let manualGrants = [];
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      manualGrants = (existing.grants || []).filter(g => g.manual === true);
      console.log('Preserving ' + manualGrants.length + ' manual entries (includes NYS Parks & HCR)');
    } catch(e) { console.log('Could not read existing file:', e.message); }
  }

  const allGrants = [...scraped, ...manualGrants];
  const output = {
    grants: allGrants, fetched: new Date().toISOString(), count: allGrants.length,
    sources: { efc: efcChecked.length, dasny: dasny.length, dec: dec.length, manual: manualGrants.length },
    // Plain metadata field, not part of "grants" — purely so it's obvious when
    // scanning the raw file in GitHub where hand-maintained entries start.
    // Lives outside the array on purpose: nothing reads or renders this key,
    // so it needs zero filtering in index.html and can't ever show up on the
    // dashboard by accident.
    _manualEntriesNote: manualGrants.length
      ? `Grants ${allGrants.length - manualGrants.length + 1}-${allGrants.length} in the array above (marked "manual": true) are NYS Parks & HCR entries, hand-maintained and preserved across every scraper run — not scraped.`
      : 'No manual entries currently present.',
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Saved to agency-grants.json');
})();
