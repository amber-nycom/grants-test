// Sends the scrapers' JSON output to the Google Sheet (via the Apps Script web app).
// Reads agency-grants.json and nys-grants.json as they currently exist in the repo.
// Env: SHEET_URL, SHEET_SECRET (GitHub secrets), DRY_RUN=true to report without writing.
const fs = require('fs');
const { SHEET_URL, SHEET_SECRET, DRY_RUN } = process.env;
if (!SHEET_URL || !SHEET_SECRET) { console.error('Missing SHEET_URL or SHEET_SECRET'); process.exit(1); }

const read = f => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { grants: [] };
const grants = [...read('agency-grants.json').grants, ...read('nys-grants.json').grants];

(async () => {
  console.log(`Sending ${grants.length} grants (dryRun=${DRY_RUN === 'true'})`);
  // text/plain avoids a CORS preflight; Apps Script answers a POST with a redirect, which fetch follows.
  const res = await fetch(SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: SHEET_SECRET, dryRun: DRY_RUN === 'true', runDate: new Date().toISOString().slice(0, 10), grants }),
    redirect: 'follow',
  });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch (e) { console.error(`HTTP ${res.status}, not JSON:`, text.slice(0, 300)); process.exit(1); }
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) process.exit(1);
})();
