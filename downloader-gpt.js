// downloader-gpt.js
// Usage: node downloader-gpt.js
// npm i puppeteer-extra puppeteer-extra-plugin-stealth inquirer cli-progress

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const inquirer = require('inquirer');
const path = require('path');
const fs = require('fs');
const cliProgress = require('cli-progress');

puppeteer.use(StealthPlugin());

// ---------- Utils ----------
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const MIXER_ROOT = '#html-mixer';
const OPEN_MIXER_CANDIDATES = [
  'button#open-mixer',
  'button[aria-label*="open"][aria-label*="mixer" i]',
  'a[href*="#mixer"]',
  'a.button--customize',
  'a.button--mixer',
  'button:has-text("Open the mixer")',
  'button:has-text("Customize")',
  'button:has-text("Launch")'
];

const createProgressBar = (label = '') =>
  new cliProgress.SingleBar(
    { format: `${label} {bar} | {percentage}% | {step}` },
    cliProgress.Presets.shades_classic
  );

async function allowDownloads(page, downloadPath) {
  if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });
  const cdp = await page.target().createCDPSession();
  // Works in current Chromium via Browser.* domain.
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath
  });
}

async function ensureCookieConsent(page) {
  try {
    // Common Didomi consent button
    const btn = await page.$('#didomi-notice-agree-button');
    if (btn) {
      await btn.click().catch(() => {});
      await delay(800);
    }
  } catch { /* ignore */ }
}

async function waitForNewMp3(downloadPath, prevCount, { timeoutMs = 90000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const mp3s = fs.readdirSync(downloadPath)
      .filter(f => f.toLowerCase().endsWith('.mp3')).length;
    if (mp3s > prevCount) return true;
    await delay(500);
  }
  return false;
}

async function closeModalIfPresent(page) {
  // Recorded selector:
  // div.modal__overlay > div > button (Close)
  const modalCloseSel = 'div.modal__overlay > div > button';
  try {
    const closeBtn = await page.waitForSelector(modalCloseSel, { visible: true, timeout: 8000 });
    if (closeBtn) await closeBtn.click();
  } catch { /* modal not present; fine */ }
}

async function clickDownloadOnMainPage(page) {
  // Flexible candidates (recorded was: #link_addcart_XXXX > span.bottom)
  const candidates = [
    'a[id^="link_addcart_"] span.bottom',
    'a[id^="link_addcart_"]',
    'a.addcart',
    'button.addcart'
  ];
  for (const sel of candidates) {
    const el = await page.$(sel);
    if (el) { await el.click(); return true; }
  }
  return false;
}

// ---------- Mixer Discovery (inline or iframe) ----------
async function findMixerContext(page, timeoutMs = 90000) {
  const start = Date.now();

  const logFrames = () => {
    const infos = page.frames().map(f => ({
      name: f.name(),
      url: f.url().slice(0, 160)
    }));
    console.log('🧭 Frames:', infos);
  };

  // 1) Check main page first (your recording clicked in main)
  if (await page.$(MIXER_ROOT)) return { handle: page, type: 'page' };

  // 2) Try clicking an "Open/Customize" button once
  for (const sel of OPEN_MIXER_CANDIDATES) {
    const el = await page.$(sel);
    if (el) {
      console.log(`🔘 Clicking mixer opener: ${sel}`);
      await el.click().catch(() => {});
      await page.waitForNetworkIdle?.({ idleTime: 800, timeout: 8000 }).catch(() => {});
      if (await page.$(MIXER_ROOT)) return { handle: page, type: 'page' };
      break; // don't click multiple openers
    }
  }

  // 3) Poll + scroll + frame-scan
  while (Date.now() - start < timeoutMs) {
    if (await page.$(MIXER_ROOT)) return { handle: page, type: 'page' };

    // Scan frames
    for (const f of page.frames()) {
      try {
        const el = await f.$(MIXER_ROOT);
        if (el) return { handle: f, type: 'frame' };
      } catch { /* ignore */ }
    }

    // Fallback: look for any likely mixer iframe and verify
    const maybeMixerIframe = await page.$('iframe[id*="mixer"], iframe[src*="custom"], iframe[src*="mixer"]');
    if (maybeMixerIframe) {
      const f = await maybeMixerIframe.contentFrame();
      if (f) {
        try {
          await f.waitForSelector(MIXER_ROOT, { timeout: 5000 });
          return { handle: f, type: 'frame' };
        } catch { /* keep polling */ }
      }
    }

    // Scroll to trigger lazy loading
    await page.evaluate(() => window.scrollBy(0, Math.ceil(window.innerHeight * 0.8)));
    await delay(700);
  }

  // Diagnostics
  console.log('❓ Mixer not found after timeout. Dumping diagnostics…');
  logFrames();
  try {
    let idx = 0;
    for (const f of page.frames()) {
      const html = await f.content().catch(() => '');
      if (html) {
        const p = path.resolve(__dirname, `error_frame_${idx++}.html`);
        fs.writeFileSync(p, html);
        console.log(`🧾 Saved ${p} (name="${f.name()}" url="${f.url()}")`);
      }
    }
  } catch {}
  throw new Error(`Could not locate mixer root (${MIXER_ROOT}) in page or frames`);
}

async function getMixerHandle(page) {
  const ctx = await findMixerContext(page);
  console.log(`✓ Mixer context: ${ctx.type}`);
  await ctx.handle.waitForSelector(MIXER_ROOT, { timeout: 30000 });
  return ctx.handle; // Page or Frame (both support $, $$, $eval, waitForSelector)
}

// ---------- Mixer actions ----------
async function setClickTrackOn(mHandle) {
  const clickSel = '#click-track-switch';
  try {
    await mHandle.waitForSelector(clickSel, { timeout: 8000 });
    const checked = await mHandle.$eval(clickSel, el => !!el.checked);
    if (!checked) await mHandle.click(clickSel);
  } catch {
    // Some songs/templates don’t expose this toggle; ignore.
  }
}

async function getTracks(mHandle) {
  await mHandle.waitForSelector('#html-mixer .track', { timeout: 60000 });
  return mHandle.$$('#html-mixer .track');
}

// ---------- Auth ----------
async function login(page, email, password) {
  await page.goto('https://www.karaoke-version.com/my/login.html', { waitUntil: 'networkidle2' });

  // From your recording: #frm_login / #frm_password / #sbm
  const selectors = {
    user: ['#frm_login', 'input[name="login"]', 'input#login', 'input[name="username"]'],
    pass: ['#frm_password', 'input[name="password"]', 'input#password'],
    submit: ['#sbm', 'button[type="submit"]', 'form#frmLogin button[type="submit"]']
  };

  let userSel, passSel, submitSel;
  for (const s of selectors.user) if (!userSel && await page.$(s)) userSel = s;
  for (const s of selectors.pass) if (!passSel && await page.$(s)) passSel = s;
  for (const s of selectors.submit) if (!submitSel && await page.$(s)) submitSel = s;

  if (!userSel || !passSel || !submitSel) {
    throw new Error(`Login selectors not found (userSel=${userSel}, passSel=${passSel}, submitSel=${submitSel})`);
  }

  await page.type(userSel, email, { delay: 20 });
  await page.type(passSel, password, { delay: 20 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
    page.click(submitSel)
  ]);
}

// ---------- Main ----------
async function main() {
  console.log('🎤 Karaoke Track Downloader — using your recording selectors\n');

  const answers = await inquirer.prompt([
    { type: 'input', name: 'email', message: 'Email/username:', default: 'eruji' },
    { type: 'password', name: 'password', message: 'Password:' },
    {
      type: 'input',
      name: 'songUrl',
      message: 'Custom backing track URL:',
      default: 'https://www.karaoke-version.com/custombackingtrack/huey-lewis-and-the-news/power-of-love.html'
    },
    { type: 'confirm', name: 'headless', message: 'Run headless?', default: false }
  ]);

  const { email, password, songUrl, headless } = answers;

  const browser = await puppeteer.launch({
    headless,
    defaultViewport: { width: 1712, height: 1313 },
    args: [
      '--disable-infobars',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const page = await browser.newPage();
  let success = false;

  try {
    const loginBar = createProgressBar('Login');
    loginBar.start(100, 0, { step: 'Opening login page' });
    await login(page, email, password);
    loginBar.update(100, { step: 'Logged in' });
    loginBar.stop();

    // Looser navigation (some scripts lazy-mount post DOMContentLoaded)
    await page.setBypassCSP(true);
    await page.goto(songUrl, { waitUntil: 'domcontentloaded' });
    await ensureCookieConsent(page);
    await page.waitForNetworkIdle?.({ idleTime: 1000, timeout: 30000 }).catch(() => {});

    // Prepare downloads
    const rawTitle = await page.title();
    const safeTitle = rawTitle.split('|')[0].trim()
      .replace(/[^a-z0-9\s-]/gi, '_')
      .replace(/\s+/g, ' ')
      .trim();
    const downloadPath = path.resolve(__dirname, safeTitle || 'downloads');
    await allowDownloads(page, downloadPath);
    console.log(`📂 Download folder: ${downloadPath}`);

    // Mixer context (inline or iframe)
    const prepBar = createProgressBar('Mixer');
    prepBar.start(100, 0, { step: 'Locating mixer' });
    const mixerHandle = await getMixerHandle(page);
    prepBar.update(40, { step: 'Mixer ready' });

    await setClickTrackOn(mixerHandle);
    prepBar.update(60, { step: 'Click track ensured' });

    const tracks = await getTracks(mixerHandle);
    prepBar.update(100, { step: `Found ${tracks.length} tracks` });
    prepBar.stop();

    // Download loop
    for (let i = 0; i < tracks.length; i++) {
      const bar = createProgressBar(`Track ${i + 1}/${tracks.length}`);
      bar.start(100, 0, { step: 'Soloing' });

      // Re-query to avoid stale handles
      const current = (await getTracks(mixerHandle))[i];
      if (!current) { bar.stop(); continue; }

      // Track name if present
      let trackName = `track_${i + 1}`;
      try {
        const nameEl = await current.$('.track__name, .track__title, .name');
        if (nameEl) trackName = await mixerHandle.evaluate(el => el.textContent.trim(), nameEl);
      } catch { /* ignore */ }

      const soloBtn = await current.$('button.track__solo');
      if (soloBtn) await soloBtn.click();
      bar.update(30, { step: `Solo "${trackName}"` });

      await delay(1000);

      bar.update(50, { step: 'Clicking Download' });
      const prevCount = fs.readdirSync(downloadPath).filter(f => f.toLowerCase().endsWith('.mp3')).length;

      const clicked = await clickDownloadOnMainPage(page);
      if (!clicked) {
        bar.stop();
        throw new Error('Download button not found on main page.');
      }

      // site shows a brief modal + starts download
      await delay(800);
      await closeModalIfPresent(page);

      bar.update(70, { step: 'Waiting for file' });
      const gotFile = await waitForNewMp3(downloadPath, prevCount, { timeoutMs: 90000 });
      if (!gotFile) {
        console.warn(`⚠️ No new .mp3 detected for "${trackName}" within timeout; continuing…`);
      }

      if (soloBtn) await soloBtn.click();
      bar.update(100, { step: `Finished "${trackName}"` });
      bar.stop();
    }

    success = true;
  } catch (err) {
    console.error('\n❌ Error:', err?.message || err);
    try {
      const shot = path.resolve(__dirname, 'error_screenshot.png');
      await page.screenshot({ path: shot, fullPage: true });
      console.log(`📸 Saved screenshot: ${shot}`);
    } catch {}
    try {
      const htmlPath = path.resolve(__dirname, 'error_page.html');
      fs.writeFileSync(htmlPath, await page.content());
      console.log(`📄 Saved HTML: ${htmlPath}`);
    } catch {}
    try {
      // Save frame HTMLs for deep inspection (helps when mixer is inline vs. iframe)
      let idx = 0;
      for (const f of page.frames()) {
        const html = await f.content().catch(() => '');
        if (html) {
          const p = path.resolve(__dirname, `error_frame_${idx++}.html`);
          fs.writeFileSync(p, html);
          console.log(`🧾 Also saved ${p} (frame name="${f.name()}" url="${f.url()}")`);
        }
      }
    } catch {}
  } finally {
    await browser.close();
    console.log(success ? '\n🎉 All done!' : '\n⚠️ Completed with errors (see logs/screenshot/HTML).');
  }
}

main();
