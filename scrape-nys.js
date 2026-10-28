const fs = require('fs');
const path = require('path');

const NYS_URL = 'https://esupplier.sfs.ny.gov/psc/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL?PortalActualURL=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2fSUPPLIER%2fERP%2fc%2fNY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL&PortalContentURL=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2fSUPPLIER%2fERP%2fc%2fNY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL&PortalContentProvider=ERP&PortalCRefLabel=Search%20for%20Grant%20Opportunities&PortalRegistryName=SUPPLIER&PortalServletURI=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsp%2ffscm%2f&PortalURI=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2f&PortalHostNode=ERP&NoCrumbs=yes&PortalKeyStruct=yes';

const SFS_FALLBACK = 'https://esupplier.sfs.ny.gov/psp/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL';

// ── DETAIL-PAGE FIELDS ───────────────────────────────────────
// Runs inside the browser on an SFS "Full Announcement Details" page. Each field is found by its
// exact label text, so a layout change leaves a field blank instead of filling it with the wrong value.
// Kept free of outside variables because Puppeteer serializes it into the page.
function readDetailFields() {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const squash = s => (s || '').replace(/\s+/g, ' ').trim();
  const LABELS = {
    award:        t => t === 'totalfundingavailable',
    awardDate:    t => t === 'anticipatedawarddate',
    questionsDue: t => t === 'questionsduedate',
    loi:          t => t === 'letterofintentdue',
    conference:   t => t.startsWith('bidder') && t.includes('conference'),
  };
  const isAnyLabel = text => { const t = norm(text); return t && Object.values(LABELS).some(f => f(t)); };
  const els = Array.from(document.querySelectorAll('td, th, label, span, div, b, strong, p'));
  const out = {};
  for (const [key, test] of Object.entries(LABELS)) {
    out[key] = '';
    // Elements whose whole text is the label; take the innermost one.
    const hits = els.filter(el => test(norm(el.innerText)));
    const label = hits.find(el => !hits.some(o => o !== el && el.contains(o)));
    if (!label) continue;
    let value = '';
    const cell = label.closest('td, th') || label;
    for (let s = cell.nextElementSibling; s && !value; s = s.nextElementSibling) value = squash(s.innerText);
    if (!value && cell !== label) {
      for (let s = label.nextElementSibling; s && !value; s = s.nextElementSibling) value = squash(s.innerText);
    }
    if (value && !isAnyLabel(value)) out[key] = value;
  }
  return out;
}

const MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };
// "Thursday, January 14, 2027" -> "01/14/2027". Anything that isn't a clear date is returned as written.
function cleanDate(v) {
  v = (v || '').trim();
  const m = v.match(/(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return String(MONTHS[m[1].toLowerCase()]).padStart(2, '0') + '/' + m[2].padStart(2, '0') + '/' + m[3];
  const n = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (n) return n[1].padStart(2, '0') + '/' + n[2].padStart(2, '0') + '/' + n[3];
  return v;
}
// "$8,000,000.000" -> "$8,000,000"
function cleanMoney(v) {
  v = (v || '').trim();
  const num = parseFloat(v.replace(/[$,\s]/g, ''));
  if (!v || !isFinite(num) || !/^\$?[\d,]+(\.\d+)?$/.test(v)) return v;
  const cents = Math.round(num * 100) % 100 !== 0;
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
}
const isEmptyish = v => !v || /^(n\/?a|none|null|-+)$/i.test(v.trim());
function cleanDetail(raw) {
  raw = raw || {};
  const pick = k => (isEmptyish(raw[k]) ? '' : raw[k].trim());
  return {
    award: cleanMoney(pick('award')),
    awardDate: cleanDate(pick('awardDate')),
    questionsDue: cleanDate(pick('questionsDue')),
    conference: pick('conference').slice(0, 500),
    loi: cleanDate(pick('loi')),
  };
}

async function loadSearchResults(page) {
  try {
    await page.goto(NYS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
  } catch (e) {
    console.log('Nav note:', e.message);
  }
  await new Promise(r => setTimeout(r, 5000));

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('input[type=submit], button, a'));
    const btn = btns.find(b => (b.value || b.innerText || '').trim().toLowerCase() === 'search');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 7000));
}

async function main() {
  const puppeteer = require('puppeteer');
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('Loading search results...');
  await loadSearchResults(page);

  // First pass: collect all grants and their row indices from the table
  const rawGrants = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const colEventId = 0, colAgency = 1, colTitle = 2, colStatus = 3, colEligibility = 4, colDueDate = 7;

    for (const row of document.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 4) continue;

      const texts = cells.map(c => c.innerText.trim().replace(/\s+/g, ' ').split('\n')[0]);
      if (texts[0].toLowerCase().includes('event id') || texts[2]?.toLowerCase().includes('grant opportunity')) continue;

      const id = texts[colEventId];
      const agency = texts[colAgency];
      const title = texts[colTitle];
      const status = texts[colStatus];
      const eligibility = texts[colEligibility] || '';
      const dueDate = texts[colDueDate] || texts[6] || '';

      if (!id || id.length > 25 || !/^[A-Z]/.test(id)) continue;
      if (!title || title.length < 4 || title.length > 150) continue;
      if (seen.has(title)) continue;
      seen.add(title);

      const eligLower = eligibility.toLowerCase();
      if (eligLower && !eligLower.includes('governmental') && !eligLower.includes('government')) continue;

      // Extract the row index from the onclick e.g. 'AUC_NAME_LNK$0' -> 0
      const anchor = cells[colTitle]?.querySelector('a');
      const onclick = anchor ? (anchor.getAttribute('href') || '') : '';
      const rowMatch = onclick.match(/AUC_NAME_LNK\$(\d+)/);
      const rowIndex = rowMatch ? parseInt(rowMatch[1]) : null;

      results.push({ id, agency, title, status, eligibility, dueDate, rowIndex });
    }
    return results;
  });

  console.log('Found ' + rawGrants.length + ' grants — clicking into each detail page...');

  const grants = [];

  for (const g of rawGrants) {
    let announcementLink = SFS_FALLBACK;

    if (g.rowIndex !== null) {
      console.log('Clicking row ' + g.rowIndex + ' for [' + g.id + ']...');
      try {
        // Click the link using PeopleSoft's own function with the row index
        await page.evaluate((idx) => {
          const links = Array.from(document.querySelectorAll('a'));
          const link = links.find(a => (a.getAttribute('href') || '').includes('AUC_NAME_LNK$' + idx));
          if (link) link.click();
        }, g.rowIndex);

        await new Promise(r => setTimeout(r, 4000));

        // Extract the Announcement Link and Service Area from the detail page
        const found = await page.evaluate(() => {
          const result = { link: null, serviceArea: null };
          const allEls = Array.from(document.querySelectorAll('td, th, label, span, div'));

          // Grab Service Area(s)
          for (const el of allEls) {
            const text = (el.innerText || '').trim().toLowerCase();
            if (text.includes('service area')) {
              const parent = el.closest('tr') || el.parentElement;
              if (parent) {
                const next = parent.nextElementSibling;
                const candidates = [parent, next].filter(Boolean);
                for (const c of candidates) {
                  const cells = Array.from(c.querySelectorAll('td, span, div'));
                  for (const cell of cells) {
                    const val = (cell.innerText || '').trim();
                    if (val && val.length > 3 && !val.toLowerCase().includes('service area')) {
                      result.serviceArea = val;
                      break;
                    }
                  }
                  if (result.serviceArea) break;
                }
              }
            }
          }

          // Strategy 1: find Announcement Link
          for (const el of allEls) {
            const text = (el.innerText || '').trim().toLowerCase();
            if (text === 'announcement link' || text.includes('announcement link')) {
              const parent = el.closest('tr') || el.parentElement;
              if (parent) {
                const candidates = [parent, parent.nextElementSibling].filter(Boolean);
                for (const c of candidates) {
                  const links = Array.from(c.querySelectorAll('a[href]'));
                  const httpLink = links.find(a => a.href && a.href.startsWith('http') && !a.href.includes('javascript'));
                  if (httpLink) { result.link = httpLink.href.replace(/^https?:\/\/https?:\/+/, 'https://'); break; }
                }
              }
            }
          }
          // Strategy 2: any http link that is not SFS
          if (!result.link) {
            const allLinks = Array.from(document.querySelectorAll('a[href]'));
            const ext = allLinks.find(a =>
              a.href && a.href.startsWith('http') && !a.href.startsWith('mailto') &&
              !a.href.includes('esupplier.sfs.ny.gov') && !a.href.includes('javascript')
            );
            if (ext) result.link = ext.href.replace(/^https?:\/\/https?:\/+/, 'https://');
          }

          return result;
        });

        if (found.link) {
          announcementLink = found.link;
          console.log('  -> ' + announcementLink);
        } else {
          console.log('  -> No external link found, keeping SFS fallback');
        }
        if (found.serviceArea) {
          g.serviceArea = found.serviceArea;
          console.log('  -> Service Area: ' + found.serviceArea);
        }

        // Extra detail fields (funding, award date, questions due, bidder's conference, letter of intent).
        // Separate try so a problem here can never lose the link or service area above.
        try {
          const details = cleanDetail(await page.evaluate(readDetailFields));
          Object.assign(g, details);
          const got = Object.entries(details).filter(([, v]) => v).map(([k]) => k);
          console.log('  -> Details: ' + (got.length ? got.join(', ') : 'none found'));
        } catch (e) {
          console.log('  -> Detail fields skipped: ' + e.message);
        }

        // Go back to search results for next iteration
        console.log('  Returning to search results...');
        await loadSearchResults(page);

      } catch (e) {
        console.log('  -> Error for [' + g.id + ']: ' + e.message);
        // Try to recover by reloading search results
        try { await loadSearchResults(page); } catch(_) {}
      }
    } else {
      console.log('[' + g.id + '] No row index found, skipping detail fetch');
    }

    grants.push({
      id: g.id,
      agency: g.agency,
      title: g.title,
      status: g.status,
      eligibility: g.eligibility,
      dueDate: g.dueDate,
      link: announcementLink,
      serviceArea: g.serviceArea || null,
      award: g.award || '',
      awardDate: g.awardDate || '',
      questionsDue: g.questionsDue || '',
      conference: g.conference || '',
      loi: g.loi || '',
      source: 'NYS',
    });
  }

  await browser.close();

  console.log('\nDone. ' + grants.length + ' grants processed.');
  grants.forEach(g => console.log(' - [' + g.id + '] ' + g.link));

  let manualGrants = [];
  const outputPath = path.join(process.cwd(), 'nys-grants.json');
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      manualGrants = (existing.grants || []).filter(g => g.manual === true);
      console.log('Preserving ' + manualGrants.length + ' manual entries');
    } catch(e) {
      console.log('Could not read existing file:', e.message);
    }
  }

  const allGrants = [...grants, ...manualGrants];
  const output = { grants: allGrants, fetched: new Date().toISOString(), count: allGrants.length };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Saved.');
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { readDetailFields, cleanDetail, cleanDate, cleanMoney };
