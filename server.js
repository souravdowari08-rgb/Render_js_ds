const express = require('express');
const bodyParser = require('body-parser');
const cheerio = require('cheerio');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteerExtra.use(StealthPlugin());

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const PROXY = process.env.PROXY_URL || null;

const LAUNCH_OPTS = {
  headless: "new",
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
    '--disable-features=site-per-process',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--disable-extensions',
    '--disable-web-security',
    '--blink-settings=imagesEnabled=false'
  ],
  defaultViewport: { width: 1280, height: 720 }
};

if (PROXY) {
  // For example: PROXY_URL="http://user:pass@host:port"
  LAUNCH_OPTS.args.push(`--proxy-server=${PROXY}`);
  console.log('Using proxy:', PROXY);
}

function extractRedirectFromHTML(html) {
  // similar heuristics: check scripts for patterns, id="c", anchors
  const re1 = /c\.setAttribute\("href","([^"]+)"\)/;
  const re2 = /window\.location(?:\.href)?\s*=\s*"([^"]+)"/;
  const re3 = /location\.assign\(["']([^"']+)["']\)/;
  let m;
  if ((m = re1.exec(html))) return m[1];
  if ((m = re2.exec(html))) return m[1];
  if ((m = re3.exec(html))) return m[1];

  const $ = cheerio.load(html);
  const cEl = $('#c');
  if (cEl && cEl.attr && cEl.attr('href')) return cEl.attr('href');

  const anchors = $('a[href]').toArray();
  for (const a of anchors) {
    const h = $(a).attr('href');
    if (!h) continue;
    if (h.includes('driveseed.org') || h.includes('/zfile/') || h.includes('/wfile/') || h.includes('/file/')) return h;
  }
  if (anchors.length) return $(anchors[0]).attr('href');
  return null;
}

async function fetchRedirectWithBrowser(url, browser) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      // more stealthy flags
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    // try to submit landing form if exists
    try {
      await page.evaluate(() => {
        const f = document.getElementById('landing');
        if (f && typeof f.submit === 'function') f.submit();
      });
    } catch (e) {}

    await page.waitForTimeout(3000);

    // try to extract via JS
    const candidate = await page.evaluate(() => {
      for (const s of Array.from(document.scripts)) {
        const t = s.textContent || '';
        let m;
        m = /c\.setAttribute\("href","([^"]+)"\)/.exec(t);
        if (m) return m[1];
        m = /window\.location(?:\.href)?\s*=\s*"([^"]+)"/.exec(t);
        if (m) return m[1];
        m = /location\.assign\(["']([^"']+)["']\)/.exec(t);
        if (m) return m[1];
      }
      const cEl = document.getElementById('c');
      if (cEl && cEl.getAttribute('href')) return cEl.getAttribute('href');
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const h = a.getAttribute('href');
        if (!h) continue;
        if (h.includes('driveseed.org') || h.includes('/zfile/') || h.includes('/wfile/') || h.includes('/file/')) return h;
      }
      return null;
    });

    if (!candidate) {
      // dump html for debugging then throw
      const html = await page.content();
      return { candidate: null, html };
    }

    // resolve candidate url
    const redirectUrl = new URL(candidate, page.url()).toString();
    // follow redirect
    await page.goto(redirectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const finalUrl = page.url();
    const html = await page.content();
    return { candidate: redirectUrl, finalUrl, html };
  } catch (err) {
    try {
      const html = await page.content();
      return { candidate: null, html, error: String(err) };
    } catch (e) {
      return { candidate: null, html: null, error: String(err) };
    }
  } finally {
    try { await page.close(); } catch (e) {}
  }
}

app.get('/', (req, res) => res.send('OK'));

app.get('/getlink', async (req, res) => {
  const startUrl = req.query.url;
  if (!startUrl) return res.status(400).json({ error: 'Missing ?url parameter' });

  let browser;
  try {
    browser = await puppeteerExtra.launch(LAUNCH_OPTS);
    const { candidate, finalUrl, html, error } = await fetchRedirectWithBrowser(startUrl, browser);

    if (!candidate) {
      // return debug info
      return res.status(504).json({ error: 'Redirect link not found', debug_html: html ? html.substring(0, 8000) : null, debug_error: error || null });
    }

    const usedFinal = finalUrl || candidate;
    const fileId = usedFinal.split('/').filter(Boolean).pop();

    const variants = {
      zfile: `https://driveseed.org/zfile/${fileId}`,
      wfile_type1: `https://driveseed.org/wfile/${fileId}?type=1`,
      wfile_type2: `https://driveseed.org/wfile/${fileId}?type=2`
    };

    const results = {};
    for (const [k, v] of Object.entries(variants)) {
      try {
        const p = await browser.newPage();
        await p.goto(v, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await p.waitForTimeout(1500);
        const el = await p.$('a[href]');
        if (el) {
          const href = await (await el.getProperty('href')).jsonValue();
          results[k] = href;
        } else {
          const h = await p.content();
          const maybe = extractRedirectFromHTML(h);
          results[k] = maybe || null;
        }
        try { await p.close(); } catch (e) {}
      } catch (e) {
        results[k] = null;
      }
    }

    await browser.close();
    return res.json({ final_url: usedFinal, file_id: fileId, download_links: results });
  } catch (err) {
    try { if (browser) await browser.close(); } catch (e) {}
    return res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
