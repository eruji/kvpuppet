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

        // Find all the tracks in the mixer. We will handle the "Intro count" track during the download loop.
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

async function fetchPurchasedSongs(page) {
    console.log('\nFetching your purchased songs...');
    await page.goto('https://www.karaoke-version.com/my/download.html', { waitUntil: 'networkidle2' });
    console.log(`Navigated to: ${page.url()}`); // Log the current URL

    // Updated selector based on the HTML structure of the "My Downloads" page
    const songListSelector = 'td.my-downloaded-files__song';
    console.log(`Waiting for selector: "${songListSelector}" with timeout 30000ms...`);
    await page.waitForSelector(songListSelector, { timeout: 30000 }); // Increased timeout for debugging
    console.log(`Selector "${songListSelector}" found!`);

    const collectedSongs = []; // This will store all songs, including potential duplicates
    const collectedSongUrls = new Set(); // This will track unique song URLs to detect the end of pagination
    let pageNumber = 1; // Start page number at 1

    // Loop to handle multiple pages of downloads
    while (true) {
        // Scrape songs currently visible on the page
        // Get the URL of the first song on the current page to detect content change later
        const firstSongOnPageHref = await page.$eval(songListSelector, el => el.querySelector('a')?.href).catch(() => null);

        const songsOnPage = await page.$$eval(songListSelector, lines =>
            lines.map(line => { // Map each song element to its data
                const anchor = line.querySelector('a');
                if (!anchor) return null;
                const name = anchor.textContent.trim();
                // Return an object with a unique key (href) to help with deduplication later
                return { name, value: anchor.href, key: anchor.href };
            }).filter(Boolean)
        );

        const initialUniqueCount = collectedSongUrls.size;

        // Add the songs from the current page to our master list
        collectedSongs.push(...songsOnPage);
        // Also add their URLs to our Set for quick uniqueness checks
        songsOnPage.forEach(song => collectedSongUrls.add(song.value));

        const newUniqueCount = collectedSongUrls.size - initialUniqueCount;

        console.log(`Scraped ${songsOnPage.length} songs from page ${pageNumber}. Found ${newUniqueCount} new unique songs. Total unique: ${collectedSongUrls.size}`);

        // If we are on page 2 or later and we didn't find any new unique songs, we are done.
        if (pageNumber > 1 && newUniqueCount === 0) {
            console.log('No new unique songs found on this page. Assuming all pages have been scraped.');
            break;
        }

        // Look for a "next" page link. The `rel="next"` attribute is a reliable selector.
        const nextButtonSelector = 'a[rel="next"]';
        const nextButton = await page.$(nextButtonSelector);

        if (nextButton) {
            pageNumber++;
            console.log(`Found "next" page link. Navigating to page ${pageNumber}...`);
            try {
                // Click the link and wait for the page to reload
                await nextButton.click();
                await page.waitForNavigation({ waitUntil: 'networkidle2' });

                // After navigation, explicitly wait for the content to change.
                // We'll wait until the first song's URL is different from the previous page's first song.
                await page.waitForFunction(
                    (selector, previousHref) => {
                        const firstSong = document.querySelector(selector);
                        const firstSongHref = firstSong ? firstSong.querySelector('a')?.href : null;
                        return firstSongHref !== previousHref;
                    },
                    { timeout: 15000 }, // Wait up to 15 seconds for the content to update
                    songListSelector,
                    firstSongOnPageHref
                );
            } catch (e) {
                console.log(`Could not click the 'next' button, assuming it's the last page. Error: ${e.message}`);
                break;
            }
        } else {
            console.log('No "next" page link found. Assuming all pages have been scraped.');
            break; // Exit the loop if there's no next page
        }
    }

    // Now that we have all songs (including duplicates), create a unique list
    const uniqueSongs = Array.from(new Map(collectedSongs.map(song => [song.key, song])).values());

    // Sort songs alphabetically by name for a clean presentation in the menu
    uniqueSongs.sort((a, b) => a.name.localeCompare(b.name));

    console.log(`✓ Found ${uniqueSongs.length} unique purchased songs.`);
    return uniqueSongs;
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
        headless: false, // Set to false to see the browser window
        defaultViewport: { width: 1280, height: 1024 }, // Revert to smaller viewport as preferred
        args: [
            '--disable-infobars', // Hides the "Chrome is being controlled..." bar
            // Removed --start-maximized as user prefers smaller window
        ]
    });
    const page = await browser.newPage();

    try {
        // --- LOGIN ---
        console.log('Logging in...');

        await page.goto('https://www.karaoke-version.com/my/login.html', { waitUntil: 'networkidle2' });
        console.log('On login page...');

        // Use selectors from your JSON file
        await page.type('#frm_login', email);
        console.log('Typed email...');
        
        await page.type('#frm_password', password);
        console.log('Typed password...');

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click('#sbm'),
        ]);
        console.log('Login successful!');

        // Fetch the list of purchased songs once after logging in
        let purchasedSongs = await fetchPurchasedSongs(page);

        // --- Main Application Loop ---
        while (true) {
            console.log('\n' + '-'.repeat(50));

            const songChoices = purchasedSongs.map(song => ({ name: song.name, value: song.value }));

            const menuChoices = [
                new inquirer.Separator('--- Select a Song to Download ---'),
                ...songChoices,
                new inquirer.Separator('---------------------------------'),
                { name: 'Refresh song list', value: 'refresh' },
                { name: 'Enter a song URL manually', value: 'manual' },
                { name: 'Exit', value: 'exit' },
            ];

            const { action } = await inquirer.prompt({
                type: 'list',
                name: 'action',
                message: 'What would you like to do?',
                choices: menuChoices,
                pageSize: 15, // Show more items in the list
            });

            if (action === 'exit') {
                console.log('Exiting...');
                break;
            }

            if (action === 'refresh') {
                purchasedSongs = await fetchPurchasedSongs(page);
                continue; // Go back to the main menu
            }

            let songUrl;
            if (action === 'manual') {
                const { newUrl } = await inquirer.prompt({
                    type: 'input',
                    name: 'newUrl',
                    message: 'Enter the song URL:',
                });
                songUrl = newUrl;
            } else {
                songUrl = action; // The 'value' of the song choice is its URL
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
        // Re-fetch the track element inside the loop to prevent "stale element" errors
        const track = (await page.$$('#html-mixer .track'))[i];

        // Get the track name for the file
        const trackNameElement = await track.$('.track__caption');
        const trackName = await page.evaluate(el => el.textContent.trim(), trackNameElement);

        // Click the 'Solo' button for the current track to isolate it for download.
        const soloButton = await track.$('button.track__solo');
        if (soloButton) {
            // Scroll the button into view and wait a moment to ensure it's clickable
            await page.evaluate(el => {
                el.scrollIntoView({ block: 'center', inline: 'center' });
            }, soloButton);
            await new Promise(resolve => setTimeout(resolve, 250)); // Brief pause after scroll
            await soloButton.click(); // Enable solo
        } else {
            console.warn(`Could not find a solo button for track "${trackName}".`);
        }
        // Wait a moment for the mix to update
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Click the main download button (This button is on the main page, not in the iframe)
        // The ID is song-specific, so we use a more generic class selector.
        // Corrected selector based on Python script and error_page.html
        const downloadButtonSelector = 'a.download';
        await page.waitForSelector(downloadButtonSelector, { timeout: 10000 });
        await page.click(downloadButtonSelector);
        
        // --- Wait for download to complete and rename the file ---
        const filesBefore = new Set(fs.readdirSync(downloadPath));
        const startTime = Date.now();
        let newFilePath = null;

        while (Date.now() - startTime < 45000) { // 45s timeout for download
            const currentFiles = fs.readdirSync(downloadPath);
            const newFile = currentFiles.find(file => !filesBefore.has(file) && !file.endsWith('.crdownload'));
            if (newFile) {
                newFilePath = path.join(downloadPath, newFile);
                // Wait a bit more to ensure the file is fully written
                await new Promise(resolve => setTimeout(resolve, 1000)); 
                break; 
            }
            await new Promise(resolve => setTimeout(resolve, 500)); // Check every 0.5s
        }

        if (newFilePath) {
            // Sanitize track name for the filesystem
            const safeTrackName = trackName.replace(/[^a-z0-9\s-]/gi, '_').replace(/\s+/g, ' ');
            // Format track number with leading zero
            const trackNumber = String(i + 1).padStart(2, '0');
            const finalFileName = `${trackNumber} - ${safeTrackName}.mp3`;
            const finalFilePath = path.join(downloadPath, finalFileName);

            // Update the progress bar to show the final filename being created
            progressBar.update({ step: `Creating "${finalFileName}"` });

            fs.renameSync(newFilePath, finalFilePath);
        } else {
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

        // Un-solo the track to prepare for the next one.
        if (soloButton) {
            // The same robust click method to un-solo
            await page.evaluate(el => {
                el.scrollIntoView({ block: 'center', inline: 'center' });
            }, soloButton);
            await soloButton.click(); // Disable solo
        }
        
        progressBar.increment();
    }
}

main();
