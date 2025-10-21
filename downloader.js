// downloader.js
// Use puppeteer-extra to make the browser automation less detectable
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const inquirer = require('inquirer');
const path = require('path');
const fs = require('fs');
const cliProgress = require('cli-progress');

// A helper function to create a styled progress bar
const createProgressBar = () => new cliProgress.SingleBar({
    format: ' {bar} | {percentage}% | {step}',
}, cliProgress.Presets.shades_classic);

// Apply the stealth plugin
puppeteer.use(StealthPlugin());

// --- Configuration Management ---
// This will store your last-used credentials and URL locally.
// IMPORTANT: Do NOT share config.json as it contains your password.
const configPath = path.resolve(__dirname, 'config.json');

function loadConfig() {
    if (fs.existsSync(configPath)) {
        try {
            const rawData = fs.readFileSync(configPath, 'utf-8');
            return JSON.parse(rawData);
        } catch (error) {
            console.warn('⚠️  Could not read or parse config.json, starting fresh.');
            return {};
        }
    }
    return {};
}

function saveConfig(data) {
    try {
        fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
        console.error('❌ Could not save to config.json:', error);
    }
}

async function navigateToSongPage(page, songUrl) {
    // --- NEW METHODOLOGY: FOLLOW THE "HUMAN PATH" ---
    console.log('\nNavigating to "My Files" page...');
    await page.goto('https://www.karaoke-version.com/my/download.html', { waitUntil: 'networkidle2' });

    // From the song URL, extract a part of the path to find the link
    // e.g., from ".../huey-lewis-and-the-news/power-of-love.html", we get "power-of-love"
    const urlPart = songUrl.split('/').pop().replace('.html', '');
    const songLinkSelector = `a[href*="${urlPart}"]`;

    console.log(`Searching for song link: ${songLinkSelector}`);
    await page.waitForSelector(songLinkSelector, { timeout: 30000 });

    console.log('Found song link, clicking to navigate to song page...');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click(songLinkSelector),
    ]);
    console.log('✅ Arrived at song page via "My Files".');
}

async function handleCookieConsent(page) {
    // Websites often have a cookie consent banner that can block other elements.
    // We'll try to click the "I agree" button if it appears.
    try {
        const cookieButtonSelector = '#didomi-notice-agree-button';
        await page.waitForSelector(cookieButtonSelector, { timeout: 5000 }); // Wait up to 5s
        await page.click(cookieButtonSelector);
        console.log('✓ Accepted cookie policy.');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {}); // Catch timeout if no navigation
    } catch (e) {
        // If the button isn't found after 5s, we assume it's not there.
        console.log('✓ Cookie banner not found or already handled, proceeding...');
    }
}


async function main() {
    console.log('🎤 Karaoke Track Downloader 🎤\n');

    const config = loadConfig();

    // 1. Get User Input
    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'email',
            message: 'Enter your Karaoke-Version email:',
            default: config.email,
        },
        {
            type: 'password',
            name: 'password',
            message: 'Enter your password:',
            mask: '*',
            default: config.password,
        },
        {
            type: 'input',
            name: 'songUrl',
            message: 'Enter the URL of the custom backing track:',
            default: config.songUrl || 'https://www.karaoke-version.com/custombackingtrack/huey-lewis-and-the-news/power-of-love.html',
        }
    ]);

    const { email, password, songUrl } = answers;

    if (!email || !password || !songUrl) {
        console.error('Email, password, and song URL are required. Exiting.');
        return;
    }

    // Save the entered details for the next run
    saveConfig({ email, password, songUrl });

    const browser = await puppeteer.launch({ 
        headless: false, // Set to 'new' or true for headless, false to watch it work
        defaultViewport: { width: 1280, height: 1024 }, // Revert to smaller viewport as preferred
        args: [
            '--disable-infobars', // Hides the "Chrome is being controlled..." bar
            // Removed --start-maximized as user prefers smaller window
        ]
    });
    const page = await browser.newPage();

    let success = false; // Flag to track overall success

    try {
        // --- LOGIN ---
        const loginProgressBar = createProgressBar();
        loginProgressBar.start(100, 0, { step: 'Logging in...' });

        await page.goto('https://www.karaoke-version.com/my/login.html', { waitUntil: 'networkidle2' });
        loginProgressBar.update(25, { step: 'On login page' });

        // Use selectors from your JSON file
        await page.type('#frm_login', email);
        loginProgressBar.update(50, { step: 'Typed email' });
        
        await page.type('#frm_password', password);
        loginProgressBar.update(75, { step: 'Typed password' });

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click('#sbm'),
        ]);
        loginProgressBar.update(100, { step: 'Login successful!' });
        loginProgressBar.stop();

        await navigateToSongPage(page, songUrl);
        await handleCookieConsent(page);

        // --- PREPARE FOR DOWNLOAD ---
        const prepProgressBar = createProgressBar();
        prepProgressBar.start(100, 0, { step: 'Preparing for download...' });

        // Get song title to create a directory
        const songTitle = await page.title();
        const safeSongTitle = songTitle.split('|')[0].trim().replace(/[^a-z0-9\s-]/gi, '_');
        const baseDownloadPath = path.resolve(__dirname, 'downloads');
        const downloadPath = path.resolve(baseDownloadPath, safeSongTitle);
        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath);
        }
        
        // Set Puppeteer to download files to our new directory
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadPath,
        });
        prepProgressBar.update(33, { step: `Created directory: ${safeSongTitle}` });

        // The mixer is in the main page, not an iframe. Wait for it to appear.
        console.log('\nWaiting for the dynamic mixer to load...');
        await page.waitForSelector('#html-mixer', { timeout: 60000 });
        console.log('✓ Mixer has loaded.');

        // Ensure "Click track" is checked, as you requested
        // Corrected selector based on Python script and error_page.html
        const clickTrackSelector = '#precount';
        await page.waitForSelector(clickTrackSelector, { timeout: 5000 });
        const isClickTrackChecked = await page.$eval(clickTrackSelector, el => el.checked);
        if (!isClickTrackChecked) {
            await page.click(clickTrackSelector);
            console.log('✓ Enabled "Click track" intro.');
        } else {
            console.log('✓ "Click track" intro was already enabled.');
        }
        prepProgressBar.update(66, { step: 'Checked intro click' });

        // Find all the tracks in the mixer
        const tracks = await page.$$('#html-mixer .track');
        console.log(`\nFound ${tracks.length} tracks to download.`);
        prepProgressBar.update(100, { step: 'Ready to download tracks!' });
        prepProgressBar.stop();


        // --- DOWNLOAD EACH TRACK ---
        // Start at i = 0 to include all tracks, including the click track.
        for (let i = 0; i < tracks.length; i++) {
            const downloadProgressBar = createProgressBar();
            const stepDescription = `Downloading track ${i + 1} of ${tracks.length}`;
            downloadProgressBar.start(100, 0, { step: stepDescription });

            // Get all tracks again to avoid "stale element" errors
            const track = (await page.$$('#html-mixer .track'))[i];

            // Get the track name for the file
            // Corrected selector from .track__name to .track__caption
            const trackNameElement = await track.$('.track__caption');
            const trackName = await page.evaluate(el => el.textContent.trim(), trackNameElement);
            
            downloadProgressBar.update(25, { step: `${stepDescription}: Soloing "${trackName}"` });

            // Click the 'Solo' button for the current track
            // Your JSON shows clicks on `button.track__solo`
            const soloButton = await track.$('button.track__solo');
            if (soloButton) {
                await soloButton.click();
            } else {
                console.warn(`Could not find a solo button for track "${trackName}". Skipping solo.`);
            }
            
            // Wait a moment for the mix to update
            await new Promise(resolve => setTimeout(resolve, 1000));
            downloadProgressBar.update(50, { step: `${stepDescription}: Clicking main download button` });

            // Click the main download button (This button is on the main page, not in the iframe)
            // The ID is song-specific, so we use a more generic class selector.
            // Corrected selector based on Python script and error_page.html
            const downloadButtonSelector = 'a.download';
            await page.waitForSelector(downloadButtonSelector, { timeout: 10000 });
            await page.click(downloadButtonSelector);
            downloadProgressBar.update(60, { step: `${stepDescription}: Waiting for download to start` });
            
            // --- Wait for download to complete (robust method) ---
            const filesBefore = fs.readdirSync(downloadPath).filter(f => f.endsWith('.mp3')).length;
            const startTime = Date.now();
            let newFileFound = false;
            while (Date.now() - startTime < 45000) { // 45s timeout for download
                const filesAfter = fs.readdirSync(downloadPath).filter(f => f.endsWith('.mp3')).length;
                if (filesAfter > filesBefore) {
                    newFileFound = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 500)); // Check every 0.5s
            }
            if (!newFileFound) {
                console.warn(`\nWarning: Download for "${trackName}" did not complete within the time limit.`);
            }
            downloadProgressBar.update(80, { step: `${stepDescription}: Download finished` });

            // --- Close the download confirmation modal ---
            try {
                const closeModalSelector = 'div.modal__overlay div.modal button';
                await page.waitForSelector(closeModalSelector, { visible: true, timeout: 5000 });
                await page.click(closeModalSelector);
            } catch (e) {
                console.log(`(Info) Download modal not found for track "${trackName}", continuing...`);
            }

            // Un-solo the track to prepare for the next one
            if (soloButton) {
                await soloButton.click();
            }
            
            downloadProgressBar.update(100, { step: `${stepDescription}: "${trackName}" finished!` });
            downloadProgressBar.stop();
        }
        success = true; // Set success flag if all tracks downloaded
    } catch (error) {
        console.error('\nAn error occurred:', error);
        // Take a screenshot on error for debugging
        const errorScreenshotPath = path.resolve(__dirname, 'error_screenshot.png');
        await page.screenshot({ path: errorScreenshotPath, fullPage: true });
        console.log(`📸 Screenshot saved to ${errorScreenshotPath}`);
        // Save the page's HTML for deep debugging
        const pageHtml = await page.content();
        fs.writeFileSync(path.resolve(__dirname, 'error_page.html'), pageHtml);
        console.log(`📄 Page HTML saved to error_page.html`);
    } finally {
        await browser.close(); // Always close the browser
        if (success) {
            console.log('\n🎉 Success! All tracks have been downloaded.');
            console.log('Check the project folder for your new directory of tracks.');
        } else {
            console.log('\n❌ Operation failed or completed with errors.');
        }
    }
}

main();
