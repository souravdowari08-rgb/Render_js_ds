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

// Puppeteer launch configuration (Render-compatible)
const LAUNCH_OPTS = {
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-infobars',
    '--disable-extensions',
    '--single-process',
    '--no-zygote',
    '--disable-web-security',
    '--disable-features=site-per-process',
    '--blink-settings=imagesEnabled=false',
    '--disable-blink-features=AutomationControlled'
  ],
  defaultViewport: { width: 1280, height: 720 }
};

// Optional proxy
if (PROXY) {
  LAUNCH_OPTS.args.push(`--proxy-server=${PROXY}`);
  console.log("Using proxy:", PROXY);
}

/* ------------------------------------------------------------------
   Helper: extract redirect link from raw HTML (backup method)
-------------------------------------------------------------------*/
function extractRedirectFromHTML(html) {
  const re1 = /c\.setAttribute\("href","([^"]+)"\)/;
  const re2 = /window\.location(?:\.href)?\s*=\s*"([^"]+)"/;
  const re3 = /location\.assign\(["']([^"']+)["']\)/;

  let m;
  if ((m = re1.exec(html))) return m[1];
  if ((m = re2.exec(html))) return m[1];
  if ((m = re3.exec(html))) return m[1];

  const $ = cheerio.load(html);
  const cEl = $("#c");
  if (cEl && cEl.attr("href")) return cEl.attr("href");

  const anchors = $("a[href]").toArray();
  for (const a of anchors) {
    const h = $(a).attr("href");
    if (!h) continue;
    if (
      h.includes("driveseed.org") ||
      h.includes("/zfile/") ||
      h.includes("/wfile/") ||
      h.includes("/file/")
    ) {
      return h;
    }
  }

  if (anchors.length) return $(anchors[0]).attr("href");
  return null;
}

/* ------------------------------------------------------------------
   Function: Use Stealth Puppeteer to fetch redirect link
-------------------------------------------------------------------*/
async function fetchRedirectWithBrowser(url, browser) {
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    // Extra stealth patches
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    // Go to link
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);

    // auto submit landing form
    try {
      await page.evaluate(() => {
        const f = document.getElementById("landing");
        if (f && typeof f.submit === "function") f.submit();
      });
    } catch (e) {}

    await page.waitForTimeout(3000);

    // Try JS extraction
    const candidate = await page.evaluate(() => {
      for (const s of Array.from(document.scripts)) {
        const t = s.textContent || "";
        let m;
        m = /c\.setAttribute\("href","([^"]+)"\)/.exec(t);
        if (m) return m[1];
        m = /window\.location(?:\.href)?\s*=\s*"([^"]+)"/.exec(t);
        if (m) return m[1];
        m = /location\.assign\(["']([^"']+)["']\)/.exec(t);
        if (m) return m[1];
      }
      const cEl = document.getElementById("c");
      if (cEl && cEl.getAttribute("href")) return cEl.getAttribute("href");

      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const h = a.getAttribute("href");
        if (!h) continue;
        if (
          h.includes("driveseed.org") ||
          h.includes("/zfile/") ||
          h.includes("/wfile/") ||
          h.includes("/file/")
        ) {
          return h;
        }
      }
      return null;
    });

    if (!candidate) {
      const html = await page.content();
      return { candidate: null, html };
    }

    // Follow redirect
    const redirectUrl = new URL(candidate, page.url()).toString();

    await page.goto(redirectUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);

    return {
      candidate: redirectUrl,
      finalUrl: page.url(),
      html: await page.content()
    };
  } catch (err) {
    let html = null;
    try { html = await page.content(); } catch (e) {}

    return { candidate: null, html, error: String(err) };
  } finally {
    try { await page.close(); } catch (e) {}
  }
}

/* ------------------------------------------------------------------
   Health route
-------------------------------------------------------------------*/
app.get("/", (req, res) => res.send("OK"));

/* ------------------------------------------------------------------
   /getlink handler
-------------------------------------------------------------------*/
app.get("/getlink", async (req, res) => {
  const startUrl = req.query.url;
  if (!startUrl) return res.status(400).json({ error: "Missing ?url" });

  let browser;
  try {
    browser = await puppeteerExtra.launch(LAUNCH_OPTS);

    const { candidate, finalUrl, html, error } =
      await fetchRedirectWithBrowser(startUrl, browser);

    if (!candidate) {
      return res.status(504).json({
        error: "Redirect link not found",
        debug_title: "Cloudflare Block / JS Challenge",
        debug_html: html ? html.substring(0, 5000) : null,
        debug_error: error || null
      });
    }

    const usedFinal = finalUrl || candidate;
    const fileId = usedFinal.split("/").filter(Boolean).pop();

    const variants = {
      zfile: `https://driveseed.org/zfile/${fileId}`,
      wfile_type1: `https://driveseed.org/wfile/${fileId}?type=1`,
      wfile_type2: `https://driveseed.org/wfile/${fileId}?type=2`
    };

    const results = {};

    for (const [key, link] of Object.entries(variants)) {
      try {
        const p = await browser.newPage();
        await p.goto(link, { waitUntil: "domcontentloaded", timeout: 25000 });
        await p.waitForTimeout(1200);

        const a = await p.$("a[href]");
        if (a) {
          const href = await (await a.getProperty("href")).jsonValue();
          results[key] = href;
        } else {
          const h = await p.content();
          results[key] = extractRedirectFromHTML(h);
        }

        await p.close();
      } catch (e) {
        results[key] = null;
      }
    }

    await browser.close();
    return res.json({
      final_url: usedFinal,
      file_id: fileId,
      download_links: results
    });
  } catch (err) {
    try { if (browser) await browser.close(); } catch (e) {}

    return res.status(500).json({ error: String(err) });
  }
});

/* ------------------------------------------------------------------
   Start server
-------------------------------------------------------------------*/
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
