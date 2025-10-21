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
    format: '{step} | {bar} | {value}/{total} Tracks',
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
    console.log('\nNavigating directly to song page...');
    await page.goto(songUrl, { waitUntil: 'networkidle2' });
    console.log('✅ Arrived at song page.');
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

async function processSong(page, songUrl, enableClickTrack) {
    let success = false;
    let cleanSongTitle = songUrl; // Default to URL if title can't be fetched
    try {
        await navigateToSongPage(page, songUrl);
        await handleCookieConsent(page);

        const songPageTitle = await page.title();
        cleanSongTitle = songPageTitle.split('|')[0].trim();
        
        // Get song title to create a directory
        const songTitle = await page.title();
        const safeSongTitle = songTitle.split('|')[0].trim().replace(/[^a-z0-9\s-]/gi, '_');
        const baseDownloadPath = path.resolve(__dirname, 'downloads');
        const downloadPath = path.resolve(baseDownloadPath, safeSongTitle);
        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath, { recursive: true });
        }
        
        // Set Puppeteer to download files to our new directory
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadPath,
        });

        // The mixer is in the main page, not an iframe. Wait for it to appear.
        console.log('\nWaiting for the dynamic mixer to load...');
        await page.waitForSelector('#html-mixer', { timeout: 60000 });
        console.log('✓ Mixer has loaded.');

        // Ensure "Click track" is checked, as you requested
        // Corrected selector based on Python script and error_page.html
        const clickTrackSelector = '#precount';
        await page.waitForSelector(clickTrackSelector, { timeout: 5000 });
        const isChecked = await page.$eval(clickTrackSelector, el => el.checked);

        if (enableClickTrack && !isChecked) {
            await page.click(clickTrackSelector);
            console.log("✓ Enabled 'Intro Click' track.");
        } else if (!enableClickTrack && isChecked) {
            await page.click(clickTrackSelector);
            console.log("✓ Disabled 'Intro Click' track.");
        } else {
            console.log(`✓ 'Intro Click' track is already set to: ${isChecked ? 'Enabled' : 'Disabled'}.`);
        }

        // --- VERIFY SONG IS PURCHASED ---
        // Check for the download button. If it's an "Add to Cart" button, the song isn't owned.
        const downloadButtonSelector = 'a.download';
        const downloadButton = await page.$(downloadButtonSelector);
        const buttonText = downloadButton ? await page.evaluate(el => el.textContent.trim(), downloadButton) : '';

        if (!downloadButton || !buttonText.toLowerCase().includes('download')) {
            console.log('\n⚠️  This song has not been purchased (the "Download" button was not found).');
            return false; // Gracefully exit this song's processing
        }

        // Find all the tracks in the mixer
        const tracks = await page.$$('#html-mixer .track');
        console.log(`Found ${tracks.length} tracks to download.`);

        const downloadProgressBar = createProgressBar();
        downloadProgressBar.start(tracks.length, 0, { step: `Downloading "${cleanSongTitle}"` });

        await downloadAllTracks(page, tracks, downloadPath, downloadProgressBar);

        downloadProgressBar.stop();

        success = true;
    } catch (error) {
        console.error(`\nAn error occurred while processing ${songUrl}:`, error);
    }
    return { success, songTitle: cleanSongTitle };
}

async function main() {
    console.log('🎤 Karaoke Track Downloader 🎤\n');

    const config = loadConfig();

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
    ]);

    const { email, password } = answers;

    if (!email || !password) {
        console.error('Email and password are required. Exiting.');
        return;
    }

    const browser = await puppeteer.launch({ 
        headless: 'new', // Set to 'new' for faster, non-visual operation
        defaultViewport: { width: 1280, height: 1024 }, // Revert to smaller viewport as preferred
        args: [
            '--disable-infobars', // Hides the "Chrome is being controlled..." bar
            // Removed --start-maximized as user prefers smaller window
        ]
    });
    const page = await browser.newPage();

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

        // --- Main Application Loop ---
        while (true) {
            console.log('\n' + '-'.repeat(50));

            const choices = [
                { name: 'Enter a new song URL', value: 'new' },
            ];
            if (config.songUrl) {
                choices.push({ name: `Download last song again (${config.songUrl})`, value: 'last' });
            }
            choices.push({ name: 'Exit', value: 'exit' });

            const { action } = await inquirer.prompt({
                type: 'list',
                name: 'action',
                message: 'What would you like to do?',
                choices,
            });

            if (action === 'exit') {
                console.log('Exiting...');
                break;
            }

            let songUrl = config.songUrl;
            if (action === 'new') {
                const { newUrl } = await inquirer.prompt({
                    type: 'input',
                    name: 'newUrl',
                    message: 'Enter the new song URL:',
                });
                songUrl = newUrl;
            }

            if (!songUrl) {
                console.log('No URL provided. Please try again.');
                continue; // Go back to the main menu
            }

            const { enableClickTrack } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'enableClickTrack',
                    message: "Enable 'Intro Click'?",
                    default: config.enableClickTrack !== false,
                },
            ]);

            // Save config for the next run
            saveConfig({ email, password, songUrl, enableClickTrack });

            const { success, songTitle } = await processSong(page, songUrl, enableClickTrack);
            if (success) {
                console.log(`\n✅ Successfully downloaded all tracks for: "${songTitle}"`);
            } else {
                console.log(`\n❌ Finished processing "${songTitle}" with issues (see logs above). Ready for next song.`);
            }
        }
    } catch (error) {
        console.error('\nAn unrecoverable error occurred:', error);
    } finally {
        await browser.close();
        console.log('\n👋 Session ended. Goodbye!');
    }
}

async function downloadAllTracks(page, tracks, downloadPath, progressBar) {
    for (let i = 0; i < tracks.length; i++) {
        // Get all tracks again to avoid "stale element" errors
        const track = (await page.$$('#html-mixer .track'))[i];

        // Get the track name for the file
        // Corrected selector from .track__name to .track__caption
        const trackNameElement = await track.$('.track__caption');
        const trackName = await page.evaluate(el => el.textContent.trim(), trackNameElement);

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

        // Click the main download button (This button is on the main page, not in the iframe)
        // The ID is song-specific, so we use a more generic class selector.
        // Corrected selector based on Python script and error_page.html
        const downloadButtonSelector = 'a.download';
        await page.waitForSelector(downloadButtonSelector, { timeout: 10000 });
        await page.click(downloadButtonSelector);
        
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
        
        progressBar.increment();
    }
}

main();
