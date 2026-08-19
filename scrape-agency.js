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

      // Open language that can override a known-closed default
      const isExplicitlyOpen =
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

// ── NYS PARKS ────────────────────────────────────────────────
// parks.ny.gov/grants is a single aggregator page that publishes real,
// structured data for every program:
//   1. An "Open Grant Opportunities" table with actual Opens/Deadline dates
//   2. A per-program "Opportunity Status: Open/Closed" label under each
//      program's listing in the "State Funded" and "Federally Funded" sections
// We read both directly from that page instead of guessing at a hardcoded
// list — no dates or open/closed flags are ever typed in by hand here, and
// nothing needs to be remembered or revised as programs open/close each year.
// If a program's status genuinely can't be determined, we leave it blank
// (status: 'Unknown') rather than assume Open or Closed — the dashboard's
// front-end fallback should never promote a blank into "Rolling."
async function scrapeParks(browserPage) {
  console.log('Scraping NYS Parks...');
  try {
    await browserPage.goto('https://parks.ny.gov/grants', { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    const result = await browserPage.evaluate(() => {
      const main = document.querySelector('main, #main, #main-content, [role="main"], article') || document.body;

      // Bot-block / wrong-page diagnostics — if these come back empty or
      // suspicious (e.g. a challenge/interstitial title), the page Puppeteer
      // received isn't the real one, regardless of what our parsing logic does.
      const pageDebug = {
        title: document.title,
        url: window.location.href,
        bodyTextLength: (document.body.innerText || '').length,
        bodyTextPreview: (document.body.innerText || '').slice(0, 300),
        totalLinksInDoc: document.querySelectorAll('a').length,
        totalTablesInDoc: document.querySelectorAll('table').length,
      };

      // ── 1. Parse the "Open Grant Opportunities" table for real dates ──
      const tableRows = [];
      const table = Array.from(main.querySelectorAll('table')).find(t => {
        const headerText = (t.querySelector('tr')?.innerText || '').toLowerCase();
        return headerText.includes('deadline') || headerText.includes('opens');
      });
      if (table) {
        const rows = Array.from(table.querySelectorAll('tr')).slice(1); // skip header row
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
          if (cells.length < 3) continue;
          tableRows.push({
            title: cells[0].replace(/\s+/g, ' ').trim(),
            opens: cells[1] || '',
            deadline: cells[2] || '',
          });
        }
      }

      // ── 2. Find every link to an individual grant page, then read its
      //      surrounding block for "Opportunity Status" and description.
      //      Going link-first (rather than assuming title/status/description
      //      sit in separate sibling elements) is more resilient to whatever
      //      block structure Drupal actually renders.
      const seenHref = new Map();
      const grantLinks = Array.from(main.querySelectorAll('a[href*="/grants/"]'));

      for (const link of grantLinks) {
        const title = (link.innerText || '').trim().replace(/\s+/g, ' ');
        if (title.length < 5) continue;

        // Climb to the nearest block-level container so we can read the
        // full surrounding text (status + description usually live right
        // alongside the title inside the same block).
        let container = link.closest('p, div, li') || link.parentElement;
        let text = (container?.innerText || '').trim();

        // If that block is basically just the link text itself, the status/
        // description text likely lives in the very next block instead.
        if (text.length <= title.length + 5 && container?.nextElementSibling) {
          text += ' ' + (container.nextElementSibling.innerText || '').trim();
        }

        const statusMatch = text.match(/Opportunity Status:\s*([A-Za-z ]+?)(?:\n|\.|$)/i);
        const status = statusMatch ? statusMatch[1].trim() : '';
        const description = text
          .replace(title, '')
          .replace(/Opportunity Status:\s*[A-Za-z ]+/i, '')
          .trim();

        // The same link often appears twice (once in the sidebar nav, once
        // in the actual program listing) — keep whichever copy actually has
        // a status/description, since the nav copy won't.
        const existing = seenHref.get(link.href);
        if (!existing || (!existing.status && status)) {
          seenHref.set(link.href, { title, link: link.href, status, description });
        }
      }

      const programs = Array.from(seenHref.values());

      return {
        tableRows,
        programs,
        debug: {
          page: pageDebug,
          tableFound: !!table,
          tableRowCount: tableRows.length,
          totalGrantLinksFound: grantLinks.length,
          uniqueProgramsAfterDedup: programs.length,
          sample: programs.slice(0, 3).map(p => ({ title: p.title, status: p.status, descPreview: p.description.slice(0, 80) })),
        },
      };
    });

    console.log('  Parks debug: ' + JSON.stringify(result.debug, null, 2));

    // Normalize table titles for fuzzy matching against program titles
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const grants = result.programs
      .filter(p => p.title && p.link && p.link.includes('parks.ny.gov'))
      .filter(p => !/^(grants?|get involved)$/i.test(p.title))
      .map(p => {
        const tableMatch = result.tableRows.find(t => {
          const nt = norm(t.title), np = norm(p.title);
          return nt.includes(np) || np.includes(nt);
        });

        const statusRaw = (p.status || '').toLowerCase();
        let status = 'Unknown';
        if (statusRaw.includes('closed')) status = 'Closed';
        else if (statusRaw.includes('open')) status = 'Available';
        // "By Prior Approval" and anything else stays Unknown — there's no
        // real application window to communicate, and we'd rather show
        // nothing than assert Open/Closed incorrectly.

        let dueDate = '';
        if (tableMatch && tableMatch.deadline && !/rolling|ongoing|as funding/i.test(tableMatch.deadline)) {
          dueDate = tableMatch.deadline.trim();
        }
        // A table entry is authoritative that the program is currently open,
        // even if the per-program status label hasn't been updated yet.
        if (tableMatch) status = 'Available';

        return {
          id: 'parks-' + p.title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40),
          title: p.title,
          agency: 'NYS Office of Parks, Recreation & Historic Preservation',
          status,
          dueDate,
          description: p.description ? p.description.slice(0, 300) : '',
          link: p.link,
          source: 'NYS Parks',
        };
      });

    console.log('  Parks: ' + grants.length + ' programs found');
    grants.forEach(g => console.log('    [' + g.status + '] ' + g.title + (g.dueDate ? ' · due ' + g.dueDate : '')));
    return grants;
  } catch (e) {
    console.log('  Parks error: ' + e.message);
    return [];
  }
}

// ── HCR ──────────────────────────────────────────────────────
// Scrapes municipal-facing HCR programs only (not individual grant-partners page)
async function scrapeHCR() {
  console.log('Scraping HCR...');
  // These are the known active municipal/nonprofit programs from HCR
  // The grant-partners page is for individuals only and is not appropriate here
  const known = [
    {
      title: 'Community Development Block Grant (CDBG)',
      link: 'https://hcr.ny.gov/community-development-block-grant',
      description: 'Federal funding for cities, towns, villages and counties to assist low- and moderate-income communities.',
    },
    {
      title: 'NYS HOME Program',
      link: 'https://hcr.ny.gov/nys-home-program',
      description: 'Funding for affordable housing development, down payment assistance, and rehabilitation for municipalities and nonprofits.',
    },
    {
      title: 'Pro-Housing Community Program',
      link: 'https://hcr.ny.gov/pro-housing-community-program',
      description: 'Certified localities gain exclusive access to up to $750 million in discretionary State funding.',
    },
    {
      title: 'Vacant Rental Program (VRP)',
      link: 'https://hcr.ny.gov/vrp',
      description: 'Grants to rehabilitate vacant and unusable housing units into quality affordable rental units.',
    },
  ];

  return known.map(k => ({
    id: 'hcr-' + k.title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
    title: k.title,
    agency: 'NYS Homes & Community Renewal',
    status: 'Available',
    dueDate: '',
    description: k.description,
    link: k.link,
    source: 'HCR',
  }));
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
      const dueDate = (hasDate && deadlineLower !== 'continuous') ? deadlineRaw : '';

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

  // Run static scrapers (EFC, HCR, DEC use https.get; Parks and DASNY need a real browser)
  const [efc, hcr, dec] = await Promise.all([scrapeEFC(), scrapeHCR(), scrapeDEC()]);
  const parks = await scrapeParks(page);
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
  const parksDeduped = dedupe(parks);
  const hcrDeduped = dedupe(hcr);
  const decDeduped = dedupe(dec);
  // Add dasny/parks titles to seen so NY PLAYS/BRICKS/SWIMS don't duplicate DASNY's
  dasny.forEach(g => seenTitles.add(g.title.toLowerCase().trim()));

  // Check status of EFC and HCR grants using Puppeteer (JS-rendered pages).
  // Parks is no longer included here — scrapeParks() now reads its own
  // authoritative status/deadline data directly off parks.ny.gov/grants.
  // EFC grants with dedicated pages (like WIIA) have their deadlines there, not on /apply.
  // Skip the generic /apply page itself since it won't have per-grant deadline info.
  const efcNeedsCheck = efcDeduped.filter(g => g.link && g.link.startsWith('http') && g.link !== 'https://efc.ny.gov/apply');
  const needsCheck = [...efcNeedsCheck, ...hcrDeduped].filter(g => g.link && g.link.startsWith('http'));
  console.log('\nChecking status of ' + needsCheck.length + ' EFC/HCR grants...');
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
  const hcrChecked = hcrDeduped.map(g => {
    const checked = statusMap[g.id] || {};
    const raw = g.status === 'Closed' && checked.status !== 'Open'
      ? 'Closed' : checked.status || g.status;
    return { ...g, status: raw === 'Open' ? 'Available' : raw, dueDate: checked.dueDate || g.dueDate };
  });

  await browser.close();

  const scraped = [...efcChecked, ...parksDeduped, ...hcrChecked, ...dasny, ...decDeduped];
  console.log('\nTotal agency grants: ' + scraped.length);
  scraped.forEach(g => console.log(' [' + g.source + '] ' + g.title + (g.dueDate ? ' · ' + g.dueDate : '')));

  const outputPath = path.join(process.cwd(), 'agency-grants.json');
  let manualGrants = [];
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      manualGrants = (existing.grants || []).filter(g => g.manual === true);
      console.log('Preserving ' + manualGrants.length + ' manual entries');
    } catch(e) { console.log('Could not read existing file:', e.message); }
  }

  const allGrants = [...scraped, ...manualGrants];
  const output = {
    grants: allGrants, fetched: new Date().toISOString(), count: allGrants.length,
    sources: { efc: efcChecked.length, parks: parks.length, hcr: hcr.length, dasny: dasny.length, dec: dec.length },
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Saved to agency-grants.json');
})();
