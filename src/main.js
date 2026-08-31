    /**
     * =============================================================================
     * AlgoScraper — Electron MAIN PROCESS (src/main.js)
     * =============================================================================
     * Owns: Appium lifecycle, device discovery, installed-apps listing, ADB helpers.
     * Renderer (popup.js) never starts Appium itself — it calls ensure-appium IPC.
     *
     * PLATFORM SUPPORT
     *   Android → adb (emulator + physical), UiAutomator2 driver, ADB screenshot/dump
     *   iOS     → simctl / xcdevice / devicectl (simulator + physical), XCUITest
     *   Windows packaged builds omit XCUITest (~300MB); iOS scraping is macOS-only
     *
     * STARTUP FLOW (app.on 'ready')
     *   1) Splash popup          → createLoadingWindow()
     *   2) Prerequisites         → bundled Node + appium-runtime present
     *   3) Automation engine     → ensureAppiumStarted() on port 4723
     *      Prefer bundled Appium+Node; if that fails, fall back to system Appium+Node
     *   4) Device check          → Android (adb) + iOS (simctl/xcdevice), Android preferred
     *   5) Main window           → createWindow() → src/index.html + popup.js
     *
     * KEY SECTIONS (search these headers below)
     *   [ENV]         PATH + auto ANDROID_HOME (detect Studio SDK or download platform-tools)
     *   [APPIUM]      Bundled → system fallback / Node / extensions.yaml / APPIUM_HOME
     *   [SPLASH]      Startup loading popup (real-time status)
     *   [DEVICES]     Android + iOS connected-device discovery (iOS skipped on Windows)
     *   [STARTUP]     ready gate: splash → Appium → devices → main window
     *   [PROTOCOL]    myapp:// deep link vs double-click → IPC "launch-mode"
     *   [IPC-APPIUM]  ensure-appium / sessions
     *   [IPC-ANDROID] version, soft-launch, screenshot, pagesource, prepare
     *   [IPC-APPS]    Launchable apps (Android MAIN/LAUNCHER + iOS User/System)
     *
     * extensions.yaml note:
     *   installPath values MUST be YAML-quoted (JSON.stringify) — project paths
     *   often contain spaces and unquoted paths break UiAutomator2 registration.
     * =============================================================================
     */
    const { app, BrowserWindow, ipcMain, dialog } = require('electron');
    const url = require('url');
    const path = require('path');
    const { pathToFileURL } = url;
    const wd = require("selenium-webdriver");
    const { exec, spawn, spawnSync } = require('child_process');
    // Product name historically includes "IOS"; app scrapes both Android and iOS.
    app.name = "AlgoScraper";
    app.setName("AlgoScraper");
    const { Menu } = require('electron');
    var appPackage
    var deviceId;
    let mainWindow;
    let loadingWindow;
    var deviceName;
    let launchedFromProtocol = false;
    let pendingDeepLinkUrl = null; // myapp://… received before main window is ready

    // Single-instance lock is required for protocol relaunches (Windows second-instance,
    // and focusing an already-open Mac app). Without this, API deep links spawn a
    // second process and Launch-mode never reaches the existing scraper window.
    const gotSingleInstanceLock = app.requestSingleInstanceLock();
    if (!gotSingleInstanceLock) {
        app.quit();
    }

    const http = require('http');
    const https = require('https');
    const fs = require('fs');
    const os = require('os');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    /** Register myapp:// for AlgoQA API launches (dev Electron + packaged app). */
    function registerMyAppProtocol() {
        // In `electron .` / forge start, argv[1] is the app path — must be passed or
        // the OS registers Electron.app itself and deep links never open AlgoScraper.
        if (process.defaultApp) {
            if (process.argv.length >= 2) {
                app.setAsDefaultProtocolClient(
                    'myapp',
                    process.execPath,
                    [path.resolve(process.argv[1])]
                );
            }
        } else {
            app.setAsDefaultProtocolClient('myapp');
        }
    }

    function findDeepLinkInArgv(argv) {
        return (argv || []).find(
            (a) => typeof a === 'string' && /^myapp:\/\//i.test(a)
        ) || null;
    }

    /** Parse myapp:// query into the userData object AlgoQA expects. */
    function parseMyAppDeepLink(deepLink) {
        const parsed = new URL(deepLink);
        const userId = parsed.searchParams.get('userId');
        const baseUrl = parsed.searchParams.get('baseUrl');
        const projectId = parsed.searchParams.get('project_id');
        const launchUrl = parsed.searchParams.get('launchUrl');
        const projectName = parsed.searchParams.get('project_name');
        const applicationTypeId = parsed.searchParams.get('application_type_id');
        const subscriptionExpiryDate = parsed.searchParams.get('subscription_expiry_date');

        return {
            userID: userId != null ? Number(userId) : null,
            baseUrl,
            project_id: projectId,
            launchUrl,
            project_name: projectName,
            application_type_id: applicationTypeId != null ? Number(applicationTypeId) : null,
            subscription_expiry_date: subscriptionExpiryDate
        };
    }

    /**
     * Apply a deep link: mark protocol launch, send credentials to renderer.
     * Do NOT replace the scraper UI with loadURL(launchUrl) — that breaks Launch.
     */
    function handleMyAppDeepLink(deepLink) {
        if (!deepLink || typeof deepLink !== 'string') return;
        launchedFromProtocol = true;
        pendingDeepLinkUrl = deepLink;
        console.log('========== DEEP LINK ==========');
        console.log(deepLink);

        let userData;
        try {
            userData = parseMyAppDeepLink(deepLink);
        } catch (err) {
            console.error('Failed to parse myapp:// deep link:', err);
            return;
        }

        console.log('Deep link userData:', userData);

        const sendToRenderer = () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            try {
                mainWindow.webContents.send('launch-mode', true);
                mainWindow.webContents.send('user-data', userData);
            } catch (err) {
                console.error('Failed to send deep-link IPC:', err);
            }
            try {
                mainWindow.show();
                mainWindow.focus();
            } catch (_) {}
        };

        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.webContents.isLoading()) {
                mainWindow.webContents.once('did-finish-load', sendToRenderer);
            } else {
                sendToRenderer();
            }
        }
        // else: createWindow / revealMainWindow will send launch-mode; flush pending then
    }

    function flushPendingDeepLink() {
        if (!pendingDeepLinkUrl) return;
        const link = pendingDeepLinkUrl;
        // handleMyAppDeepLink clears nothing critical; keep URL until sent successfully
        handleMyAppDeepLink(link);
    }

    // ---------------------------------------------------------------------------
    // [ENV] PATH + Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT)
    // GUI apps (Start Menu / Applications) often miss vars a terminal would have.
    // Detect the SDK so bundled Appium/UiAutomator2 can Launch on a fresh PC.
    // ---------------------------------------------------------------------------
    function androidSdkLooksValid(root) {
        if (!root) return false;
        try {
            const adbName = process.platform === 'win32' ? 'adb.exe' : 'adb';
            return fs.existsSync(path.join(root, 'platform-tools', adbName));
        } catch (_) {
            return false;
        }
    }

    function getManagedAndroidSdkRoot() {
        try {
            return path.join(app.getPath('userData'), 'android-sdk');
        } catch (_) {
            return path.join(os.homedir(), '.algoscraper', 'android-sdk');
        }
    }

    function resolveAndroidSdkRoot() {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        const candidates = [
            process.env.ANDROID_HOME,
            process.env.ANDROID_SDK_ROOT,
            path.join(localAppData, 'Android', 'Sdk'),
            path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
            path.join(os.homedir(), 'Android', 'Sdk'),
            'C:\\Android\\Sdk',
            'C:\\Android',
            path.join(os.homedir(), 'Library', 'Android', 'sdk'),
            '/usr/local/share/android-sdk',
            '/opt/homebrew/share/android-sdk',
            '/opt/android-sdk',
            getManagedAndroidSdkRoot()
        ].filter(Boolean);

        for (const root of candidates) {
            const resolved = path.resolve(root);
            if (androidSdkLooksValid(resolved)) return resolved;
        }

        // If adb is already on PATH, walk up from platform-tools to the SDK root.
        try {
            const pathSep = process.platform === 'win32' ? ';' : ':';
            const adbName = process.platform === 'win32' ? 'adb.exe' : 'adb';
            for (const dir of String(process.env.PATH || '').split(pathSep)) {
                if (!dir) continue;
                const adbPath = path.join(dir, adbName);
                if (!fs.existsSync(adbPath)) continue;
                const maybeSdk = path.resolve(dir, '..');
                if (androidSdkLooksValid(maybeSdk)) return maybeSdk;
            }
        } catch (_) {}
        return null;
    }

    function applyAndroidSdkToEnv(env) {
        const target = env || process.env;
        const sdk = resolveAndroidSdkRoot();
        if (!sdk) return null;
        target.ANDROID_HOME = sdk;
        target.ANDROID_SDK_ROOT = sdk;
        const pathSep = process.platform === 'win32' ? ';' : ':';
        const extras = [
            path.join(sdk, 'platform-tools'),
            path.join(sdk, 'emulator'),
            path.join(sdk, 'tools'),
            path.join(sdk, 'tools', 'bin')
        ].filter((p) => {
            try { return fs.existsSync(p); } catch (_) { return false; }
        });
        const parts = String(target.PATH || '').split(pathSep).filter(Boolean);
        for (let i = extras.length - 1; i >= 0; i--) {
            if (!parts.includes(extras[i])) parts.unshift(extras[i]);
        }
        target.PATH = parts.join(pathSep);
        return sdk;
    }

    function javaHomeLooksValid(root) {
        if (!root) return false;
        try {
            const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
            return fs.existsSync(path.join(root, 'bin', javaName));
        } catch (_) {
            return false;
        }
    }

    function firstExistingJavaHome(dirs) {
        for (const dir of dirs) {
            if (!dir) continue;
            try {
                if (!fs.existsSync(dir)) continue;
                if (javaHomeLooksValid(dir)) return dir;
                const entries = fs.readdirSync(dir).sort().reverse();
                for (const name of entries) {
                    const candidate = path.join(dir, name);
                    if (javaHomeLooksValid(candidate)) return candidate;
                    const macHome = path.join(candidate, 'Contents', 'Home');
                    if (javaHomeLooksValid(macHome)) return macHome;
                }
            } catch (_) {}
        }
        return null;
    }

    function resolveJavaHome() {
        if (javaHomeLooksValid(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
        const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const studioJbr = [
            path.join(pf, 'Android', 'Android Studio', 'jbr'),
            path.join(pf, 'Android', 'Android Studio', 'jre'),
            path.join(localAppData, 'Programs', 'Android Studio', 'jbr'),
            path.join(localAppData, 'Programs', 'Android Studio', 'jre'),
            '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
            '/Applications/Android Studio.app/Contents/jre/Contents/Home'
        ];
        for (const root of studioJbr) {
            if (javaHomeLooksValid(root)) return root;
        }
        return firstExistingJavaHome([
            path.join(pf, 'Java'),
            path.join(pf, 'Eclipse Adoptium'),
            path.join(pf, 'Microsoft'),
            path.join(pf, 'Amazon Corretto'),
            path.join(pf86, 'Java'),
            '/Library/Java/JavaVirtualMachines',
            '/opt/homebrew/opt/openjdk',
            '/usr/local/opt/openjdk'
        ]);
    }

    function applyJavaHomeToEnv(env) {
        const target = env || process.env;
        const javaHome = resolveJavaHome();
        if (!javaHome) return null;
        target.JAVA_HOME = javaHome;
        const bin = path.join(javaHome, 'bin');
        const pathSep = process.platform === 'win32' ? ';' : ':';
        const parts = String(target.PATH || '').split(pathSep).filter(Boolean);
        if (fs.existsSync(bin) && !parts.includes(bin)) {
            parts.unshift(bin);
            target.PATH = parts.join(pathSep);
        }
        return javaHome;
    }

    function applyAndroidToolingToEnv(env) {
        const sdk = applyAndroidSdkToEnv(env);
        const javaHome = applyJavaHomeToEnv(env);
        return { sdk, javaHome };
    }

    function platformToolsDownloadUrl() {
        if (process.platform === 'win32') {
            return 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
        }
        if (process.platform === 'darwin') {
            return 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip';
        }
        return 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip';
    }

    async function downloadHttpsFile(fileUrl, destPath) {
        try {
            const { net } = require('electron');
            if (net && typeof net.fetch === 'function') {
                const res = await net.fetch(fileUrl, { redirect: 'follow' });
                if (!res.ok) {
                    throw new Error(`Download failed ${res.status} for ${fileUrl}`);
                }
                const buf = Buffer.from(await res.arrayBuffer());
                fs.writeFileSync(destPath, buf);
                return destPath;
            }
        } catch (netErr) {
            console.warn('electron.net.fetch failed, falling back to https:', netErr && netErr.message);
        }
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(destPath);
            const request = (currentUrl, redirectsLeft) => {
                const getter = String(currentUrl).startsWith('http:') ? http : https;
                const req = getter.get(currentUrl, {
                    headers: { 'User-Agent': 'AlgoScraper' }
                }, (res) => {
                    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                        res.resume();
                        request(res.headers.location, redirectsLeft - 1);
                        return;
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        reject(new Error(`Download failed ${res.statusCode} for ${currentUrl}`));
                        return;
                    }
                    res.pipe(file);
                    file.on('finish', () => file.close(() => resolve(destPath)));
                });
                req.setTimeout(90000, () => {
                    req.destroy();
                    reject(new Error('Download timed out after 90s'));
                });
                req.on('error', (err) => {
                    try { fs.unlinkSync(destPath); } catch (_) {}
                    reject(err);
                });
            };
            request(fileUrl, 5);
        });
    }

    function unzipArchive(zipPath, destDir) {
        fs.mkdirSync(destDir, { recursive: true });
        if (process.platform === 'win32') {
            const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
            let result = spawnSync(tar, ['-xf', zipPath, '-C', destDir], {
                windowsHide: true,
                encoding: 'utf8'
            });
            if (result.status !== 0) {
                result = spawnSync('powershell.exe', [
                    '-NoProfile', '-NonInteractive', '-Command',
                    `Expand-Archive -LiteralPath '${String(zipPath).replace(/'/g, "''")}' -DestinationPath '${String(destDir).replace(/'/g, "''")}' -Force`
                ], { windowsHide: true, encoding: 'utf8' });
            }
            if (result.status !== 0) {
                throw new Error((result.stderr || result.stdout || 'Failed to unzip platform-tools').toString().trim());
            }
            return;
        }
        const result = spawnSync('unzip', ['-o', zipPath, '-d', destDir], { encoding: 'utf8' });
        if (result.status !== 0) {
            throw new Error((result.stderr || result.stdout || 'Failed to unzip platform-tools').toString().trim());
        }
    }

    function copyBundledAndroidSdkIfPresent(managedRoot) {
        const bundledRoots = [
            process.resourcesPath ? path.join(process.resourcesPath, 'android-sdk') : null,
            path.join(__dirname, '..', 'android-sdk')
        ].filter(Boolean);
        for (const root of bundledRoots) {
            if (!androidSdkLooksValid(root)) continue;
            fs.mkdirSync(managedRoot, { recursive: true });
            const from = path.join(root, 'platform-tools');
            const to = path.join(managedRoot, 'platform-tools');
            fs.cpSync(from, to, { recursive: true });
            return androidSdkLooksValid(managedRoot);
        }
        return false;
    }

    async function installPlatformTools(managedRoot) {
        const zipPath = path.join(os.tmpdir(), `algoscraper-platform-tools-${Date.now()}.zip`);
        try {
            console.log('Downloading Android platform-tools for AlgoScraper…');
            await downloadHttpsFile(platformToolsDownloadUrl(), zipPath);
            const existing = path.join(managedRoot, 'platform-tools');
            if (fs.existsSync(existing)) {
                fs.rmSync(existing, { recursive: true, force: true });
            }
            unzipArchive(zipPath, managedRoot);
            const adb = path.join(managedRoot, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
            if (process.platform !== 'win32' && fs.existsSync(adb)) {
                try { fs.chmodSync(adb, 0o755); } catch (_) {}
            }
        } finally {
            try { fs.unlinkSync(zipPath); } catch (_) {}
        }
        if (!androidSdkLooksValid(managedRoot)) {
            throw new Error('Downloaded platform-tools, but adb was not found after extract.');
        }
    }

    let androidSdkEnsurePromise = null;

    async function ensureManagedAndroidSdk() {
        if (androidSdkEnsurePromise) return androidSdkEnsurePromise;
        androidSdkEnsurePromise = (async () => {
            applyAndroidToolingToEnv(process.env);
            let sdk = resolveAndroidSdkRoot();
            if (sdk) return { sdk, source: 'existing' };

            const managed = getManagedAndroidSdkRoot();
            if (androidSdkLooksValid(managed)) {
                applyAndroidToolingToEnv(process.env);
                return { sdk: managed, source: 'managed' };
            }

            try {
                try {
                    if (copyBundledAndroidSdkIfPresent(managed)) {
                        applyAndroidToolingToEnv(process.env);
                        return { sdk: managed, source: 'bundled' };
                    }
                } catch (copyErr) {
                    console.warn('Bundled Android SDK copy skipped:', copyErr && copyErr.message);
                }
                await installPlatformTools(managed);
                applyAndroidToolingToEnv(process.env);
                console.log('Android SDK (managed):', managed);
                return { sdk: managed, source: 'downloaded' };
            } catch (err) {
                console.warn('Could not auto-install Android platform-tools:', err && err.message);
                return { sdk: null, source: 'failed', error: err && err.message };
            }
        })().finally(() => {
            androidSdkEnsurePromise = null;
        });
        return androidSdkEnsurePromise;
    }

    function androidSdkMissingMessage() {
        return process.platform === 'win32'
            ? "AlgoScraper could not set up Android tools on this PC (ANDROID_HOME).\n\n"
              + "The app normally downloads Google platform-tools automatically and sets ANDROID_HOME for you.\n\n"
              + "Check your internet connection and try Launch again.\n"
              + "Or install Android Studio (SDK Platform-Tools). Default folder:\n"
              + "%LOCALAPPDATA%\\Android\\Sdk\n\n"
              + "You still need an emulator or a phone with USB debugging — those cannot be bundled."
            : "AlgoScraper could not set up Android tools on this Mac (ANDROID_HOME).\n\n"
              + "The app normally downloads Google platform-tools automatically and sets ANDROID_HOME for you.\n\n"
              + "Check your internet connection and try Launch again.\n"
              + "Or install Android Studio (SDK Platform-Tools). Default folder:\n"
              + "~/Library/Android/sdk\n\n"
              + "iOS scraping uses Xcode and does not need ANDROID_HOME.\n"
              + "Android still needs an emulator or a phone with USB debugging.";
    }

    const detectedAndroidTooling = applyAndroidToolingToEnv(process.env);
    if (detectedAndroidTooling.sdk) {
        console.log("Android SDK:", detectedAndroidTooling.sdk);
    } else {
        console.warn("Android SDK not found — ANDROID_HOME / ANDROID_SDK_ROOT unset");
    }
    if (detectedAndroidTooling.javaHome) {
        console.log("JAVA_HOME:", detectedAndroidTooling.javaHome);
    } else {
        console.warn("JAVA_HOME not found — UiAutomator2 may fail on a fresh PC");
    }

    // macOS: prepend Homebrew bins. Windows: keep ';' PATH — never use ':' or
    // Unix paths (that previously broke Appium child process resolution).
    if (process.platform !== 'win32') {
        const extraPaths = [
            '/usr/local/bin',
            '/opt/homebrew/bin',
            '/usr/bin',
            '/bin',
            '/usr/sbin',
            '/sbin'
        ];
        const sdkTools = process.env.ANDROID_HOME
            ? path.join(process.env.ANDROID_HOME, 'platform-tools')
            : null;
        if (sdkTools && fs.existsSync(sdkTools)) extraPaths.unshift(sdkTools);
        process.env.PATH = extraPaths.join(':') + (process.env.PATH ? ':' + process.env.PATH : '');
    } else {
        const winExtras = [
            path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
            process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools') : null,
            process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools') : null,
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools') : null
        ].filter(Boolean);
        const parts = String(process.env.PATH || '').split(';').filter(Boolean);
        for (const p of winExtras) {
            try {
                if (fs.existsSync(p) && !parts.includes(p)) parts.unshift(p);
            } catch (_) {}
        }
        process.env.PATH = parts.join(';');
    }

    let appiumProcess = null;      // child we own (bundled OR system Appium) — never both
    let appiumMode = null;         // 'bundled' | 'system' | null
    let appiumStartLogs = [];      // recent Appium stdout/stderr for error dialogs
    let startupGateActive = false; // true while splash → main transition (Windows must not quit)

    function pushAppiumLog(line) {
        const text = String(line || '').trim();
        if (!text) return;
        appiumStartLogs.push(text);
        if (appiumStartLogs.length > 80) {
            appiumStartLogs = appiumStartLogs.slice(-80);
        }
    }

    // ===========================================================================
    // [APPIUM] Lifecycle — prefer bundled, fall back to system Appium + Node
    // Port 4723 only (kill foreign/stale first so bundled and system never conflict)
    // Bundled: appium-runtime/ + bundled-node/
    // System:  PATH / npm-global Appium + system Node (only if bundled fails)
    // Drivers (bundled): uiautomator2 + xcuitest(macOS)
    // ===========================================================================

    // Kill anything already bound to :4723 (foreign or stale Appium) — macOS / Linux / Windows
    function killExistingAppium() {
        return new Promise((resolve) => {
            console.log("Cleaning up any existing process on port 4723...");

            if (appiumProcess) {
                try {
                    if (process.platform === 'win32') {
                        try { spawn('taskkill', ['/pid', String(appiumProcess.pid), '/T', '/F']); } catch (_) {}
                    }
                    appiumProcess.kill("SIGKILL");
                } catch (_) {}
                appiumProcess = null;
            }
            appiumMode = null;

            const isWin = process.platform === 'win32';
            const command = isWin
                ? `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4723 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*appium*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
                : 'lsof -ti:4723 2>/dev/null | xargs kill -9 2>/dev/null; true';

            exec(command, { shell: true, windowsHide: true }, (error) => {
                if (error) {
                    console.log("Port 4723 was clean or cleanup exited cleanly.");
                } else {
                    console.log("Successfully freed port 4723");
                }
                // Give the OS time to release the socket
                setTimeout(resolve, 1200);
            });
        });
    }

    function checkAppium() {
        return new Promise((resolve) => {
            const req = http.get(
                "http://127.0.0.1:4723/status",
                (res) => {
                    res.resume();
                    resolve(res.statusCode === 200);
                }
            );

            req.on("error", () => resolve(false));
            req.setTimeout(2500, () => {
                req.destroy();
                resolve(false);
            });
        });
    }

    function isOwnedAppiumProcessAlive() {
        return !!(appiumProcess && appiumProcess.pid && !appiumProcess.killed);
    }

    /** True when the Appium we just spawned actually loaded UiAutomator2. */
    function appiumServerLoadedUia2() {
        const text = appiumStartLogs.join('\n');
        if (!text) return false;
        if (/No drivers have been installed/i.test(text)) return false;
        if (/Could not find.*driver.*use-drivers/i.test(text)) return false;
        return /Attempting to load driver uiautomator2|loaded driver uiautomator2|uiautomator2@/i.test(text);
    }

    // Back-compat alias
    function isBundledAppiumProcessAlive() {
        return isOwnedAppiumProcessAlive();
    }

    function isBundledNodePath(candidate) {
        if (!candidate) return false;
        try {
            const resolved = path.resolve(candidate);
            const bundled = path.resolve(getBundledNodePath());
            if (resolved === bundled) return true;
            const bundledDir = path.resolve(getBundledNodeDir());
            return resolved === bundledDir || resolved.startsWith(bundledDir + path.sep);
        } catch (_) {
            return String(candidate).includes('bundled-node');
        }
    }

    /**
     * System Node only (never the AlgoScraper bundled-node binary).
     * Returns absolute path or null.
     */
    function resolveSystemNodeBinary() {
        const candidates = [
            process.env.ALGO_SYSTEM_NODE,
            process.env.NODE_BINARY && !isBundledNodePath(process.env.NODE_BINARY)
                ? process.env.NODE_BINARY
                : null,
            '/usr/local/bin/node',
            '/opt/homebrew/bin/node',
            '/usr/bin/node',
            process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : null,
            process.platform === 'win32' ? 'C:\\Program Files (x86)\\nodejs\\node.exe' : null
        ].filter(Boolean);

        for (const candidate of candidates) {
            try {
                if (fs.existsSync(candidate) && !isBundledNodePath(candidate)) {
                    return candidate;
                }
            } catch (_) {}
        }

        try {
            const cmd = process.platform === 'win32' ? 'where node' : 'which -a node 2>/dev/null || command -v node';
            const foundLines = require('child_process').execSync(cmd, {
                encoding: 'utf8',
                shell: true,
                windowsHide: true,
                timeout: 4000
            }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

            for (const found of foundLines) {
                if (fs.existsSync(found) && !isBundledNodePath(found)) {
                    return found;
                }
            }
        } catch (_) {}

        return null;
    }

    /**
     * True when Appium was resolved from this repo's node_modules (not appium-runtime
     * and not a real global install). That copy is Appium 2.19; mixing it with the
     * user's ~/.appium UiAutomator2 6.x (Appium 3) yields zero usable drivers.
     */
    function isProjectLocalAppium(mainPath) {
        if (!mainPath) return false;
        const resolved = path.resolve(String(mainPath));
        if (resolved.includes(`${path.sep}appium-runtime${path.sep}`)) return false;
        const projectRoot = path.resolve(__dirname, '..');
        const prefix = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
        return resolved.startsWith(prefix);
    }

    /**
     * Locate system-installed Appium main.js using system Node / npm global.
     * Returns { nodeBinary, appiumMain, via } or null.
     */
    function resolveSystemAppium() {
        const nodeBinary = resolveSystemNodeBinary();
        if (!nodeBinary) {
            return null;
        }

        // 1) require.resolve via system Node from a neutral cwd.
        // Project node_modules/appium is Appium 2.19 without a matching driver when
        // ~/.appium only has UiAutomator2 6.x (Appium 3). Walking up from the repo
        // would pick that copy and Launch would fail with "Could not find a driver".
        try {
            const quotedNode = process.platform === 'win32' ? `"${nodeBinary}"` : nodeBinary;
            const main = require('child_process').execSync(
                `${quotedNode} -e "console.log(require.resolve('appium/build/lib/main.js'))"`,
                {
                    encoding: 'utf8',
                    shell: true,
                    windowsHide: true,
                    timeout: 10000,
                    cwd: os.tmpdir(),
                    env: Object.assign({}, process.env, {
                        NODE_PATH: process.env.ALGO_SYSTEM_NODE_PATH || ''
                    })
                }
            ).trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();

            if (main && fs.existsSync(main) && !isProjectLocalAppium(main)) {
                return { nodeBinary, appiumMain: main, via: 'require.resolve' };
            }
        } catch (_) {}

        // 2) npm root -g → appium/build/lib/main.js
        try {
            const npmRoot = require('child_process').execSync('npm root -g', {
                encoding: 'utf8',
                shell: true,
                windowsHide: true,
                timeout: 8000
            }).trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();

            if (npmRoot) {
                const main = path.join(npmRoot, 'appium', 'build', 'lib', 'main.js');
                if (fs.existsSync(main) && !isProjectLocalAppium(main)) {
                    return { nodeBinary, appiumMain: main, via: 'npm-root-g' };
                }
            }
        } catch (_) {}

        // 3) Common install locations
        const commons = process.platform === 'win32'
            ? [
                path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'appium', 'build', 'lib', 'main.js'),
                path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'appium', 'build', 'lib', 'main.js')
            ]
            : [
                '/usr/local/lib/node_modules/appium/build/lib/main.js',
                '/opt/homebrew/lib/node_modules/appium/build/lib/main.js',
                path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules', 'appium', 'build', 'lib', 'main.js')
            ];

        for (const main of commons) {
            try {
                if (main && fs.existsSync(main) && !isProjectLocalAppium(main)) {
                    return { nodeBinary, appiumMain: main, via: 'common-path' };
                }
            } catch (_) {}
        }

        return null;
    }

    function clearAppiumSessions() {
        return new Promise((resolve) => {
            const req = http.get("http://127.0.0.1:4723/sessions", (res) => {
                let body = "";
                res.on("data", (c) => { body += c; });
                res.on("end", () => {
                    try {
                        const parsed = JSON.parse(body);
                        const sessions = (parsed && parsed.value) || [];
                        let pending = sessions.length;
                        if (!pending) {
                            resolve({ cleared: 0 });
                            return;
                        }
                        sessions.forEach((s) => {
                            const id = s.id || s.sessionId;
                            const del = http.request({
                                hostname: "127.0.0.1",
                                port: 4723,
                                path: `/session/${id}`,
                                method: "DELETE"
                            }, (r) => {
                                r.resume();
                                pending -= 1;
                                if (pending <= 0) resolve({ cleared: sessions.length });
                            });
                            del.on("error", () => {
                                pending -= 1;
                                if (pending <= 0) resolve({ cleared: sessions.length });
                            });
                            del.end();
                        });
                    } catch (e) {
                        resolve({ cleared: 0, error: e.message });
                    }
                });
            });
            req.on("error", () => resolve({ cleared: 0 }));
            req.setTimeout(3000, () => {
                req.destroy();
                resolve({ cleared: 0 });
            });
        });
    }

    function getAppiumRuntimePath() {
        return app.isPackaged
            ? path.join(process.resourcesPath, "appium-runtime")
            : path.join(__dirname, "..", "appium-runtime");
    }

    function getBundledNodeDir() {
        return app.isPackaged
            ? path.join(process.resourcesPath, "bundled-node")
            : path.join(__dirname, "..", "bundled-node");
    }

    function getBundledNodePath() {
        const binaryName = process.platform === "win32" ? "node.exe" : "node";
        return path.join(getBundledNodeDir(), binaryName);
    }

    /**
     * Always write a clean extensions.yaml for the bundled runtime.
     * Registers drivers that are actually present:
     *   - uiautomator2  → Android (always required)
     *   - xcuitest      → iOS (macOS builds; omitted from Windows packages to shrink installer)
     *
     * @param {string} runtimePath  Folder that contains node_modules/appium-* drivers
     * @param {string} [homePath]   Writable APPIUM_HOME (defaults to runtimePath).
     *                              Packaged Windows installs use userData because
     *                              Program Files / resources may be read-only.
     */
    function repairAppiumExtensionsYaml(runtimePath, homePath) {
        const appiumHome = homePath || runtimePath;
        const cacheDir = path.join(appiumHome, "node_modules", ".cache", "appium");
        const yamlPath = path.join(cacheDir, "extensions.yaml");

        const uia2Path = path.resolve(runtimePath, "node_modules", "appium-uiautomator2-driver");
        const xcuitestPath = path.resolve(runtimePath, "node_modules", "appium-xcuitest-driver");
        const hasUia2 = fs.existsSync(uia2Path);
        const hasXcuitest = fs.existsSync(xcuitestPath);

        // Quote paths for YAML — project folders often contain spaces
        // (e.g. "algoScraper Android"). Unquoted installPath breaks driver load.
        const yq = (value) => JSON.stringify(String(value));

        let uia2Version = "2.45.1";
        let xcuitestVersion = "9.10.5";
        try {
            if (hasUia2) {
                uia2Version = JSON.parse(fs.readFileSync(path.join(uia2Path, "package.json"), "utf8")).version || uia2Version;
            }
        } catch (_) {}
        try {
            if (hasXcuitest) {
                xcuitestVersion = JSON.parse(fs.readFileSync(path.join(xcuitestPath, "package.json"), "utf8")).version || xcuitestVersion;
            }
        } catch (_) {}

        const lines = [];
        if (!hasUia2 && !hasXcuitest) {
            lines.push("drivers: {}");
        } else {
            lines.push("drivers:");
            if (hasXcuitest) {
                lines.push(
                    "  xcuitest:",
                    "    automationName: XCUITest",
                    "    platformNames:",
                    "      - iOS",
                    "      - tvOS",
                    "    mainClass: XCUITestDriver",
                    "    scripts:",
                    "      build-wda: ./scripts/build-wda.js",
                    "      open-wda: ./scripts/open-wda.js",
                    "      tunnel-creation: ./scripts/tunnel-creation.mjs",
                    "      download-wda-sim: ./scripts/download-wda-sim.mjs",
                    "    doctor:",
                    "      checks:",
                    "        - ./build/lib/doctor/required-checks.js",
                    "        - ./build/lib/doctor/optional-checks.js",
                    "    pkgName: appium-xcuitest-driver",
                    `    version: ${yq(xcuitestVersion)}`,
                    "    appiumVersion: ^2.5.4",
                    "    installType: npm",
                    `    installSpec: ${yq(`appium-xcuitest-driver@${xcuitestVersion}`)}`,
                    `    installPath: ${yq(xcuitestPath)}`
                );
            }
            if (hasUia2) {
                lines.push(
                    "  uiautomator2:",
                    "    automationName: UiAutomator2",
                    "    platformNames:",
                    "      - Android",
                    "    mainClass: AndroidUiautomator2Driver",
                    "    scripts:",
                    "      reset: scripts/reset.js",
                    "    doctor:",
                    "      checks:",
                    "        - ./build/lib/doctor/required-checks.js",
                    "        - ./build/lib/doctor/optional-checks.js",
                    "    pkgName: appium-uiautomator2-driver",
                    `    version: ${yq(uia2Version)}`,
                    "    appiumVersion: ^2.4.1",
                    "    installType: npm",
                    `    installSpec: ${yq(`appium-uiautomator2-driver@${uia2Version}`)}`,
                    `    installPath: ${yq(uia2Path)}`
                );
            }
        }
        lines.push("plugins: {}", "schemaRev: 4", "");

        try {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(yamlPath, lines.join("\n"), "utf8");
            console.log(
                "Wrote clean Appium extensions.yaml",
                `(home=${appiumHome}, uia2=${hasUia2}, xcuitest=${hasXcuitest})`
            );
            return { repaired: true, path: yamlPath, home: appiumHome, hasUia2, hasXcuitest };
        } catch (err) {
            console.error("Failed to write extensions.yaml:", err);
            return { repaired: false, error: err.message, home: appiumHome };
        }
    }

    /**
     * APPIUM_HOME must contain node_modules/appium-uiautomator2-driver (Appium 2
     * scans that tree). Unpackaged: use appium-runtime itself. Packaged: writable
     * userData home with junctions back to the bundled drivers.
     */
    function getWritableAppiumHome(runtimePath) {
        if (!app.isPackaged) {
            return runtimePath;
        }
        try {
            const home = path.join(app.getPath('userData'), 'appium-home');
            fs.mkdirSync(home, { recursive: true });
            return home;
        } catch (_) {
            return runtimePath;
        }
    }

    function extensionsYamlPath(appiumHome) {
        return path.join(appiumHome, "node_modules", ".cache", "appium", "extensions.yaml");
    }

    function extensionsYamlHasUia2(appiumHome) {
        try {
            const yamlPath = extensionsYamlPath(appiumHome);
            if (!fs.existsSync(yamlPath)) return false;
            const text = fs.readFileSync(yamlPath, "utf8");
            return /uiautomator2/i.test(text) && /UiAutomator2/.test(text);
        } catch (_) {
            return false;
        }
    }

    function linkDir(src, dest) {
        if (!fs.existsSync(src)) return false;
        if (fs.existsSync(dest)) return true;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
            fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
            return true;
        } catch (err) {
            console.warn(`Failed to link ${src} → ${dest}:`, err.message || err);
            return false;
        }
    }

    /**
     * Appium 2 only auto-discovers drivers under APPIUM_HOME/node_modules.
     * When home !== runtime, junction the bundled drivers into that home.
     */
    function linkBundledDriversIntoHome(runtimePath, appiumHome) {
        if (path.resolve(runtimePath) === path.resolve(appiumHome)) {
            return;
        }
        const nm = path.join(runtimePath, 'node_modules');
        const destNm = path.join(appiumHome, 'node_modules');
        fs.mkdirSync(destNm, { recursive: true });
        linkDir(
            path.join(nm, 'appium-uiautomator2-driver'),
            path.join(destNm, 'appium-uiautomator2-driver')
        );
        if (process.platform === 'darwin') {
            linkDir(
                path.join(nm, 'appium-xcuitest-driver'),
                path.join(destNm, 'appium-xcuitest-driver')
            );
        }
        const pkgPath = path.join(appiumHome, 'package.json');
        if (!fs.existsSync(pkgPath)) {
            const deps = { 'appium-uiautomator2-driver': '*' };
            if (process.platform === 'darwin') deps['appium-xcuitest-driver'] = '*';
            fs.writeFileSync(pkgPath, JSON.stringify({
                name: 'algoscraper-appium-home',
                private: true,
                dependencies: deps
            }, null, 2), 'utf8');
        }
    }

    /**
     * Make sure Appium 2 actually lists UiAutomator2 (yaml alone is not always enough).
     * Uses `appium driver install --source local` against the bundled driver folder.
     */
    function ensureBundledUia2Registered(runtimePath, appiumHome, nodeBinary, appiumMain) {
        const uia2Path = path.join(runtimePath, "node_modules", "appium-uiautomator2-driver");
        if (!fs.existsSync(uia2Path)) {
            throw new Error(`Bundled UiAutomator2 missing at ${uia2Path}. Run npm run setup.`);
        }

        repairAppiumExtensionsYaml(runtimePath, appiumHome);
        if (extensionsYamlHasUia2(appiumHome)) {
            try { fs.writeFileSync(path.join(appiumHome, ".uia2-registered"), uia2Path, "utf8"); } catch (_) {}
            return { ok: true, via: 'yaml' };
        }

        const marker = path.join(appiumHome, ".uia2-registered");
        try {
            if (fs.existsSync(marker)
                && fs.readFileSync(marker, "utf8").trim() === uia2Path
                && extensionsYamlHasUia2(appiumHome)) {
                return { ok: true, via: 'marker' };
            }
        } catch (_) {}

        const env = Object.assign({}, process.env, {
            APPIUM_HOME: appiumHome,
            NODE_PATH: path.join(runtimePath, "node_modules")
        });
        delete env.ELECTRON_RUN_AS_NODE;

        const result = spawnSync(
            nodeBinary,
            [appiumMain, "driver", "install", "--source", "local", uia2Path],
            {
                cwd: runtimePath,
                env,
                encoding: "utf8",
                timeout: 120000,
                windowsHide: true,
                shell: false
            }
        );
        console.log(
            "appium driver install --source local uiautomator2",
            "status=", result.status,
            (result.stdout || "").slice(-500),
            (result.stderr || "").slice(-500)
        );
        repairAppiumExtensionsYaml(runtimePath, appiumHome);
        const ok = extensionsYamlHasUia2(appiumHome);
        if (ok) {
            try { fs.writeFileSync(marker, uia2Path, "utf8"); } catch (_) {}
        }
        return { ok, via: 'local-install', status: result.status };
    }

    function verifyBundledRuntime() {
        const runtimePath = getAppiumRuntimePath();
        const appiumMain = path.join(
            runtimePath,
            "node_modules",
            "appium",
            "build",
            "lib",
            "main.js"
        );
        const uia2 = path.join(runtimePath, "node_modules", "appium-uiautomator2-driver");
        const xcuitest = path.join(runtimePath, "node_modules", "appium-xcuitest-driver");
        let nodeBinary = getBundledNodePath();

        if (!fs.existsSync(runtimePath)) {
            throw new Error(`Bundled appium-runtime folder missing at: ${runtimePath}. Reinstall AlgoScraper.`);
        }
        if (!fs.existsSync(appiumMain)) {
            throw new Error(`Bundled Appium not found at: ${appiumMain}. Reinstall AlgoScraper (appium-runtime incomplete).`);
        }
        if (!fs.existsSync(uia2)) {
            throw new Error(
                `Bundled UiAutomator2 driver missing at: ${uia2}. ` +
                `From the project folder run: npm run setup`
            );
        }
        // XCUITest is macOS/iOS only — Windows packages intentionally omit it.
        // Don't hard-fail Android if XCUITest is missing; warn and continue with uia2.
        if (process.platform === "darwin" && !fs.existsSync(xcuitest)) {
            console.warn(
                "Bundled XCUITest driver missing — iOS scrape unavailable until you run: npm run setup"
            );
        }
        if (!fs.existsSync(nodeBinary)) {
            const systemNode = resolveSystemNodeBinary();
            if (systemNode && fs.existsSync(systemNode)) {
                console.warn("Bundled Node missing — using system Node for Appium:", systemNode);
                nodeBinary = systemNode;
            } else {
                throw new Error(
                    `Bundled Node binary missing at: ${nodeBinary}. ` +
                    (process.platform === 'win32'
                        ? 'Install Node.js, or rebuild with npm run make:win (must include bundled-node/node.exe).'
                        : 'Run: npm run download-node')
                );
            }
        }

        const appiumHome = getWritableAppiumHome(runtimePath);
        linkBundledDriversIntoHome(runtimePath, appiumHome);
        repairAppiumExtensionsYaml(runtimePath, appiumHome);
        try {
            ensureBundledUia2Registered(runtimePath, appiumHome, nodeBinary, appiumMain);
        } catch (regErr) {
            console.warn("UiAutomator2 register skipped:", regErr.message || regErr);
        }
        return { runtimePath, appiumMain, appiumHome, nodeBinary };
    }

    function resolveAppiumNodeBinary() {
        // 1) Prefer Node.js shipped inside AlgoScraper (no user install needed)
        const bundled = getBundledNodePath();
        try {
            if (fs.existsSync(bundled)) {
                console.log("Using bundled Node.js:", bundled);
                return bundled;
            }
        } catch (_) {}

        // 2) System Node (fallback path for incomplete installs)
        const systemNode = resolveSystemNodeBinary();
        if (systemNode) {
            console.log("Using system Node.js:", systemNode);
            return systemNode;
        }

        return 'node';
    }

    function buildAppiumServerArgs(extra = []) {
        return [
            "--address", "127.0.0.1",
            "--port", "4723",
            "--base-path", "/",
            "--log-level", "info",
            "--log-no-colors",
            ...extra
        ];
    }

    function attachOwnedAppiumProcess(proc, { nodeBinary, settleLabel }) {
        return new Promise((resolve, reject) => {
            appiumProcess = proc;

            let settled = false;

            const settleOk = () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };

            const settleErr = (err) => {
                if (!settled) {
                    settled = true;
                    const detail = appiumStartLogs.slice(-12).join(" | ");
                    reject(new Error(`${err && err.message ? err.message : err}${detail ? ` | logs: ${detail}` : ""}`));
                }
            };

            appiumProcess.on("spawn", () => {
                pushAppiumLog(`spawned pid=${appiumProcess && appiumProcess.pid} mode=${settleLabel}`);
                settleOk();
            });

            if (appiumProcess.stdout) {
                appiumProcess.stdout.on("data", (data) => {
                    const text = data.toString();
                    console.log("[Appium]", text);
                    pushAppiumLog(text);
                });
            }

            if (appiumProcess.stderr) {
                appiumProcess.stderr.on("data", (data) => {
                    const text = data.toString();
                    console.log("[Appium Error]", text);
                    pushAppiumLog(text);
                });
            }

            appiumProcess.on("error", (err) => {
                appiumProcess = null;
                appiumMode = null;
                if (err && err.code === 'ENOENT') {
                    settleErr(new Error(
                        `Node.js binary not found ("${nodeBinary}").`
                    ));
                } else {
                    settleErr(err);
                }
            });

            appiumProcess.on("exit", (code, signal) => {
                console.log(`Appium exited code=${code} signal=${signal} mode=${settleLabel}`);
                pushAppiumLog(`exit code=${code} signal=${signal}`);
                appiumProcess = null;
                appiumMode = null;
                if (!settled) {
                    settleErr(new Error(`Appium exited immediately with code ${code} signal ${signal}`));
                }
            });

            setTimeout(() => {
                if (isOwnedAppiumProcessAlive()) {
                    settleOk();
                }
            }, 2000);
        });
    }

    async function startBundledAppium() {
        if (isOwnedAppiumProcessAlive() && appiumMode === 'bundled') {
            return;
        }

        let runtimePath;
        let appiumMain;
        let appiumHome;
        let nodeBinary;
        ({ runtimePath, appiumMain, appiumHome, nodeBinary } = verifyBundledRuntime());

        if (!nodeBinary || !fs.existsSync(nodeBinary)) {
            nodeBinary = resolveAppiumNodeBinary();
        }

        console.log("Starting bundled Appium with:", nodeBinary, appiumMain);
        appiumStartLogs = [];
        pushAppiumLog(`mode=bundled`);
        pushAppiumLog(`platform=${process.platform}`);
        pushAppiumLog(`packaged=${app.isPackaged}`);
        pushAppiumLog(`resourcesPath=${process.resourcesPath || '(dev)'}`);
        pushAppiumLog(`node=${nodeBinary}`);
        pushAppiumLog(`nodeExists=${fs.existsSync(nodeBinary)}`);
        pushAppiumLog(`main=${appiumMain}`);
        pushAppiumLog(`mainExists=${fs.existsSync(appiumMain)}`);
        pushAppiumLog(`APPIUM_HOME=${appiumHome}`);
        pushAppiumLog(`runtime=${runtimePath}`);

        const nodeDir = path.dirname(nodeBinary);
        const pathSep = process.platform === 'win32' ? ';' : ':';
        const mergedPath = [nodeDir, process.env.PATH || ''].filter(Boolean).join(pathSep);

        const appiumEnv = Object.assign({}, process.env, {
            APPIUM_HOME: appiumHome,
            NODE_PATH: path.join(runtimePath, "node_modules"),
            PATH: mergedPath,
            NODE_BINARY: nodeBinary
        });
        applyAndroidToolingToEnv(appiumEnv);
        delete appiumEnv.ELECTRON_RUN_AS_NODE;
        delete appiumEnv.ELECTRON_NO_ATTACH_CONSOLE;
        pushAppiumLog(`ANDROID_HOME=${appiumEnv.ANDROID_HOME || '(missing)'}`);
        pushAppiumLog(`JAVA_HOME=${appiumEnv.JAVA_HOME || '(missing)'}`);

        const driverList = [];
        if (fs.existsSync(path.join(runtimePath, "node_modules", "appium-uiautomator2-driver"))) {
            driverList.push("uiautomator2");
        }
        if (process.platform === 'darwin'
            && fs.existsSync(path.join(runtimePath, "node_modules", "appium-xcuitest-driver"))) {
            driverList.push("xcuitest");
        }
        if (!driverList.length) {
            throw new Error("No Appium drivers found in appium-runtime. Reinstall AlgoScraper.");
        }
        pushAppiumLog(`drivers=${driverList.join(',')}`);

        // Load UiAutomator2 explicitly. yaml is repaired just above so this does not
        // start an empty server the way --use-drivers did with a blank APPIUM_HOME.
        const args = [
            appiumMain,
            ...buildAppiumServerArgs(['--use-drivers', driverList.join(',')])
        ];

        let proc;
        try {
            proc = spawn(nodeBinary, args, {
                cwd: runtimePath,
                detached: false,
                env: appiumEnv,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                shell: false
            });
        } catch (spawnSyncErr) {
            throw spawnSyncErr;
        }

        appiumMode = 'bundled';
        await attachOwnedAppiumProcess(proc, { nodeBinary, settleLabel: 'bundled' });
    }

    async function startSystemAppium() {
        if (isOwnedAppiumProcessAlive() && appiumMode === 'system') {
            return;
        }

        const resolved = resolveSystemAppium();
        if (!resolved) {
            throw new Error(
                "System Appium/Node not found. Install Node.js and Appium globally "
                + "(npm install -g appium) and required drivers "
                + "(appium driver install uiautomator2"
                + (process.platform === 'darwin' ? " / xcuitest" : "")
                + ")."
            );
        }

        const { nodeBinary, appiumMain, via } = resolved;
        console.log("Starting system Appium with:", nodeBinary, appiumMain, `(via ${via})`);
        appiumStartLogs = [];
        pushAppiumLog(`mode=system`);
        pushAppiumLog(`platform=${process.platform}`);
        pushAppiumLog(`node=${nodeBinary}`);
        pushAppiumLog(`main=${appiumMain}`);
        pushAppiumLog(`via=${via}`);

        const nodeDir = path.dirname(nodeBinary);
        const pathSep = process.platform === 'win32' ? ';' : ':';
        // Prefer system node; strip bundled-node from PATH to avoid mixing runtimes
        const pathParts = String(process.env.PATH || '')
            .split(pathSep)
            .filter((p) => p && !p.includes('bundled-node'));
        const mergedPath = [nodeDir, ...pathParts].join(pathSep);

        const appiumEnv = Object.assign({}, process.env, {
            PATH: mergedPath,
            NODE_BINARY: nodeBinary
        });
        applyAndroidToolingToEnv(appiumEnv);
        // Critical: do not mix bundled modules / bundled APPIUM_HOME with system Appium
        delete appiumEnv.NODE_PATH;
        pushAppiumLog(`ANDROID_HOME=${appiumEnv.ANDROID_HOME || '(missing)'}`);
        pushAppiumLog(`JAVA_HOME=${appiumEnv.JAVA_HOME || '(missing)'}`);
        delete appiumEnv.ELECTRON_RUN_AS_NODE;
        delete appiumEnv.ELECTRON_NO_ATTACH_CONSOLE;
        if (appiumEnv.APPIUM_HOME) {
            const home = String(appiumEnv.APPIUM_HOME);
            if (home.includes('appium-runtime') || home.includes('appium-home')
                || (process.resourcesPath && home.includes(process.resourcesPath))) {
                delete appiumEnv.APPIUM_HOME;
            }
        }

        // Let system Appium load drivers from the user's ~/.appium (no --use-drivers forced
        // from bundled paths — avoids conflict / missing-driver errors).
        const args = [appiumMain, ...buildAppiumServerArgs()];

        let proc;
        try {
            proc = spawn(nodeBinary, args, {
                cwd: path.dirname(appiumMain),
                detached: false,
                env: appiumEnv,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                shell: false
            });
        } catch (spawnSyncErr) {
            throw spawnSyncErr;
        }

        appiumMode = 'system';
        await attachOwnedAppiumProcess(proc, { nodeBinary, settleLabel: 'system' });
    }

    /** @param {'bundled'|'system'} mode */
    async function startAppium(mode = 'bundled') {
        if (mode === 'system') {
            return startSystemAppium();
        }
        return startBundledAppium();
    }

    async function waitForAppium(timeout = 60000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            // If our child died while waiting, fail fast
            if (!isOwnedAppiumProcessAlive() && Date.now() - start > 3000) {
                return false;
            }
            if (await checkAppium()) {
                return true;
            }
            await new Promise(r => setTimeout(r, 800));
        }
        return false;
    }

    async function tryStartAppiumMode(mode, options = {}) {
        const maxRetries = options.maxRetries || 2;
        const readyTimeout = options.readyTimeout
            || (process.platform === 'win32' ? 90000 : 45000);
        let lastError = `Failed to start ${mode} Appium`;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const label = mode === 'bundled' ? 'Bundled Automation Engine' : 'System Automation Engine';
            console.log(`Starting ${mode} Appium (Attempt ${attempt}/${maxRetries})`);
            await setStartupStatus({
                step: 'appium',
                status: 'active',
                detail: `${label} (${attempt}/${maxRetries})`,
                headline: 'Preparing AlgoScraper',
                live: `${label} (${attempt}/${maxRetries})`
            });

            try {
                await killExistingAppium();
                await startAppium(mode);
                const running = await waitForAppium(readyTimeout);
                if (running) {
                    if (!appiumServerLoadedUia2()) {
                        lastError = `${label} started on port 4723 but UiAutomator2 did not load.`
                            + (appiumStartLogs.length ? `\nRecent logs:\n${appiumStartLogs.slice(-20).join("\n")}` : "");
                        throw new Error(lastError);
                    }
                    try { await clearAppiumSessions(); } catch (_) {}
                    console.log(`${mode} Appium ready on http://127.0.0.1:4723`);
                    return { success: true, mode, attempt };
                }
                lastError = `${label} started but port 4723 did not become ready in time.`
                    + (appiumStartLogs.length ? `\nRecent logs:\n${appiumStartLogs.slice(-15).join("\n")}` : "");
            } catch (e) {
                console.log(`${mode} Appium start failed:`, e);
                lastError = e?.stack || e?.message || String(e);
            }

            if (appiumProcess) {
                try { appiumProcess.kill("SIGKILL"); } catch (_) {}
                appiumProcess = null;
            }
            appiumMode = null;
            await new Promise(r => setTimeout(r, 1200 * attempt));
        }

        return { success: false, mode, error: lastError };
    }

    /**
     * Appium lifecycle (bundled first, system fallback):
     * 1) If OUR child is alive and /status is OK → clear leftover sessions and reuse
     * 2) Else kill :4723, try bundled Appium+Node
     * 3) If bundled fails → try system Appium+Node (no env mix / no dual servers)
     * 4) If both fail → return combined error for the dialog
     */
    async function ensureAppiumStarted(options = {}) {
        const forceRestart = !!(options && options.forceRestart);

        // Reuse only when this app owns the process and it is healthy
        if (!forceRestart && isOwnedAppiumProcessAlive() && await checkAppium()) {
            try {
                const runtimePath = getAppiumRuntimePath();
                const home = getWritableAppiumHome(runtimePath);
                if (!extensionsYamlHasUia2(home) || !appiumServerLoadedUia2()) {
                    console.log("Owned Appium is up but UiAutomator2 is not loaded — restarting");
                } else {
                    console.log(`Owned Appium already running (mode=${appiumMode}, pid=${appiumProcess.pid})`);
                    try { await clearAppiumSessions(); } catch (_) {}
                    return { success: true, reused: true, mode: appiumMode || 'unknown' };
                }
            } catch (_) {
                if (appiumServerLoadedUia2()) {
                    console.log(`Owned Appium already running (mode=${appiumMode}, pid=${appiumProcess.pid})`);
                    try { await clearAppiumSessions(); } catch (_) {}
                    return { success: true, reused: true, mode: appiumMode || 'unknown' };
                }
            }
        }

        if (!forceRestart && !isOwnedAppiumProcessAlive() && await checkAppium()) {
            console.log("Foreign Appium detected on :4723 — replacing with AlgoScraper-managed Appium");
        }

        const bundledResult = await tryStartAppiumMode('bundled', {
            maxRetries: 3,
            readyTimeout: process.platform === 'win32' ? 90000 : 45000
        });
        if (bundledResult.success) {
            return { success: true, reused: false, mode: 'bundled', attempt: bundledResult.attempt };
        }

        // --- System fallback (Android + iOS / Windows + macOS) ---
        const systemAvailable = !!resolveSystemAppium();
        await setStartupStatus({
            step: 'appium',
            status: 'active',
            detail: systemAvailable
                ? 'Bundled engine failed — trying system Appium…'
                : 'Bundled engine failed — checking system Appium…',
            headline: 'Preparing AlgoScraper',
            live: systemAvailable
                ? 'Bundled engine failed — trying system Appium…'
                : 'Bundled engine failed — checking system Appium…'
        });

        if (!systemAvailable) {
            const tips = process.platform === 'win32'
                ? "\n\nFix:\n1) Reinstall AlgoScraper (bundled Appium)\n2) Or install system Node.js + Appium:\n   npm install -g appium\n   appium driver install uiautomator2\n3) Allow AlgoScraper/node.exe in antivirus/firewall\n4) Ensure port 4723 is free"
                : "\n\nFix:\n1) From the project folder run: npm run setup\n2) Or install system Node.js + Appium:\n   npm install -g appium\n   appium driver install uiautomator2\n   appium driver install xcuitest";

            return {
                success: false,
                error:
                    "Could not start the automation engine.\n\n"
                    + "=== Bundled Appium ===\n"
                    + (bundledResult.error || "Unknown bundled failure")
                    + "\n\n=== System Appium ===\n"
                    + "Not available (system Node.js and/or Appium not found)."
                    + tips
            };
        }

        const systemResult = await tryStartAppiumMode('system', {
            maxRetries: 2,
            readyTimeout: process.platform === 'win32' ? 90000 : 45000
        });
        if (systemResult.success) {
            return { success: true, reused: false, mode: 'system', attempt: systemResult.attempt };
        }

        const tips = process.platform === 'win32'
            ? "\n\nFix:\n1) Reinstall AlgoScraper\n2) Or repair system install: npm install -g appium && appium driver install uiautomator2\n3) Allow node.exe in antivirus\n4) Free port 4723"
            : "\n\nFix:\n1) Run: npm run setup\n2) Or repair system install: npm install -g appium && appium driver install uiautomator2 && appium driver install xcuitest\n3) Free port 4723";

        return {
            success: false,
            error:
                "Could not start the automation engine with bundled OR system Appium.\n\n"
                + "=== Bundled Appium ===\n"
                + (bundledResult.error || "Unknown bundled failure")
                + "\n\n=== System Appium ===\n"
                + (systemResult.error || "Unknown system failure")
                + tips
        };
    }

    ipcMain.on('msg', (event, message) => {
      if (message){
        // startApp(message);
      }
     });
    // Handle creating/removing shortcuts on Windows when installing/uninstalling.
    if (require('electron-squirrel-startup')) {
      app.quit();
    }

    // ===========================================================================
    // [SPLASH] Compact startup popup — same layout as original, modern styling
    // Messages update ONE AT A TIME (fade) while prereq → Appium → device → launch run
    // Loaded from src/splash.html (file://) so icons/fonts work on Windows packaged builds
    // ===========================================================================
    function getAppWindowIcon() {
      if (process.platform === 'win32') {
        const ico = path.join(__dirname, '..', 'assets', 'algoScraper Logo.ico');
        if (fs.existsSync(ico)) return ico;
      }
      return path.join(__dirname, '..', 'assets', 'algoScraper Logo.png');
    }

    function createLoadingWindow() {
      loadingWindow = new BrowserWindow({
        width: 420,
        height: 260,
        frame: false,
        transparent: false,
        backgroundColor: "#141820",
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        alwaysOnTop: true,
        show: false,
        skipTaskbar: true,
        hasShadow: true,
        roundedCorners: true,
        icon: getAppWindowIcon(),
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          sandbox: false
        }
      });

      loadRendererIntoWindow(loadingWindow, 'splash.html').catch((err) => {
        console.error('Failed to load splash.html:', err);
      });

      loadingWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
        console.error('Splash did-fail-load:', code, desc, url);
      });

      loadingWindow.once('ready-to-show', () => {
        if (loadingWindow && !loadingWindow.isDestroyed()) {
          loadingWindow.center();
          loadingWindow.show();
        }
      });
    }

    async function waitForLoadingWindowReady() {
      if (!loadingWindow || loadingWindow.isDestroyed()) return;
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          if (!loadingWindow.webContents.isLoading()) {
            done();
            return;
          }
          loadingWindow.webContents.once('did-finish-load', done);
        } catch (_) {
          done();
          return;
        }
        setTimeout(done, 2500);
      });
      await sleep(60);
    }

    function resolveRendererFile(fileName) {
      // Always load UI from the same place as main.js (inside asar when packaged).
      // Preferring app.asar.unpacked for *.js breaks require() → node_modules in asar.
      return path.join(__dirname, fileName);
    }

    async function loadRendererIntoWindow(win, fileName) {
      if (!win || win.isDestroyed()) {
        throw new Error('Object has been destroyed');
      }
      const filePath = resolveRendererFile(fileName);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Renderer file missing: ${filePath}`);
      }
      // loadFile is asar-aware and keeps renderer Node require() working
      await win.loadFile(filePath);
      return filePath;
    }

    /** Strip symbols that become mojibake (â□□) on Windows splash fonts/encodings */
    function splashSafeText(text) {
      return String(text || '')
        .replace(/[\u2713\u2714\u2705\u2611]/g, '') // ✓ ✔ ✅ ☑
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    async function setStartupStatus({ step, status = 'active', detail = '', headline = '', live = '' }) {
      if (!loadingWindow || loadingWindow.isDestroyed()) return;

      const payload = JSON.stringify({
        step,
        status,
        detail: splashSafeText(detail),
        headline: splashSafeText(headline),
        live: splashSafeText(live)
      });
      const b64 = Buffer.from(payload, 'utf8').toString('base64');
      try {
        await loadingWindow.webContents.executeJavaScript(
          `window.__setStartupUI && window.__setStartupUI(JSON.parse(atob('${b64}')))`
        );
      } catch (err) {
        console.warn('setStartupStatus failed:', err?.message || err);
      }
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function showStep(step, detail, options = {}) {
      const {
        headline = 'Preparing AlgoScraper',
        live = detail,
        delay = 500,
        status = 'active'
      } = options;
      await setStartupStatus({ step, status, detail, headline, live });
      // Extra beat so the fade-out/fade-in reads as one message at a time
      if (delay > 0) await sleep(delay + 180);
    }

    async function showSuccess(step, detail, options = {}) {
      const {
        headline = 'Preparing AlgoScraper',
        live = detail,
        delay = 550
      } = options;
      await setStartupStatus({
        step,
        status: 'done',
        detail,
        headline,
        live
      });
      if (delay > 0) await sleep(delay + 180);
    }

    async function closeLoadingWindow() {
      if (loadingWindow && !loadingWindow.isDestroyed()) {
        try {
          loadingWindow.destroy();
        } catch (_) {}
        loadingWindow = null;
      }
    }

    const createWindow = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.show();
          mainWindow.focus();
        } catch (_) {}
        return;
      }

      const indexHtml = resolveRendererFile('index.html');
      if (!fs.existsSync(indexHtml)) {
        console.error('Main UI missing:', indexHtml);
        dialog.showErrorBox(
          'AlgoScraper UI Missing',
          `Could not find the main window file:\n${indexHtml}\n\nReinstall AlgoScraper.`
        );
        return;
      }

      mainWindow = new BrowserWindow({
        show: false, // Keep hidden initially to prevent flashing
//        fullscreen: true, // enable this if need scraper to open in full page
        title: "AlgoScraper",
        width: 1280,
        height: 800,
        backgroundColor: "#e8edf3",
        icon: getAppWindowIcon(),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true,
            sandbox: false
        }
      });

      Menu.setApplicationMenu(null);
      const template = [
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' }
          ]
        },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forcereload' },
            { role: 'toggledevtools' },
            { type: 'separator' },
            { role: 'resetzoom' },
            { role: 'zoomin' },
            { role: 'zoomout' },
            { type: 'separator' },
            { role: 'togglefullscreen' }
          ]
        },
        {
          label: 'Window',
          submenu: [
            { role: 'Close' }
          ]
        }
      ];
      const menu = Menu.buildFromTemplate(template);
      Menu.setApplicationMenu(menu);

      let shown = false;
      const revealMainWindow = () => {
        if (shown || !mainWindow || mainWindow.isDestroyed()) return;
        shown = true;
        try {
          mainWindow.maximize();
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send("launch-mode", launchedFromProtocol);
          flushPendingDeepLink();
        } catch (err) {
          console.error('Failed to reveal main window:', err);
        }
      };

      mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
        console.error('Main window did-fail-load:', code, desc, url);
        dialog.showErrorBox(
          'AlgoScraper Failed to Open',
          `Could not load the scraper window.\n\n${desc}\n\nPath: ${indexHtml}`
        );
      });

      mainWindow.once("ready-to-show", revealMainWindow);
      // Windows can miss ready-to-show in some packaged builds — force reveal
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(revealMainWindow, 50);
      });
      setTimeout(revealMainWindow, 4000);

      // Prefer unpacked HTML on Windows; avoid broken file:// URLs into app.asar
      loadRendererIntoWindow(mainWindow, 'index.html').catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        // Ignore teardown races if app is quitting / window already gone
        if (/destroyed/i.test(msg) || !mainWindow || mainWindow.isDestroyed()) {
          console.warn('Main window load aborted (window destroyed):', msg);
          return;
        }
        console.error('Failed to load index.html:', err);
        dialog.showErrorBox(
          'AlgoScraper Failed to Open',
          `Could not load the scraper window.\n\n${msg}`
        );
      });
    };

    // By = wd.By,
    // until = wd.until;

     async function startApp(message) {
       var desiredCaps = {
         platformName: message[0],
         deviceName: message[1],
         appPackage: message[2],
         appActivity: message[3],
         browserName: '',
     };
         //Initiating the Driver
         try{
         let driver = await new wd.Builder().usingServer("http://127.0.0.1:4723/wd/hub").withCapabilities(desiredCaps).build();
         }catch(error){
           console.log("error: ", error)
         }

     }



    // Variable to store the list of devices discovered at startup / refresh
    let connectedDevices = [];

    // ===========================================================================
    // [DEVICES] Connected targets — Android (emulator + physical) and iOS (sim + physical)
    // Preference: when BOTH platforms are present, Android devices are listed/selected first.
    // Device Name dropdown (renderer) shows ONLY the active platform's devices.
    // ===========================================================================

    // --- ANDROID: `adb devices -l` → emulator-* or USB serial ---
    async function getConnectedAndroidDevices() {
        return new Promise((resolve) => {
            exec("adb devices -l", (error, stdout) => {
                const devices = [];
                if (!error && stdout) {
                    const lines = stdout.split('\n');
                    lines.forEach(line => {
                        // Match any authorized device/emulator line from `adb devices -l`
                        const deviceMatch = line.match(/^(\S+)\s+device\b/);
                        if (deviceMatch) {
                            const id = deviceMatch[1];
                            let name = id;

                            // Try to extract a friendly model name
                            const modelMatch = line.match(/model:([^\s]+)/);
                            if (modelMatch) {
                                name = modelMatch[1].replace(/_/g, ' ');
                            }

                            devices.push({
                                id: id,
                                name: name,
                                type: id.startsWith('emulator') ? 'emulator' : 'physical',
                                platform: 'Android'
                            });
                        }
                    });
                }
                resolve(devices);
            });
        });
    }

    // --- iOS: booted Simulator (simctl) + physical iPhone (xcdevice) ---
    // macOS only — Windows has no Xcode toolchain / XCUITest in the package.
    async function getConnectedIOSDevices() {
        if (process.platform !== 'darwin') {
            return [];
        }
        return new Promise((resolve) => {
            const devices = [];

            // 1. Get BOOTED simulators
            exec("xcrun simctl list devices booted", (simError, simStdout) => {
                if (!simError) {
                    const lines = simStdout.split("\n");
                    lines.forEach(line => {
                        const match = line.match(/(.*?)\s+\(([A-F0-9-]+)\)\s+\(Booted\)/);
                        if (match) {
                            devices.push({
                                id: match[2],
                                name: match[1].trim(),
                                type: "simulator",
                                platform: 'IOS' // Tells the frontend to switch to iOS
                            });
                        }
                    });
                }

                // 2. Get CONNECTED physical iPhones
                exec("xcrun xcdevice list", (phyError, phyStdout) => {
                    if (!phyError && phyStdout) {
                        try {
                            const allDevices = JSON.parse(phyStdout);
                            if (Array.isArray(allDevices)) {
                                allDevices.forEach(device => {
                                    if (device && device.available === true && device.simulator === false && device.platform === "com.apple.platform.iphoneos") {
                                        devices.push({
                                            id: device.identifier,
                                            name: device.name,
                                            type: "physical",
                                            platform: 'IOS'
                                        });
                                    }
                                });
                            }
                        } catch (e) {
                            console.log("xcdevice parse error safely caught:", e);
                        }
                    }
                    resolve(devices);
                });
            });
        });
    }

    /**
     * Merge all discovered devices.
     * Order: Android (emulator + physical) FIRST, then iOS (simulator + physical).
     * Default selection / platform therefore prefers Android when both are connected.
     */
    function mergeConnectedDevices(androidDevices, iosDevices) {
        return [...(androidDevices || []), ...(iosDevices || [])];
    }

    // --- 3. UPDATED CHECK CONNECTION LOGIC ---
    async function checkDeviceConnected() {
        // Android emulator/physical + iOS simulator/physical in parallel
        const [iosDevices, androidDevices] = await Promise.all([
            getConnectedIOSDevices(),
            getConnectedAndroidDevices()
        ]);

        connectedDevices = mergeConnectedDevices(androidDevices, iosDevices);

        if (connectedDevices.length > 0) {
            deviceId = connectedDevices[0].id;
            deviceName = connectedDevices[0].name;
        }

        return connectedDevices.length > 0;
    }

    // Live refresh for UI platform switching (Android ↔ iOS)
    ipcMain.handle("refresh-connected-devices", async () => {
        try {
            const [iosDevices, androidDevices] = await Promise.all([
                getConnectedIOSDevices(),
                getConnectedAndroidDevices()
            ]);
            connectedDevices = mergeConnectedDevices(androidDevices, iosDevices);
            return {
                success: true,
                devices: connectedDevices,
                android: androidDevices,
                ios: iosDevices
            };
        } catch (err) {
            console.error("refresh-connected-devices failed:", err);
            return {
                success: false,
                devices: connectedDevices || [],
                android: [],
                ios: [],
                error: err?.message || String(err)
            };
        }
    });

    // ===========================================================================
    // [STARTUP] Gate: splash → Appium → any Android/iOS device → main window
    // Quits with an error dialog if Appium or device discovery fails.
    // ===========================================================================
    //app.on('ready', createWindow);
    app.on('ready', async () => {
        // Second instance already called app.quit() — do not boot Appium / windows
        if (!gotSingleInstanceLock) return;

    // Set macOS Dock Icon for local dev (npm start)
        if (process.platform === 'darwin' && app.dock) {
            app.dock.setIcon(path.join(__dirname, '..', 'assets', 'algoScraper Logo.png'));
        }

        // Register myapp:// so AlgoQA can deep-link into the scraper
        registerMyAppProtocol();

        // ---------------------------------------------------------------------
        // Protocol vs double-click (drives renderer Launch / token UI)
        //   Windows: cold-start URL is on process.argv as myapp://...
        //   macOS:   open-url (may arrive before ready) → pendingDeepLinkUrl
        // Renderer receives IPC "launch-mode" with this flag (see createWindow).
        // ---------------------------------------------------------------------
        const coldStartLink = findDeepLinkInArgv(process.argv);
        if (coldStartLink) {
            launchedFromProtocol = true;
            pendingDeepLinkUrl = coldStartLink;
            console.log('Cold-start protocol launch detected:', coldStartLink);
        }

        startupGateActive = true;
        createLoadingWindow();
        await waitForLoadingWindowReady();

        await showStep('prereq', 'Checking Prerequisites', {
            headline: 'Preparing AlgoScraper',
            live: 'Checking Prerequisites',
            delay: 450
        });
        await showSuccess('prereq', 'Prerequisites Checked', {
            headline: 'Preparing AlgoScraper',
            live: 'Prerequisites Checked',
            delay: 400
        });

            if (!resolveAndroidSdkRoot()) {
                await showStep('sdk', 'Preparing Android tools', {
                    headline: 'Preparing AlgoScraper',
                    live: 'Downloading Android tools',
                    delay: 200
                });
                const sdkResult = await ensureManagedAndroidSdk();
                if (sdkResult && sdkResult.sdk) {
                    await showSuccess('sdk', 'Android tools ready', {
                        headline: 'Preparing AlgoScraper',
                        live: 'Android tools ready',
                        delay: 300
                    });
                } else {
                    console.warn('Android tools not ready:', sdkResult && sdkResult.error);
                }
            } else {
                applyAndroidToolingToEnv(process.env);
            }

            console.log("CHECKING APPIUM");
            await showStep('appium', 'Checking Appium', {
                headline: 'Preparing AlgoScraper',
                live: 'Checking Appium',
                delay: 400
            });

            // Prefer bundled Appium+Node; if that fails, fall back to system Appium+Node
            const bootResult = await ensureAppiumStarted({ forceRestart: true });

            if (bootResult && bootResult.success) {
                const engineLabel = bootResult.mode === 'system'
                    ? 'System Automation Engine Ready'
                    : 'Automation Engine Ready';
                await showSuccess('appium', engineLabel, {
                    headline: 'Preparing AlgoScraper',
                    live: engineLabel,
                    delay: 450
                });
            } else {
                await setStartupStatus({
                    step: 'appium',
                    status: 'error',
                    detail: 'Automation Engine Startup Failed',
                    headline: 'Preparing AlgoScraper',
                    live: 'Automation Engine Startup Failed'
                });
                await sleep(600);
                await closeLoadingWindow();
                startupGateActive = false;

                dialog.showErrorBox(
                    "Automation Engine Startup Failed",
                    `AlgoScraper could not start Appium on port 4723.\n\n`
                    + `Tried:\n`
                    + `1) Bundled Appium + bundled Node\n`
                    + `2) System Appium + system Node (fallback)\n\n`
                    + `Only one server is started at a time (port 4723 is cleared first).\n\n`
                    + `Error Log:\n${bootResult ? bootResult.error : "Unknown error"}`
                );

                if (appiumProcess) {
                    try { appiumProcess.kill(); } catch (_) {}
                    appiumProcess = null;
                }

                app.quit();
                return;
            }

            console.log("CHECKING DEVICE");
            await showStep('device', 'Checking Connected Device', {
                headline: 'Preparing AlgoScraper',
                live: 'Checking Connected Device',
                delay: 400
            });

            let deviceConnected = false;
            let deviceErrorStr = process.platform === 'win32'
                ? "No Android emulator/device detected."
                : "No Android emulator/device or iOS Simulator/device detected.";
            try {
                deviceConnected = await checkDeviceConnected();
            } catch (deviceError) {
                console.error("Device detection caught an execution error:", deviceError);
                deviceErrorStr = deviceError?.stack || deviceError?.message || String(deviceError);
                deviceConnected = false;
            }

            if (deviceConnected) {
                await showSuccess('device', `${deviceName} Ready`, {
                    headline: 'Preparing AlgoScraper',
                    live: `${deviceName} Ready`,
                    delay: 450
                });
            } else {
                await setStartupStatus({
                    step: 'device',
                    status: 'error',
                    detail: 'No device connected',
                    headline: 'Preparing AlgoScraper',
                    live: 'No Device Connected'
                });
                await sleep(700);
                await closeLoadingWindow();
                startupGateActive = false;

                const deviceHelp = process.platform === 'win32'
                    ? `Please start an Android emulator or connect a phone with USB debugging.\n\nAlgoScraper installs ADB automatically. You still need a running device.\n\nError Log:\n${deviceErrorStr}`
                    : `Please connect an Android emulator/device or start an iOS Simulator / connect an iPhone.\n\nAndroid: AlgoScraper installs ADB automatically; you still need a running device.\nMac iOS: Xcode Command Line Tools are required.\n\nError Log:\n${deviceErrorStr}`;
                dialog.showErrorBox("Device Connection Failed", deviceHelp);

                // Terminate Appium process and quit application completely
                if (appiumProcess) {
                    appiumProcess.kill();
                    appiumProcess = null;
                }

                app.quit();
                return;
            }

        await showStep('launch', 'Launching AlgoScraper', {
            headline: 'Preparing AlgoScraper',
            live: 'Launching AlgoScraper',
            delay: 400
        });
        await showSuccess('launch', 'Ready', {
            headline: 'Preparing AlgoScraper',
            live: 'Ready',
            delay: 350
        });

        // IMPORTANT (Windows): never close the splash before main exists.
        // Closing the last window fires window-all-closed → app.quit() →
        // "Object has been destroyed" when createWindow tries to load.
        try {
          createWindow();
          await sleep(80);
          await closeLoadingWindow();
          startupGateActive = false;
        } catch (err) {
          startupGateActive = false;
          console.error('createWindow threw:', err);
          dialog.showErrorBox(
            'AlgoScraper Failed to Open',
            err && err.message ? err.message : String(err)
          );
        }
    });

    app.on("second-instance", (event, commandLine) => {
      const deepLink = findDeepLinkInArgv(commandLine);

      if (deepLink) {
        console.log("Received deep link (second-instance):", deepLink);
        handleMyAppDeepLink(deepLink);
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });

    // macOS: open-url can fire before ready — keep pending until window exists
    app.on("open-url", (event, deepLink) => {
      event.preventDefault();
      handleMyAppDeepLink(deepLink);
    });

    // Quit when all winxdows are closed, except on macOS. There, it's common
    // for applications and their menu bar to stay active until the user quits
    // explicitly with Cmd + Q.

    app.on("before-quit", () => {

        if (appiumProcess) {

            appiumProcess.kill();

            appiumProcess = null;

        }

    });

    app.on('window-all-closed', () => {
      // During splash → main handoff there can briefly be 0 windows on Windows.
      // Quitting here destroys the new BrowserWindow mid-load ("Object has been destroyed").
      if (startupGateActive) {
        console.log('window-all-closed ignored during startup handoff');
        return;
      }
      if (appiumProcess) {
        try { appiumProcess.kill(); } catch (e) {}
        appiumProcess = null;
      }
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    app.on('activate', () => {
      // On OS X it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) {
       // Open scraper
       createWindow();

       mainWindow.webContents.once("did-finish-load", () => {
         mainWindow.webContents.send(
           "launch-mode",
           launchedFromProtocol
         );
       });
      }
    });

    // In this file you can include the rest of your app's specific main process
    // code. You can also put them in separate files and import them here.


    // code to recieve message from popup.js and close electron UI
    ipcMain.on('appPackage', (event, message) => {
      appPackage = message
    });

    const appDataPath = app.getPath('appData');
    const folderPath = path.join(appDataPath, 'algoScraperScreenShot');
    ipcMain.on('message', (event, message) => {
      if(message === 'get me appData and device details'){
      //   if(deviceId != undefined || deviceName !=undefined){
      // event.reply('message-from-main', {folderPath, deviceId, deviceName});
      //   }
        // else{
          event.reply('message-from-main', {folderPath, connectedDevices});
        // }
      }
    });

    ipcMain.on('message', (event, message) => {
      if(message === 'get me appData and device details'){
          event.reply('message-from-main', {folderPath, connectedDevices});
      }
    });

    ipcMain.on("close-app", () => {

        console.log("Closing AlgoScraper...");

        // Stop Appium process if we started it, then quit without wiping simulators
        if (appiumProcess) {
            try {
                appiumProcess.kill();
            } catch (e) {
                console.log("Appium already stopped");
            }
            appiumProcess = null;
        }

        app.quit();

    });

    // ===========================================================================
    // [IPC-APPIUM] Renderer asks main to ensure / health-check / clear sessions
    // Used by Launch Application in popup.js before creating the WebDriver session
    // ===========================================================================
    ipcMain.handle("android-sdk-status", async () => {
        const ensured = await ensureManagedAndroidSdk();
        applyAndroidToolingToEnv(process.env);
        const sdk = (ensured && ensured.sdk) || resolveAndroidSdkRoot();
        const javaHome = resolveJavaHome();
        return {
            found: !!sdk,
            sdk: sdk || null,
            javaHome: javaHome || null,
            message: sdk ? null : androidSdkMissingMessage()
        };
    });

    ipcMain.handle("ensure-appium", async (event, opts) => {
        try {
            const forceRestart = !!(opts && opts.forceRestart);
            let result = await ensureAppiumStarted({ forceRestart });
            if (!result || !result.success) {
                console.log("ensure-appium soft start failed — forcing restart (bundled then system)");
                result = await ensureAppiumStarted({ forceRestart: true });
            }
            // Final health gate
            if (result && result.success && !(await checkAppium())) {
                console.log("ensure-appium status check failed after start — forcing restart");
                result = await ensureAppiumStarted({ forceRestart: true });
            }
            return result;
        } catch (e) {
            return { success: false, error: e?.message || String(e) };
        }
    });

    ipcMain.handle("check-appium", async () => {
        return await checkAppium();
    });

    ipcMain.handle("clear-appium-sessions", async () => {
        try {
            if (!(await checkAppium())) {
                return { cleared: 0 };
            }
            return await clearAppiumSessions();
        } catch (e) {
            return { cleared: 0, error: e?.message || String(e) };
        }
    });

    // ===========================================================================
    // [IPC-ANDROID] ADB-only helpers (physical device + emulator)
    // Used when Appium/UiAutomator2 needs a nudge on OEM ROMs (e.g. OPPO/ColorOS)
    // ===========================================================================

    // Read Android OS version for the Platform Version field
    ipcMain.handle("get-android-version", async (event, udid) => {
        return new Promise((resolve) => {
            if (!udid) {
                resolve("");
                return;
            }
            exec(`adb -s ${udid} shell getprop ro.build.version.release`, (error, stdout) => {
                if (error || !stdout) {
                    resolve("");
                    return;
                }
                resolve(String(stdout).trim());
            });
        });
    });

    // Soft-launch Android app WITHOUT force-stop (-S). Force-stop kills UiAutomator2 on many OEMs.
    ipcMain.handle("android-soft-launch", async (event, data) => {
        const udid = data && data.udid;
        const pkg = data && data.pkg;
        const activity = data && data.activity;
        if (!udid || !pkg) {
            return { success: false, error: "Missing udid/package" };
        }

        const runAdb = (cmd) => new Promise((resolve) => {
            exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
                resolve({
                    success: !error,
                    output: String(stdout || ""),
                    error: error ? (stderr || error.message) : ""
                });
            });
        });

        const activityArg = (() => {
            const a = String(activity || "").trim();
            if (!a) return "";
            if (a.includes("/")) return a;
            return `${pkg}/${a.replace(/^\//, "")}`;
        })();

        if (activityArg) {
            const started = await runAdb(`adb -s ${udid} shell am start -n "${activityArg}"`);
            const out = `${started.output} ${started.error}`;
            if (started.success && !/Error|Exception|does not exist/i.test(out)) {
                return { success: true, output: started.output };
            }
        }

        return runAdb(`adb -s ${udid} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
    });

    ipcMain.handle("android-foreground-package", async (event, udid) => {
        return new Promise((resolve) => {
            if (!udid) {
                resolve({ success: false, error: "Missing udid" });
                return;
            }
            const cmd = `adb -s ${udid} shell "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp'"`;
            exec(cmd, { timeout: 8000 }, (error, stdout) => {
                const text = String(stdout || "");
                const match = text.match(/([a-zA-Z0-9._]+)\/[a-zA-Z0-9._$]+/);
                if (match) {
                    resolve({ success: true, pkg: match[1], raw: text.trim() });
                    return;
                }
                resolve({ success: false, error: error ? error.message : "No focused app" });
            });
        });
    });

    // --- ANDROID fallback captures when UiAutomator2 instrumentation is flaky ---
    // ADB screenshot fallback when UiAutomator2 instrumentation crashes
    ipcMain.handle("android-adb-screenshot", async (event, udid) => {
        return new Promise((resolve) => {
            if (!udid) {
                resolve({ success: false, error: "Missing udid" });
                return;
            }
            const { execFile } = require('child_process');
            execFile('adb', ['-s', udid, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 25 * 1024 * 1024 }, (error, stdout) => {
                if (error || !stdout || !stdout.length) {
                    resolve({ success: false, error: error ? error.message : "Empty screenshot" });
                    return;
                }
                // Some devices prepend a CRLF that corrupts PNG — strip until PNG signature
                let buf = Buffer.from(stdout);
                const pngStart = buf.indexOf(Buffer.from([0x89, 0x50, 0x4E, 0x47]));
                if (pngStart > 0) buf = buf.slice(pngStart);
                resolve({ success: true, base64: buf.toString('base64') });
            });
        });
    });

    // ADB UI hierarchy dump fallback
    ipcMain.handle("android-adb-pagesource", async (event, udid) => {
        return new Promise((resolve) => {
            if (!udid) {
                resolve({ success: false, error: "Missing udid" });
                return;
            }
            const remote = '/data/local/tmp/algo_window_dump.xml';
            const cmd = `adb -s ${udid} shell uiautomator dump ${remote} && adb -s ${udid} shell cat ${remote}`;
            exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error || !stdout) {
                    resolve({ success: false, error: stderr || (error && error.message) || "Dump failed" });
                    return;
                }
                const xmlStart = stdout.indexOf('<?xml');
                const hierarchyStart = stdout.indexOf('<hierarchy');
                const start = xmlStart >= 0 ? xmlStart : hierarchyStart;
                if (start < 0) {
                    resolve({ success: false, error: "No hierarchy XML in dump output" });
                    return;
                }
                resolve({ success: true, xml: stdout.slice(start).trim() });
            });
        });
    });

    // Prepare device: whitelist Appium packages and stop leftover instrumentation only
    ipcMain.handle("android-prepare-device", async (event, udid) => {
        return new Promise((resolve) => {
            if (!udid) {
                resolve({ success: false });
                return;
            }
            const cmds = [
                `adb -s ${udid} shell am force-stop io.appium.uiautomator2.server.test`,
                `adb -s ${udid} shell am force-stop io.appium.uiautomator2.server`,
                `adb -s ${udid} shell dumpsys deviceidle whitelist +io.appium.settings >/dev/null 2>&1 || true`,
                `adb -s ${udid} shell dumpsys deviceidle whitelist +io.appium.uiautomator2.server >/dev/null 2>&1 || true`,
                `adb -s ${udid} shell dumpsys deviceidle whitelist +io.appium.uiautomator2.server.test >/dev/null 2>&1 || true`
            ].join(' ; ');
            exec(cmds, () => resolve({ success: true }));
        });
    });

    // ===========================================================================
    // [IPC-APPS] App Name dropdown — launchable apps for selected device
    // Android: MAIN/LAUNCHER activities (system + third-party), humanize/aapt labels
    // iOS sim: simctl listapps → User + System (Safari/Settings/…), skip WDA/posters
    // iOS device: devicectl device info apps (JSON / text fallback)
    // ===========================================================================

    // Humanize package ids like com.digilocker.android → "DigiLocker" (skip token "android")
    function titleCaseAppToken(token) {
        if (!token) return '';
        if (/^[A-Z0-9]+$/.test(token) && token.length <= 4) return token;
        if (/[a-z]/.test(token) && /[A-Z]/.test(token)) {
            return token
                .replace(/([a-z])([A-Z])/g, '$1 $2')
                .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
        }
        return token.charAt(0).toUpperCase() + token.slice(1);
    }

    function humanizeAndroidPackage(pkg) {
        const KNOWN = {
            'com.spotify.music': 'Spotify',
            'com.ubercab': 'Uber',
            'com.linkedin.android': 'LinkedIn',
            'com.whatsapp': 'WhatsApp',
            'com.whatsapp.w4b': 'WhatsApp Business',
            'com.instagram.android': 'Instagram',
            'com.facebook.katana': 'Facebook',
            'com.facebook.orca': 'Messenger',
            'com.twitter.android': 'X',
            'com.snapchat.android': 'Snapchat',
            'com.microsoft.teams': 'Microsoft Teams',
            'com.microsoft.appmanager': 'Phone Link',
            'com.google.android.youtube': 'YouTube',
            'com.google.android.apps.youtube.music': 'YouTube Music',
            'com.google.android.apps.youtube.creator': 'YouTube Studio',
            'com.google.android.apps.maps': 'Google Maps',
            'com.google.android.gm': 'Gmail',
            'com.google.android.apps.photos': 'Google Photos',
            'com.google.android.calendar': 'Google Calendar',
            'com.google.android.contacts': 'Contacts',
            'com.google.android.dialer': 'Phone',
            'com.google.android.apps.messaging': 'Messages',
            'com.google.android.deskclock': 'Clock',
            'com.google.android.calculator': 'Calculator',
            'com.google.android.documentsui': 'Files',
            'com.google.android.apps.docs': 'Google Drive',
            'com.android.chrome': 'Chrome',
            'com.android.settings': 'Settings',
            'com.android.vending': 'Play Store',
            'com.android.camera2': 'Camera',
            'com.android.gallery3d': 'Gallery',
            'com.android.contacts': 'Contacts',
            'com.android.dialer': 'Phone',
            'com.android.mms': 'Messages',
            'com.android.deskclock': 'Clock',
            'com.android.calculator2': 'Calculator',
            'com.android.documentsui': 'Files',
            'com.sec.android.app.camera': 'Camera',
            'com.sec.android.app.samsungapps': 'Galaxy Store',
            'com.samsung.android.messaging': 'Messages',
            'com.azure.authenticator': 'Authenticator',
            'money.jupiter': 'Jupiter',
            'com.digilocker.android': 'DigiLocker',
            'com.suno.android': 'Suno',
            'in.swiggy.android.instamart': 'Swiggy Instamart',
            'in.redbus.android': 'redBus'
        };
        if (KNOWN[pkg]) return KNOWN[pkg];

        const SKIP = new Set([
            'com', 'org', 'net', 'io', 'app', 'android', 'mobile', 'free', 'pro', 'dev', 'debug',
            'client', 'main', 'ui', 'core', 'beta', 'lite', 'plus', 'www', 'co', 'me', 'in', 'uk',
            'jp', 'cn', 'tv', 'apps', 'application', 'pkg', 'package', 'prod', 'staging', 'demo',
            'google', 'samsung', 'sec', 'oplus', 'heytap', 'coloros', 'xiaomi', 'miui', 'huawei',
            'oneplus', 'realme', 'oppo', 'vivo', 'motorola', 'lenovo', 'sony', 'lge', 'htc'
        ]);
        const PRODUCT = new Set([
            'music', 'mail', 'maps', 'chat', 'pay', 'bank', 'shop', 'store', 'video', 'news',
            'books', 'photos', 'drive', 'docs', 'meet', 'calendar', 'wallet', 'weather', 'notes',
            'browser', 'launcher', 'gallery', 'camera', 'messages', 'contacts', 'clock', 'files'
        ]);

        const parts = String(pkg || '').split('.').filter(Boolean);
        const meaningful = parts.filter((p) => !SKIP.has(p.toLowerCase()) && !/^\d+$/.test(p) && p.length > 1);
        if (!meaningful.length) return pkg;

        const last = meaningful[meaningful.length - 1].toLowerCase();
        if (meaningful.length >= 2 && PRODUCT.has(last)) {
            return `${titleCaseAppToken(meaningful[meaningful.length - 2])} ${titleCaseAppToken(meaningful[meaningful.length - 1])}`;
        }
        if (meaningful.length >= 2 && meaningful[meaningful.length - 1].length <= 3) {
            return titleCaseAppToken(meaningful[meaningful.length - 2]);
        }
        return titleCaseAppToken(meaningful[meaningful.length - 1]);
    }

    function shouldIgnoreAndroidPackage(pkg) {
        const p = String(pkg || '').toLowerCase();
        if (!p) return true;
        if (p.startsWith('io.appium.')) return true;
        if (p.includes('uiautomator')) return true;
        if (p.includes('.test') && p.includes('android')) return true;
        // Keep Settings / Chrome / launcher apps — only drop true non-UI services
        const ignoredExact = new Set([
            'android',
            'com.android.systemui',
            'com.google.android.gms',
            'com.google.android.gsf',
            'com.google.android.packageinstaller',
            'com.android.packageinstaller',
            'com.android.shell',
            'com.android.bluetooth',
            'com.android.nfc',
            'com.android.keychain',
            'com.android.vpndialogs'
        ]);
        if (ignoredExact.has(p)) return true;
        const ignoredPrefixes = [
            'com.android.providers.', 'com.android.internal.',
            'com.google.android.ext.', 'com.google.android.overlay',
            'com.android.theme.', 'com.android.wallpaper',
            'com.qualcomm.', 'com.qti.', 'com.android.cts.',
            'com.android.inputmethod.', 'com.google.android.inputmethod.'
        ];
        return ignoredPrefixes.some((prefix) => p.startsWith(prefix));
    }

    function resolveAaptBinary() {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        const roots = [
            process.env.ANDROID_HOME,
            process.env.ANDROID_SDK_ROOT,
            path.join(os.homedir(), 'Library', 'Android', 'sdk'),
            path.join(os.homedir(), 'Android', 'Sdk'),
            path.join(localAppData, 'Android', 'Sdk')
        ].filter(Boolean);

        for (const root of roots) {
            const buildTools = path.join(root, 'build-tools');
            if (!fs.existsSync(buildTools)) continue;
            let versions = [];
            try {
                versions = fs.readdirSync(buildTools).sort().reverse();
            } catch (_) {
                continue;
            }
            for (const version of versions) {
                const candidate = path.join(
                    buildTools,
                    version,
                    process.platform === 'win32' ? 'aapt.exe' : 'aapt'
                );
                if (fs.existsSync(candidate)) return candidate;
            }
        }
        return null;
    }

    function getAndroidLabelCachePath() {
        try {
            return path.join(app.getPath('userData'), 'android-app-labels.json');
        } catch (_) {
            return path.join(os.tmpdir(), 'algoscraper-android-app-labels.json');
        }
    }

    function loadAndroidLabelCache() {
        try {
            const raw = fs.readFileSync(getAndroidLabelCachePath(), 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    function saveAndroidLabelCache(cache) {
        try {
            fs.writeFileSync(getAndroidLabelCachePath(), JSON.stringify(cache, null, 2), 'utf8');
        } catch (err) {
            console.warn('Failed to save Android label cache:', err?.message || err);
        }
    }

    async function resolveAndroidLabelWithAapt(udid, pkg, aaptPath) {
        try {
            const { stdout: pathOut } = await execAsync(`adb -s "${udid}" shell pm path "${pkg}"`, { timeout: 8000 });
            const apkLine = String(pathOut || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('package:'));
            if (!apkLine) return null;
            const apkRemote = apkLine.replace(/^package:/, '').trim();
            if (!apkRemote) return null;

            const tmpApk = path.join(os.tmpdir(), `algoscraper-label-${pkg.replace(/[^a-zA-Z0-9._-]/g, '_')}.apk`);
            await execAsync(`adb -s "${udid}" pull "${apkRemote}" "${tmpApk}"`, { timeout: 20000 });
            const { stdout: badging } = await execAsync(`"${aaptPath}" dump badging "${tmpApk}"`, { timeout: 10000 });
            try { fs.unlinkSync(tmpApk); } catch (_) {}

            const labelMatch = String(badging).match(/application-label(?:-[\w-]+)?:'([^']+)'/);
            if (labelMatch && labelMatch[1] && labelMatch[1].trim()) {
                return labelMatch[1].trim();
            }
        } catch (_) {
            try {
                const tmpApk = path.join(os.tmpdir(), `algoscraper-label-${pkg.replace(/[^a-zA-Z0-9._-]/g, '_')}.apk`);
                if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
            } catch (__) {}
        }
        return null;
    }

    async function getLaunchableAndroidPackages(udid) {
        // Same idea as iOS app list: all home-screen launchable apps, not third-party-only.
        const launchable = new Set();
        try {
            // Prefer modern query; works on emulator + most real devices (Win/Mac)
            const { stdout } = await execAsync(
                `adb -s "${udid}" shell cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER`,
                { timeout: 15000 }
            );
            String(stdout || '').split('\n').forEach((line) => {
                const match = line.match(/^\s*([a-zA-Z0-9._]+)\/[a-zA-Z0-9._$]+/);
                if (match) launchable.add(match[1]);
            });
        } catch (err) {
            console.warn('Launchable activity query failed:', err?.message || err);
        }

        // Older Android / OEM fallback via dumpsys package
        if (!launchable.size) {
            try {
                const { stdout } = await execAsync(
                    `adb -s "${udid}" shell dumpsys package | grep -E "android.intent.action.MAIN|android.intent.category.LAUNCHER|^[ ]+[a-zA-Z0-9._]+/"`,
                    { timeout: 20000 }
                );
                const lines = String(stdout || '').split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (!lines[i].includes('android.intent.category.LAUNCHER')) continue;
                    // Look nearby for component "pkg/activity"
                    for (let j = Math.max(0, i - 8); j <= Math.min(lines.length - 1, i + 2); j++) {
                        const m = lines[j].match(/([a-zA-Z0-9._]+)\/[a-zA-Z0-9._$]+/);
                        if (m) launchable.add(m[1]);
                    }
                }
            } catch (err) {
                console.warn('dumpsys LAUNCHER fallback failed:', err?.message || err);
            }
        }

        // Last resort: third-party packages (still better than empty dropdown)
        if (!launchable.size) {
            try {
                const { stdout } = await execAsync(`adb -s "${udid}" shell pm list packages -3`, { timeout: 10000 });
                String(stdout || '').split('\n').forEach((line) => {
                    if (line.includes('package:')) {
                        launchable.add(line.replace('package:', '').trim());
                    }
                });
            } catch (_) {}
        }

        // Same idea as iOS: show all launchable apps (system + user), not third-party only
        return [...launchable]
            .filter((pkg) => pkg && !shouldIgnoreAndroidPackage(pkg))
            .sort((a, b) => a.localeCompare(b));
    }

    function dedupeAppDisplayNames(apps) {
        const counts = {};
        apps.forEach((app) => {
            const key = String(app.name || '').toLowerCase();
            counts[key] = (counts[key] || 0) + 1;
        });
        return apps.map((app) => {
            const key = String(app.name || '').toLowerCase();
            if ((counts[key] || 0) > 1) {
                return { ...app, name: `${app.name} (${app.bundleId})` };
            }
            return app;
        });
    }

    function parseIOSSimulatorApps(stdout) {
        // Brace-count parser: simctl listapps nests GroupContainers; naive regex breaks.
        // Keep ApplicationType User + System; drop extensions / WDA / poster apps.
        const apps = [];
        const text = String(stdout || '');
        const blockedTokens = [
            'WebDriverAgent', 'xctrunner', 'Poster', 'Wallpaper', 'PridePoster',
            'GradientPoster', 'EmojiPoster', 'PreviewShell', 'ShareExtension',
            'NotificationService', 'QuickLook', 'Sticker', 'MessagesViewService',
            'WidgetExtension', 'IntentExtension', '.appex'
        ];

        // Brace-count parser — nested GroupContainers / nested dicts break non-greedy regex
        let i = 0;
        while (i < text.length) {
            const keyMatch = text.slice(i).match(/"([^"]+)"\s*=\s*\{/);
            if (!keyMatch) break;

            const bundleId = keyMatch[1];
            const start = i + keyMatch.index + keyMatch[0].length - 1; // index of '{'
            let depth = 0;
            let j = start;
            for (; j < text.length; j++) {
                const ch = text[j];
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        j++;
                        break;
                    }
                }
            }
            const body = text.slice(start + 1, j - 1);
            i = j;

            // Skip nested keys that are not real app entries
            if (!/ApplicationType\s*=/.test(body) && !/CFBundleIdentifier\s*=/.test(body)) {
                continue;
            }

            const typeMatch = body.match(/ApplicationType\s*=\s*([A-Za-z]+)/);
            const appType = typeMatch ? typeMatch[1] : '';
            // Include User installs + System home-screen apps (Safari, Settings, …)
            if (appType && appType !== 'User' && appType !== 'System') continue;

            const pathMatch = body.match(/Path\s*=\s*"([^"]+)"/);
            const appPath = pathMatch ? pathMatch[1] : '';
            if (appPath.includes('.appex') || bundleId.includes('.appex')) continue;
            if (appPath && !/\.app(\/|$)/.test(appPath)) continue;

            const executableMatch = body.match(/CFBundleExecutable\s*=\s*"?([^";\n]+)"?/);
            if (!executableMatch) continue;

            // Display names are often unquoted in simctl output: CFBundleDisplayName = Settings;
            const displayMatch = body.match(/CFBundleDisplayName\s*=\s*"?([^";\n]+)"?/);
            const nameMatch = body.match(/CFBundleName\s*=\s*"?([^";\n]+)"?/);
            let displayName = (displayMatch && displayMatch[1])
                || (nameMatch && nameMatch[1])
                || executableMatch[1]
                || bundleId;
            displayName = String(displayName).trim().replace(/^"|"$/g, '');
            if (!displayName) continue;

            if (blockedTokens.some((token) => bundleId.includes(token) || displayName.includes(token))) {
                continue;
            }
            // Skip Watch companion / internal shells that are not useful for scraping
            if (bundleId === 'com.apple.Bridge' || bundleId === 'com.apple.webapp') continue;

            apps.push({ name: displayName, bundleId });
        }
        return apps;
    }

    function parseIOSPhysicalApps(stdout) {
        const apps = [];
        // JSON from: xcrun devicectl device info apps --device <id> --json-output -
        try {
            const parsed = JSON.parse(stdout);
            const list = parsed?.result?.apps || parsed?.apps || parsed?.result?.appList || [];
            if (Array.isArray(list)) {
                list.forEach((item) => {
                    const bundleId = item.bundleIdentifier || item.bundleID || item.bundleId || item.identifier;
                    const displayName = item.name || item.displayName || item.CFBundleDisplayName || item.bundleName;
                    const hidden = item.hidden === true || item.isHidden === true;
                    const appType = String(item.applicationType || item.type || '').toLowerCase();
                    if (!bundleId || !displayName || hidden) return;
                    if (appType && appType !== 'user' && appType !== 'unknown') return;
                    if (String(bundleId).includes('WebDriverAgent') || String(bundleId).includes('xctrunner')) return;
                    apps.push({ name: String(displayName).trim(), bundleId: String(bundleId).trim() });
                });
                if (apps.length) return apps;
            }
        } catch (_) {}

        // Text fallback: "name: Foo" / "bundleIdentifier: com.foo"
        const blocks = String(stdout || '').split(/\n(?=\S)/);
        let current = {};
        const flush = () => {
            if (current.bundleId && current.name) {
                if (!String(current.bundleId).includes('WebDriverAgent')) {
                    apps.push({ name: current.name, bundleId: current.bundleId });
                }
            }
            current = {};
        };
        String(stdout || '').split('\n').forEach((line) => {
            const nameMatch = line.match(/^\s*(?:name|displayName|CFBundleDisplayName)\s*[:=]\s*"?([^"]+)"?\s*$/i);
            const idMatch = line.match(/^\s*(?:bundleIdentifier|bundleID|bundleId)\s*[:=]\s*"?([^"]+)"?\s*$/i);
            if (nameMatch) current.name = nameMatch[1].trim();
            if (idMatch) {
                if (current.bundleId) flush();
                current.bundleId = idMatch[1].trim();
            }
        });
        flush();
        return apps;
    }

    async function enrichAndroidLabelsInBackground(event, udid, apps) {
        const aaptPath = resolveAaptBinary();
        if (!aaptPath || !apps.length) return;

        const cache = loadAndroidLabelCache();
        // Prefer packages that still look like raw package tokens / weak names
        const pending = apps
            .filter((app) => !cache[app.bundleId])
            .sort((a, b) => {
                const weak = (name) => /^(App|Server|Client|Main|Android|Premium|Member)$/i.test(name) ? 0 : 1;
                return weak(a.name) - weak(b.name);
            })
            .slice(0, 12);
        if (!pending.length) return;

        let changed = false;
        const queue = [...pending];
        const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
            while (queue.length) {
                const app = queue.shift();
                if (!app) break;
                const label = await resolveAndroidLabelWithAapt(udid, app.bundleId, aaptPath);
                if (label && label.toLowerCase() !== 'android') {
                    cache[app.bundleId] = label;
                    changed = true;
                }
            }
        });
        await Promise.all(workers);

        if (!changed) return;
        saveAndroidLabelCache(cache);

        const refreshed = dedupeAppDisplayNames(
            apps.map((app) => ({
                ...app,
                name: cache[app.bundleId] || app.name
            }))
        ).sort((a, b) => a.name.localeCompare(b.name));

        try {
            event.reply('installed-apps', refreshed);
        } catch (_) {}
    }

    // Shared IPC: renderer sends selected device → returns [{ name, bundleId }, ...]
    ipcMain.on("get-installed-apps", async (event, selectedDevice) => {
        if (!selectedDevice) {
            event.reply("installed-apps", []);
            return;
        }

        const udid = selectedDevice.id;
        const platform = String(selectedDevice.platform || '').toUpperCase();

        try {
            if (platform === 'ANDROID') {
                const packages = await getLaunchableAndroidPackages(udid);
                const cache = loadAndroidLabelCache();
                let apps = packages.map((pkg) => ({
                    name: cache[pkg] || humanizeAndroidPackage(pkg),
                    bundleId: pkg
                }));
                apps = dedupeAppDisplayNames(apps).sort((a, b) => a.name.localeCompare(b.name));
                event.reply("installed-apps", apps);
                // Resolve real APK labels in background (cached for next time)
                enrichAndroidLabelsInBackground(event, udid, apps).catch(() => {});
                return;
            }

            // iOS simulator / device — only executable launchable apps with real display names
            let apps = [];
            if (selectedDevice.type === 'simulator') {
                const { stdout } = await execAsync(`xcrun simctl listapps "${udid}"`, { timeout: 30000 });
                apps = parseIOSSimulatorApps(stdout);
            } else {
                let stdout = '';
                try {
                    const result = await execAsync(
                        `xcrun devicectl device info apps --device "${udid}" --json-output -`,
                        { timeout: 30000 }
                    );
                    stdout = result.stdout || '';
                } catch (_) {
                    const result = await execAsync(
                        `xcrun devicectl device info apps --device "${udid}"`,
                        { timeout: 30000 }
                    );
                    stdout = result.stdout || '';
                }
                apps = parseIOSPhysicalApps(stdout);
            }

            const uniqueApps = dedupeAppDisplayNames(
                Array.from(new Map(apps.map((app) => [app.bundleId, app])).values())
            ).sort((a, b) => a.name.localeCompare(b.name));

            event.reply("installed-apps", uniqueApps);
        } catch (err) {
            console.error('get-installed-apps failed:', err);
            event.reply("installed-apps", []);
        }
    });

    // --- ANDROID: resolve launcher MainActivity for App Activity field ---
    ipcMain.on("get-android-activity", (event, data) => {
        const cmd = `adb -s ${data.udid} shell cmd package resolve-activity --brief ${data.pkg}`;
        exec(cmd, (error, stdout) => {
            if (!error && stdout) {
                const lines = stdout.trim().split('\n');
                const activityLine = lines.find(l => l.includes('/'));
                if (activityLine) {
                    const activity = activityLine.split('/')[1];
                    event.reply('receive-android-activity', activity);
                } else {
                    event.reply('receive-android-activity', '');
                }
            } else {
                event.reply('receive-android-activity', '');
            }
        });
    });