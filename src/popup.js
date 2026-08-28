    /**
     * =============================================================================
     * AlgoScraper — Electron RENDERER (src/popup.js)
     * =============================================================================
     * Runs inside the BrowserWindow (index.html). Owns UI events, Appium WebDriver
     * session usage, scraping, gestures, scenarios, and Download / AlgoQA export.
     * Heavy device/Appium process work stays in main.js via IPC.
     *
     * PLATFORM FLOW
     *   Android → UiAutomator2, appPackage/appActivity, ADB soft-launch + capture fallbacks
     *   iOS     → XCUITest, bundleId, mobile: activateApp / tap / dragFromToForDuration
     *   Windows builds: Android only (IOS option removed; no XCUITest runtime)
     *   macOS builds: Android + iOS
     *
     * USER FLOWS (what happens end-to-end)
     *   1) Launch Application → ensure-appium IPC → wd.Builder session → soft-open app
     *      → loadFirstScreen (screenshot + page source into #zoomFrame)
     *   2) Tap mode (default) → click screenshot → findIOSLocator → row in table
     *   3) Touch mode → short press = device tap; drag = swipe (mouseup only; click ignored)
     *   4) Scrape UI → refresh page source → filter meaningful nodes → table rows
     *   5) Load Page (#Scrape) → hidden; tag-based scrape kept in code but not shown
     *   6) Record / Add Scenario → pageScenarioData → nested JSON on Download/Send
     *   7) Download / Send → flat controls OR SCENARIOS; FINGERPRINT+APP URL keys empty
     *
     * KEY SECTIONS (search these markers)
     *   [UI-LOCK]       Reset / launch form enable-disable
     *   [LAUNCH-MODE]   Double-click vs myapp:// protocol → token + Launch gate
     *   [PLATFORM-UI]   Custom selects, device filter, platform switch gate
     *   [WIN-ANDROID]   Windows: Android-only platform option (same UI chrome as macOS)
     *   [LAUNCH]        Launch Application → WebDriver session
     *   [CAPTURE]       Screenshot + page source (Appium + Android ADB fallback)
     *   [SCRAPE]        Load Page / Scrape UI / tap-to-select → controls table
     *   [GESTURES]      Touch / swipe loaders + Android/iOS mobile commands
     *   [TABLE]         createAndAppendTable, pagination, hide/show columns
     *   [EXPORT]        Download JSON + AlgoQA Send (normal vs record scenario)
     *   [SCENARIO]      Record / Add Scenario modals + Scenario Outline bar
     *   [MODALS]        Alert / confirm themes (success|info|warning|error|confirm)
     *
     * LAUNCH GATE (important)
     *   Double-click / npm start → Launch DISABLED until user pastes a valid token
     *   myapp:// deep link (API) → token UI hidden, Launch ENABLED immediately
     *   Windows + macOS share this rule (same Android feature set / same UI)
     *   [XML-HELPERS]   Dual-platform bounds / locators / identification types
     * =============================================================================
     */
    const wd = require("selenium-webdriver");
    const fs = require('fs');
    const path = require('path');
    const { app, ipcRenderer } = require('electron');

    const os = require('os');
    const { exec } = require('child_process');

    // Windows: compact left-form density (html.platform-win) so the table gets more height.
    // Windows remains Android-only via lockPlatformToAndroidOnWindows().
    if (process.platform === 'win32') {
        document.documentElement.classList.add('platform-win');
        if (document.body) document.body.classList.add('platform-win');
    }
    var folderPath;
    const By = wd.By;
    const until = wd.until;
    var initialData = [];
    var driver;                 // Active selenium-webdriver session (null after reset/failure)
    var imgTagFlag = false;     // Whether #screenshot <img> already exists in #zoomFrame
    var ssflag = false;
    var dtControls = [];        // Temporary batch of scraped controls before table append
    let counter = 0;
    let count = 0;
    var downloadcontrolNameLists=[];
    var controlNameLists = [];
    var systemAppData
    var tableCreated = false;   // True once at least one real control row was added
    var xpath_id = 0;
    var showElement = false;
    var screenNameList = [];
    var deviceId;
    var deviceName;
    var connectedDevices = [];  // Full list from main; dropdown shows platform-filtered subset
    let launchedViaProtocol = false;
    let rotation = 0;
    let zoomLevel = 1;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let scrollStartLeft = 0;
    let scrollStartTop = 0;
    let hasDragged = false;
    const BASE_WIDTH = 250;
    const BASE_HEIGHT = 480;
    let tapMode = true;         // true = scrape/select element; false = touch/swipe device
    let createFeatureMode = false;
    let pendingFeatureData = null;
    let registeredFeatureAreas = [];

    function isFullPageFeatureArea(area) {
        if (!area) return false;
        if (area.fullPage) return true;
        const r = area.rect;
        if (!r) return false;
        const dims = (typeof getDeviceDimensions === "function")
            ? getDeviceDimensions()
            : { width: 0, height: 0 };
        if (!(dims.width > 0 && dims.height > 0)) return false;
        const screenArea = dims.width * dims.height;
        const rectArea = (Number(r.width) || 0) * (Number(r.height) || 0);
        if (r.x <= 2 && r.y <= 2 && r.width >= dims.width * 0.95 && r.height >= dims.height * 0.95) {
            return true;
        }
        return screenArea > 0 && (rectArea / screenArea) > 0.85;
    }

    function hasFullPageFeature() {
        return (registeredFeatureAreas || []).some(isFullPageFeatureArea);
    }

    /** First click maps the page. After that (or with Shift), click maps a control inside it. */
    function shouldMapFullPageFeature(shiftKey) {
        if (shiftKey) return false;
        return !hasFullPageFeature();
    }
    let showElementHover = false;
    let touchInProgress = false; // Blocks overlapping touch/swipe while loader is up
    let hoverRequestId = 0;
    let hoverTimer = null;
    let lastXPath = "";
    let oldFeatureNameValue = "";
    let oldControlNameValue = "";
    let pendingFeatureRename = null;
    let refreshShouldLaunchApp = false;
    let refreshInProgress = false;

    function getScreenViewport() {
        return document.getElementById("zoomFrame")
            || document.getElementById("screenViewport")
            || document.getElementById("image-container");
    }

    function mountScreenshot(img) {
        const viewport = getScreenViewport();
        if (viewport) {
            viewport.appendChild(img);
        }
    }

    function updateZoomTooltips() {
        const pct = Math.round(zoomLevel * 100);
        const zoomInBtn = document.getElementById("zoomInBtn");
        const zoomOutBtn = document.getElementById("zoomOutBtn");
        const resetZoomBtn = document.getElementById("resetZoomBtn");
        const zoomInTip = document.querySelector("#zoomInBtn + .toolTip");
        const zoomOutTip = document.querySelector("#zoomOutBtn + .toolTip");
        const resetZoomTip = document.querySelector("#resetZoomBtn + .toolTip");

        if (zoomLevel <= 1.0) {
            if (zoomOutBtn) {
                zoomOutBtn.disabled = true;
                zoomOutBtn.style.opacity = "0.45";
                zoomOutBtn.style.cursor = "not-allowed";
            }
            if (zoomInBtn) {
                zoomInBtn.disabled = false;
                zoomInBtn.style.opacity = "1";
                zoomInBtn.style.cursor = "pointer";
            }
            if (zoomOutTip) zoomOutTip.textContent = "Zoom Out (100% Min)";
            if (zoomInTip) zoomInTip.textContent = "Zoom In (125%)";
        } else if (zoomLevel >= 3.0) {
            if (zoomInBtn) {
                zoomInBtn.disabled = true;
                zoomInBtn.style.opacity = "0.45";
                zoomInBtn.style.cursor = "not-allowed";
            }
            if (zoomOutBtn) {
                zoomOutBtn.disabled = false;
                zoomOutBtn.style.opacity = "1";
                zoomOutBtn.style.cursor = "pointer";
            }
            if (zoomInTip) zoomInTip.textContent = "Zoom In (Max 300%)";
            if (zoomOutTip) zoomOutTip.textContent = `Zoom Out (${Math.round((zoomLevel - 0.25) * 100)}%)`;
        } else {
            if (zoomInBtn) {
                zoomInBtn.disabled = false;
                zoomInBtn.style.opacity = "1";
                zoomInBtn.style.cursor = "pointer";
            }
            if (zoomOutBtn) {
                zoomOutBtn.disabled = false;
                zoomOutBtn.style.opacity = "1";
                zoomOutBtn.style.cursor = "pointer";
            }
            if (zoomInTip) zoomInTip.textContent = `Zoom In (${Math.round((zoomLevel + 0.25) * 100)}%)`;
            if (zoomOutTip) zoomOutTip.textContent = `Zoom Out (${Math.round((zoomLevel - 0.25) * 100)}%)`;
        }
        if (resetZoomTip) resetZoomTip.textContent = `Reset Zoom (${pct}%)`;
    }

    /**
     * Dynamically adjusts the phone bezel aspect-ratio and sizing so that the
     * inner #zoomFrame viewport perfectly matches the device screen's native aspect ratio.
     * This eliminates any top/bottom/side gaps and prevents distortion.
     */
    function adjustDevicePreviewSize(imgEl) {
        const screenshot = imgEl || document.getElementById("screenshot");
        const bezel = document.querySelector(".phone-bezel");
        const stage = document.querySelector(".phone-stage");
        if (!bezel) return;

        if (!screenshot || screenshot.style.display === "none") {
            bezel.style.aspectRatio = "9 / 19.5";
            bezel.style.width = "";
            return;
        }

        let natW = screenshot.naturalWidth;
        let natH = screenshot.naturalHeight;
        if (!natW || !natH || natW <= 0 || natH <= 0) {
            const dims = (typeof getDeviceDimensions === 'function') ? getDeviceDimensions() : null;
            if (dims && dims.width > 0 && dims.height > 0) {
                natW = dims.width;
                natH = dims.height;
            } else {
                natW = 1080;
                natH = 2400;
            }
        }

        const deviceAspect = (natW > 0 && natH > 0) ? (natW / natH) : (9 / 19.5);

        // Metrics matching modern sleek CSS chrome:
        // Top chrome: padding (8px) + dynamic island pill (5px + 5px margin) = 18px
        // Bottom chrome: padding (8px)
        // Total vertical chrome: 26px
        // Horizontal chrome: padding (6px left + 6px right) = 12px
        const V_CHROME = 26;
        const H_CHROME = 12;

        const stageH = (stage && stage.clientHeight) || 500;
        const stageW = (stage && stage.clientWidth) || 300;
        const targetH = Math.max(120, stageH);
        let innerH = Math.max(80, targetH - V_CHROME);
        let innerW = innerH * deviceAspect;
        let bezelW = innerW + H_CHROME;
        let bezelH = targetH;

        if (bezelW > stageW && stageW > 0) {
            bezelW = stageW;
            innerW = Math.max(60, bezelW - H_CHROME);
            innerH = innerW / deviceAspect;
            bezelH = innerH + V_CHROME;
        }

        const bezelAspect = bezelW / bezelH;
        bezel.style.aspectRatio = `${bezelAspect}`;
    }

    /**
     * Screenshot size grows with zoom; #zoomFrame stays fixed.
     * At zoom 1 the full device screen fits in the frame (no scroll, no letterboxing/gaps).
     * Scroll appears only when zoomed in.
     */
    function applyScreenshotZoom(imgEl) {
        const screenshot = imgEl || document.getElementById("screenshot");
        const viewport = getScreenViewport();
        if (!screenshot) return;

        adjustDevicePreviewSize(screenshot);

        if (viewport && viewport.id === "zoomFrame") {
            viewport.style.width = "";
            viewport.style.height = "";
            viewport.style.maxWidth = "";
            viewport.style.maxHeight = "";
            viewport.style.minWidth = "";
            viewport.style.minHeight = "";
            viewport.style.overflow = zoomLevel > 1 ? "auto" : "hidden";
            if (zoomLevel <= 1) {
                viewport.scrollLeft = 0;
                viewport.scrollTop = 0;
            }
        }

        if (zoomLevel <= 1) {
            screenshot.style.transition = isDragging ? "none" : "width 0.15s ease, height 0.15s ease";
            screenshot.style.width = "100%";
            screenshot.style.height = "100%";
            screenshot.style.maxWidth = "100%";
            screenshot.style.maxHeight = "100%";
            screenshot.style.objectFit = "fill";
            screenshot.style.transform = `rotate(${rotation}deg)`;
            screenshot.style.transformOrigin = "center center";
            screenshot.style.cursor = "default";
            screenshot.style.display = "block";
            screenshot.style.margin = "0 auto";
            screenshot.style.position = "relative";
            screenshot.style.zIndex = "1";
        } else {
            const frameW = (viewport && viewport.clientWidth) || 300;
            const frameH = (viewport && viewport.clientHeight) || 600;
            const w = Math.round(frameW * zoomLevel);
            const h = Math.round(frameH * zoomLevel);

            screenshot.style.transition = isDragging ? "none" : "width 0.15s ease, height 0.15s ease";
            screenshot.style.width = w + "px";
            screenshot.style.height = h + "px";
            screenshot.style.maxWidth = "none";
            screenshot.style.maxHeight = "none";
            screenshot.style.objectFit = "fill";
            screenshot.style.transform = `rotate(${rotation}deg)`;
            screenshot.style.transformOrigin = "center center";
            screenshot.style.cursor = "grab";
            screenshot.style.display = "block";
            screenshot.style.margin = "0 auto";
            screenshot.style.position = "relative";
            screenshot.style.zIndex = "1";
        }

        updateZoomTooltips();
    }

    function showErrorPopup(title, error) {
        const titleElem = document.getElementById('launchErrorTitle');
        const logElem = document.getElementById('launchErrorLog');
        const popupElem = document.getElementById('launchErrorPopup');
        const overlayElem = document.getElementById('overlay');
        const appRunningPopup = document.getElementById('AppRunningPopup');

        if (appRunningPopup) appRunningPopup.style.display = 'none';
        if (overlayElem) overlayElem.style.display = 'block';

        if (titleElem) titleElem.innerText = title;
        if (logElem) {
            logElem.innerText = error?.stack || error?.message || String(error);
        }

        if (popupElem) popupElem.style.display = 'block';

        const okBtn = document.getElementById("okay_button");
        if (okBtn) {
            okBtn.onclick = () => {
                if (popupElem) popupElem.style.display = 'none';
                if (overlayElem) overlayElem.style.display = 'none';
                // Do NOT quit the whole app — let the user retry Launch
                resetLaunchPlaceholder(
                    "Launch failed. Fix the issue above, then click Launch Application again.",
                    "error"
                );
            };
        }
    }

    function escapeDummyHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Phone preview placeholder messages (info | warning | error | loading).
     * Keeps icon + colors consistent across launch / reset / session errors.
     */
    function showDummyDeviceMessage(options = {}) {
        const dummy = document.getElementById("dummyDevice");
        if (!dummy) return;

        const bezel = document.querySelector(".phone-bezel");
        if (bezel) {
            bezel.style.aspectRatio = "9 / 19.5";
            bezel.style.width = "";
        }

        const theme = options.theme || 'info';
        const title = options.title || getIdleDummyTitle();
        const detail = options.detail || '';

        const themes = {
            info: { color: '#2F8BCC', iconFill: '#2F8BCC' },
            warning: { color: '#b06000', iconFill: '#f9a825' },
            error: { color: '#c5221f', iconFill: '#d93025' },
            loading: { color: '#3c4043', iconFill: '#2F8BCC' }
        };
        const t = themes[theme] || themes.info;

        dummy.style.display = "block";

        if (theme === 'loading') {
            dummy.innerHTML = `
                <div class="phone-welcome-overlay phone-welcome-${theme}">
                    <img class="phone-welcome-loader" src="icon/load-8510_256.gif" alt="" />
                    <p id="dummyMainText" class="phone-welcome-title">${escapeDummyHtml(title)}</p>
                    ${detail ? `<p id="dummyErrorText" class="phone-welcome-detail">${escapeDummyHtml(detail)}</p>` : `<p id="dummyErrorText" class="phone-welcome-detail" style="display:none;"></p>`}
                </div>
            `;
            return;
        }

        dummy.innerHTML = `
            <div class="phone-welcome-overlay phone-welcome-${theme}">
                <svg id="dummyIcon" class="info-svg" viewBox="0 0 24 24" fill="${t.iconFill}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                </svg>
                <p id="dummyMainText" class="phone-welcome-title" style="color:${t.color};">${escapeDummyHtml(title)}</p>
                <p id="dummyErrorText" class="phone-welcome-detail" style="${detail ? 'display:block;' : 'display:none;'}color:${t.color};">${detail ? escapeDummyHtml(detail) : ''}</p>
            </div>
        `;
    }

    function getIdleDummyTitle() {
        // Same copy on Windows + macOS (Windows platform field stays Android-only)
        return 'Select platform, app and device, then click Launch Application.';
    }

    function resetLaunchPlaceholder(message, theme = 'error') {
        if (!message) {
            showDummyDeviceMessage({ theme: 'info', title: getIdleDummyTitle() });
            return;
        }
        showDummyDeviceMessage({
            theme,
            title: message,
            detail: ''
        });
    }

    let resetFormLockActive = false;

    function unlockLaunchForm() {
        resetFormLockActive = false;
        ["platformname", "appname", "devicename", "udid", "appiumurl", "platformversion", "automationName", "bundleID", "apppackage", "appactivity"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = false;
        });
        const runBtn = document.getElementById('Run');
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.style.backgroundColor = '#2F8BCC';
        }
        const overlay = document.getElementById('overlay');
        if (overlay) overlay.style.display = 'none';
        const appRunningPopup = document.getElementById('AppRunningPopup');
        if (appRunningPopup) appRunningPopup.style.display = 'none';
        if (typeof updatePlatformUI === 'function') updatePlatformUI();
        setPageNameBoxEnabled(false);
    }

    function setPageNameBoxEnabled(enabled) {
        const badgeWrapper = document.querySelector('.screen-name-badge');
        const pageNameInput = document.getElementById('pagename_searchbox');
        const badgeLabel = document.querySelector('.badge-label');

        if (badgeWrapper) {
            badgeWrapper.classList.toggle('is-disabled', !enabled);
            if (!enabled) {
                badgeWrapper.style.setProperty('pointer-events', 'none', 'important');
                badgeWrapper.style.setProperty('cursor', 'not-allowed', 'important');
                badgeWrapper.style.setProperty('opacity', '0.6', 'important');
                if (badgeLabel) {
                    badgeLabel.style.setProperty('background-color', '#94a3b8', 'important');
                }
                if (pageNameInput) {
                    pageNameInput.disabled = true;
                }
            } else {
                badgeWrapper.style.removeProperty('pointer-events');
                badgeWrapper.style.removeProperty('cursor');
                badgeWrapper.style.removeProperty('opacity');
                if (badgeLabel) {
                    badgeLabel.style.setProperty('background-color', '#2F8BCC', 'important');
                }
                if (pageNameInput) {
                    pageNameInput.disabled = false;
                }
            }
        }
    }
    window.setPageNameBoxEnabled = setPageNameBoxEnabled;

    /** Keep configuration fields accessible and editable for user customization. */
    function lockSecondaryLaunchFields() {
        const isIos = (typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : 'Android') === 'IOS';
        ["udid", "appiumurl", "platformversion", "automationName"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = false;
        });
        const bundleInput = document.getElementById("bundleID");
        if (bundleInput) bundleInput.disabled = !isIos;
        const appPkgInput = document.getElementById("apppackage");
        if (appPkgInput) appPkgInput.disabled = isIos;
        const appActInput = document.getElementById("appactivity");
        if (appActInput) appActInput.disabled = isIos;
    }

    // After Reset: only Launch + Platform / App / Device stay enabled; table data cleared
    function applyPostResetUI() {
        resetFormLockActive = true;
        registeredFeatureAreas = [];
        createFeatureMode = false;

        // Only Launch Application enabled
        const runBtn = document.getElementById('Run');
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.style.backgroundColor = '#2F8BCC';
        }

        const actionButtons = ['Scrape', 'scrapeUI', 'reset', 'download', 'algoQA', 'recordScenarioBtn', 'addScenarioBtn', 'createFeatureBtn'];
        actionButtons.forEach((id) => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.disabled = true;
                btn.style.backgroundColor = '#B6B6B4';

                // Reset Create Feature button text if needed
                if (id === 'createFeatureBtn') {
                    const btnSpan = btn.querySelector('span');
                    if (btnSpan) btnSpan.innerText = "Create Feature";
                }
            }
        });

        // Top 3 selectable fields only
        ["platformname", "appname", "devicename"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = false;
        });

        // Keep platform-specific visibility, then re-lock secondary inputs
        if (typeof updatePlatformUI === 'function') updatePlatformUI();
        lockSecondaryLaunchFields();
        setPageNameBoxEnabled(false);

        const recordScenarioBtn = document.getElementById('recordScenarioBtn');
        const recordScenarioWrapper = document.getElementById('recordScenarioWrapper');
        const addScenarioBtn = document.getElementById('addScenarioBtn');
        if (recordScenarioBtn && addScenarioBtn) {
            recordScenarioBtn.style.setProperty("display", "inline-flex", "important");
            if (recordScenarioWrapper) recordScenarioWrapper.style.setProperty("display", "inline-flex", "important");
            addScenarioBtn.style.setProperty("display", "none", "important");
            recordScenarioBtn.disabled = true;
            recordScenarioBtn.style.backgroundColor = '#B6B6B4';
        }
    }

    // selenium-webdriver wraps each arg into args[] — pass the params OBJECT, not [{...}]
    async function mobileExecute(script, params) {
        if (!driver) throw new Error("No active driver session");
        return driver.executeScript(script, params || {});
    }

    async function applyAndroidFullHierarchySettings() {
        if (!driver) return;
        const settings = {
            ignoreUnimportantViews: false,
            allowInvisibleElements: true,
            enableMultiWindows: false,
            snapshotMaxDepth: 100
        };
        try {
            await mobileExecute("mobile: updateSettings", { settings });
            return;
        } catch (_) {}
        try {
            await mobileExecute("mobile:settings", { settings });
        } catch (_) {}
    }

    ipcRenderer.on(
        "user-data",
        (event, userData) => {

            console.log(
                "Received User Data:",
                userData
            );

            localStorage.setItem(
                "algoQAUser",
                JSON.stringify(userData)
            );

            console.log(
                "Saved To LocalStorage:",
                userData
            );
        }
    );

    // 1. Create a dedicated ResizeObserver for the table container
    const tableContainerObserver = new ResizeObserver(() => {
        // requestAnimationFrame ensures this runs smoothly alongside browser repaints
        requestAnimationFrame(adjustEmptyRows);
    });

    window.addEventListener("DOMContentLoaded", () => {
        const tableContainer = document.getElementById('table-container');

        if (tableContainer) {
            // 2. Attach the observer. Any time the container changes size
            // (including when display goes from 'none' to 'block'), it will auto-adjust rows.
            tableContainerObserver.observe(tableContainer);
            tableContainer.style.display = "block";
        }

        // 3. Use a slight timeout on initial load to guarantee CSS files have fully applied
        setTimeout(() => {
            renderDefaultExcelGrid();
            initResizableTable();
        }, 50);
    });

   window.addEventListener("DOMContentLoaded", () => {
       document.getElementById("split-div3").style.display = "none";
       document.getElementById("tapBtn").style.background = "#2F8BCC";
       document.getElementById("tapBtn").style.color = "#fff";
       document.getElementById("touchBtn").style.background = "transparent";
       document.getElementById("touchBtn").style.color = "#333";

       // ALWAYS clear past session on a fresh app launch so it never auto-connects
       localStorage.removeItem("algoQAUser");

       // Windows: keep same dropdown chrome, Android-only option list
       if (process.platform === 'win32') {
           lockPlatformToAndroidOnWindows();
       }
       showDummyDeviceMessage({ theme: 'info', title: getIdleDummyTitle() });
       // Fill table empty rows after shared layout settles (Windows + macOS)
       requestAnimationFrame(() => {
           if (typeof adjustEmptyRows === 'function') adjustEmptyRows();
           setTimeout(() => {
               if (typeof adjustEmptyRows === 'function') adjustEmptyRows();
           }, 250);
       });

       // Apply the correct state (this fixes the cold boot race condition)
       applyLaunchModeState();

       // Trigger platform UI (Android fields / iOS fields) on load
       const platformSelect = document.getElementById('platformname');
       if (platformSelect && platformSelect.tagName === 'SELECT') {
           platformSelect.dispatchEvent(new Event('change'));
       } else if (typeof updatePlatformUI === 'function') {
           updatePlatformUI();
       }

       // Initialize animated typewriter placeholder on token input
       initTokenPlaceholderAnimation();
   });

    function initTokenPlaceholderAnimation() {
        const tokenInput = document.getElementById("tokenInput");
        if (!tokenInput) return;

        const phrases = [
            "Paste your token...",
            "Paste token here...",
            "Enter access token...",
            "algoQA API token..."
        ];

        let phraseIndex = 0;
        let charIndex = 0;
        let isDeleting = false;
        let animationTimeout = null;

        function typeLoop() {
            if (!tokenInput || tokenInput.style.display === "none") {
                animationTimeout = setTimeout(typeLoop, 800);
                return;
            }

            // Pause animation if user has entered text
            if (tokenInput.value && tokenInput.value.length > 0) {
                animationTimeout = setTimeout(typeLoop, 800);
                return;
            }

            const currentPhrase = phrases[phraseIndex];

            if (isDeleting) {
                charIndex--;
                tokenInput.setAttribute("placeholder", currentPhrase.substring(0, charIndex));
            } else {
                charIndex++;
                tokenInput.setAttribute("placeholder", currentPhrase.substring(0, charIndex));
            }

            let delay = isDeleting ? 40 : 85;

            if (!isDeleting && charIndex === currentPhrase.length) {
                // Pause after completing a phrase
                delay = 2200;
                isDeleting = true;
            } else if (isDeleting && charIndex === 0) {
                isDeleting = false;
                phraseIndex = (phraseIndex + 1) % phrases.length;
                delay = 400;
            }

            animationTimeout = setTimeout(typeLoop, delay);
        }

        typeLoop();

        tokenInput.addEventListener("focus", () => {
            if (!tokenInput.value) {
                tokenInput.setAttribute("placeholder", "Paste your token here...");
            }
        });

        tokenInput.addEventListener("blur", () => {
            if (!tokenInput.value) {
                charIndex = 0;
                isDeleting = false;
            }
        });
    }

    // ===========================================================================
    // [LAUNCH-MODE] Token gate for Launch Application (Windows + macOS)
    // ---------------------------------------------------------------------------
    // launchedViaProtocol === true  → opened via myapp:// (AlgoQA API / deep link)
    //   • Hide "Paste your Token"
    //   • Enable Launch immediately
    // launchedViaProtocol === false → normal double-click / npm start
    //   • Show token field
    //   • Keep Launch DISABLED until a valid token is saved in localStorage
    // main.js sends IPC "launch-mode" after the window is ready.
    // ===========================================================================

    /** Enable/disable #Run and sync blue vs grey pill styling. */
    function setLaunchEnabled(enabled) {
        const runBtn = document.getElementById("Run");
        if (!runBtn) return;
        runBtn.disabled = !enabled;
        runBtn.style.backgroundColor = enabled ? "#2F8BCC" : "#B6B6B4";
    }

    /** True when localStorage has a decrypted AlgoQA session from a pasted token. */
    function hasConnectedToken() {
        try {
            const raw = localStorage.getItem("algoQAUser");
            if (!raw) return false;
            const parsed = JSON.parse(raw);
            return !!(parsed && (parsed.userID || parsed.userId || parsed.baseUrl));
        } catch (_) {
            return false;
        }
    }

    /** Apply protocol vs double-click UI rules to token controls + Launch. */
    function applyLaunchModeState() {
        const tokenInput = document.getElementById("tokenInput");
        const changeTokenBtn = document.getElementById("changeTokenBtn");
        const tokenStatus = document.getElementById("tokenStatus");

        if (launchedViaProtocol) {
            // API / deep-link: credentials already provided — no token UI
            if (tokenInput) tokenInput.style.setProperty("display", "none", "important");
            if (changeTokenBtn) changeTokenBtn.style.setProperty("display", "none", "important");
            if (tokenStatus) tokenStatus.style.setProperty("display", "none", "important");

            setLaunchEnabled(true);
            // Scrape / Download / etc. stay locked until after a successful Launch
            document.getElementById("Scrape").disabled = true;
            document.getElementById("Scrape").style.backgroundColor = "#B6B6B4";
            document.getElementById("download").disabled = true;
            document.getElementById("download").style.backgroundColor = "#B6B6B4";
            document.getElementById("reset").disabled = true;
            document.getElementById("reset").style.backgroundColor = "#B6B6B4";
            document.getElementById("scrapeUI").disabled = true;
            document.getElementById("scrapeUI").style.backgroundColor = "#B6B6B4";
            document.getElementById("algoQA").disabled = true;
            document.getElementById("algoQA").style.backgroundColor = "#B6B6B4";
        } else {
            // Desktop open: user must paste token before Launch
            if (tokenInput) {
                tokenInput.style.setProperty("display", "inline-block", "important");
                if (!hasConnectedToken()) {
                    tokenInput.value = "";
                }
                tokenInput.disabled = false;
                tokenInput.readOnly = false;
            }
            if (changeTokenBtn) changeTokenBtn.style.setProperty("display", "none", "important");
            if (tokenStatus) tokenStatus.style.setProperty("display", "none", "important");

            setLaunchEnabled(hasConnectedToken());
        }
        if (typeof setPageNameBoxEnabled === 'function') {
            setPageNameBoxEnabled(!!driver);
        }
    }

    // main → renderer: true = myapp:// protocol, false = normal app start
    ipcRenderer.on("launch-mode", (event, launchedFromProtocol) => {
        launchedViaProtocol = !!launchedFromProtocol;

        const apply = () => {
            if (typeof applyLaunchModeState === 'function') applyLaunchModeState();
        };

        if (document.readyState === "interactive" || document.readyState === "complete") {
            apply();
        } else {
            window.addEventListener("DOMContentLoaded", apply, { once: true });
        }
    });

    // Fresh window: clear prior token session, then lock Launch for double-click mode
    window.addEventListener("DOMContentLoaded", () => {
        document.getElementById("split-div3").style.display = "none";

        document.getElementById("tapBtn").style.background = "#2F8BCC";
        document.getElementById("tapBtn").style.color = "#fff";

        document.getElementById("touchBtn").style.background = "transparent";
        document.getElementById("touchBtn").style.color = "#333";

    // Do not restore a previous token across normal desktop restarts.
    // Protocol / API launches may already have user-data — keep that session.
    if (!launchedViaProtocol) {
        localStorage.removeItem("algoQAUser");
    }

        applyLaunchModeState();
    });

    const CryptoJS = require("crypto-js");

    const secretKey = "algoshackv5-123";

    function decryptData(cipherText) {
        try {
            const bytes = CryptoJS.AES.decrypt(cipherText, secretKey);
            // Enforcing strict UTF-8 conversion drops malformed block fragments
            const decrypted = bytes.toString(CryptoJS.enc.Utf8);

            // If the parsing fails to return readable text, it's an invalid block sequence
            if (!decrypted || decrypted.trim() === "") {
                return null;
            }

            console.log("Decrypted successfully:", decrypted);
            return decrypted;
        } catch (err) {
            console.error("Decrypt Error:", err);
            return null;
        }
    }

    // var controlIdList =[];
    // let screenName = false;

//    var plateformName = document.getElementById('platformname');
//    var plateformOption = plateformName.options[plateformName.selectedIndex].text;

//    document.getElementById('platformname').value = 'IOS';
//    document.getElementById('platformname').disabled = true;

    prestart();

    // ---- Custom dropdown enhancer (keeps native <select> API working) ----
    function closeAllCustomSelects(exceptWrap) {
        document.querySelectorAll('.custom-select-wrap.is-open').forEach((wrap) => {
            if (exceptWrap && wrap === exceptWrap) return;
            wrap.classList.remove('is-open');
            const trigger = wrap.querySelector('.custom-select-trigger');
            if (trigger) trigger.style.borderRadius = '';
        });
    }

    // Custom dropdown chrome over native <select> (Platform / App / Device)
    function enhanceCustomSelect(selectEl) {
        if (!selectEl || selectEl.dataset.customized === '1') return;
        selectEl.dataset.customized = '1';
        selectEl.classList.add('native-select-hidden', 'js-custom-select');

        const wrap = document.createElement('div');
        wrap.className = 'custom-select-wrap';
        selectEl.parentNode.insertBefore(wrap, selectEl);
        wrap.appendChild(selectEl);

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'custom-select-trigger';
        trigger.innerHTML = `
            <span class="custom-select-label is-placeholder">Select...</span>
            <svg class="custom-select-caret" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
            </svg>
        `;
        const menu = document.createElement('div');
        menu.className = 'custom-select-menu';
        menu.setAttribute('role', 'listbox');

        wrap.appendChild(trigger);
        wrap.appendChild(menu);

        const labelEl = trigger.querySelector('.custom-select-label');

        function syncDisabledAndError() {
            const disabled = !!selectEl.disabled;
            trigger.disabled = disabled;
            wrap.classList.toggle('is-disabled', disabled);
            if (disabled) wrap.classList.remove('is-open');

            const border = (selectEl.style && selectEl.style.borderColor) || '';
            const hasError = border === 'red' || border === 'rgb(255, 0, 0)' || border === '#ff0000' || border === '#d9534f';
            wrap.classList.toggle('has-error', hasError);
        }

        function rebuildMenu() {
            const options = Array.from(selectEl.options || []);
            menu.innerHTML = '';

            if (!options.length) {
                menu.innerHTML = `<div class="custom-select-empty">No options</div>`;
                labelEl.textContent = 'Select...';
                labelEl.classList.add('is-placeholder');
                syncDisabledAndError();
                return;
            }

            let selectedOpt = options[selectEl.selectedIndex];
            if (!selectedOpt && options.length) {
                selectEl.selectedIndex = 0;
                selectedOpt = options[0];
            }

            options.forEach((opt, index) => {
                const item = document.createElement('div');
                item.className = 'custom-select-option';
                item.setAttribute('role', 'option');
                item.dataset.index = String(index);

                const isSelected = (index === selectEl.selectedIndex);
                if (opt.disabled) item.classList.add('is-disabled');
                if (isSelected) item.classList.add('is-selected');

                const textSpan = document.createElement('span');
                textSpan.className = 'custom-select-option-text';
                textSpan.textContent = opt.textContent || opt.value || '';
                item.appendChild(textSpan);

                if (isSelected) {
                    const checkSpan = document.createElement('span');
                    checkSpan.style.display = 'inline-flex';
                    checkSpan.style.alignItems = 'center';
                    checkSpan.style.marginLeft = '8px';
                    checkSpan.style.flexShrink = '0';
                    checkSpan.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" style="width: 14px; height: 14px; color: #2F8BCC;"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`;
                    item.appendChild(checkSpan);
                }

                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (opt.disabled) return;

                    selectEl.selectedIndex = index;
                    selectEl.value = opt.value;
                    selectEl.style.borderColor = '';
                    rebuildMenu();
                    wrap.classList.remove('is-open');
                    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                });

                menu.appendChild(item);
            });

            if (selectedOpt) {
                const text = (selectedOpt.textContent || selectedOpt.value || '').trim();
                labelEl.textContent = text || 'Select...';
                labelEl.classList.toggle('is-placeholder', !text || text === 'Loading Apps...');
            }
            syncDisabledAndError();
        }

        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (selectEl.disabled) return;
            selectEl.style.borderColor = '';
            syncDisabledAndError();
            const willOpen = !wrap.classList.contains('is-open');
            closeAllCustomSelects(wrap);
            if (willOpen) {
                const rect = trigger.getBoundingClientRect();
                menu.style.left = `${Math.round(rect.left)}px`;
                menu.style.width = `${Math.round(rect.width)}px`;
                menu.style.top = `${Math.round(rect.bottom + 4)}px`;
                menu.style.bottom = 'auto';

                // Flip upward if not enough space below
                const spaceBelow = window.innerHeight - rect.bottom;
                if (spaceBelow < 180 && rect.top > spaceBelow) {
                    menu.style.top = 'auto';
                    menu.style.bottom = `${Math.round(window.innerHeight - rect.top + 4)}px`;
                }
            }
            wrap.classList.toggle('is-open', willOpen);
        });

        // Keep UI in sync when options / disabled / style change programmatically
        const mo = new MutationObserver(() => rebuildMenu());
        mo.observe(selectEl, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['disabled', 'style', 'value']
        });

        // selectedIndex / value changes without mutation (e.g. .value = x)
        const proto = Object.getPrototypeOf(selectEl);
        const valueDesc = Object.getOwnPropertyDescriptor(proto, 'value');
        const indexDesc = Object.getOwnPropertyDescriptor(proto, 'selectedIndex');
        if (valueDesc && valueDesc.set) {
            Object.defineProperty(selectEl, 'value', {
                configurable: true,
                enumerable: true,
                get() { return valueDesc.get.call(this); },
                set(v) {
                    valueDesc.set.call(this, v);
                    rebuildMenu();
                }
            });
        }
        if (indexDesc && indexDesc.set) {
            Object.defineProperty(selectEl, 'selectedIndex', {
                configurable: true,
                enumerable: true,
                get() { return indexDesc.get.call(this); },
                set(v) {
                    indexDesc.set.call(this, v);
                    rebuildMenu();
                }
            });
        }

        rebuildMenu();
        selectEl._rebuildCustomSelect = rebuildMenu;
    }

    function initAllCustomSelects() {
        document.querySelectorAll('select.js-custom-select, #platformname, #appname, #devicename').forEach((el) => {
            if (el.tagName !== 'SELECT') return;
            enhanceCustomSelect(el);
        });
    }

    // ===========================================================================
    // [WIN-ANDROID] Windows platform lock
    // ---------------------------------------------------------------------------
    // Windows packages omit XCUITest. Keep the same <select> + custom-select chrome
    // as macOS; only remove the IOS option so Android scrapes look/feel identical.
    // ===========================================================================
    function lockPlatformToAndroidOnWindows() {
        if (process.platform !== 'win32') return;
        const platformEl = document.getElementById('platformname');
        if (!platformEl || platformEl.tagName !== 'SELECT') return;

        platformEl.innerHTML = '<option value="Android" selected>Android</option>';
        platformEl.value = 'Android';
    }

    lockPlatformToAndroidOnWindows();
    initAllCustomSelects();
    document.addEventListener('click', () => closeAllCustomSelects());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAllCustomSelects();
    });

    // ===========================================================================
    // [PLATFORM-UI] Platform / App / Device dropdowns
    // - Device list is filtered by selected platform (Android-only or iOS-only)
    // - When both platforms exist at startup, Android is preferred by default
    // - Switching platform live-checks devices via refresh-connected-devices IPC
    // ===========================================================================
    ipcRenderer.send('message', 'get me appData and device details');

    // --- AUTO-SWITCH PLATFORM ON LOAD ---
    let lastSelectedPlatform = document.getElementById('platformname')
        ? document.getElementById('platformname').value
        : 'Android';
    let applyingPlatformFromDevice = false;

    function normalizePlatformName(platform) {
        const p = String(platform || '').toUpperCase();
        if (p === 'IOS' || p === 'IPHONE OS' || p === 'IPADOS') return 'IOS';
        return 'Android';
    }

    function devicesForPlatform(platform, list) {
        const target = normalizePlatformName(platform);
        return (list || []).filter((d) => normalizePlatformName(d.platform) === target);
    }

    /** Android first when both platforms are present; preserves relative order within each. */
    function preferAndroidDevicesFirst(list) {
        const devices = list || [];
        const android = devices.filter((d) => normalizePlatformName(d.platform) === 'Android');
        const ios = devices.filter((d) => normalizePlatformName(d.platform) === 'IOS');
        return [...android, ...ios];
    }

    function deviceDisplayLabel(device) {
        if (!device) return '';
        const typeLabel = device.type === 'emulator'
            ? 'emulator'
            : device.type === 'simulator'
                ? 'simulator'
                : 'device';
        return `${device.name} (${typeLabel})`;
    }

    function populateDeviceDropdown(devices) {
        const deviceSelect = document.getElementById('devicename');
        if (!deviceSelect) return null;

        // Safety: never mix platforms in the Device Name dropdown
        const platformSelect = document.getElementById('platformname');
        const activePlatform = platformSelect?.value || lastSelectedPlatform || 'Android';
        const filtered = devicesForPlatform(activePlatform, devices);
        const ordered = preferAndroidDevicesFirst(filtered.length ? filtered : devices);

        deviceSelect.innerHTML = '';

        if (ordered.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.text = 'Select Device';
            deviceSelect.appendChild(option);
            deviceSelect.value = '';
            deviceId = '';
            deviceName = '';
            const udidInput = document.getElementById('udid');
            if (udidInput) udidInput.value = '';
            if (typeof deviceSelect._rebuildCustomSelect === 'function') {
                deviceSelect._rebuildCustomSelect();
            }
            return null;
        }

        ordered.forEach((device) => {
            const option = document.createElement('option');
            option.value = device.name;
            option.text = deviceDisplayLabel(device);
            option.dataset.deviceId = device.id;
            deviceSelect.appendChild(option);
        });

        deviceId = ordered[0].id;
        deviceName = ordered[0].name;
        deviceSelect.value = deviceName;
        const udidInput = document.getElementById('udid');
        if (udidInput) udidInput.value = deviceId;
        if (typeof deviceSelect._rebuildCustomSelect === 'function') {
            deviceSelect._rebuildCustomSelect();
        }
        return ordered[0];
    }

    async function refreshConnectedDevicesList() {
        try {
            const result = await ipcRenderer.invoke('refresh-connected-devices');
            if (result && Array.isArray(result.devices)) {
                connectedDevices = preferAndroidDevicesFirst(result.devices);
            }
            return connectedDevices || [];
        } catch (err) {
            console.error('refreshConnectedDevicesList failed:', err);
            return connectedDevices || [];
        }
    }

    let platformSwitchInProgress = false;

    function showPlatformSwitchLoader(message) {
        let loader = document.getElementById('platformSwitchLoader');
        if (!loader) {
            loader = document.createElement('div');
            loader.id = 'platformSwitchLoader';
            loader.innerHTML = `
                <img src="icon/load-8510_256.gif" alt="Loading" />
                <p class="platform-switch-msg"></p>
            `;
            document.body.appendChild(loader);
        }
        const msg = loader.querySelector('.platform-switch-msg');
        if (msg) {
            msg.textContent = message || 'Checking connected devices...';
        }
        loader.classList.add('is-visible');
        loader.style.display = 'flex';
    }

    function hidePlatformSwitchLoader() {
        const loader = document.getElementById('platformSwitchLoader');
        if (loader) {
            loader.classList.remove('is-visible');
            loader.style.display = 'none';
        }
    }

    ipcRenderer.on('message-from-main', (event, message) => {
        // Keep full list in memory; dropdown shows only the active platform
        connectedDevices = preferAndroidDevicesFirst(message.connectedDevices || []);
        console.log("connectedDevices =", connectedDevices);

        if (connectedDevices.length > 0) {
            // Default platform: Android if any Android device exists, else iOS
            // Windows builds are Android-only — never switch platform to iOS
            let preferredPlatform = connectedDevices.some(
                (d) => normalizePlatformName(d.platform) === 'Android'
            ) ? 'Android' : 'IOS';
            if (process.platform === 'win32') {
                preferredPlatform = 'Android';
            }

            const platformDevices = devicesForPlatform(preferredPlatform, connectedDevices);
            const selectedDevice = populateDeviceDropdown(platformDevices);
            if (!selectedDevice) return;

            const platformSelect = document.getElementById('platformname');
            if (platformSelect) {
                applyingPlatformFromDevice = true;
                platformSelect.value = preferredPlatform;
                lastSelectedPlatform = preferredPlatform;
                if (platformSelect.tagName === 'SELECT') {
                    platformSelect.dispatchEvent(new Event('change'));
                } else if (typeof updatePlatformUI === 'function') {
                    updatePlatformUI();
                }

                applyingPlatformFromDevice = false;
            }

            if (normalizePlatformName(selectedDevice.platform) === 'Android') {
                ipcRenderer.invoke("get-android-version", selectedDevice.id).then((ver) => {
                    if (ver) {
                        const pv = document.getElementById('platformversion');
                        if (pv) {
                            pv.value = ver;
                            pv.dataset.userEdited = 'true';
                        }
                    }
                }).catch(() => {});
            }

            ipcRenderer.send("get-installed-apps", selectedDevice);
        }

        // Start continuous real-time device monitoring
        startRealtimeDeviceMonitoring();
    });

    let realtimeDeviceMonitorInterval = null;
    let lastKnownDeviceFingerprint = "";

    function computeDeviceFingerprint(devices) {
        if (!devices || !devices.length) return "";
        return devices.map(d => `${d.id}:${d.platform}:${d.name}`).sort().join("|");
    }

    function startRealtimeDeviceMonitoring() {
        if (realtimeDeviceMonitorInterval) clearInterval(realtimeDeviceMonitorInterval);

        realtimeDeviceMonitorInterval = setInterval(async () => {
            if (platformSwitchInProgress) return;

            try {
                const freshDevices = await refreshConnectedDevicesList();
                const freshFingerprint = computeDeviceFingerprint(freshDevices);

                // --- 1. ACTIVE SESSION REAL-TIME VALIDATION ---
                if (driver) {
                    const activePlatform = typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : 'Android';
                    const activePlatformTarget = typeof normalizePlatformName === 'function' ? normalizePlatformName(activePlatform) : activePlatform;
                    const matchingActiveDevices = devicesForPlatform(activePlatformTarget, freshDevices);

                    const activeUdid = document.getElementById('udid')?.value || deviceId;
                    const isDeviceStillConnected = matchingActiveDevices.some(d => d.id === activeUdid || d.name === deviceName);

                    if (!isDeviceStillConnected) {
                        console.warn(`[Real-time Monitor] Active session device (${deviceName || activeUdid}) disconnected.`);
                        markSessionInterrupted(new Error(`device disconnected: ${deviceName || activeUdid}`));
                        lastKnownDeviceFingerprint = freshFingerprint;
                        return;
                    }
                }

                // --- 2. IDLE / FORM REAL-TIME UPDATE ---
                if (!driver && freshFingerprint !== lastKnownDeviceFingerprint) {
                    const wasDeviceConnectedBefore = !!lastKnownDeviceFingerprint;
                    lastKnownDeviceFingerprint = freshFingerprint;

                    const platformSelect = document.getElementById('platformname');
                    const activePlatform = platformSelect ? platformSelect.value : lastSelectedPlatform;
                    const platformTarget = typeof normalizePlatformName === 'function' ? normalizePlatformName(activePlatform) : activePlatform;
                    const matching = devicesForPlatform(platformTarget, freshDevices);

                    const currentUdid = document.getElementById('udid')?.value || deviceId;
                    const isCurrentSelectedStillConnected = matching.some(d => d.id === currentUdid);

                    if (matching.length > 0) {
                        if (!isCurrentSelectedStillConnected || !currentUdid) {
                            const selected = populateDeviceDropdown(matching);
                            if (selected) {
                                if (normalizePlatformName(selected.platform) === 'Android') {
                                    ipcRenderer.invoke("get-android-version", selected.id).then((ver) => {
                                        if (ver) {
                                            const pv = document.getElementById('platformversion');
                                            if (pv) {
                                                pv.value = ver;
                                                pv.dataset.userEdited = 'true';
                                            }
                                        }
                                    }).catch(() => {});
                                }
                                ipcRenderer.send("get-installed-apps", selected);
                            }
                        } else {
                            populateDeviceDropdown(matching);
                            const deviceSelect = document.getElementById('devicename');
                            if (deviceSelect && deviceName) deviceSelect.value = deviceName;
                        }

                        const runBtn = document.getElementById('Run');
                        if (runBtn && !resetFormLockActive) {
                            runBtn.disabled = false;
                            runBtn.style.backgroundColor = '#2F8BCC';
                        }
                    } else {
                        // Current platform has no devices!
                        // Check if an ALTERNATE platform has an available device
                        const alternateTarget = platformTarget === 'Android' ? 'IOS' : 'Android';
                        const alternateMatching = devicesForPlatform(alternateTarget, freshDevices);

                        if (alternateMatching.length > 0 && process.platform !== 'win32') {
                            // Automatically switch to available platform!
                            applyingPlatformFromDevice = true;
                            if (platformSelect) {
                                platformSelect.value = alternateTarget;
                                lastSelectedPlatform = alternateTarget;
                                if (typeof updatePlatformUI === 'function') updatePlatformUI();
                                if (typeof platformSelect._rebuildCustomSelect === 'function') {
                                    platformSelect._rebuildCustomSelect();
                                }
                            }
                            applyingPlatformFromDevice = false;

                            const selectedAlt = populateDeviceDropdown(alternateMatching);
                            if (selectedAlt) {
                                if (alternateTarget === 'Android') {
                                    ipcRenderer.invoke("get-android-version", selectedAlt.id).then((ver) => {
                                        if (ver) {
                                            const pv = document.getElementById('platformversion');
                                            if (pv) {
                                                pv.value = ver;
                                                pv.dataset.userEdited = 'true';
                                            }
                                        }
                                    }).catch(() => {});
                                }
                                ipcRenderer.send("get-installed-apps", selectedAlt);
                            }

                            const runBtn = document.getElementById('Run');
                            if (runBtn && !resetFormLockActive) {
                                runBtn.disabled = false;
                                runBtn.style.backgroundColor = '#2F8BCC';
                            }

                            if (wasDeviceConnectedBefore) {
                                showCustomAlert(
                                    "Device Disconnected",
                                    `The <b>${platformTarget === 'Android' ? 'Android' : 'iOS'}</b> device was disconnected.<br><br>Automatically switched to available <b>${alternateTarget === 'Android' ? 'Android' : 'iOS'}</b> device: <b>${selectedAlt ? selectedAlt.name : ''}</b>.`,
                                    "warning"
                                );
                            }
                        } else {
                            // NO devices connected on ANY platform!
                            const deviceSelect = document.getElementById('devicename');
                            if (deviceSelect) {
                                deviceSelect.innerHTML = '<option value="">Select Device</option>';
                                if (typeof deviceSelect._rebuildCustomSelect === 'function') {
                                    deviceSelect._rebuildCustomSelect();
                                }
                            }
                            const udidInput = document.getElementById('udid');
                            if (udidInput) udidInput.value = '';
                            deviceId = '';
                            deviceName = '';

                            const appSelect = document.getElementById('appname');
                            if (appSelect) {
                                appSelect.innerHTML = '<option value="">Select App</option>';
                                if (typeof appSelect._rebuildCustomSelect === 'function') {
                                    appSelect._rebuildCustomSelect();
                                }
                            }

                            const runBtn = document.getElementById('Run');
                            if (runBtn) {
                                runBtn.disabled = true;
                                runBtn.style.backgroundColor = '#B6B6B4';
                            }

                            if (wasDeviceConnectedBefore) {
                                showCustomAlert(
                                    "Device Disconnected",
                                    `The connected device was disconnected and no other device is available.<br><br>Please connect an Android device or start an iOS simulator.`,
                                    "warning"
                                );
                            }
                        }
                    }
                }
            } catch (pollErr) {
                console.warn("[Real-time Monitor] polling tick skipped:", pollErr);
            }
        }, 2000);
    }
    document.getElementById('devicename').addEventListener('change', async function() {
        const platformSelect = document.getElementById('platformname');
        const currentPlatform = platformSelect ? platformSelect.value : lastSelectedPlatform;
        const platformDevices = devicesForPlatform(currentPlatform, connectedDevices);
        const selectedDevice = platformDevices.find(device => device.name === this.value)
            || connectedDevices.find(device => device.name === this.value);

        if (selectedDevice) {
            deviceId = selectedDevice.id;
            deviceName = selectedDevice.name;
            document.getElementById('udid').value = selectedDevice.id;

            if (normalizePlatformName(selectedDevice.platform) === 'Android') {
                try {
                    const ver = await ipcRenderer.invoke("get-android-version", selectedDevice.id);
                    if (ver) {
                        const pv = document.getElementById('platformversion');
                        if (pv) {
                            pv.value = ver;
                            pv.dataset.userEdited = 'true';
                        }
                    }
                } catch (_) {}
            }

            ipcRenderer.send("get-installed-apps", selectedDevice);
        }
    });

//    document.getElementById('platformname').disabled = true;


    ipcRenderer.on("installed-apps", (event, apps) => {
            console.log("Installed Apps:", apps);
            const dropdown = document.getElementById("appname");
            if (!dropdown) return;

            const previousValue = dropdown.value;
            dropdown.innerHTML = "";

            (apps || []).forEach(app => {
                const option = document.createElement("option");
                option.text = app.name;
                option.value = app.bundleId;
                option.title = app.bundleId;
                dropdown.appendChild(option);
            });

            if (typeof dropdown._rebuildCustomSelect === 'function') {
                dropdown._rebuildCustomSelect();
            }

            if (!apps || !apps.length) return;

            // Keep current selection when labels refresh in background
            const stillExists = previousValue && apps.some((app) => app.bundleId === previousValue);
            if (stillExists) {
                dropdown.value = previousValue;
            } else {
                dropdown.selectedIndex = 0;
                dropdown.dispatchEvent(new Event('change'));
            }
        });

        document.getElementById("appname").addEventListener("change", function(){
            const platform = document.getElementById('platformname').value;

            if (platform === 'Android') {
                // Fill Android Package
                document.getElementById("apppackage").value = this.value;
                document.getElementById("appactivity").value = "Loading Activity...";

                // Ask main.js to use ADB to find the exact MainActivity for this package
                ipcRenderer.send("get-android-activity", {
                    udid: document.getElementById('udid').value,
                    pkg: this.value
                });
            } else {
                // Fill iOS Bundle ID
                document.getElementById("bundleID").value = this.value;
            }
        });

        // Receive the Android Activity from main.js and populate the field
        ipcRenderer.on("receive-android-activity", (event, activity) => {
            document.getElementById("appactivity").value = activity || "MainActivity";
        });


    const homeDirectory = require('os').homedir();
    folderPath = path.join(homeDirectory, 'algoScraperScreenShot');
    document.getElementById('Scrape').disabled = true;
    document.getElementById('Scrape').style.backgroundColor = '#B6B6B4'
    document.getElementById('download').disabled = true;
    document.getElementById('download').style.backgroundColor = '#B6B6B4'
        document.getElementById('reset').disabled = true;
      document.getElementById('reset').style.backgroundColor = '#B6B6B4'
    document.getElementById('scrapeUI').disabled = true;
    document.getElementById('scrapeUI').style.backgroundColor = '#B6B6B4';

    document.getElementById('algoQA').disabled = true;
    document.getElementById('algoQA').style.backgroundColor = '#B6B6B4';

    // Double-click start: Launch stays off until token (protocol mode enables via IPC)
    if (!launchedViaProtocol) {
        if (typeof setLaunchEnabled === 'function') {
            setLaunchEnabled(false);
        } else {
            const runEarly = document.getElementById('Run');
            if (runEarly) {
                runEarly.disabled = true;
                runEarly.style.backgroundColor = '#B6B6B4';
            }
        }
    } else if (typeof applyLaunchModeState === 'function') {
        applyLaunchModeState();
    }

    document.getElementById("Run").addEventListener('click', async () => {
            // Windows: #platformname is a readonly INPUT; macOS: SELECT — never use .options
            var plateformOption = getSelectedPlatform();
            var appName = document.getElementById('appname').value;
            var deviceName = document.getElementById('devicename').value;
            var udidName = document.getElementById('udid').value;
            var platformVersion = document.getElementById('platformversion').value;
            var automationName = document.getElementById('automationName').value;
            var bundleID = document.getElementById('bundleID').value;
            var appPackage = document.getElementById('apppackage').value;
            var appActivity = document.getElementById('appactivity').value;
            var appiumURL = document.getElementById('appiumurl').value;

            function triggerScreenshotLoader() {
                if (process.platform !== 'win32') {
                    document.getElementById('overlay').style.display = 'block';
                }
                document.getElementById('AppRunningPopup').style.display = 'none';
                showDummyDeviceMessage({
                    theme: 'loading',
                    title: 'Starting session and loading screen…'
                });
            }

    // ===========================================================================
    // ===========================================================================
    // [LAUNCH] Launch Application
    // Validates platform fields → ensure-appium IPC → builds caps → wd session
    // Android: prepare device, no force-stop launch; then android-soft-launch
    // iOS:     appium:bundleId + mobile: activateApp after session
    // On success: enables Scrape UI / Download / Record / Send (Load Page stays disabled)
    // ===========================================================================
    // Android: UiAutomator2 + appPackage/appActivity (+ optional ADB prepare/soft-launch)
    // iOS:     XCUITest + bundleId (+ mobile: activateApp)
    // Always ensure bundled Appium is up via IPC before creating the session.
    // ===========================================================================
            // 1. Smart Validation based on Platform
            let isValid = true;
            if (appName.trim() === '') { document.getElementById('appname').style.borderColor = 'red'; isValid = false; }
            if (deviceName.trim() === '') { document.getElementById('devicename').style.borderColor = 'red'; isValid = false; }
            if (udidName.trim() === '') { document.getElementById('udid').style.borderColor = 'red'; isValid = false; }
            if (appiumURL.trim() === '') { document.getElementById('appiumurl').style.borderColor = 'red'; isValid = false; }
            if (automationName.trim() === '') { document.getElementById('automationName').style.borderColor = 'red'; isValid = false; }
            if (plateformOption === 'Android') {
                if (appPackage.trim() === '') { document.getElementById('apppackage').style.borderColor = 'red'; isValid = false; }
                if (appActivity.trim() === '') { document.getElementById('appactivity').style.borderColor = 'red'; isValid = false; }
                // platformVersion is helpful but UiAutomator2 can work with udid alone
                if (platformVersion.trim() === '') {
                    platformVersion = '14';
                    document.getElementById('platformversion').value = platformVersion;
                }
            } else {
                if (bundleID.trim() === '') { document.getElementById('bundleID').style.borderColor = 'red'; isValid = false; }
                if (platformVersion.trim() === '') { document.getElementById('platformversion').style.borderColor = 'red'; isValid = false; }
            }

            // 2. Launch if Valid
            if (isValid) {
                triggerScreenshotLoader();

                // IMPORTANT: Create the exact 9-item array expected by launchApp
                initialData = [plateformOption, deviceName, platformVersion, automationName, appiumURL, udidName, bundleID, appPackage, appActivity];

                // Keep configuration fields enabled so user can always edit them
                resetFormLockActive = false;

                launchApp(initialData);
            }
        });

        async function launchApp(initialData) {
            var platform = initialData[0]; // Android or IOS/iOS
            var deviceName = initialData[1];
            var platformVersion = initialData[2];
            var automationName = initialData[3];
            var serverURL = initialData[4];
            var udid = initialData[5];
            var bundleID = initialData[6];
            var appPackage = initialData[7];
            var appActivity = initialData[8];
            const launchingAndroid = platform === 'Android';

            // Verify selected device is connected for both iOS and Android before attempting launch
            try {
                const liveDevices = await refreshConnectedDevicesList();
                const platformTarget = typeof normalizePlatformName === 'function' ? normalizePlatformName(platform) : (platform === 'Android' ? 'Android' : 'IOS');
                const platformDevices = devicesForPlatform(platformTarget, liveDevices);
                const isStillConnected = platformDevices.some(d => d.id === udid || d.name === deviceName);
                if (!isStillConnected) {
                    const isIos = platformTarget === 'IOS';
                    const hint = isIos
                        ? 'Please open an iOS Simulator or connect an iPhone, then try again.'
                        : 'Please connect an Android device or start an emulator, then try again.';
                    unlockLaunchForm();
                    document.getElementById('overlay').style.display = 'none';
                    resetLaunchPlaceholder(
                        `${isIos ? 'iOS' : 'Android'} device not connected. Connect a device or start simulator/emulator, then click Launch Application.`,
                        "error"
                    );
                    showCustomAlert(
                        "Device Not Connected",
                        `The selected ${isIos ? 'iOS' : 'Android'} device (<b>${deviceName || udid}</b>) is not connected.<br><br>${hint}`,
                        "warning"
                    );
                    return;
                }
            } catch (_) {}

            if (launchingAndroid) {
                try {
                    const sdk = await ipcRenderer.invoke("android-sdk-status");
                    if (!sdk || !sdk.found) {
                        const err = new Error(
                            (sdk && sdk.message)
                            || "Android SDK was not found (ANDROID_HOME / ANDROID_SDK_ROOT)."
                        );
                        showErrorPopup("Android SDK Required", err);
                        unlockLaunchForm();
                        resetLaunchPlaceholder(
                            "Could not set up Android tools. Check internet and try Launch again.",
                            "error"
                        );
                        return;
                    }
                } catch (sdkErr) {
                    console.warn("android-sdk-status failed:", sdkErr && sdkErr.message);
                }
            }

            // Make sure Appium is listening before creating the session
            try {
                const boot = await ipcRenderer.invoke("ensure-appium");
                if (!boot || !boot.success) {
                    throw new Error(boot && boot.error ? boot.error : "Appium is not running on port 4723");
                }
            } catch (bootErr) {
                console.error("Appium ensure failed:", bootErr);
                showErrorPopup("Appium Not Running", bootErr);
                unlockLaunchForm();
                resetLaunchPlaceholder(
                    "Appium is not running on port 4723. Restart AlgoScraper or run npm run setup.",
                    "error"
                );
                return;
            }

            const isAndroid = platform === 'Android';

            // Auto-correct Android platform version from the device when possible
            if (isAndroid && udid) {
                try {
                    const detected = await ipcRenderer.invoke("get-android-version", udid);
                    if (detected) {
                        platformVersion = String(detected);
                        const pv = document.getElementById('platformversion');
                        if (pv) pv.value = platformVersion;
                    }
                } catch (_) {}
            }

            // Normalize automation name casing
            if (isAndroid) {
                automationName = 'UiAutomator2';
            } else {
                automationName = 'XCUITest';
            }
            const autoInput = document.getElementById('automationName');
            if (autoInput) autoInput.value = automationName;

            // Quit any previous driver so UiAutomator2 server is not left in a bad state
            if (driver) {
                try { await driver.quit(); } catch (_) {}
                driver = null;
            }
            try {
                await ipcRenderer.invoke("clear-appium-sessions");
            } catch (_) {}

            var caps = {
                platformName: isAndroid ? 'Android' : 'iOS',
                "appium:deviceName": deviceName,
                "appium:platformVersion": platformVersion,
                "appium:automationName": automationName,
                "appium:udid": udid,
                "appium:newCommandTimeout": 500000
            };

            if (isAndroid) {
                // Clean leftover UIA2 / go HOME before creating session.
                // Do NOT open the target app yet — opening ChatGPT before UIA2 boots can crash instrumentation on OPPO.
                try {
                    await ipcRenderer.invoke("android-prepare-device", udid);
                    await new Promise(r => setTimeout(r, 800));
                } catch (prepErr) {
                    console.log("Android prepare skipped:", prepErr.message);
                }

                // Never pass appPackage/appActivity / forceAppLaunch on ColorOS — that triggers `am start -S`
                // and kills UiAutomator2 (session "not known" / Process crashed).
                caps["appium:autoGrantPermissions"] = true;
                caps["appium:noReset"] = true;
                caps["appium:dontStopAppOnReset"] = true;
                caps["appium:autoLaunch"] = false;
                caps["appium:ignoreHiddenApiPolicyError"] = true;
                caps["appium:skipLogcatCapture"] = true;
                caps["appium:disableWindowAnimation"] = true;
                caps["appium:uiautomator2ServerLaunchTimeout"] = 90000;
                caps["appium:adbExecTimeout"] = 90000;
                caps["appium:systemPort"] = 8200 + Math.floor(Math.random() * 100);
                // Full accessibility tree like iOS XCUITest (default skips "unimportant" Compose/Calendar nodes)
                caps["appium:settings"] = {
                    ignoreUnimportantViews: false,
                    allowInvisibleElements: true,
                    enableMultiWindows: false,
                    snapshotMaxDepth: 100
                };
            } else {
                caps["appium:bundleId"] = bundleID;
                caps["appium:simpleIsVisibleCheck"] = true;
                caps["appium:preventWDAAttachments"] = true;
                caps["appium:useJSONSource"] = false;
            }

            try {
                console.log("Building Appium driver with capabilities:", caps);

                const buildSession = async () => new wd.Builder()
                    .usingServer(serverURL)
                    .withCapabilities(caps)
                    .forBrowser("")
                    .build();

                try {
                    driver = await buildSession();
                } catch (firstErr) {
                    const msg = String(firstErr && firstErr.message || firstErr);
                    if (/Could not find a driver|UiAutomator2|automationName/i.test(msg)) {
                        console.warn("UiAutomator2 missing on Appium — restarting bundled engine and retrying");
                        await ipcRenderer.invoke("ensure-appium", { forceRestart: true });
                        driver = await buildSession();
                    } else {
                        throw firstErr;
                    }
                }

                // AFTER session is healthy: wait for UiAutomator2, then open the app once.
                // Do not activateApp immediately — that can crash instrumentation and black the emulator.
                if (isAndroid) {
                    await waitMs(2000);
                    try {
                        const soft = await ipcRenderer.invoke("android-soft-launch", {
                            udid,
                            pkg: appPackage,
                            activity: appActivity
                        });
                        if (soft && !soft.success) {
                            console.warn("android-soft-launch:", soft.error);
                        }
                    } catch (softErr) {
                        console.log("android-soft-launch skipped:", softErr.message);
                    }
                    await waitMs(1500);
                    await assertAndroidAppOpened(appPackage);
                } else {
                    try {
                        await mobileExecute("mobile: activateApp", { bundleId: bundleID });
                    } catch (activateErr) {
                        console.log("activate/soft-launch skipped:", activateErr.message);
                    }
                }
                if (isAndroid) {
                    try { await applyAndroidFullHierarchySettings(); } catch (setErr) {
                        console.warn("Android hierarchy settings skipped:", setErr.message || setErr);
                    }
                }
            } catch (error) {
                console.error("Failed to initialize driver session:", error);
                driver = null;
                const msg = String((error && error.message) || error || "");
                const isDeviceOffline = /device.*offline|device.*not found|could not connect|econnrefused|device '[^']+' not found/i.test(msg);
                const androidOpenFailed = isAndroid && /did not open|package is missing/i.test(msg);
                const sdkMissing = isAndroid && /ANDROID_HOME|ANDROID_SDK_ROOT/i.test(msg);

                if (isDeviceOffline) {
                    showCustomAlert(
                        "Device Disconnected",
                        `Connection to the <b>${isAndroid ? 'Android' : 'iOS'}</b> device failed.<br><br>Please check that your device or emulator is connected, unlocked, and responsive, then try again.`,
                        "warning"
                    );
                    unlockLaunchForm();
                    resetLaunchPlaceholder(
                        "Device disconnected or unresponsive. Reconnect device and click Launch Application.",
                        "error"
                    );
                    return;
                }

                showErrorPopup(
                    androidOpenFailed
                        ? "Application Did Not Open"
                        : sdkMissing
                            ? "Android SDK Required"
                            : "Appium Driver Initialization Failed",
                    sdkMissing
                        ? new Error(
                            "AlgoScraper could not set up Android tools (ANDROID_HOME).\n\n"
                            + "It normally downloads platform-tools automatically. Check internet and retry Launch.\n\n"
                            + "You still need a running emulator or a phone with USB debugging."
                        )
                        : error
                );
                unlockLaunchForm();
                resetLaunchPlaceholder(
                    androidOpenFailed
                        ? "The selected app did not open. Check package/activity, then click Launch Application again."
                        : sdkMissing
                            ? "Could not set up Android tools. Check internet and try Launch again."
                            : "Launch failed. Check the error popup, then try Launch Application again.",
                    "error"
                );
                return;
            }

            // Enable UI buttons upon successful launch
            document.getElementById('Run').disabled = true;
            document.getElementById('Run').style.backgroundColor = '#B6B6B4';
            // Load Page stays hidden/disabled — Scrape UI + tap scrape are the active paths
            document.getElementById('Scrape').disabled = true;
            document.getElementById('Scrape').style.backgroundColor = '#B6B6B4';
            document.getElementById('download').disabled = false;
            document.getElementById('download').style.backgroundColor = '#2F8BCC';
            document.getElementById('reset').disabled = false;
            document.getElementById('reset').style.backgroundColor = '#2F8BCC';
            document.getElementById('scrapeUI').disabled = false;
            document.getElementById('scrapeUI').style.backgroundColor = '#2F8BCC';
            document.getElementById('algoQA').disabled = false;
            document.getElementById('algoQA').style.backgroundColor = '#2F8BCC';
            document.getElementById('AppRunningPopup').style.display = 'none';
            document.getElementById('overlay').style.display = 'none';
            document.getElementById('recordScenarioBtn').disabled = false;
            document.getElementById('recordScenarioBtn').style.backgroundColor = '#2F8BCC';
            document.getElementById('createFeatureBtn').disabled = false;
            document.getElementById('createFeatureBtn').style.backgroundColor = '#2F8BCC';
            setPageNameBoxEnabled(true);
            const addScenarioBtnAfterLaunch = document.getElementById('addScenarioBtn');
            if (addScenarioBtnAfterLaunch) {
                addScenarioBtnAfterLaunch.disabled = false;
                addScenarioBtnAfterLaunch.style.backgroundColor = '#2F8BCC';
            }

            try {
                await loadFirstScreen();
                refreshShouldLaunchApp = false;
                if (typeof window.switchAppTab === "function") window.switchAppTab("home");
            } catch (screenErr) {
                console.error("loadFirstScreen failed:", screenErr);
                displayScreenshotError(screenErr);
            }
        }


    async function startApp(initialData) {


        var IOS_desiredCaps = {
            platformName: initialData[0],
            "appium:options": {
                deviceName: initialData[1],
                platformVersion: initialData[2],
                automationName: initialData[3],
                udid: initialData[5],
                bundleId: initialData[6],
                simpleIsVisibleCheck: true,
                preventWDAAttachments: true,
                useJSONSource: false,
                newCommandTimeout: 500000
            }
        };
    }

    // ===========================================================================
    // [CAPTURE] Screenshot + page source
    // Prefer Appium driver APIs; on Android fall back to ADB IPC when UIA2 dies
    // (common on ColorOS / flaky instrumentation). iOS uses Appium only.
    // ===========================================================================
    async function captureDeviceScreenshot() {
        // Prefer Appium screenshot; fall back to ADB when UiAutomator2 dies (common on OPPO/Android 16)
        try {
            if (driver) {
                return await driver.takeScreenshot();
            }
        } catch (e) {
            console.warn("Appium screenshot failed, trying ADB:", e.message);
        }

        const udid = document.getElementById('udid') && document.getElementById('udid').value;
        const platform = typeof getSelectedPlatform === 'function'
            ? getSelectedPlatform()
            : (document.getElementById('platformname') && document.getElementById('platformname').value);
        if (platform === 'Android' && udid) {
            const adbShot = await ipcRenderer.invoke("android-adb-screenshot", udid);
            if (adbShot && adbShot.success) {
                return adbShot.base64;
            }
            throw new Error(adbShot && adbShot.error ? adbShot.error : "ADB screenshot failed");
        }
        throw new Error("Unable to capture screenshot");
    }

    async function capturePageSource() {
        try {
            if (driver && typeof isAndroidPlatform === 'function' && isAndroidPlatform()) {
                try { await applyAndroidFullHierarchySettings(); } catch (_) {}
            }
            if (driver) {
                return await driver.getPageSource();
            }
        } catch (e) {
            console.warn("Appium getPageSource failed, trying ADB dump:", e.message);
        }

        const udid = document.getElementById('udid') && document.getElementById('udid').value;
        const platform = typeof getSelectedPlatform === 'function'
            ? getSelectedPlatform()
            : (document.getElementById('platformname') && document.getElementById('platformname').value);
        if (platform === 'Android' && udid) {
            const dump = await ipcRenderer.invoke("android-adb-pagesource", udid);
            if (dump && dump.success) {
                return dump.xml;
            }
            throw new Error(dump && dump.error ? dump.error : "ADB hierarchy dump failed");
        }
        throw new Error("Unable to get page source");
    }

    /** Wait until the app UI has settled (Android needs longer than iOS after launch). */
    async function waitUntilAppScreenReady({ minWait, retries, gap } = {}) {
        const isAndroid = typeof isAndroidPlatform === 'function' && isAndroidPlatform();
        const startWait = minWait != null ? minWait : (isAndroid ? 1600 : 800);
        const maxTries = retries != null ? retries : (isAndroid ? 5 : 3);
        const pause = gap != null ? gap : (isAndroid ? 600 : 400);

        await waitMs(startWait);

        let lastCount = 0;
        let lastDoc = null;
        for (let i = 0; i < maxTries; i++) {
            try {
                const src = await capturePageSource();
                if (src && src.length > 300) {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(src, "text/xml");
                    const count = doc.getElementsByTagName("*").length;
                    lastDoc = doc;
                    if (count > 5 && lastCount > 0 && Math.abs(count - lastCount) <= 2) {
                        window.xmlDoc = doc;
                        return doc;
                    }
                    lastCount = count;
                    if (count > 5 && i === maxTries - 1) {
                        window.xmlDoc = doc;
                        return doc;
                    }
                }
            } catch (e) {
                console.warn("waitUntilAppScreenReady:", e.message || e);
            }
            await waitMs(pause);
        }
        if (lastDoc) window.xmlDoc = lastDoc;
        return lastDoc;
    }

    async function loadFirstScreen() {
        try {
            await waitUntilAppScreenReady();

            const image = await captureDeviceScreenshot();

            const homeDirectory =
                require("os").homedir();

            folderPath =
                path.join(
                    homeDirectory,
                    "algoScraperScreenShot"
                );

            if (!fs.existsSync(folderPath)) {

                fs.mkdirSync(
                    folderPath,
                    { recursive: true }
                );
            }

            require("fs").writeFileSync(
                `${folderPath}/image0.png`,
                image,
                "base64"
            );

            const dummy =
                document.getElementById("dummyDevice");

            if (dummy) {

                dummy.style.display = "none";

            }

            let img =
                document.getElementById("screenshot");

            if (!img) {

                img =
                    document.createElement("img");

                img.id = "screenshot";
                enableImageDragging(img);

                img.onmousemove = function (e) {

                    previewElement(e);

                };

                img.onmouseleave = function () {

                    showElementHover = false;

                    lastXPath = "";

                    clearTimeout(hoverTimer);

                    clearOverlay();

                };

                attachScreenshotInteractionHandlers(img);

                mountScreenshot(img);
                applyScreenshotZoom(img);

                imgTagFlag = true;
            }

            rotation = 0;
            zoomLevel = 1;

            img.onload = function () {
                adjustDevicePreviewSize(img);
                applyScreenshotZoom(img);
            };
            img.src = `${folderPath}/image0.png?${Date.now()}`;
            if (img.complete && img.naturalWidth > 0) {
                adjustDevicePreviewSize(img);
                applyScreenshotZoom(img);
            }

            // Load XML so hover/tap/show element work immediately
            const pageSource = await capturePageSource();
            const parser = new DOMParser();
            window.xmlDoc = parser.parseFromString(pageSource, "text/xml");

        } catch (error) {
            console.error("Screenshot capture failed:", error);
            // Call the new UI error handler instead of crashing
            displayScreenshotError(error);
        }
    }




// ===========================================================================
// [SCRAPE] Load Page (#Scrape) — button is hidden in index.html (display:none)
// Still wired: validates page name → capture screenshot/source → filter by
// getLoadPageTags() (Android widgets vs XCUI types) → createAndAppendTable.
// Prefer Scrape UI + tap-to-select for day-to-day scraping.
// ===========================================================================
document.getElementById("Scrape").addEventListener('click', async () => {
    if (createFeatureMode) return;
    document.getElementById('searchbox').value = '';
    document.getElementById('brokenText').style.display = 'none';
    const ssElement = document.getElementById('ss');
    if (ssElement) {
        ssElement.remove();
    }
    if (typeof noResultsMessage !== 'undefined') {
        noResultsMessage.style.display = 'none';
    }

    try {
        if (!verifyPageNameSavedBeforeScraping()) {
            return;
        }
        var pagename_searchbox_Field = document.getElementById('pagename_searchbox').value.trim();

        var controlIdList = [];
        controlNameLists = [];

        // 2. DUPLICATE PAGE NAME CHECK
        // Sync before check
        if (typeof syncRegisteredPageNames === 'function') syncRegisteredPageNames();
        if (!window.registeredPageNames || !window.registeredPageNames.has(pagename_searchbox_Field)) {

//            var plateformOption = plateformName.options[plateformName.selectedIndex].text;
            document.getElementById('sttus_bar_div').style.display = 'none';
            document.getElementById('div_status_bar').style.display = 'block';

            // Lock UI during scrape
            document.getElementById('Scrape').style.backgroundColor = '#B6B6B4';
            document.getElementById('Scrape').disabled = true;
            document.getElementById('reset').style.backgroundColor = '#B6B6B4';
            document.getElementById('reset').disabled = true;
            document.getElementById('download').style.backgroundColor = '#B6B6B4';
            document.getElementById('download').disabled = true;

            const homeDirectory = require('os').homedir();
            folderPath = path.join(homeDirectory, 'algoScraperScreenShot');

            try {
                if (!fs.existsSync(folderPath)) {
                    fs.mkdirSync(folderPath, { recursive: true });
                }
            } catch (err) {
                console.error("Folder creation error:", err);
            }

            // Capture screenshot (Appium + Android ADB fallback)
            const image = await captureDeviceScreenshot();
            require('fs').writeFileSync(`${folderPath}/image${counter}.png`, image, 'base64');

            await addImage();

            var firstlist = [];

            async function addImage() {
                if (imgTagFlag === false) {
                    let img = document.createElement('img');
                    img.id = 'screenshot';
                    enableImageDragging(img);
                    rotation = 0;
                    zoomLevel = 1;
                    img.onload = function () {
                        adjustDevicePreviewSize(img);
                        applyScreenshotZoom(img);
                    };
                    img.src = `${folderPath}/image${counter}.png?${new Date().getTime()}`;

                    img.onmousemove = function(e) {
                        previewElement(e);
                    };

                    img.onmouseleave = function () {
                        showElementHover = false;
                        clearOverlay();
                    };

                    attachScreenshotInteractionHandlers(img);

                    const dummy = document.getElementById("dummyDevice");
                    if (dummy) {
                        dummy.style.display = "none";
                    }
                    mountScreenshot(img);
                    if (img.complete && img.naturalWidth > 0) {
                        adjustDevicePreviewSize(img);
                        applyScreenshotZoom(img);
                    }
                    counter = counter + 1;
                    imgTagFlag = true;
                } else {
                    let ss = document.getElementById('screenshot');
                    const dummy = document.getElementById("dummyDevice");

                    if (dummy) {
                        dummy.style.display = "none";
                    }
                    rotation = 0;
                    zoomLevel = 1;

                    ss.onload = function () {
                        adjustDevicePreviewSize(ss);
                        applyScreenshotZoom(ss);
                    };
                    ss.src = `${folderPath}/image${counter}.png?${new Date().getTime()}`;
                    if (ss.complete && ss.naturalWidth > 0) {
                        adjustDevicePreviewSize(ss);
                        applyScreenshotZoom(ss);
                    }

                    imgTagFlag = true;
                    counter = counter + 1;
                }
            }

            var pageSource = await capturePageSource();
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(pageSource, "text/xml");
            window.xmlDoc = xmlDoc;
            showElementHover = false;

            function selectNodes(path) {
                var xpathResult = xmlDoc.evaluate(path, xmlDoc, null, XPathResult.ANY_TYPE, null);
                var nodes = [];
                var node;
                while (node = xpathResult.iterateNext()) {
                    nodes.push(node);
                }
                return nodes;
            }

            let listOfTags = getLoadPageTags();
            var xmlNodes = [];

            listOfTags.forEach(function (stringTag) {
                var getElements = xmlDoc.getElementsByTagName(stringTag);
                for (var i = 0; i < getElements.length; i++) {
                    xmlNodes.push(getElements[i]);
                }
            });

            for (var i = 0; i < xmlNodes.length; i++) {
                var node = xmlNodes[i];

                if (node.nodeName !== "AppiumAUT" && node.nodeName !== "XCUIElementTypeApplication"
                    && node.nodeName !== "hierarchy"
                    && !node.nodeName.includes("XCUIElementTypeWindow")
                    && node.nodeName !== "" && node.nodeName !== null) {

                    const nodeRect = parseNodeRect(node);
                    if (nodeRect && (nodeRect.width <= 0 || nodeRect.height <= 0)) {
                        continue;
                    }

                    var controlName = "";
                    var controlType = mapControlType(node.nodeName);
                    var controlIdentificationType = "";
                    var controlId = "";
                    var xpath = "";

                    try {
                        const locatorCandidates = buildLocatorCandidates(node);
                        controlId = locatorCandidates[0];
                        controlIdentificationType = inferIdentificationType(controlId);

                        if (isAndroidPlatform() || node.nodeName.startsWith('android.')) {
                            controlName = (
                                node.getAttribute("text") ||
                                node.getAttribute("content-desc") ||
                                (node.getAttribute("resource-id") || "").split("/").pop() ||
                                ""
                            ).trim();
                        } else if (node.getAttribute("name") !== null && node.getAttribute("name").trim() !== "") {
                            let rawName = node.getAttribute("name").trim();
                            controlName = rawName;
                            controlName = checkForSingleQuote(controlName);
                        } else if (node.getAttribute("value") !== null && node.getAttribute("value").trim() !== "") {
                            controlName = node.getAttribute("value").trim();
                            controlName = checkForSingleQuote(controlName);
                        } else if (node.getAttribute("label") !== null && node.getAttribute("label").trim() !== "") {
                            controlName = node.getAttribute("label").trim();
                        }

                        if (controlIdList.includes(controlId)) {
                            controlIdList.push(controlId);
                            var CNcount = 0;
                            var CN_ID = controlId;
                            for (var k = 0; k < controlIdList.length; k++) {
                                if (CN_ID === controlIdList[k]) CNcount++;
                            }
                            xpath = "(" + controlId + ")[" + CNcount + "]";
                        } else {
                            controlIdList.push(controlId);
                            xpath = controlId;
                        }
                    } catch (err) {
                        console.log("Error :", err);
                        controlId = "//" + node.nodeName;
                        controlName = node.nodeName;
                        xpath = controlId;
                    }

                    if (controlName === "") {
                        controlName = generateProfessionalControlName(node);
                    }

                    if (controlName !== "") {
                        controlName = controlName.substring(0, Math.min(40, controlName.length));
                        controlName = controlName.replace(/[^a-zA-Z0-9 ]/g, "").trimStart();
                        if (/^\d/.test(controlName)) {
                            controlName = `NUM_` + controlName;
                        }
                        var count = 0;

                        firstlist.forEach(function (item) {
                            if (item.toLowerCase() === controlName.toLowerCase()) {
                                count++;
                            }
                        });

                        if (count > 1) {
                            controlName = controlName + "_" + count;
                        }

                        // remove duplicates from page
                        if (!controlNameLists.includes(controlName)) {
                            controlNameLists.push(controlName);
                        } else {
                            controlNameLists.push(controlName);
                            if (controlNameLists.includes(controlName)) {
                                var CNcount = 0;
                                var CN = controlName;
                                for (var j = 0; j < controlNameLists.length; j++) {
                                    if (CN === controlNameLists[j]) CNcount++;
                                }
                                controlName = controlName + "_" + (CNcount);
                            }
                        }

                        let controlValue = getInputControlValue(node);

                        dtControls.push({
                            ControlName: controlName,
                            ControlType: controlType,
                            ControlId: xpath,
                            ControlValue: controlValue,
                            IdentificationType: controlIdentificationType || inferIdentificationType(xpath),
                            Fingerprint: generateNodeFingerprint(node)
                        });
                    }
                }
            }

            createAndAppendTable(dtControls);
            dtControls = [];

            // Restore UI after successful scrape
            document.getElementById('div_status_bar').style.display = 'none';
            showElementHover = false;
            hoverRequestId++;
            clearOverlay();
            document.getElementById('Scrape').style.backgroundColor = '#B6B6B4';
            document.getElementById('Scrape').disabled = true;
            document.getElementById('reset').style.backgroundColor = '#2F8BCC';
            document.getElementById('reset').disabled = false;
            document.getElementById('download').style.backgroundColor = '#2F8BCC';
            document.getElementById('download').disabled = false;
            document.getElementById('scrapeUI').disabled = false;
            document.getElementById('scrapeUI').style.backgroundColor = '#2F8BCC';
            document.getElementById('algoQA').disabled = false;
            document.getElementById('algoQA').style.backgroundColor = '#2F8BCC';

        } else {
            // Duplicate Page Name logic
            document.getElementById('SamePageNameError').style.display = 'block';
            document.getElementById('overlay').style.display = 'block';
            document.getElementById("okay").addEventListener('click', async () => {
                document.getElementById('confirmationPopup').style.display = 'none';
                document.getElementById('SamePageNameError').style.display = 'none';
                document.getElementById('overlay').style.display = 'none';
            });
        }

    } catch(error) {
        document.getElementById('div_status_bar').style.display = 'none';
        document.getElementById('download').disabled = false;
        document.getElementById('download').style.backgroundColor = '#2F8BCC';

        console.error("Scraping Error:", error);
        showErrorPopup("Error occurred while scraping", error);
    }
});










    // ===========================================================================
    // [EXPORT] Download JSON + AlgoQA Send
    // pendingExportAction drives the shared confirmation modal Okay handler:
    //   alertOnly | download | algoQA | deleteRow | bulkDelete | deletePage | reset
    // Normal scrape → { isRecordscenario:false, dashboardControls:[...] }
    // Record scenario → nested SCENARIOS; FINGERPRINT and APP URL keys stay ""
    // ===========================================================================
    let pendingExportAction = null;
    let rowToDelete = null;

       // Helper to check if table actually contains user data
           function hasValidTableData(tableId) {
               var rows = document.querySelectorAll(`#${tableId} tr`);
               var validCount = 0;
               rows.forEach(row => {
                   // Ignore placeholder background rows and error rows
                   if (row.classList.contains('empty-excel-row') || row.classList.contains('no-results-row')) return;

                   // If it is a real row (scraped or added manually), count it as valid data
                   validCount++;
               });
               return validCount > 0;
           }

        document.getElementById("download").addEventListener('click', async () => {
                  if (!tableCreated || !hasValidTableData('myTable')) {
                      showCustomAlert("Export Failed", "No scraped data found to download.", "error");
                      return;
                  }

                  if (typeof hiddenRows !== 'undefined' && hiddenRows && hiddenRows.length > 0) {
                      pendingExportAction = "download";
                      showHiddenColumnsWarning();
                  } else {
                      downloadTableAsJSON('myTable');
                  }
                });

    function extractAllTableData(tableId) {
        const table = document.getElementById(tableId || 'myTable');
        if (!table) return [];

        const allHeaderElements = Array.from(document.querySelectorAll('#mainTable thead tr th'));
        const rows = table.querySelectorAll('tr');
        const extractedData = [];

        // Map column index to field key
        const colIndexToField = [];
        allHeaderElements.forEach((th, idx) => {
            const clone = th.cloneNode(true);
            clone.querySelectorAll('.resizer, .custom-tooltip, svg, img, input, button, select').forEach(el => el.remove());
            const thText = (clone.textContent || "").replace('Delete Column', '').replace('Add Column', '').trim().toUpperCase();

            if (thText.includes('CONTROL NAME')) colIndexToField[idx] = "CONTROL NAME";
            else if (thText.includes('CONTROL TYPE')) colIndexToField[idx] = "CONTROL TYPE";
            else if (thText.includes('CONTROL ID') || thText.includes('XPATH')) colIndexToField[idx] = "XPATH";
            else if (thText.includes('PAGE NAME')) colIndexToField[idx] = "PAGE NAME";
            else if (thText.includes('IDENTIFICATION TYPE')) colIndexToField[idx] = "IDENTIFICATION TYPE";
            else if (thText.includes('CONTROL VALUE')) colIndexToField[idx] = "CONTROL VALUE";
            else if (thText.includes('FEATURE NAME')) colIndexToField[idx] = "FEATURE NAME";
            else if (thText.includes('NODE NAME')) colIndexToField[idx] = "NODE NAME";
            else if (th.classList.contains('custom-editable-header')) {
                const colName = th.querySelector('span')?.textContent?.trim() || thText;
                colIndexToField[idx] = colName;
            } else {
                colIndexToField[idx] = null;
            }
        });

        rows.forEach((row) => {
            if (row.classList.contains('empty-excel-row') || row.classList.contains('no-results-row')) return;
            if (typeof hiddenRows !== 'undefined' && hiddenRows.some(h => h.rowElement === row)) return;

            const allCells = Array.from(row.querySelectorAll('td'));
            if (allCells.length === 0) return;

            const rowObj = {
                "CONTROL NAME": "",
                "CONTROL TYPE": "",
                "XPATH": "",
                "PAGE NAME": "",
                "IDENTIFICATION TYPE": "",
                "CONTROL VALUE": "",
                "FEATURE NAME": "",
                "NODE NAME": "",
                "FINGERPRINT": "",
                "APP URL": ""
            };

            allCells.forEach((cell, cellIndex) => {
                const fieldName = colIndexToField[cellIndex];
                if (!fieldName) return;

                let val = "";
                const selectEl = cell.querySelector('select');
                if (selectEl) {
                    val = (selectEl.value || "").trim();
                } else {
                    const inputEl = cell.querySelector('input[type="text"], textarea');
                    if (inputEl) {
                        val = (inputEl.value || "").trim();
                    } else {
                        val = (cell.textContent || "").trim();
                    }
                }
                rowObj[fieldName] = val;
            });

            const fingerprintCell = row.querySelector('.fingerprint');
            const appUrlCell = row.querySelector('.appUrl');
            if (fingerprintCell && !rowObj["FINGERPRINT"]) {
                rowObj["FINGERPRINT"] = (fingerprintCell.textContent || "").trim();
            }
            if (appUrlCell && !rowObj["APP URL"]) {
                rowObj["APP URL"] = (appUrlCell.textContent || "").trim();
            }

            const hasData = rowObj["CONTROL NAME"] || rowObj["XPATH"] || rowObj["CONTROL TYPE"] || rowObj["PAGE NAME"];
            if (hasData) {
                extractedData.push(rowObj);
            }
        });

        return extractedData;
    }

    function downloadTableAsJSON(tableId) {
        const statusBar = document.getElementById('sttus_bar_div');
        if (statusBar) statusBar.style.display = 'none';

        const now = new Date();
        const dateTime = now.toISOString().split('T')[0] + 'T' + now.toTimeString().split(' ')[0];

        const dashboardControls = extractAllTableData(tableId);

        // Detect if we are in Record Scenario Mode based on whether scenario data was created
        const isRecordMode = window.pageScenarioData && Object.keys(window.pageScenarioData).length > 0;
        let jsonContent;

        if (isRecordMode) {
            const scenariosList = [];
            const stepsByPage = {};

            // Group extracted rows (steps) by Page Name
            dashboardControls.forEach(step => {
                const page = step["PAGE NAME"];
                if (!stepsByPage[page]) stepsByPage[page] = [];
                stepsByPage[page].push(step);
            });

            // Build the Scenario payload mapping the steps to their corresponding Scenario
            for (const pageName in window.pageScenarioData) {
                const scenarioInfo = window.pageScenarioData[pageName];
                if (scenarioInfo && scenarioInfo.scenarioName) {
                    scenariosList.push({
                        "SCENARIO_NAME": scenarioInfo.scenarioName,
                        "SCENARIO_OUTLINE": scenarioInfo.scenarioOutline || "",
                        "STEPS": stepsByPage[pageName] || []
                    });
                }
            }

            jsonContent = {
                "isRecordscenario": true,
                "dashboardControls": {
                    "APP URL": "",
                    "SCENARIOS": scenariosList
                }
            };
        } else {
            // Fallback to normal behavior
            jsonContent = {
                "isRecordscenario": false,
                "dashboardControls": dashboardControls
            };
        }

        const blob = new Blob([JSON.stringify(jsonContent, null, 2)], { type: "application/json;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        const appSelect = document.getElementById('appname');
        const appName = appSelect ? appSelect.options[appSelect.selectedIndex].text.trim() : "App";

        a.download = appName + "_" + dateTime + ".json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }




    // actions to perform on clicking reset button
    document.getElementById("reset").addEventListener('click', async () => {
            showConfirmDialog({
                title: "Confirm Reset",
                mainText: "Do you really want to reset?",
                subText: "You will not be able to recover the data!",
                action: "reset",
                theme: "confirm"
            });
        });

    // Legacy okay_btn handler replaced later by cloned newOkayBtn → executeResetAction()
    document.getElementById("okay_btn").addEventListener('click', async () => {
      // Intentionally left as a no-op fallback; unified handler below owns Confirm.
    });

    // Note: back_btn is cloned later in the file, so its main logic resides there.
    document.getElementById("back_btn").addEventListener('click', async () => {
      document.getElementById('overlay').style.display = 'none';
      document.getElementById('confirmationPopup').style.display = 'none';
    });

    var searchBox = document.getElementById('searchbox');
    var table = document.getElementById('myTable');

    // Add event listener to the search box
    searchBox.addEventListener('keyup', function () {
        var searchText = this.value.toLowerCase().trim();
        var rawSearchText = this.value.trim();
        var found = false;
        var tableBody = document.getElementById('myTable');
        var emptyStateEl = document.getElementById('tableSearchEmptyState');
        var emptySubtitleEl = document.getElementById('tableSearchEmptySubtitle');

        // Remove legacy "No results found" row if present
        var existingNoResultRow = tableBody.querySelector('.no-results-row');
        if (existingNoResultRow) {
            existingNoResultRow.remove();
        }

        var dataRowCount = 0;

        // Iterate through each row in the table
        for (var i = 0; i < table.rows.length; i++) {
            var row = table.rows[i];

            // Always keep empty placeholder Excel rows hidden during active search
            if (row.classList.contains('empty-excel-row')) {
                row.style.display = searchText === "" ? '' : 'none';
                continue;
            }

            dataRowCount++;

            // Extract searchable text exclusively from visible content cells (skip Index, Delete, Hidden columns)
            var visibleCells = Array.from(row.cells).filter((cell, index) => {
                return index > 0 && cell.style.display !== 'none' && !cell.classList.contains('delete-cell');
            });

            var rowSearchableText = visibleCells.map(cell => {
                var selectEl = cell.querySelector('select');
                if (selectEl) {
                    return selectEl.value;
                }
                return cell.innerText;
            }).join(' ').toLowerCase();

            // Flag matching rows
            if (searchText === "" || rowSearchableText.indexOf(searchText) > -1) {
                row.classList.remove('search-hidden');
                found = true;
            } else {
                row.classList.add('search-hidden');
            }
        }

        // Apply pagination to handle the actual hiding/showing
        currentPage = 1;
        applyPagination();

        // Modern centered empty state display
        if (emptyStateEl) {
            if (searchText !== "" && !found) {
                if (emptySubtitleEl) {
                    emptySubtitleEl.innerText = `No elements match "${rawSearchText}". Try searching for a different keyword.`;
                }
                emptyStateEl.style.display = 'flex';
                // Hide any remaining placeholder rows
                tableBody.querySelectorAll('.empty-excel-row').forEach(r => r.style.display = 'none');
            } else {
                emptyStateEl.style.display = 'none';
                if (searchText === "" && typeof adjustEmptyRows === 'function') {
                    adjustEmptyRows();
                }
            }
        }
    });

    const clearSearchBtn = document.getElementById("clearSearchBtn");
    if (clearSearchBtn) {
        clearSearchBtn.addEventListener("click", function () {
            if (searchBox) {
                searchBox.value = "";
                searchBox.dispatchEvent(new Event('keyup'));
                searchBox.focus();
            }
        });
    }

    const tableEl = document.getElementById("myTable");

    tableEl.addEventListener("click", onTableClick);
    tableEl.addEventListener("mouseover", onShowElementHover);
    tableEl.addEventListener("mouseout", (e) => {
        // Clear overlay when cursor moves out of an XPath cell
        if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest(".xpath")) {
            onShowElementLeave(e);
        }
    });
    tableEl.addEventListener("mouseleave", onShowElementLeave);

    tableEl.addEventListener("focusin", (e) => {
        if (e.target.classList.contains("featureName")) {
            oldFeatureNameValue = (e.target.innerText || "").replace(/\u00a0/g, " ").trim();
        }
        if (e.target.classList.contains("cn")) {
            oldControlNameValue = (e.target.innerText || "").replace(/\u00a0/g, " ").trim();
        }
    });

    tableEl.addEventListener("focusout", (e) => {
        // Control Name: cannot be empty — restore previous value if cleared
        if (e.target.classList.contains("cn")) {
            const newControlName = (e.target.innerText || "").replace(/\u00a0/g, " ").trim();
            if (newControlName === "") {
                e.target.innerText = oldControlNameValue || "";
                if (oldControlNameValue) {
                    showCustomAlert("Control Name Required", "Control Name cannot be empty. Previous value has been restored.", "warning");
                }
            }
            oldControlNameValue = "";
        }

        if (e.target.classList.contains("featureName")) {
            const newFeatureNameValue = e.target.innerText.trim();

            if (newFeatureNameValue !== oldFeatureNameValue && oldFeatureNameValue !== "") {
                // Unique Name Check (Feature and Page Names)
                const isNameUsedAsFeature = registeredFeatureAreas.some(area => area.name.toLowerCase() === newFeatureNameValue.toLowerCase());
                const isNameUsedAsPage = Array.from(window.registeredPageNames || []).some(p => p.toLowerCase() === newFeatureNameValue.toLowerCase());

                if (isNameUsedAsFeature || isNameUsedAsPage) {
                    pendingFeatureRename = {
                        oldName: oldFeatureNameValue,
                        cellElement: e.target
                    };
                    showCustomAlert("Feature Already Exists", "This feature name is already used. Please try a different one.", "warning");
                } else {
                    pendingFeatureRename = {
                        oldName: oldFeatureNameValue,
                        newName: newFeatureNameValue,
                        cellElement: e.target
                    };

                    // Check if the current value is already a registered feature
                    const isExistingFeature = registeredFeatureAreas.some(area => area.name === oldFeatureNameValue);

                    if (!isExistingFeature) {
                        showConfirmDialog({
                            title: "Create New Feature",
                            mainText: `Do you want to create a new feature "<b>${newFeatureNameValue}</b>" for this element?`,
                            subText: "This element will be assigned to this new feature.",
                            action: "createNewFeature",
                            theme: "confirm",
                            okayBtnText: "Create"
                        });
                    } else {
                        showConfirmDialog({
                            title: "Update Feature Name",
                            mainText: `How would you like to apply the rename for "<b>${oldFeatureNameValue}</b>"?`,
                            subText: "Choose 'Rename All' to update every occurrence, or 'Sub-feature' for only this element.",
                            action: "renameFeature",
                            theme: "confirm",
                            okayBtnText: "Rename All",
                            extraBtnText: "Sub-feature"
                        });
                    }
                }
            }
            oldFeatureNameValue = "";
        }
    });

    tableEl.addEventListener("keydown", (e) => {
        if ((e.target.classList.contains("featureName") || e.target.classList.contains("cn")) && e.key === "Enter") {
            e.preventDefault();
            e.target.blur();
        }
    });


    //show element

    async function onTableClick(e) {

            // 1. DELETE ROW HANDLER
            if (e.target.classList.contains("deleteBtn")) {
                const targetRow = e.target.closest("tr");
                if (!targetRow) return;

                // A. Extract Control Name & Page Name dynamically from the row
                const cnCell = targetRow.querySelector(".cn");
                const pageCell = targetRow.querySelector(".page"); // Extract page name cell

                let controlName = cnCell && cnCell.innerText.trim() !== "" ? cnCell.innerText.trim() : null;
                let pageName = pageCell && pageCell.innerText.trim() !== "" ? pageCell.innerText.trim() : null;

                // B. Build the confirmation text to include the Page Name
                let mainText;
                if (controlName && pageName) {
                    mainText = `Are you sure you want to delete<br>"${controlName}" from "${pageName}"?`;
                } else if (controlName) {
                    mainText = `Are you sure you want to delete<br>"${controlName}"?`;
                } else {
                    mainText = `Are you sure you want to delete this row?`;
                }

                // C. Inject text into the modal
                showConfirmDialog({
                    title: "Confirm Deletion",
                    mainText: mainText,
                    subText: "This action cannot be undone.",
                    action: "deleteRow",
                    theme: "confirm"
                });

                // D. Store the row reference
                rowToDelete = targetRow;

                return;
            }

        // 2. SHOW ELEMENT HANDLER
        if (e.target.id && e.target.id.startsWith("info_")) {
            document.getElementById("split-div3").style.display = "block";
            const row = e.target.closest("tr");
            const xpath = row.querySelector(".xpath").innerText.trim();

            if (xpath.startsWith("COORDINATE(")) {
                const match = xpath.match(/COORDINATE\((\d+),(\d+)\)/);
                if (match) {
                    const x = parseInt(match[1]);
                    const y = parseInt(match[2]);
                    showCoordinateMarker(x, y);
                    return;
                }
            }

            try {
                document.getElementById("split-div3").style.display = "block";
                document.getElementById("image-container_ss").style.display = "flex";
                document.getElementById("image-container_ss").style.justifyContent = "center";
                document.getElementById("image-container_ss").style.alignItems = "center";
                document.getElementById("image-container_ss").innerHTML = "";

                const el = await driver.findElement(By.xpath(xpath));
                const image = await el.takeScreenshot();

                let ss = document.getElementById("ss");
                if (!ss) {
                    ss = document.createElement("img");
                    ss.id = "ss";
                    ss.style.width = "280px";
                    ss.style.height = "520px";
                    ss.style.objectFit = "contain";
                    document.getElementById("image-container_ss").appendChild(ss);
                }

                ss.src = "data:image/png;base64," + image;
                showElementHover = false;
                clearOverlay();
            } catch (err) {
                console.error("Show Element Error:", err);
                showErrorPopup("Unable to locate element", err);
            }
        }
    }


    async function onShowElementHover(e) {
            const xpathCell = e.target.closest(".xpath");

            if (!xpathCell) {
                onShowElementLeave(e);
                return;
            }

            const selectEl = xpathCell.querySelector("select");
            const xpath = selectEl ? selectEl.value.trim() : xpathCell.innerText.trim();

            if (!xpath) {
                onShowElementLeave(e);
                return;
            }

            if (xpath === lastXPath) return;

            lastXPath = xpath;
            clearTimeout(hoverTimer);

            hoverRequestId++; // Invalidate previous requests
            const currentRequestId = hoverRequestId;

            // IMMEDIATELY clear overlay to prevent confusion between rows
            clearOverlay();

            if (xpath.startsWith("SWIPE(")) {
                const match = xpath.match(/SWIPE\((\d+),(\d+),(\d+),(\d+)\)/);
                if (match) {
                    drawSwipeHoverMarker(parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10), parseInt(match[4], 10));
                }
                return;
            }

            if (xpath.startsWith("COORDINATE(")) {
                const match = xpath.match(/COORDINATE\((\d+),(\d+)\)/);
                if (match) {
                    const x = parseInt(match[1], 10);
                    const y = parseInt(match[2], 10);
                    drawCoordinateHoverMarker(x, y);
                }
                return;
            }

            hoverTimer = setTimeout(async () => {
                if (currentRequestId !== hoverRequestId) return;

                showElementHover = true;
                try {
                    const element = await driver.findElement(By.xpath(xpath));
                    const rect = await element.getRect();

                    if (currentRequestId === hoverRequestId) {
                        drawShowElementMarker(rect);

                        // Check if this coordinate belongs to a feature area and show it
                        const centerX = rect.x + rect.width / 2;
                        const centerY = rect.y + rect.height / 2;
                        let matchedArea = null;
                        let minArea = Number.MAX_VALUE;
                        for (const area of registeredFeatureAreas) {
                            const { x, y, width, height } = area.rect;
                            if (centerX >= x && centerX <= (x + width) && centerY >= y && centerY <= (y + height)) {
                                const a = width * height;
                                if (a < minArea) {
                                    minArea = a;
                                    matchedArea = area;
                                }
                            }
                        }
                        if (matchedArea) {
                            drawFeatureAreaHighlight(matchedArea);
                        }
                    }
                } catch {
                    if (currentRequestId === hoverRequestId) {
                        clearOverlay();
                    }
                }
            }, 80);
        }

        // Dedicated handler for option hover events
        async function onOptionHover(xpath) {
            if (!xpath || xpath === lastXPath) return;

            lastXPath = xpath;
            clearTimeout(hoverTimer);

            hoverRequestId++;
            const currentRequestId = hoverRequestId;

            // IMMEDIATELY clear overlay
            clearOverlay();

            if (xpath.startsWith("SWIPE(")) {
                const match = xpath.match(/SWIPE\((\d+),(\d+),(\d+),(\d+)\)/);
                if (match) {
                    drawSwipeHoverMarker(parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10), parseInt(match[4], 10));
                }
                return;
            }

            if (xpath.startsWith("COORDINATE(")) {
                const match = xpath.match(/COORDINATE\((\d+),(\d+)\)/);
                if (match) {
                    const x = parseInt(match[1], 10);
                    const y = parseInt(match[2], 10);
                    drawCoordinateHoverMarker(x, y);
                }
                return;
            }

            hoverTimer = setTimeout(async () => {
                if (currentRequestId !== hoverRequestId) return;

                showElementHover = true;

                try {
                    const element = await driver.findElement(By.xpath(xpath));
                    const rect = await element.getRect();

                    // CRITICAL FIX: Only draw if this is STILL the active hover session
                    if (currentRequestId === hoverRequestId) {
                        drawShowElementMarker(rect);

                        // Check if this coordinate belongs to a feature area and show it
                        const centerX = rect.x + rect.width / 2;
                        const centerY = rect.y + rect.height / 2;
                        let matchedArea = null;
                        let minArea = Number.MAX_VALUE;
                        for (const area of registeredFeatureAreas) {
                            const { x, y, width, height } = area.rect;
                            if (centerX >= x && centerX <= (x + width) && centerY >= y && centerY <= (y + height)) {
                                const a = width * height;
                                if (a < minArea) {
                                    minArea = a;
                                    matchedArea = area;
                                }
                            }
                        }
                        if (matchedArea) {
                            drawFeatureAreaHighlight(matchedArea);
                        }
                    }
                } catch (err) {
                    if (currentRequestId === hoverRequestId) {
                        clearOverlay();
                    }
                }
            }, 60);
        }

        // Handler for when user selects a different option in the dropdown
        async function onDropdownChange(selectElement) {
            // Kill any pending hover operations triggered while navigating the dropdown menu
            clearTimeout(hoverTimer);
            hoverRequestId++;
            clearOverlay();

            const xpath = selectElement.value.trim();

            // Set lastXPath so that resting the mouse on the select doesn't immediately re-trigger
            lastXPath = xpath;

            // Keep IDENTIFICATION TYPE in sync with the selected locator strategy
            try {
                const row = selectElement.closest("tr");
                const idTypeCell = row && row.querySelector(".identificationType");
                if (idTypeCell) {
                    idTypeCell.innerText = typeof inferIdentificationType === "function"
                        ? inferIdentificationType(xpath)
                        : "";
                }
            } catch (_) {}

            if (!xpath) return;

            if (xpath.startsWith("SWIPE(")) {
                const match = xpath.match(/SWIPE\((\d+),(\d+),(\d+),(\d+)\)/);
                if (match) {
                    drawSwipeHoverMarker(parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10), parseInt(match[4], 10));
                }
                return;
            }

            if (xpath.startsWith("COORDINATE(")) {
                const match = xpath.match(/COORDINATE\((\d+),(\d+)\)/);
                if (match) {
                    const x = parseInt(match[1], 10);
                    const y = parseInt(match[2], 10);
                    drawCoordinateHoverMarker(x, y);
                }
                return;
            }

            try {
                const element = await driver.findElement(By.xpath(xpath));
                const rect = await element.getRect();
                drawShowElementMarker(rect);
            } catch {
                clearOverlay();
            }
        }

    function onShowElementLeave(e) {
            showElementHover = false;
            lastXPath = "";
            hoverRequestId++; // MAGIC FIX: Instantly kills any pending Appium drawings!
            clearTimeout(hoverTimer);
            clearOverlay();
        }




// ===========================================================================
// [GESTURES] Touch / swipe / foreground
// HOW:
//   attachScreenshotInteractionHandlers(#screenshot)
//     → mouseup distance > threshold → showLocalDeviceLoader → performSwipe
//     → else short press → showLocalDeviceLoader → performTouch
//     → click in Touch mode is ignored (prevents swipe+click double fire)
//   Android: mobile: swipeGesture / scrollGesture (avoid dragGesture — it clicks)
//   iOS:     mobile: dragFromToForDuration (short) / mobile: swipe
//   End-of-page swipe: compare pre/post hierarchy + screenshot; skip table row
// Foreground check uses bundleId (iOS) or appPackage (Android)
// ===========================================================================

function isDeadSessionError(err) {
    const msg = String((err && (err.message || err.originalMessage)) || err || '').toLowerCase();
    return /no such session|invalid session id|session is either terminated|session deleted|not started|cannot find session|instrumentation process is not running|disconnected from (the )?device|econnrefused|econnreset/.test(msg);
}

function isAppClosedOrBackgroundError(err) {
    const msg = String((err && (err.message || err.originalMessage)) || err || '');
    return /Application is closed or running in the background/i.test(msg);
}

function isWindowsAndroid() {
    return process.platform === 'win32'
        && typeof isAndroidPlatform === 'function'
        && isAndroidPlatform();
}

/**
 * Windows emulator: queryAppState is often wrong (returns 3 / fails) even when the app
 * is visible. Soft-prepare for Refresh — activate if needed, never throw.
 */
async function ensureWindowsAndroidReadyForRefresh() {
    const appId = (document.getElementById('apppackage') && document.getElementById('apppackage').value || '').trim();
    if (!appId || !driver) return;

    let code = NaN;
    try {
        code = Number(await mobileExecute("mobile: queryAppState", { appId }));
    } catch (e) {
        console.warn("Windows refresh queryAppState bypassed:", e && e.message);
    }
    if (code === 4) return;

    try {
        await mobileExecute("mobile: activateApp", { appId });
        await waitMs(600);
    } catch (e) {
        console.warn("Windows refresh activateApp:", e && e.message);
    }

    try {
        code = Number(await mobileExecute("mobile: queryAppState", { appId }));
        if (code === 4) return;
    } catch (_) {}

    try {
        const udid = document.getElementById('udid') && document.getElementById('udid').value;
        const fg = await ipcRenderer.invoke("android-foreground-package", udid);
        const focused = fg && fg.pkg ? String(fg.pkg) : '';
        if (focused && (focused === appId || focused.startsWith(appId + '.') || appId.startsWith(focused))) {
            return;
        }
    } catch (_) {}

    // Still uncertain — continue Refresh (screenshot has ADB fallback). Do not throw.
    console.warn("Windows refresh: foreground state uncertain; continuing without killing session");
}

function markSessionInterrupted(err) {
    const rawMsg = err && err.message ? err.message : String(err || "");
    const readableError = rawMsg.split('\n')[0].substring(0, 150);
    const isDeviceDisconnected = /device (offline|not found|disconnected)|connection refused|econnrefused|device '[^']+' not found|closed the connection/i.test(rawMsg);

    const platform = typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : 'Android';
    const isAndroid = platform === 'Android';

    const screenshotImg = document.getElementById("screenshot");
    if (screenshotImg) screenshotImg.style.display = "none";

    const bannerTitle = isDeviceDisconnected
        ? `${isAndroid ? 'Android device' : 'Device'} disconnected. Reconnect device and click Launch Application.`
        : 'Session interrupted. Keep the app open, then click Launch Application to reconnect.';

    showDummyDeviceMessage({
        theme: 'error',
        title: bannerTitle,
        detail: readableError
    });

    const runBtn = document.getElementById('Run');
    if (runBtn) {
        runBtn.disabled = false;
        runBtn.style.backgroundColor = '#2F8BCC';
    }

    ['Scrape', 'scrapeUI', 'reset', 'download', 'algoQA', 'recordScenarioBtn', 'createFeatureBtn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.disabled = true;
            btn.style.backgroundColor = '#B6B6B4';
        }
    });

    ["platformname", "appname", "devicename"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
    });

    driver = null;
    refreshShouldLaunchApp = true;

    if (isDeviceDisconnected) {
        const currentTarget = typeof normalizePlatformName === 'function' ? normalizePlatformName(platform) : platform;
        const alternateTarget = currentTarget === 'Android' ? 'IOS' : 'Android';
        const alternateDevices = Array.isArray(connectedDevices) ? devicesForPlatform(alternateTarget, connectedDevices) : [];

        if (alternateDevices.length > 0 && process.platform !== 'win32') {
            const platformSelect = document.getElementById('platformname');
            if (platformSelect) {
                applyingPlatformFromDevice = true;
                platformSelect.value = alternateTarget;
                lastSelectedPlatform = alternateTarget;
                if (typeof updatePlatformUI === 'function') updatePlatformUI();
                if (typeof platformSelect._rebuildCustomSelect === 'function') platformSelect._rebuildCustomSelect();
                applyingPlatformFromDevice = false;
            }
            const selectedAlt = populateDeviceDropdown(alternateDevices);
            if (selectedAlt) {
                if (alternateTarget === 'Android') {
                    ipcRenderer.invoke("get-android-version", selectedAlt.id).then((ver) => {
                        if (ver) {
                            const pv = document.getElementById('platformversion');
                            if (pv) {
                                pv.value = ver;
                                pv.dataset.userEdited = 'true';
                            }
                        }
                    }).catch(() => {});
                }
                ipcRenderer.send("get-installed-apps", selectedAlt);
            }

            showCustomAlert(
                "Device Disconnected",
                `The active <b>${currentTarget === 'Android' ? 'Android' : 'iOS'}</b> device was disconnected.<br><br>Automatically switched platform to available <b>${alternateTarget === 'Android' ? 'Android' : 'iOS'}</b> device: <b>${selectedAlt ? selectedAlt.name : ''}</b>.`,
                "warning"
            );
            return;
        }

        // If no alternate device available
        showCustomAlert(
            "Device Disconnected",
            `The connected <b>${isAndroid ? 'Android' : 'iOS'}</b> device was unplugged or disconnected, and no other device is available.<br><br>Please connect a device or start an emulator/simulator to continue.`,
            "warning"
        );
    }
}

/** iOS: any command failure still ends the session. Android: only a dead session does. */
function handleDeviceCommandError(err, label) {
    console.error(label, err);

    const rawMsg = err && err.message ? err.message : String(err || "");
    const isDeviceDisconnected = /device (offline|not found|disconnected)|connection refused|econnrefused|device '[^']+' not found|closed the connection/i.test(rawMsg);

    if (isDeviceDisconnected) {
        markSessionInterrupted(err);
        return;
    }

    // Windows Android emulator: never kill session for flaky "app background" / transient errors
    if (isWindowsAndroid() && driver && !isDeadSessionError(err)) {
        const msg = rawMsg.split('\n')[0].substring(0, 180);
        showCustomAlert("Device action failed", msg, "warning");
        return;
    }

    if (isAndroidPlatform() && driver && !isDeadSessionError(err) && !isAppClosedOrBackgroundError(err)) {
        const msg = rawMsg.split('\n')[0].substring(0, 180);
        showCustomAlert("Device action failed", msg, "warning");
        return;
    }
    markSessionInterrupted(err);
}

function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// HELPER: Checks if the target application is actually in the foreground
async function checkAppForegroundState(opts = {}) {
    if (!driver) throw new Error("No active session driver found.");

    var plateformOption = getSelectedPlatform();
    var isIos = plateformOption === 'IOS' || plateformOption === 'iOS';

    var appId = isIos
        ? document.getElementById('bundleID').value.trim()
        : document.getElementById('apppackage').value.trim();

    if (!appId) return;

    let state;
    try {
        state = await mobileExecute("mobile: queryAppState", isIos
            ? { bundleId: appId }
            : { appId: appId });
    } catch (e) {
        // If the Appium version doesn't support queryAppState, ignore and proceed
        console.log("App state query bypassed:", e.message);
        return;
    }

    // Appium App States: 0 (Not Installed), 1 (Not Running), 2 (Suspended), 3 (Background), 4 (Foreground)
    // executeScript may return a string ("4") — strict !== 4 was killing Android refresh/touch/swipe
    const code = Number(state);
    if (code === 4) return;

    // Windows Android emulator: queryAppState is unreliable — verify via ADB, else soft-continue
    if (!isIos && process.platform === 'win32') {
        try {
            await mobileExecute("mobile: activateApp", { appId });
            await waitMs(400);
            const again = Number(await mobileExecute("mobile: queryAppState", { appId }));
            if (again === 4) return;
        } catch (_) {}

        try {
            const udid = document.getElementById('udid') && document.getElementById('udid').value;
            const fg = await ipcRenderer.invoke("android-foreground-package", udid);
            const focused = fg && fg.pkg ? String(fg.pkg) : '';
            if (focused && (focused === appId || focused.startsWith(appId + '.') || appId.startsWith(focused))) {
                return;
            }
        } catch (_) {}

        // Soft: do not throw — caller (Refresh/touch) can still use ADB screenshot fallback
        if (opts.soft !== false) {
            console.warn("Windows Android foreground check soft-passed (queryAppState=", code, ")");
            return;
        }
    }

    if (!isIos) {
        throw new Error("Application is closed or running in the background.");
    }

    if (code !== 4) {
        throw new Error("Application is closed or running in the background.");
    }
}

async function assertAndroidAppOpened(pkg) {
    const appId = String(pkg || '').trim();
    if (!appId) {
        throw new Error("Application package is missing. Select an app, then click Launch Application.");
    }

    const queryState = async () => {
        try {
            return Number(await mobileExecute("mobile: queryAppState", { appId }));
        } catch (_) {
            return NaN;
        }
    };

    for (let i = 0; i < 2; i++) {
        const code = await queryState();
        if (code === 4) return;
        if (i === 0) {
            try {
                await mobileExecute("mobile: activateApp", { appId });
            } catch (_) {}
            await waitMs(1200);
        }
    }

    if ((await queryState()) === 4) return;

    const udid = document.getElementById('udid') && document.getElementById('udid').value;
    try {
        const fg = await ipcRenderer.invoke("android-foreground-package", udid);
        const focused = fg && fg.pkg ? String(fg.pkg) : '';
        if (focused && (focused === appId || focused.startsWith(appId + '.') || appId.startsWith(focused))) {
            return;
        }
    } catch (_) {}

    throw new Error(
        "Application did not open. The device is still on the home/app list screen. " +
        "Check App Package and Activity, open the selected app on the phone, then click Launch Application again."
    );
}

// Show frosted loader centered on #zoomFrame (phone screenshot), not the wider panel.
// Forces a paint (rAF × 2) so the spinner appears before slow Appium/ADB work.
async function showLocalDeviceLoader() {
    const host = document.getElementById("zoomFrame")
        || document.getElementById("image-container");
    if (!host) return null;

    if (getComputedStyle(host).position === "static") {
        host.style.position = "relative";
    }

    let localLoader = document.getElementById("localTouchLoader");
    if (!localLoader) {
        localLoader = document.createElement("div");
        localLoader.id = "localTouchLoader";
        localLoader.innerHTML = `
            <div class="local-blur-overlay">
                <img src="icon/load-8510_256.gif" alt="Loading"/>
            </div>
        `;
    }
    if (localLoader.parentElement !== host) {
        host.appendChild(localLoader);
    }

    const globalOverlay = document.getElementById("overlay");
    const appRunningPopup = document.getElementById("AppRunningPopup");
    if (globalOverlay) globalOverlay.style.display = "none";
    if (appRunningPopup) appRunningPopup.style.display = "none";

    localLoader.classList.add("is-visible");
    localLoader.style.display = "flex";

    void localLoader.offsetHeight;
    await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    return localLoader;
}

function hideLocalDeviceLoader() {
    const localLoader = document.getElementById("localTouchLoader");
    if (!localLoader) return;
    localLoader.classList.remove("is-visible");
    localLoader.style.display = "none";
}

// Touch mode: swipe vs tap decided only in mouseup (click must not also fire a tap).
// Scrape/tap mode: click selects elements via findIOSLocator (works for Android + iOS XML).
// Windows: native <img> drag cancels mouseup on the image — disable drag + listen on document.
function attachScreenshotInteractionHandlers(img) {
    if (!img) return;

    img.draggable = false;
    img.setAttribute('draggable', 'false');
    img.style.webkitUserDrag = 'none';
    img.style.userSelect = 'none';
    img.ondragstart = function (e) {
        e.preventDefault();
        return false;
    };

    let gestureStartX = 0;
    let gestureStartY = 0;
    let gesturing = false;
    let wasActuallyASwipe = false;
    let peakDistance = 0;
    // Screen px — keep low so real scrolls are not misclassified as taps/clicks
    const SWIPE_THRESHOLD_PX = 18;

    const onMove = function (e) {
        if (!gesturing) return;
        const dx = e.clientX - gestureStartX;
        const dy = e.clientY - gestureStartY;
        peakDistance = Math.max(peakDistance, Math.sqrt(dx * dx + dy * dy));
        if (peakDistance > SWIPE_THRESHOLD_PX) {
            wasActuallyASwipe = true;
        }
    };

    const endGesture = async function (e) {
        if (!gesturing) return;
        gesturing = false;
        document.removeEventListener('mouseup', endGesture);
        document.removeEventListener('mousemove', onMove);

        if (e.button !== 0) return;

        const diffX = e.clientX - gestureStartX;
        const diffY = e.clientY - gestureStartY;
        const distance = Math.max(
            peakDistance,
            Math.sqrt(diffX * diffX + diffY * diffY)
        );
        const { scaleX, scaleY, rect, dims } = getScreenshotScale(img);

        const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
        const toDevice = (clientX, clientY) => ({
            x: clamp(Math.round((clientX - rect.left) * scaleX), 0, Math.max(0, dims.width - 1)),
            y: clamp(Math.round((clientY - rect.top) * scaleY), 0, Math.max(0, dims.height - 1))
        });

        // Prefer swipe whenever the pointer traveled meaningfully (never click on scroll)
        if (distance > SWIPE_THRESHOLD_PX) {
            wasActuallyASwipe = true;
            if (!tapMode && zoomLevel <= 1) {
                const start = toDevice(gestureStartX, gestureStartY);
                const end = toDevice(e.clientX, e.clientY);
                // If clamp collapsed the gesture (edge release), extend along primary axis
                let endX = end.x;
                let endY = end.y;
                if (Math.abs(endX - start.x) < 8 && Math.abs(endY - start.y) < 8) {
                    const deviceDist = Math.round(distance * Math.max(scaleX, scaleY));
                    if (Math.abs(diffY) >= Math.abs(diffX)) {
                        endY = clamp(start.y + (diffY < 0 ? -deviceDist : deviceDist), 0, dims.height - 1);
                    } else {
                        endX = clamp(start.x + (diffX < 0 ? -deviceDist : deviceDist), 0, dims.width - 1);
                    }
                }
                await showLocalDeviceLoader();
                await performSwipe(start.x, start.y, endX, endY);
            }
        } else {
            // True short tap only — never treat a scroll attempt as a device click
            if (!tapMode && zoomLevel <= 1 && !wasActuallyASwipe) {
                await showLocalDeviceLoader();
                const p = toDevice(e.clientX, e.clientY);
                await performTouch(p.x, p.y);
            }
        }

        // Keep click suppressed briefly after a swipe (some browsers fire click late)
        if (wasActuallyASwipe) {
            setTimeout(() => { wasActuallyASwipe = false; }, 350);
        }
    };

    img.onmousedown = function (e) {
        if (e.button !== 0) return;
        // Block Chromium native image-drag (breaks swipe mouseup on Windows)
        e.preventDefault();

        wasActuallyASwipe = false;
        peakDistance = 0;
        gesturing = true;
        gestureStartX = e.clientX;
        gestureStartY = e.clientY;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', endGesture);
    };

    // mouseup handled on document so swipe still completes if pointer leaves the image
    img.onmouseup = null;

    img.onclick = async function (e) {
        if (hasDragged) return;
        if (wasActuallyASwipe) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // Touch mode: mouseup already ran performTouch/swipe — never open Create Feature
        if (!tapMode) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // Create Feature only while in Tap (scrape) mode
        if (createFeatureMode) {
            const { scaleX, scaleY, rect } = getScreenshotScale(img);
            const clickX = (e.clientX - rect.left) * scaleX;
            const clickY = (e.clientY - rect.top) * scaleY;
            // First click = full page. After a page feature exists, click = control inside it.
            // Shift+click always maps the control under the cursor.
            handleFeatureClick(clickX, clickY, { preferFullPage: shouldMapFullPageFeature(e.shiftKey) });
            return;
        }

        if (!verifyPageNameSavedBeforeScraping()) {
            return;
        }

        const { scaleX, scaleY, rect } = getScreenshotScale(img);
        const clickX = (e.clientX - rect.left) * scaleX;
        const clickY = (e.clientY - rect.top) * scaleY;
        findIOSLocator(clickX, clickY);
    };
}

//Perform touch action for device connected
async function performTouch(x, y) {
    if (touchInProgress) return;
    touchInProgress = true;

    await showLocalDeviceLoader();

    try {
        await checkAppForegroundState();

        var plateformOption = getSelectedPlatform();

        console.log("Touch:", x, y, "Platform:", plateformOption);

        if (plateformOption === 'Android') {
            // Prefer UiAutomator2 clickGesture, then fall back to W3C Actions
            try {
                await mobileExecute("mobile: clickGesture", { x: Math.round(x), y: Math.round(y) });
            } catch (gestureErr) {
                const actions = driver.actions({ bridge: true });
                await actions.move({ x: Math.round(x), y: Math.round(y) }).press().release().perform();
            }
        } else {
            // iOS tap execution
            await mobileExecute("mobile: tap", { x: x, y: y });
        }

        console.log("Touch Success");

        await waitMs(1500);

        const image = await captureDeviceScreenshot();
        require("fs").writeFileSync(`${folderPath}/image0.png`, image, "base64");

        const screenshot = document.getElementById("screenshot");
        if (screenshot) {
            screenshot.src = `${folderPath}/image0.png?${Date.now()}`;
            await new Promise(resolve => {
                screenshot.onload = resolve;
                screenshot.onerror = resolve;
            });
            adjustDevicePreviewSize(screenshot);
            applyScreenshotZoom(screenshot);
        }

        const pageSource = await capturePageSource();
        const parser = new DOMParser();
        window.xmlDoc = parser.parseFromString(pageSource, "text/xml");

        clearOverlay();

    } catch (err) {
        handleDeviceCommandError(err, "Touch Error:");

    } finally {
        if (pendingExportAction !== "alertOnly") {
            hideLocalDeviceLoader();
            touchInProgress = false;
        }
    }
}


//Perform swipe action on connected device
async function performSwipe(startX, startY, endX, endY) {
    if (touchInProgress) return;
    touchInProgress = true; // Lock interactions instantly

    // Loader should already be visible from mouseup; ensure it is centered on the phone frame
    await showLocalDeviceLoader();

    // --- Bulletproof Screen State Comparison ---
    function getPageStructureState(xmlDocument) {
        if (!xmlDocument) return "";
        let state = [];
        const nodes = xmlDocument.getElementsByTagName("*");
        const ignoreRoots = new Set([
            "AppiumAUT", "XCUIElementTypeApplication", "XCUIElementTypeWindow", "hierarchy"
        ]);

        for (let i = 0; i < nodes.length; i++) {
            let n = nodes[i];
            let nodeName = n.nodeName;

            // Ignore chrome / transient UI that falsely looks like a scroll change
            if (
                nodeName.includes("StatusBar") ||
                nodeName.includes("ScrollBar") ||
                nodeName.includes("ActivityIndicator") ||
                nodeName.includes("HomeIndicator") ||
                ignoreRoots.has(nodeName)
            ) {
                continue;
            }

            const rect = typeof parseNodeRect === "function" ? parseNodeRect(n) : null;
            if (rect && (rect.width <= 0 || rect.height <= 0)) continue;

            let text = n.getAttribute("label")
                || n.getAttribute("text")
                || n.getAttribute("content-desc")
                || n.getAttribute("value")
                || n.getAttribute("name")
                || n.getAttribute("resource-id")
                || "";
            text = String(text).trim();

            // Skip empty tags and clock/battery text
            if (text === "" || /^\d{1,2}:\d{2}/.test(text) || /battery/i.test(text)) {
                // Still track sized unlabeled nodes via rounded bounds (Android lists often lack text)
                if (rect && rect.width > 2 && rect.height > 2) {
                    state.push(`${nodeName}_${Math.round(rect.x / 20) * 20}_${Math.round(rect.y / 20) * 20}_${Math.round(rect.width / 20) * 20}`);
                }
                continue;
            }

            let y = rect ? rect.y : parseFloat(n.getAttribute("y"));
            if (isNaN(y) && rect) y = rect.y;
            if (!isNaN(y)) {
                state.push(`${text}_${Math.round(y / 10) * 10}`);
            }
        }
        return state.join("|");
    }

    try {
        // 2. NOW check the Page Name. (The loader is already spinning on screen!)
        const pageName = document.getElementById("pagename_searchbox").value.trim();
        if (pageName === "") {
            document.getElementById("pagename_searchbox").style.borderColor = "red";
            showCustomAlert("Missing Information", "Please enter Page Name before attempting to scroll.", "warning");
            flashPageNameError(); // Flashes the badge red for 2 seconds
            return; // Exit! The loader stays visible behind the alert until 'Okay' is clicked.
        }

        // ---> Verifies app is actually in foreground <---
        await checkAppForegroundState();

        // Fresh hierarchy + screenshot BEFORE swipe (needed for reliable end-of-page detection)
        try {
            const preSource = await capturePageSource();
            window.xmlDoc = new DOMParser().parseFromString(preSource, "text/xml");
        } catch (_) {}
        const preSwipeState = getPageStructureState(window.xmlDoc);
        let preImage = "";
        try {
            preImage = await captureDeviceScreenshot();
        } catch (_) {}

                console.log("Swipe from:", startX, startY, "to", endX, endY);

                        var plateformOption = getSelectedPlatform();
                        const dims = (typeof getDeviceDimensions === 'function')
                            ? getDeviceDimensions()
                            : { width: Math.max(startX, endX, 1) + 1, height: Math.max(startY, endY, 1) + 1 };
                        const dx = endX - startX;
                        const dy = endY - startY;
                        // Finger moved up → swipe direction "up" (content scrolls down)
                        const direction = Math.abs(dy) >= Math.abs(dx)
                            ? (dy < 0 ? 'up' : 'down')
                            : (dx < 0 ? 'left' : 'right');
                        // Scroll/swipe area: wide viewport around the gesture (not the thin drag bbox)
                        const areaLeft = Math.max(0, Math.round(dims.width * 0.08));
                        const areaTop = Math.max(0, Math.round(dims.height * 0.15));
                        const areaWidth = Math.max(40, Math.round(dims.width * 0.84));
                        const areaHeight = Math.max(40, Math.round(dims.height * 0.65));
                        const travel = Math.sqrt(dx * dx + dy * dy);
                        const percent = Math.min(0.95, Math.max(0.35, travel / Math.max(dims.height, dims.width, 1)));

                        if (plateformOption === 'Android') {
                            // Prefer swipe/scroll gestures — dragGesture often presses a control (looks like a click)
                            let swiped = false;
                            try {
                                await mobileExecute("mobile: swipeGesture", {
                                    left: areaLeft,
                                    top: areaTop,
                                    width: areaWidth,
                                    height: areaHeight,
                                    direction,
                                    percent,
                                    speed: 2200
                                });
                                swiped = true;
                            } catch (e1) {
                                console.warn("swipeGesture failed, trying scrollGesture:", e1.message || e1);
                            }
                            if (!swiped) {
                                try {
                                    await mobileExecute("mobile: scrollGesture", {
                                        left: areaLeft,
                                        top: areaTop,
                                        width: areaWidth,
                                        height: areaHeight,
                                        direction,
                                        percent: Math.max(percent, 0.5),
                                        speed: 1800
                                    });
                                    swiped = true;
                                } catch (e2) {
                                    console.warn("scrollGesture failed, trying W3C drag:", e2.message || e2);
                                }
                            }
                            if (!swiped) {
                                // Last resort: quick press-move-release (short hold so it does not "click")
                                const actions = driver.actions({ bridge: true, async: false });
                                await actions
                                    .move({ x: Math.round(startX), y: Math.round(startY) })
                                    .press()
                                    .move({ x: Math.round(endX), y: Math.round(endY), duration: 250 })
                                    .release()
                                    .perform();
                            }
                        } else {
                            // iOS: short duration = flick/scroll; long duration feels like a press/click
                            try {
                                await mobileExecute("mobile: dragFromToForDuration", {
                                    fromX: startX,
                                    fromY: startY,
                                    toX: endX,
                                    toY: endY,
                                    duration: 0.18
                                });
                            } catch (iosErr) {
                                await mobileExecute("mobile: swipe", {
                                    direction,
                                    velocity: 500
                                });
                            }
                        }

                await waitMs(2000);

                const image = await captureDeviceScreenshot();
                require("fs").writeFileSync(`${folderPath}/image0.png`, image, "base64");

                const screenshot = document.getElementById("screenshot");
                if (screenshot) {
                    screenshot.src = `${folderPath}/image0.png?${Date.now()}`;
                    await new Promise(resolve => { screenshot.onload = resolve; screenshot.onerror = resolve; });
                    adjustDevicePreviewSize(screenshot);
                    applyScreenshotZoom(screenshot);
                }

                const pageSource = await capturePageSource();
                const parser = new DOMParser();
                window.xmlDoc = parser.parseFromString(pageSource, "text/xml");
                clearOverlay();

                // 4. Capture the exact text & layout state AFTER swiping
                const postSwipeState = getPageStructureState(window.xmlDoc);

                // 5. End of page / no scroll room: nothing meaningful moved — do NOT store swipe in table
                const hierarchyUnchanged = preSwipeState === postSwipeState;
                const screenshotUnchanged = !!(preImage && image && preImage === image);
                if (hierarchyUnchanged || screenshotUnchanged) {
                    showCustomAlert(
                        "Scroll Complete",
                        "No more content to scroll on this page (end of page reached). Swipe was not added to the table.",
                        "info"
                    );
                    return;
                }

                // 6. Record the Scroll Action in the Table ONLY if a successful scroll occurred
                let rootXPath = (plateformOption === 'IOS' || plateformOption === 'iOS') ? "//XCUIElementTypeApplication" : "//hierarchy";

                createAndAppendTable([
                    {
                        ControlName: `act_Scroll_${Math.round(startX)}_${Math.round(startY)}`,
                        ControlType: "Scroll",
                        ControlId: [
                            `SWIPE(${Math.round(startX)},${Math.round(startY)},${Math.round(endX)},${Math.round(endY)})`,
                            rootXPath
                        ],
                        IdentificationType: "Scroll",
                        Fingerprint: "<Action Type=\"Scroll\" />"
                    }
                ]);

    } catch (err) {
        handleDeviceCommandError(err, "Swipe Error:");
    } finally {
        // ONLY turn the loader off automatically if we are NOT waiting for the user to click "Okay" on an alert
        if (pendingExportAction !== "alertOnly") {
            hideLocalDeviceLoader();
            touchInProgress = false;
        }
    }
}

    function previewElement(e){

        if (isDragging) {
            clearOverlay();
            return;
        }

        if(showElementHover){
            return;
        }

        // Don't show hover highlight in Touch Mode
            if (!tapMode) {
                clearOverlay();
                return;
            }

        const img =
            document.getElementById(
                "screenshot"
            );

        if(!img || !window.xmlDoc)
            return;

        const { scaleX, scaleY, rect } = getScreenshotScale(img);

        const x =
            Math.round(
                (e.clientX - rect.left) * scaleX
            );

        const y =
            Math.round(
                (e.clientY - rect.top) * scaleY
            );

            const node =
                findHoveredNode(
                    x,
                    y
                );

            // Find if current point is within a registered feature area (prefer smallest)
            let currentFeatureArea = null;
            let smallestAreaFound = Number.MAX_VALUE;
            const dimsForArea = (typeof getDeviceDimensions === "function")
                ? getDeviceDimensions()
                : { width: 0, height: 0 };
            const screenArea = (dimsForArea.width > 0 && dimsForArea.height > 0)
                ? (dimsForArea.width * dimsForArea.height)
                : ((img && img.naturalWidth && img.naturalHeight)
                    ? (img.naturalWidth * img.naturalHeight)
                    : 0);
            for (const area of registeredFeatureAreas) {
                if (!area || !area.rect) continue;
                const { x: ax, y: ay, width: aw, height: ah } = area.rect;
                if (x >= ax && x <= (ax + aw) && y >= ay && y <= (ay + ah)) {
                    const rectArea = aw * ah;
                    const isFull = !!area.fullPage || (screenArea > 0 && (rectArea / screenArea) > 0.85);
                    // Full-page features: hide name while Shift-mapping a control
                    if (isFull && e.shiftKey) {
                        continue;
                    }
                    if (rectArea < smallestAreaFound) {
                        smallestAreaFound = rectArea;
                        currentFeatureArea = area;
                    }
                }
            }

            if (createFeatureMode) {
                const preferFullPage = shouldMapFullPageFeature(e.shiftKey);
                drawFeatureHoverAt(x, y, { preferFullPage });
                if (currentFeatureArea) {
                    drawFeatureAreaHighlight(currentFeatureArea, { active: true });
                }
                if (preferFullPage) {
                    const overlayEl = document.getElementById("overlayContainer");
                    const shot = document.getElementById("screenshot");
                    if (overlayEl && shot) drawFullPageFeatureFrame(shot, overlayEl);
                }
            } else if (node) {
                drawHoveredNode(node);
                if (currentFeatureArea) {
                    drawFeatureAreaHighlight(currentFeatureArea, { active: true });
                }
            } else {
                clearOverlay();
                if (currentFeatureArea) {
                    drawFeatureAreaHighlight(currentFeatureArea, { active: true });
                }
            }

    }

    function findHoveredNode(x, y){

        if(!window.xmlDoc)
            return null;

        const allNodes =
            window.xmlDoc.getElementsByTagName("*");

        let smallestNode = null;

        let smallestArea =
            Number.MAX_VALUE;
        let fullScreenFallback = null;
        let fullScreenArea = Number.MAX_VALUE;

        for(let i=0;i<allNodes.length;i++){

            const node =
                allNodes[i];

            if (["AppiumAUT", "XCUIElementTypeApplication", "XCUIElementTypeWindow", "hierarchy"].includes(node.nodeName)) {
                continue;
            }

            const rect = nodeRectOnScreenshot(node);
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                continue;
            }

            const { x: nx, y: ny, width: nw, height: nh } = rect;
            const area = nw * nh;
            const hits = x >= nx && x <= nx + nw && y >= ny && y <= ny + nh;
            if (!hits) continue;

            let skipFullScreen = false;
            if (typeof isAndroidPlatform === 'function' && isAndroidPlatform()) {
                const img = document.getElementById("screenshot");
                const sw = img && img.naturalWidth;
                const sh = img && img.naturalHeight;
                if (sw && sh && (area / (sw * sh)) > 0.92) {
                    skipFullScreen = true;
                    if (area < fullScreenArea) {
                        fullScreenArea = area;
                        fullScreenFallback = node;
                    }
                }
            }

            if (skipFullScreen) continue;

            if (area < smallestArea) {
                smallestArea = area;
                smallestNode = node;
            }

        }

        return smallestNode || fullScreenFallback;

    }

    function prestart() {
        updatePlatformUI();
    }





   // 1. Add Row Handler (Inserts 1 new row at top, pushing default rows down without replacing them)
       const addRowBtn = document.getElementById("add_row_btn");
       if (addRowBtn && !addRowBtn.dataset.listenerAttached) {
           addRowBtn.dataset.listenerAttached = "true";

           addRowBtn.addEventListener('click', async (e) => {
               e.preventDefault();
               e.stopPropagation();

               var pageName = document.getElementById('pagename_searchbox').value || "";
               var table = document.getElementById('myTable');
               var tableTopRow = table.insertRow(0);

               var allHeaders = Array.from(document.querySelectorAll('#mainTable thead tr > *'));
               var rowHtml = "";

               allHeaders.forEach((th) => {
                   // FIX: Use textContent to securely find headers even if CSS hides them
                   var thText = (th.textContent || th.innerText || '').replace('Delete Column', '').replace('Add Column', '').trim().toUpperCase();
                   var isHidden = window.getComputedStyle(th).display === 'none';
                   var displayStyle = isHidden ? 'display: none !important;' : '';

                   if (th.classList.contains('excel-header-corner')) {
                       rowHtml += `<td class="row-index" style="${displayStyle}"></td>`;
                   } else if (th.id === 'add_empty_column') {
                       rowHtml += `<td class="add-col-cell" style="${displayStyle}">&nbsp;</td>`;
                   } else if (th.classList.contains('custom-editable-header')) {
                       rowHtml += `<td contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">&nbsp;</td>`;
                   } else if (thText.includes('CONTROL NAME')) {
                       rowHtml += `<td class="cn pt-3-half" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}"></td>`;
                   } else if (thText.includes('CONTROL TYPE')) {
                       // 1. Define available Control Types
                                       const allControlTypes = [
                                           "TextBox", "Button", "RadioButton", "CheckBox", "Link",
                                           "DropDownList", "Image", "TextArea", "FileUpload", "Label",
                                           "Page", "AnchorTag", "Mouse", "Scroll", "Window",
                                           "NewTab", "Parent"
                                       ];
                       let ctSelectOptionsHtml = allControlTypes.map(type => `<option value="${type}">${type}</option>`).join('');
                       let controlTypeCellHtml = `<select class="xpath-dropdown" style="width: 100%; border: none; background: transparent; font-size: 11px; font-weight: 600;"><option value="" disabled selected hidden>Controls</option>${ctSelectOptionsHtml}</select>`;

                       rowHtml += `<td class="ct pt-3-half" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border-color: black; text-align: center; ${displayStyle}">${controlTypeCellHtml}</td>`;
                   } else if (thText.includes('CONTROL ID')) {
                       rowHtml += `<td class="xpath pt-3-half" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}"></td>`;
                   } else if (thText.includes('PAGE NAME')) {
                       rowHtml += `<td class="page pt-3-half" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${pageName}</td>`;
                   } else if (thText.includes('IDENTIFICATION TYPE')) {
                       rowHtml += `<td class="identificationType pt-3-half" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}"></td>`;
                   } else if (thText.includes('CONTROL VALUE')) {
                       rowHtml += `<td class="controlValue pt-3-half" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}"></td>`;
                   } else if (thText.includes('FEATURE NAME')) {
                       rowHtml += `<td class="featureName pt-3-half" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${pageName}</td>`;
                   } else if (thText.includes('NODE NAME')) {
                       rowHtml += `<td class="nodeName pt-3-half" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${pageName}</td>`;
                   } else if (th.classList.contains('fingerprint')) {
                       rowHtml += `<td class="fingerprint" style="display:none;"></td>`;
                   } else if (th.id === 'appUrl' || thText.includes('APP URL')) {
                       rowHtml += `<td class="appUrl" style="display:none;"></td>`;
                   } else if (thText.includes('DELETE')) {
                       rowHtml += `<td class="delete-cell" style="border-color:black; ${displayStyle}">
                           <input type="checkbox" class="bulk-delete-cb" style="display:none; cursor:pointer; margin:0 auto;">
                           <img src="icon/icons8-delete_red.svg" alt="delete" class="deleteBtn" style="margin-left: auto; margin-right: 1px; max-width:17px; cursor: pointer; -webkit-user-drag: none; display:inline-block;">
                       </td>`;
                   }else {
                       rowHtml += `<td contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">&nbsp;</td>`;
                   }
               });

               tableTopRow.innerHTML = rowHtml;
               tableCreated = true;
               document.getElementById('table-container').style.display = "block";

               updateRowNumbers();
           });
       }

    // 2. Add Column Handler (Adds 1 column with editable header & delete trash icon)
        const addColBtn = document.getElementById("add_empty_column");
        if (addColBtn && !addColBtn.dataset.listenerAttached) {
            addColBtn.dataset.listenerAttached = "true";

            addColBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();

                var headerRow = document.querySelector('#mainTable thead tr');
                if (!headerRow) return;

                var existingCustomCols = headerRow.querySelectorAll('.custom-editable-header').length + 1;

                var newTh = document.createElement('th');
                newTh.className = "custom-editable-header";
                newTh.style.width = "180px";
                newTh.style.textAlign = "center";
                newTh.style.borderColor = "black";

                newTh.innerHTML = `
                    <span contenteditable="true" style="outline:none; cursor:text;">NEW_COLUMN_${existingCustomCols}</span>
                    <img src="icon/icons8-delete_red.svg" class="deleteColBtn" style="width:13px; cursor:pointer; margin-left:6px; vertical-align:middle;" title="Delete Column" />
                    <div class="resizer"></div>
                `;

                // Column Delete Listener
                const deleteColImg = newTh.querySelector('.deleteColBtn');
                deleteColImg.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    var colIndex = newTh.cellIndex;
                    deleteCustomColumn(colIndex);
                });

                // FIX: Securely locate the Delete column using textContent
                var deleteTh = Array.from(headerRow.children).find(th => {
                    let t = (th.textContent || th.innerText || "").toUpperCase();
                    return t.includes('DELETE');
                });

                if (deleteTh) {
                    headerRow.insertBefore(newTh, deleteTh);
                } else {
                    headerRow.insertBefore(newTh, addColBtn);
                }

                // Add matching cell to all existing body rows BEFORE the Delete cell
                var allBodyRows = document.querySelectorAll('#myTable tr');
                allBodyRows.forEach(row => {
                    var newTd = document.createElement('td');
                    newTd.contentEditable = "true";
                    newTd.style.overflow = "hidden";
                    newTd.style.whiteSpace = "nowrap";
                    newTd.style.textOverflow = "ellipsis";
                    newTd.style.fontSize = "11px";
                    newTd.style.fontWeight = "600";
                    newTd.style.borderColor = "black";
                    newTd.style.textAlign = "center";
                    newTd.innerHTML = "&nbsp;";

                    var deleteTd = row.querySelector('.delete-cell');
                    if (deleteTd) {
                        row.insertBefore(newTd, deleteTd);
                    } else {
                        var lastCell = row.querySelector('.add-col-cell') || row.lastElementChild;
                        row.insertBefore(newTd, lastCell);
                    }
                });

                initResizableTable();

                // Auto-scroll the table to the far right so the user immediately sees the new column
                const tableContainer = document.getElementById('table-container');
                if (tableContainer) {
                    setTimeout(() => {
                        tableContainer.scrollLeft = tableContainer.scrollWidth;
                    }, 50);
                }
            });
        }



    document.getElementById("appname").addEventListener('click', async () => {
      document.getElementById("appname").style.borderColor = ''
    })
    document.getElementById("devicename").addEventListener('click', async () => {
      document.getElementById("devicename").style.borderColor = ''
    })
    document.getElementById("udid").addEventListener('click', async () => {
      document.getElementById("udid").style.borderColor = ''
    })
    document.getElementById("platformversion").addEventListener('click', async () => {
      document.getElementById("platformversion").style.borderColor = ''
    })
    document.getElementById("automationName").addEventListener('click', async () => {
      document.getElementById("automationName").style.borderColor = ''
    })
    document.getElementById("bundleID").addEventListener('click', async () => {
      document.getElementById("bundleID").style.borderColor = ''
    })
    document.getElementById("appiumurl").addEventListener('click', async () => {
      document.getElementById("appiumurl").style.borderColor = ''
    })
    document.getElementById("pagename_searchbox").addEventListener('click', async () => {
      document.getElementById("pagename_searchbox").style.borderColor = ''
    })


    function checkForSingleQuote(statement) {
      var words = statement.split(" ");
      for (var i = 0; i < words.length; i++) {
        if (words[i].includes("'")) {
          words[i] = ""
        }
      }
      statement = words.join(" ");
      return statement;
    }


// ===========================================================================
// [TABLE] Insert scraped controls into #myTable
// Each row: Control Name/Type/ID dropdown, Page Name, Identification Type
// (derived from primary locator), hidden Fingerprint + App URL cells.
// Changing Control ID dropdown updates Identification Type via onDropdownChange.
// ===========================================================================
function createAndAppendTable(dtControls) {
    if (typeof noResultsMessage !== 'undefined') {
        noResultsMessage.style.display = 'none';
    }

    var pageName = document.getElementById('pagename_searchbox').value;
    var tbody = document.getElementById('myTable');

    var allHeaders = Array.from(document.querySelectorAll('#mainTable thead tr > *'));

    for (var i = 0; i < dtControls.length; i++) {
        let xpaths = Array.isArray(dtControls[i].ControlId)
            ? dtControls[i].ControlId
            : [dtControls[i].ControlId];

        let selectOptionsHtml = xpaths.map(xp =>
            `<option value="${xp.replace(/"/g, '&quot;')}" onmousemove="onOptionHover('${xp.replace(/'/g, "\\'")}')">${xp}</option>`
        ).join('');

        let controlIdCellHtml = `<select class="xpath-dropdown" onchange="onDropdownChange(this)" onmouseleave="onShowElementLeave(event)" style="width: 100%; border: none; background: transparent; font-size: 11px; font-weight: 600;">${selectOptionsHtml}</select>`;

        let tr = tbody.insertRow(0);
        tr.dataset.rect = JSON.stringify(dtControls[i].rect || null);

        let emptyRows = tbody.querySelectorAll('tr.empty-excel-row');
        if (emptyRows.length > 0) {
            emptyRows[emptyRows.length - 1].remove();
        }

        let td_id = i;

                // 1. Define available Control Types (Comprehensive & Alphabetical) All Control Types
                   const allControlTypes = [
                                             "TextBox", "Button", "RadioButton", "CheckBox", "Link",
                                             "DropDownList", "Image", "TextArea", "FileUpload", "Label",
                                             "Page", "AnchorTag", "Mouse", "Scroll", "Window",
                                             "NewTab", "Parent"
                                                      ];


                let currentControlType = dtControls[i].ControlType || "";

                // 2. Ensure current type is in the list, then build options
                let optionsList = [...new Set([currentControlType, ...allControlTypes])].filter(Boolean);
                let ctSelectOptionsHtml = optionsList.map(type =>
                    `<option value="${type}" ${type === currentControlType ? 'selected' : ''}>${type}</option>`
                ).join('');

                // 3. Create the Dropdown HTML
                let controlTypeCellHtml = `<select class="xpath-dropdown" style="width: 100%; border: none; background: transparent; font-size: 11px; font-weight: 600;">${ctSelectOptionsHtml}</select>`;

                const primaryLocator = (xpaths[0] || "").trim();
                const identificationType = (dtControls[i].IdentificationType || "").trim()
                    || (typeof inferIdentificationType === "function" ? inferIdentificationType(primaryLocator) : "");

                let rowDataMap = {
                                    "#": "",
                                    "CONTROL NAME": dtControls[i].ControlName || "",
                                    "CONTROL TYPE": controlTypeCellHtml, // Use dropdown HTML
                                    "CONTROL ID": controlIdCellHtml,
                            "PAGE NAME": pageName,
                            "IDENTIFICATION TYPE": identificationType,
                            "CONTROL VALUE": dtControls[i].ControlValue || "", // UPDATED to catch the passed value
                            "FEATURE NAME": dtControls[i].FeatureName || pageName,
                            "NODE NAME": pageName,
                            "DELETE": `<img src="icon/icons8-delete_red.svg" id="del_${td_id}" alt="delete" class="deleteBtn" style="margin-left: auto; margin-right: 1px; max-width:17px; overflow: hidden; cursor: pointer; -webkit-user-drag: none; display:inline-block;">`,
                            "FINGERPRINT": (dtControls[i].Fingerprint || "").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
                            "APP URL": getCurrentAppIdentity()
                        };

        var rowHtml = "";

        // Build cells dynamically and hide them if the header is currently hidden
        allHeaders.forEach((th) => {
            // FIX: securely fetch header text ignoring CSS
            var thText = (th.textContent || th.innerText || '').replace('Delete Column', '').replace('Add Column', '').trim().toUpperCase();

            var isHidden = window.getComputedStyle(th).display === 'none';
            var displayStyle = isHidden ? 'display: none !important;' : '';

            if (th.classList.contains('excel-header-corner')) {
                rowHtml += `<td class="row-index" style="${displayStyle}"></td>`;
            } else if (th.id === 'add_empty_column') {
                rowHtml += `<td class="add-col-cell" style="${displayStyle}">&nbsp;</td>`;
            } else if (th.classList.contains('custom-editable-header')) {
                rowHtml += `<td contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">&nbsp;</td>`;
            } else if (thText.includes('CONTROL NAME')) {
                rowHtml += `<td class="cn pt-3-half" id="cn_${td_id}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["CONTROL NAME"]}</td>`;
            } else if (thText.includes('CONTROL TYPE')) {
                            rowHtml += `<td class="ct pt-3-half" id="ct_${td_id}" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["CONTROL TYPE"]}</td>`;
            } else if (thText.includes('CONTROL ID')) {
                rowHtml += `<td class="xpath pt-3-half" id="xpath_${td_id}" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["CONTROL ID"]}</td>`;
            } else if (thText.includes('PAGE NAME')) {
                rowHtml += `<td class="page pt-3-half" id="page_${td_id}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["PAGE NAME"]}</td>`;
            } else if (thText.includes('IDENTIFICATION TYPE')) {
                rowHtml += `<td class="identificationType pt-3-half" id="identificationType_${td_id}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["IDENTIFICATION TYPE"]}</td>`;
            } else if (thText.includes('CONTROL VALUE')) {
                rowHtml += `<td class="controlValue pt-3-half" id="controlValue_${td_id}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["CONTROL VALUE"]}</td>`;
            } else if (thText.includes('FEATURE NAME')) {
                rowHtml += `<td class="featureName pt-3-half" id="featureName_${td_id}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["FEATURE NAME"]}</td>`;
            } else if (thText.includes('NODE NAME')) {
                rowHtml += `<td class="nodeName pt-3-half" id="nodeName_${td_id}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["NODE NAME"]}</td>`;
            } else if (th.classList.contains('fingerprint')) {
                rowHtml += `<td class="fingerprint" style="display:none;">${rowDataMap["FINGERPRINT"]}</td>`;
            } else if (th.id === 'appUrl' || thText.includes('APP URL')) {
                rowHtml += `<td class="appUrl" style="display:none;">${rowDataMap["APP URL"] || ""}</td>`;
            } else if (thText.includes('DELETE')) {
                rowHtml += `<td class="delete-cell" style="border-color:black; ${displayStyle}">
                    <input type="checkbox" class="bulk-delete-cb" style="display:none; cursor:pointer; margin:0 auto;">
                    <img src="icon/icons8-delete_red.svg" alt="delete" class="deleteBtn" style="margin-left: auto; margin-right: 1px; max-width:17px; cursor: pointer; -webkit-user-drag: none; display:inline-block;">
                </td>`;
            }else {
                rowHtml += `<td contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">&nbsp;</td>`;
            }
        });

        tr.innerHTML = rowHtml;
    }

    tableCreated = true;
    document.getElementById('download').disabled = false;
    document.getElementById('download').style.backgroundColor = '#2F8BCC';
    document.getElementById('table-container').style.display = "block";

    updateRowNumbers();
    initResizableTable();

    applyPagination();
}

    function initResizableTable() {
        const resizers = document.querySelectorAll('#mainTable .resizer');

        resizers.forEach(resizer => {
            const th = resizer.parentElement;

            // Prevent attaching duplicate event listeners
            if (resizer.dataset.resizableInit === "true") {
                return;
            }
            resizer.dataset.resizableInit = "true";

            // 1. Mouse Drag Resizing
            resizer.addEventListener('mousedown', function(e) {
                e.preventDefault();
                e.stopPropagation();

                const startX = e.clientX;
                const startWidth = th.offsetWidth;
                let currentWidth = startWidth;
                let animationFrameId = null;

                function updateWidth() {
                    // Minimum column width limit: 25px
                    if (currentWidth >= 25) {
                        th.style.width = `${currentWidth}px`;
                        th.style.minWidth = `${currentWidth}px`;
                    }
                    animationFrameId = null;
                }

                function handleMouseMove(e) {
                    currentWidth = startWidth + (e.clientX - startX);
                    if (!animationFrameId) {
                        animationFrameId = requestAnimationFrame(updateWidth);
                    }
                }

                function handleMouseUp() {
                    document.removeEventListener('mousemove', handleMouseMove);
                    document.removeEventListener('mouseup', handleMouseUp);
                    if (animationFrameId) {
                        cancelAnimationFrame(animationFrameId);
                    }
                }

                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
            });

            // 2. Double-Click Auto-Fit Calculation
            resizer.addEventListener('dblclick', function(e) {
                e.preventDefault();
                e.stopPropagation();

                th.style.width = '';
                th.style.minWidth = '';

                const table = document.getElementById('mainTable');
                const colIndex = th.cellIndex;
                let maxWidth = 30; // Baseline safety minimum

                const dummySpan = document.createElement('span');
                dummySpan.style.visibility = 'hidden';
                dummySpan.style.position = 'absolute';
                dummySpan.style.whiteSpace = 'nowrap';
                dummySpan.style.font = window.getComputedStyle(th).font;
                document.body.appendChild(dummySpan);

                // Measure header text
                dummySpan.innerText = th.innerText.replace(/\s+/g, ' ').trim();
                maxWidth = Math.max(maxWidth, dummySpan.offsetWidth + 20);

                // Measure cell contents in rows
                                const rows = table.querySelectorAll('tbody tr');
                                rows.forEach(row => {
                                    const cell = row.cells[colIndex];
                                    if (cell) {
                                        let textToMeasure = "";
                                        let extraPadding = 25; // Default padding for normal text cells

                                        const selectEl = cell.querySelector('select');
                                        if (selectEl) {
                                            // ONLY measure the currently selected option, ignoring hidden long XPaths
                                            if (selectEl.selectedIndex >= 0) {
                                                textToMeasure = selectEl.options[selectEl.selectedIndex].text;
                                            } else {
                                                textToMeasure = selectEl.value;
                                            }
                                            // Add extra padding to account for the physical dropdown arrow icon
                                            extraPadding = 45;
                                        } else {
                                            textToMeasure = cell.innerText;
                                        }

                                        dummySpan.innerText = textToMeasure;
                                        const cellWidth = dummySpan.offsetWidth + extraPadding;
                                        if (cellWidth > maxWidth) {
                                            maxWidth = cellWidth;
                                        }
                                    }
                                });

                document.body.removeChild(dummySpan);

                th.style.width = `${maxWidth}px`;
                th.style.minWidth = `${maxWidth}px`;
            });
        });
    }

    function clearOverlay(){

        const overlay =
            document.getElementById(
                "overlayContainer"
            );

        if(overlay){

            overlay.innerHTML = "";

        }

    }

    function drawHoveredNode(node){

        clearOverlay();

        const overlay =
            document.getElementById("overlayContainer");

        const img =
            document.getElementById("screenshot");

        if(!overlay || !img || !node)
            return;

        const nodeRect = nodeRectOnScreenshot(node);
        if (!nodeRect) return;

        const { invScaleX: scaleX, invScaleY: scaleY } = getScreenshotScale(img);

        const x = nodeRect.x;
        const y = nodeRect.y;
        const width = nodeRect.width;
        const height = nodeRect.height;

        const box =
            document.createElement("div");

        box.style.position = "absolute";

        const overlayRect =
            overlay.getBoundingClientRect();

        const imgRect =
            img.getBoundingClientRect();

        const offsetX =
            imgRect.left - overlayRect.left;

        const offsetY =
            imgRect.top - overlayRect.top;

        box.style.left =
            (offsetX + x * scaleX) + "px";

        box.style.top =
            (offsetY + y * scaleY) + "px";

        box.style.width =
            (width * scaleX) + "px";

        box.style.height =
            (height * scaleY) + "px";

        box.style.border =
            "2px dashed blue";

        box.style.pointerEvents =
            "none";

        box.style.boxSizing =
            "border-box";

        overlay.appendChild(box);

        drawParentLayers(node);

    }

    function drawFeatureHover(node){
        if (!node) return;
        const rect = nodeRectOnScreenshot(node);
        if (!rect) return;
        drawFeatureHoverAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
    }

    /** Pick the region Create Feature would save on click (full page by default, or control with Shift). */
    function resolveFeatureTargetAt(clickX, clickY, preferFullPage) {
        if (!window.xmlDoc) return null;

        const rootTypes = ["AppiumAUT", "XCUIElementTypeApplication", "XCUIElementTypeWindow", "hierarchy"];
        const img = document.getElementById("screenshot");
        const dims = (typeof getDeviceDimensions === "function")
            ? getDeviceDimensions()
            : { width: 0, height: 0 };
        const screenArea = (dims.width > 0 && dims.height > 0)
            ? (dims.width * dims.height)
            : ((img && img.naturalWidth && img.naturalHeight) ? (img.naturalWidth * img.naturalHeight) : 0);

        // Click (preferFullPage) → always the full screenshot/device rect
        if (preferFullPage) {
            if (dims.width > 0 && dims.height > 0) {
                return {
                    node: null,
                    rect: { x: 0, y: 0, width: dims.width, height: dims.height },
                    area: dims.width * dims.height,
                    fullPage: true
                };
            }
            if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
                return {
                    node: null,
                    rect: { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight },
                    area: img.naturalWidth * img.naturalHeight,
                    fullPage: true
                };
            }
            return null;
        }

        // Shift+click or inner feature → smallest meaningful control, never the full page
        const hits = [];
        const nodes = window.xmlDoc.getElementsByTagName("*");
        const pageH = Math.max(1, dims.height || 1);
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (rootTypes.includes(node.nodeName)) continue;
            const rect = parseNodeRect(node);
            if (!rect || rect.width <= 0 || rect.height <= 0) continue;
            const { x, y, width, height } = rect;
            if (clickX >= x && clickX <= (x + width) && clickY >= y && clickY <= (y + height)) {
                const area = width * height;
                if (screenArea > 0 && (area / screenArea) > 0.92) continue;
                if (y <= pageH * 0.05 && height / pageH >= 0.55 && (y + height) / pageH < 0.92) continue;
                hits.push({ node, rect, area });
            }
        }
        if (!hits.length) return null;

        hits.sort((a, b) => a.area - b.area);
        const meaningful = hits.filter((h) => typeof isMeaningfulControlNode === "function" && isMeaningfulControlNode(h.node));
        return meaningful[0] || hits[0];
    }

    /**
     * Create Feature hover preview.
     * preferFullPage (default click): cyan full-screenshot frame + nested hints.
     * !preferFullPage (Shift): emphasize the control under the pointer (what Shift+click saves).
     */
    function drawFeatureHoverAt(x, y, options = {}) {
        clearOverlay();

        const overlay = document.getElementById("overlayContainer");
        const img = document.getElementById("screenshot");
        if (!overlay || !img || !window.xmlDoc) return;

        const preferFullPage = options.preferFullPage !== false;

        // Skip shell/root nodes — iOS Window often stops above the bottom tab bar and
        // looks like a "full page" cut mid-screen if drawn as the hover outline.
        const rootSkip = new Set([
            "AppiumAUT",
            "hierarchy",
            "XCUIElementTypeApplication",
            "XCUIElementTypeWindow"
        ]);

        const dims = (typeof getDeviceDimensions === "function")
            ? getDeviceDimensions()
            : { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };
        const pageArea = Math.max(1, (dims.width || 1) * (dims.height || 1));
        const pageH = Math.max(1, dims.height || 1);

        const hits = [];
        const seenKeys = new Set();
        const allNodes = window.xmlDoc.getElementsByTagName("*");
        for (let i = 0; i < allNodes.length; i++) {
            const node = allNodes[i];
            if (rootSkip.has(node.nodeName)) continue;

            const rect = nodeRectOnScreenshot(node);
            if (!rect || rect.width <= 0 || rect.height <= 0) continue;

            const { x: nx, y: ny, width: nw, height: nh } = rect;
            if (!(x >= nx && x <= nx + nw && y >= ny && y <= ny + nh)) continue;

            if (nh < 4 || nw < 4) continue;
            if ((nw * nh) / pageArea > 0.92) continue;
            if (ny <= pageH * 0.05 && nh / pageH >= 0.55 && (ny + nh) / pageH < 0.92) continue;

            const area = nw * nh;
            const key = `${Math.round(nx)},${Math.round(ny)},${Math.round(nw)},${Math.round(nh)}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            hits.push({ node, area, rect });
        }

        hits.sort((a, b) => b.area - a.area);

        if (preferFullPage) {
            // Nested hints only (full page frame drawn by caller / below)
            const layers = hits.slice(0, 8);
            const colors = [
                "#34A853", "#FBBC05", "#EA4335", "#9C27B0", "#FF6D00",
                "#8BC34A", "#3F51B5", "#E91E63"
            ];
            layers.forEach((hit, index) => {
                if (!hit) return;
                drawLayer(hit.node, colors[index % colors.length]);
            });
            drawFullPageFeatureFrame(img, overlay);
            return;
        }

        // Shift: show the control that will be saved (smallest meaningful hit)
        const inners = hits.slice().sort((a, b) => a.area - b.area);
        const primary = inners[0];
        if (primary) {
            drawLayer(primary.node, "#2F8BCC");
        } else {
            drawFullPageFeatureFrame(img, overlay);
        }
    }

    /** Cyan dashed box around the entire visible screenshot = complete app page (never mid-cut). */
    function drawFullPageFeatureFrame(img, overlay) {
        if (!img || !overlay) return;

        const overlayRect = overlay.getBoundingClientRect();
        const imgRect = img.getBoundingClientRect();
        if (!imgRect.width || !imgRect.height) return;

        // Remove any previous page frame so we never stack duplicates
        overlay.querySelectorAll(".feature-full-page-frame").forEach((el) => el.remove());

        const left = imgRect.left - overlayRect.left;
        const top = imgRect.top - overlayRect.top;
        const width = imgRect.width;
        const height = imgRect.height;

        const box = document.createElement("div");
        box.className = "feature-full-page-frame";
        box.style.position = "absolute";
        box.style.left = left + "px";
        box.style.top = top + "px";
        box.style.width = width + "px";
        box.style.height = height + "px";
        box.style.border = "3px dashed #2F8BCC";
        box.style.boxSizing = "border-box";
        box.style.pointerEvents = "none";
        box.style.zIndex = "2000";
        overlay.appendChild(box);
    }

    function drawShowElementMarker(rect){

        clearOverlay();

        const overlay =
            document.getElementById("overlayContainer");

        const img =
            document.getElementById("screenshot");

        if(!overlay || !img)
            return;

        const { invScaleX: scaleX, invScaleY: scaleY } = getScreenshotScale(img);

        const imgRect =
            img.getBoundingClientRect();

        const overlayRect =
            overlay.getBoundingClientRect();

        const left =
            imgRect.left -
            overlayRect.left +
            rect.x * scaleX;

        const top =
            imgRect.top -
            overlayRect.top +
            rect.y * scaleY;

        const width =
            rect.width * scaleX;

        const height =
            rect.height * scaleY;

        // Red Border
        const box =
            document.createElement("div");

        box.style.position = "absolute";
        box.style.left = left + "px";
        box.style.top = top + "px";
        box.style.width = width + "px";
        box.style.height = height + "px";
        box.style.border = "2px dashed blue";
        box.style.boxSizing = "border-box";
        box.style.pointerEvents = "none";

        overlay.appendChild(box);

    }

    function drawFeatureAreaHighlight(area, options = {}) {
        const overlay = document.getElementById("overlayContainer");
        const img = document.getElementById("screenshot");
        if (!overlay || !img || !area || !area.rect) return;

        const featureName = String(area.name || "").trim() || "Feature";
        const active = options.active !== false;
        const { invScaleX: scaleX, invScaleY: scaleY } = getScreenshotScale(img);
        const imgRect = img.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();

        const offsetX = imgRect.left - overlayRect.left;
        const offsetY = imgRect.top - overlayRect.top;

        const dims = (typeof getDeviceDimensions === "function")
            ? getDeviceDimensions()
            : { width: 0, height: 0 };
        const r = area.rect;
        const looksFullPage = !!area.fullPage || (
            dims.width > 0 && dims.height > 0 &&
            r.x <= 2 && r.y <= 2 &&
            r.width >= dims.width * 0.95 &&
            r.height >= dims.height * 0.95
        );

        // Full-page features wrap the screenshot image only (not zoom/toolbar chrome)
        let boxW, boxH, boxLeft, boxTop;
        if (looksFullPage) {
            boxLeft = offsetX;
            boxTop = offsetY;
            boxW = imgRect.width;
            boxH = imgRect.height;
        } else {
            const { x, y, width, height } = r;
            boxW = Math.max(1, width * scaleX);
            boxH = Math.max(1, height * scaleY);
            boxLeft = offsetX + x * scaleX;
            boxTop = offsetY + y * scaleY;
        }
        const boxBottom = boxTop + boxH;

        // Screenshot band inside overlay — labels must stay inside (parents clip overflow)
        const viewLeft = offsetX;
        const viewTop = offsetY;
        const viewRight = offsetX + imgRect.width;
        const viewBottom = offsetY + imgRect.height;
        const spaceAbove = boxTop - viewTop;
        const spaceBelow = viewBottom - boxBottom;
        const labelH = 22;
        const labelMinW = 56;

        const box = document.createElement("div");
        box.className = "feature-area-highlight";
        box.style.cssText = [
            "position:absolute",
            `left:${boxLeft}px`,
            `top:${boxTop}px`,
            `width:${boxW}px`,
            `height:${boxH}px`,
            `border:2px dashed ${active ? "#2F8BCC" : "rgba(47,139,204,0.45)"}`,
            "box-sizing:border-box",
            "pointer-events:none",
            `z-index:${active ? 1000 : 900}`,
            "overflow:visible"
        ].join(";");

        // Label is a sibling on the overlay (not inside the box) so overflow:hidden cannot clip it to a white sliver
        const label = document.createElement("div");
        label.className = "feature-area-label";
        label.textContent = featureName;

        let labelTop;
        if (spaceAbove >= labelH + 2) {
            labelTop = boxTop - labelH; // above
        } else if (spaceBelow >= labelH + 2) {
            labelTop = boxBottom + 2; // below
        } else {
            labelTop = boxTop + 4; // inside top
        }
        labelTop = Math.max(viewTop + 2, Math.min(labelTop, viewBottom - labelH - 2));
        const labelLeft = Math.max(viewLeft + 2, Math.min(boxLeft + 2, viewRight - labelMinW - 2));

        label.style.cssText = [
            "position:absolute",
            `left:${labelLeft}px`,
            `top:${labelTop}px`,
            "display:inline-block",
            "width:auto",
            `min-width:${labelMinW}px`,
            `min-height:${labelH}px`,
            "max-width:180px",
            "box-sizing:border-box",
            "padding:3px 8px",
            "margin:0",
            `background-color:${active ? "#2F8BCC" : "rgba(47,139,204,0.9)"}`,
            "color:#ffffff",
            "font-size:11px",
            "font-weight:700",
            "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif",
            "line-height:16px",
            "border-radius:3px",
            "white-space:nowrap",
            "overflow:hidden",
            "text-overflow:ellipsis",
            "pointer-events:none",
            "z-index:1002",
            "box-shadow:0 1px 4px rgba(0,0,0,0.35)"
        ].join(";");

        overlay.appendChild(box);
        overlay.appendChild(label);
    }

    //dotted over lay for specific element and it's node

    function drawParentLayers(node){

        let parent = node.parentNode;

        const colors = [
            "green",
            "orange",
            "purple",
            "cyan"
        ];

        let level = 0;

        while(parent){

            if(parent.nodeType !== 1){

                parent = parent.parentNode;
                continue;

            }

            const type = parent.nodeName;

            // Skip unwanted parents
            if(
                type === "XCUIElementTypeApplication" ||
                type === "XCUIElementTypeWindow" ||
                type === "XCUIElementTypeOther" ||
                type === "hierarchy" ||
                type === "android.widget.FrameLayout" ||
                type === "android.view.ViewGroup"
            ){

                parent = parent.parentNode;
                continue;

            }

            drawLayer(
                parent,
                colors[level]
            );

            // Stop after first meaningful parent
            break;

        }

    }


    //dotted over lay for specific element and it's node and it's parent node also

    //function drawParentLayers(node){
    //
    //    let parent = node.parentNode;
    //
    //    const colors = [
    //        "green",
    //        "orange",
    //        "purple",
    //        "cyan"
    //    ];
    //
    //    let level = 0;
    //
    //    while(parent){
    //
    //        if(parent.nodeType !== 1){
    //            parent = parent.parentNode;
    //            continue;
    //        }
    //
    //        const type = parent.nodeName;
    //
    //        if(
    //            type === "XCUIElementTypeApplication" ||
    //            type === "XCUIElementTypeWindow"
    //        ){
    //            break;
    //        }
    //
    //        drawLayer(
    //            parent,
    //            colors[level % colors.length]
    //        );
    //
    //        parent = parent.parentNode;
    //
    //        level++;
    //
    //    }
    //
    //}

    function drawLayer(node,color){

        const overlay =
            document.getElementById("overlayContainer");

        const img =
            document.getElementById("screenshot");

        if (!overlay || !img || !node) return;

        const nodeRect = nodeRectOnScreenshot(node);
        if (!nodeRect) return;

        const { invScaleX: scaleX, invScaleY: scaleY } = getScreenshotScale(img);

        const overlayRect =
            overlay.getBoundingClientRect();

        const imgRect =
            img.getBoundingClientRect();

        const offsetX =
            imgRect.left - overlayRect.left;

        const offsetY =
            imgRect.top - overlayRect.top;

        const x = nodeRect.x;
        const y = nodeRect.y;
        const w = nodeRect.width;
        const h = nodeRect.height;

        const div =
            document.createElement("div");

        div.style.position = "absolute";

        div.style.left =
            (offsetX + x * scaleX) + "px";

        div.style.top =
            (offsetY + y * scaleY) + "px";

        div.style.width =
            (w * scaleX) + "px";

        div.style.height =
            (h * scaleY) + "px";

        div.style.border =
            "2px dashed " + color;

        div.style.pointerEvents =
            "none";

        div.style.boxSizing =
            "border-box";

        overlay.appendChild(div);

    }

    function testOverlay(){

        clearOverlay();

        const overlay =
            document.getElementById(
                "overlayContainer"
            );

        const box =
            document.createElement("div");

        box.style.position = "absolute";
        box.style.left = "60px";
        box.style.top = "80px";
        box.style.width = "120px";
        box.style.height = "50px";
        box.style.border = "2px dashed red";
        box.style.boxSizing = "border-box";

        overlay.appendChild(box);

    }

    //for coordinates
    async function showCoordinateMarker(x, y) {


        const oldSS =
                document.getElementById("ss");

            if (oldSS) {
                oldSS.remove();
            }

        const container =
            document.getElementById(
                "image-container_ss"
            );

        if (!container) return;

        const screenshot =
            document.getElementById(
                "screenshot"
            );

        if (!screenshot) return;

        // Clear previous content
        container.innerHTML = "";

        const wrapper =
            document.createElement(
                "div"
            );

        wrapper.style.position =
            "relative";

        wrapper.style.display =
            "inline-block";

        const img =
            document.createElement(
                "img"
            );

        img.src =
            screenshot.src;

        img.style.width =
            "100px";

        wrapper.appendChild(
            img
        );

        img.onload = () => {

            const dims = getDeviceDimensions();
            const appWidth = dims.width;
            const appHeight = dims.height;

            if (!appWidth || !appHeight) return;

            const marker =
                document.createElement(
                    "div"
                );

            marker.style.position =
                "absolute";

            marker.style.width =
                "12px";

            marker.style.height =
                "12px";

            marker.style.borderRadius =
                "50%";

            marker.style.background =
                "red";

            marker.style.left =
                (
                    (x / appWidth) *
                    img.width
                    - 6
                ) + "px";

            marker.style.top =
                (
                    (y / appHeight) *
                    img.height
                    - 6
                ) + "px";

            wrapper.appendChild(
                marker
            );
        };

        container.replaceChildren(
            wrapper
        );

        lastClickedImg =
            wrapper;

        container.style.display =
            "flex";
    }

    const tableEC = document.getElementById("myTable");
    let loadingImage = false; // Flag to indicate if an image is currently being loaded
    let lastClickedImg = null; // Variable to keep track of the last clicked image

    tableEC.addEventListener("click", async (event) => {
      // Check if an image is currently being loaded, if yes, cancel the loading
      if (loadingImage) return;

//      var plateformOption = plateformName.options[plateformName.selectedIndex].text;
      if (event.target.tagName === "TD" && event.target.cellIndex === 4) {
        const thirdCell = event.target.parentNode.cells[2];
        const innerText = thirdCell.innerText;


    //for coordinates

        if (innerText.startsWith("COORDINATE(")) {

            const match = innerText.match(
                /COORDINATE\((\d+),(\d+)\)/
            );

            const x = parseInt(match[1]);
            const y = parseInt(match[2]);

            showCoordinateMarker(x, y);

            return;
        }
        document.getElementById("brokenText").style.display = "none";

        try {
          loadingImage = true; // Set loadingImage to true to indicate image loading
          if (lastClickedImg) {
            lastClickedImg.remove(); // Remove the previously clicked image
          }

          const imageContainer =
              document.getElementById("image-container_ss");

          const statusBar =
              document.getElementById("div_status_bar_ss");

          if (imageContainer)
              imageContainer.style.display = "flex";

          if (statusBar)
              statusBar.style.display = "flex";

          const el = await driver.findElement(By.xpath(innerText));
          const data = await el.takeScreenshot();
          const screenshot = Buffer.from(data, "base64");
            fs.writeFileSync(`${folderPath}/ss_${count}.png`, screenshot);
          let img = document.createElement("img");
          img.src = `${folderPath}/ss_${count}.png`;
          img.id = "ss";
          img.style.maxWidth = "100%";
          img.style.maxHeight = "100%";
          img.style.width = "100%";
          img.style.height = "100%";
          img.style.objectFit = "contain";
          document.getElementById("image-container_ss").appendChild(img);
          lastClickedImg = img; // Set the last clicked image
          count = count + 1;
        } catch (e) {

                const imageContainer =
                    document.getElementById("image-container_ss");

                const brokenText =
                    document.getElementById("brokenText");

                if (imageContainer)
                    imageContainer.style.display = "none";

                if (brokenText)
                    brokenText.style.display = "flex";

                console.error("IOS ELEMENT ERROR:", e);
                                showErrorPopup("Failed to Load Element Image", e);
                        } finally {
          loadingImage = false; // Reset loadingImage flag after image loading is complete or failed
          document.getElementById("div_status_bar_ss").style.display = "none";
        }
      }
    });

    // ===========================================================================
    // [SCRAPE] Scrape UI — bulk-scrape all meaningful on-screen controls
    // Refreshes page source first, skips root/system/0-size nodes, keeps nodes
    // with label/name/text/resource-id/etc., maps types + XPath candidates.
    // ===========================================================================
    document.getElementById("scrapeUI").addEventListener("click", async () => {
            if (createFeatureMode) return;

            // Strict Page Name Saved Check BEFORE scraping
            if (!verifyPageNameSavedBeforeScraping()) {
                return;
            }

            const pageNameInput = document.getElementById("pagename_searchbox");
            const pageName = pageNameInput ? pageNameInput.value.trim() : "";

            dtControls = [];
            controlNameLists = [];

        // Always refresh hierarchy before Scrape UI (Android + iOS)
        try {
            const freshSource = await capturePageSource();
            const parser = new DOMParser();
            window.xmlDoc = parser.parseFromString(freshSource, "text/xml");
        } catch (refreshErr) {
            console.warn("Scrape UI page-source refresh failed, using cached xmlDoc:", refreshErr);
        }

        if (!window.xmlDoc) {
            showCustomAlert("Scrape Failed", "No page source available. Launch the app and try again.", "warning");
            return;
        }

        const xmlNodes = window.xmlDoc.getElementsByTagName("*");

        const ignoreSystemTypes = [
            "AppiumAUT",
            "XCUIElementTypeApplication",
            "XCUIElementTypeWindow",
            "hierarchy"
        ];

        for (let i = 0; i < xmlNodes.length; i++) {
            const node = xmlNodes[i];

            // 1. Skip system root elements
            if (ignoreSystemTypes.includes(node.nodeName))
                continue;

            const uiName = typeof getUiNodeName === 'function' ? getUiNodeName(node) : node.nodeName;

            // 2. Filter out invisible or unrendered 0-sized elements
            const nodeRect = parseNodeRect(node);
            if (nodeRect && (nodeRect.width <= 0 || nodeRect.height <= 0)) {
                continue;
            }

            // 3. Keep the same class of nodes iOS scrape keeps: labeled, interactive, or real widgets
            if (typeof isMeaningfulControlNode === 'function' && !isMeaningfulControlNode(node)) {
                continue;
            }

            // 5. Generate clean, professional variable name (e.g., btn_Login)
            let controlName = generateProfessionalControlName(node);

            // 6. Fetch XPaths using updated getAllPossibleXPaths
            let allXPaths = getAllPossibleXPaths(node);

            // Extract input value if it's a text entry field
            let controlValue = getInputControlValue(node);

            // CHECK: Is the node center within a registered feature area?
            let nodeEffectiveFeatureName = "";
            let nodeSmallestAreaFound = Number.MAX_VALUE;
            if (nodeRect) {
                const nodeCenterX = nodeRect.x + nodeRect.width / 2;
                const nodeCenterY = nodeRect.y + nodeRect.height / 2;
                for (const area of registeredFeatureAreas) {
                    const { x, y, width, height } = area.rect;
                    if (nodeCenterX >= x && nodeCenterX <= (x + width) && nodeCenterY >= y && nodeCenterY <= (y + height)) {
                        const rectArea = width * height;
                        if (rectArea < nodeSmallestAreaFound) {
                            nodeSmallestAreaFound = rectArea;
                            nodeEffectiveFeatureName = area.name;
                        }
                    }
                }
            }

            dtControls.push({
                ControlName: controlName,
                ControlType: mapControlType(uiName),
                ControlId: allXPaths,
                ControlValue: controlValue,
                IdentificationType: inferIdentificationType(allXPaths[0]),
                FeatureName: nodeEffectiveFeatureName || pageName,
                Fingerprint: generateNodeFingerprint(node),
                rect: nodeRect
            });
        }

        createAndAppendTable(dtControls);
        dtControls = [];
    });

    document.getElementById("closePreview").addEventListener("click", () => {
        document.getElementById("split-div3").style.display = "none";

        const ss = document.getElementById("ss");
        if (ss) {
            ss.remove();
        }

        document.getElementById("image-container_ss").innerHTML = "";
    });

    const tokenInput = document.getElementById("tokenInput");

    tokenInput.addEventListener("keydown", function (e) {

        if (e.key !== "Enter") return;

        e.preventDefault();

        const encryptedToken = tokenInput.value.trim();
        const tokenStatus = document.getElementById("tokenStatus");

        tokenInput.readOnly = true;

        // Decrypt the pasted token
        const decryptedToken = decryptData(encryptedToken);

        let isValidJson = false;
        let parsedData = null;

        // Strict Evaluation: Prevent passed states on partial block corruption
        if (decryptedToken) {
            try {
                parsedData = JSON.parse(decryptedToken);
                // Verify structural object properties to guarantee total validity
                if (parsedData && (parsedData.userID || parsedData.baseUrl)) {
                    isValidJson = true;
                }
            } catch (e) {
                isValidJson = false;
            }
        }

        console.log("Validation Result:", isValidJson);

        // Inside your tokenInput keydown listener:
                if (isValidJson && parsedData) {
                    // Hide token input, Show connected status & Change button
                    tokenInput.style.setProperty("display", "none", "important");
                    tokenStatus.style.setProperty("display", "block", "important");

                    const changeTokenBtn = document.getElementById("changeTokenBtn");
                    if (changeTokenBtn) changeTokenBtn.style.setProperty("display", "inline-block", "important");

                    tokenStatus.innerHTML = "Connected";
                    tokenStatus.style.backgroundColor = "rgba(22, 163, 74, 0.18)";
                    tokenStatus.style.border = "1px solid rgba(74, 222, 128, 0.45)";
                    tokenStatus.style.color = "#bbf7d0";

                    localStorage.setItem("algoQAUser", JSON.stringify(parsedData));
                    console.log("Saved Data:", localStorage.getItem("algoQAUser"));

                    const runBtn = document.getElementById("Run");

                    // Session Check: If app is already active, lock Launch but restore scraper controls
                    if (driver) {
                        runBtn.disabled = true;
                        runBtn.style.backgroundColor = "#B6B6B4";

                        const featureButtons = ["Scrape", "scrapeUI", "reset", "algoQA"];
                        featureButtons.forEach(btnId => {
                            const btn = document.getElementById(btnId);
                            if (btn) {
                                btn.disabled = false;
                                btn.style.backgroundColor = "#2F8BCC";
                            }
                        });
                    } else {
                        setLaunchEnabled(true);
                    }

                } else {
                    // Clear and fail immediately if token is invalid or tampered with
                    tokenInput.style.setProperty("display", "none", "important");
                    tokenStatus.style.setProperty("display", "block", "important");
                    tokenStatus.innerHTML = "Invalid token";
                    tokenStatus.style.backgroundColor = "rgba(239, 68, 68, 0.18)";
                    tokenStatus.style.border = "1px solid rgba(252, 165, 165, 0.45)";
                    tokenStatus.style.color = "#fecaca";

                    // Hide change button on error
                    const changeTokenBtn = document.getElementById("changeTokenBtn");
                    if (changeTokenBtn) changeTokenBtn.style.setProperty("display", "none", "important");
                    setLaunchEnabled(false);

                    setTimeout(() => {
                        tokenStatus.style.setProperty("display", "none", "important");
                        tokenInput.style.setProperty("display", "inline-block", "important");
                        tokenInput.value = "";
                        tokenInput.readOnly = false;
                        tokenInput.focus();
                    }, 2000);
                }
    });

    document.getElementById("algoQA").addEventListener("click", async () => {
                const userData = JSON.parse(localStorage.getItem("algoQAUser"));
                if (!userData) {
                    showCustomAlert("Authentication Error", "Token data not found. Please paste your token.", "error");
                    return;
                }

                if (!tableCreated || !hasValidTableData('myTable')) {
                    showCustomAlert("Export Failed", "No scraped data found to send.", "error");
                    return;
                }

                if (typeof hiddenRows !== 'undefined' && hiddenRows && hiddenRows.length > 0) {
                    pendingExportAction = "algoQA";
                    showHiddenColumnsWarning();
                } else {
                    await sendTableDataToAPI("myTable");
                }
            });

    async function sendTableDataToAPI(tableId) {
        const userData = JSON.parse(localStorage.getItem("algoQAUser"));
        if (!userData) {
            showCustomAlert("Authentication Error", "Token data not found.", "error");
            return;
        }

        const tableData = extractAllTableData(tableId);

        if (tableData.length === 0) {
            showCustomAlert("Export Failed", "No scraped data found.", "error");
            return;
        }

        // Detect if we are in Record Scenario Mode
        var isRecordMode = window.pageScenarioData && Object.keys(window.pageScenarioData).length > 0;
        var finalDataPayload;

        if (isRecordMode) {
            var scenariosList = [];
            var stepsByPage = {};

            // Group rows (steps) by their PAGE NAME
            tableData.forEach(step => {
                var page = step["PAGE NAME"];
                if (!stepsByPage[page]) stepsByPage[page] = [];
                stepsByPage[page].push(step);
            });

            // Assemble SCENARIOS list mapping steps to their relevant scenario details
            for (var pageName in window.pageScenarioData) {
                var scenarioInfo = window.pageScenarioData[pageName];
                if (scenarioInfo && scenarioInfo.scenarioName) {
                    scenariosList.push({
                        "SCENARIO_NAME": scenarioInfo.scenarioName,
                        "SCENARIO_OUTLINE": scenarioInfo.scenarioOutline || "",
                        "STEPS": stepsByPage[pageName] || []
                    });
                }
            }

            finalDataPayload = {
//                "isRecordscenario": true,
                "dashboardControls": {
                    "APP URL": "",
                    "SCENARIOS": scenariosList
                }
            };
        } else {
            // Fallback to normal behavior
            finalDataPayload = tableData;
        }

        const payload = {
            data: finalDataPayload,
            isRecordscenario: isRecordMode, // Include top-level flag for API handling
            userID: Number(userData.userID),
            baseUrl: userData.baseUrl,
            projectId: userData.project_id,
            launchUrl: userData.launchUrl,
            projectName: userData.project_name,
            applicationTypeId: Number(userData.application_type_id),
            applicationType: "Mobile"
        };

        console.log("Payload:", payload);

        try {
            const endpoint = userData.project_id ? "saveReScraperData" : "MobileAutomationScraperData";
            const response = await fetch(`${userData.baseUrl}/project/${endpoint}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            if (!response.ok) throw new Error("API request failed");

            showCustomAlert("Success!", "Scraped data shared successfully to AlgoQA.", "success");

            if (driver) { try { await driver.quit(); } catch (err) {} }
            // Only shut down iOS simulators on macOS — never run xcrun on Windows
            if (process.platform === 'darwin') {
                const { exec } = require("child_process");
                exec("xcrun simctl shutdown all", () => { ipcRenderer.send("close-app"); });
            } else {
                ipcRenderer.send("close-app");
            }

        } catch (error) {
            console.error("Error sending table data:", error);
            showErrorPopup("Failed to share data to AlgoQA", error);
        }
    }



    //document.getElementById("rotateBtn").addEventListener("click", () => {
    //
    //    const screenshot = document.getElementById("screenshot");
    //
    //    if (!screenshot) return;
    //
    //    rotation += 90;
    //
    //    screenshot.style.transition = "transform 0.3s ease";
    //    screenshot.style.transformOrigin = "center center";
    //    screenshot.style.transform =
    //        `rotate(${rotation}deg)`;
    //
    //});


    document.getElementById("refreshBtn").addEventListener("click", async () => {
                if (refreshInProgress) return;

                // After Reset (or no session): Refresh acts as Launch Application once
                // until the app loads and the first page is shown.
                if (refreshShouldLaunchApp || !driver) {
                    const runBtn = document.getElementById('Run');
                    if (runBtn && !runBtn.disabled) {
                        runBtn.click();
                    } else {
                        showCustomAlert("Cannot Launch", "Please make sure you are authenticated and all application details are filled.", "warning");
                    }
                    return;
                }

                refreshInProgress = true;

                const globalOverlay = document.getElementById("overlay");
            const appRunningPopup = document.getElementById("AppRunningPopup");

            if (globalOverlay) globalOverlay.style.display = "none";
            if (appRunningPopup) appRunningPopup.style.display = "none";

            // Keep the current screenshot visible; loader sits on top (do not blank the phone)
            const existingShot = document.getElementById("screenshot");
            if (existingShot) existingShot.style.display = "block";
            const dummyKeep = document.getElementById("dummyDevice");
            if (dummyKeep && existingShot) dummyKeep.style.display = "none";

            await showLocalDeviceLoader();

            try {
                // Windows Android emulator: queryAppState often false-fails and used to
                // show "Session interrupted". Soft-prep only — never kill the session.
                if (isWindowsAndroid()) {
                    await ensureWindowsAndroidReadyForRefresh();
                } else {
                    await checkAppForegroundState({ revive: false });
                }
                await waitUntilAppScreenReady({ minWait: isAndroidPlatform() ? 800 : 400, retries: 3, gap: 400 });

                const image = await captureDeviceScreenshot();

                require("fs").writeFileSync(
                    `${folderPath}/image0.png`,
                    image,
                    "base64"
                );

                const dummy = document.getElementById("dummyDevice");
                if (dummy) {
                    dummy.style.display = "none";
                }

                let screenshot = document.getElementById("screenshot");

                if (!screenshot) {
                    screenshot = document.createElement("img");
                    screenshot.id = "screenshot";

                    applyScreenshotZoom(screenshot);
                    enableImageDragging(screenshot);

                    screenshot.onmousemove = function (e) {
                        previewElement(e);
                    };

                    screenshot.onmouseleave = function () {
                        showElementHover = false;
                        lastXPath = "";
                        clearTimeout(hoverTimer);
                        clearOverlay();
                    };

                    attachScreenshotInteractionHandlers(screenshot);

                    mountScreenshot(screenshot);
                    imgTagFlag = true;
                }

                screenshot.style.display = "block";
                // Swap image without clearing src first — avoids a black/off screen
                screenshot.src = `${folderPath}/image0.png?t=${Date.now()}`;

                await new Promise(resolve => {
                    screenshot.onload = resolve;
                    screenshot.onerror = resolve;
                });
                adjustDevicePreviewSize(screenshot);
                applyScreenshotZoom(screenshot);

                const pageSource = await capturePageSource();
                const parser = new DOMParser();
                window.xmlDoc = parser.parseFromString(pageSource, "text/xml");

                document.getElementById('scrapeUI').disabled = false;
                document.getElementById('scrapeUI').style.backgroundColor = '#2F8BCC';

                document.getElementById('reset').disabled = false;
                document.getElementById('reset').style.backgroundColor = '#2F8BCC';

                document.getElementById('algoQA').disabled = false;
                document.getElementById('algoQA').style.backgroundColor = '#2F8BCC';

                document.getElementById('download').disabled = false;
                document.getElementById('download').style.backgroundColor = '#2F8BCC';

                document.getElementById('recordScenarioBtn').disabled = false;
                document.getElementById('recordScenarioBtn').style.backgroundColor = '#2F8BCC';

                document.getElementById('createFeatureBtn').disabled = false;
                document.getElementById('createFeatureBtn').style.backgroundColor = '#2F8BCC';

                const addScenarioBtnRefresh = document.getElementById('addScenarioBtn');
                if (addScenarioBtnRefresh) {
                    addScenarioBtnRefresh.disabled = false;
                    addScenarioBtnRefresh.style.backgroundColor = '#2F8BCC';
                }

                tableCreated = true;

                clearOverlay();

                zoomLevel = 1;
                screenshot.style.objectFit = "unset";
                applyScreenshotZoom(screenshot);
                // Windows: re-fit after layout so the phone is not clipped mid-frame
                if (process.platform === 'win32') {
                    requestAnimationFrame(() => applyScreenshotZoom(screenshot));
                }

            } catch (err) {
                // Windows Android: keep session alive unless the driver is truly dead
                if (isWindowsAndroid() && driver && !isDeadSessionError(err)) {
                    console.error("Refresh Error:", err);
                    const msg = err && err.message ? err.message.split('\n')[0].substring(0, 180) : String(err).substring(0, 180);
                    showCustomAlert("Refresh failed", msg, "warning");
                } else {
                    handleDeviceCommandError(err, "Refresh Error:");
                }

            } finally {
                hideLocalDeviceLoader();
                refreshInProgress = false;
            }
        });

    document.getElementById("zoomInBtn").addEventListener("click", () => {
        const screenshot = document.getElementById("screenshot");
        if (!screenshot) return;

        // Zoom in step (25% increments, capped at 300% / 3.0x)
        const nextZoom = Math.min(3.0, Math.round((zoomLevel + 0.25) * 100) / 100);
        if (nextZoom === zoomLevel) return;
        zoomLevel = nextZoom;
        applyScreenshotZoom(screenshot);
    });

    document.getElementById("zoomOutBtn").addEventListener("click", () => {
        const screenshot = document.getElementById("screenshot");
        if (!screenshot) return;

        // Zoom out step: cannot go below normal state 1.0 (100%)
        if (zoomLevel <= 1.0) {
            zoomLevel = 1.0;
            applyScreenshotZoom(screenshot);
            return;
        }

        const nextZoom = Math.max(1.0, Math.round((zoomLevel - 0.25) * 100) / 100);
        zoomLevel = nextZoom;
        applyScreenshotZoom(screenshot);
    });

    document.getElementById("resetZoomBtn").addEventListener("click", () => {
        const screenshot = document.getElementById("screenshot");
        if (!screenshot) return;

        zoomLevel = 1.0;
        applyScreenshotZoom(screenshot);
    });

    document.getElementById("tapBtn").addEventListener("click", () => {

        tapMode = true;

        document.getElementById("tapBtn").style.background = "#2F8BCC";
        document.getElementById("tapBtn").style.color = "#fff";

        document.getElementById("touchBtn").style.background = "transparent";
        document.getElementById("touchBtn").style.color = "#333";

    });

    document.getElementById("touchBtn").addEventListener("click", () => {

        tapMode = false;
        clearOverlay();

        // Touch mode and Create Feature cannot run together
        if (createFeatureMode) {
            createFeatureMode = false;
            const createFeatureBtn = document.getElementById("createFeatureBtn");
            if (createFeatureBtn) {
                createFeatureBtn.style.backgroundColor = "#2F8BCC";
                const btnSpan = createFeatureBtn.querySelector("span");
                if (btnSpan) btnSpan.innerText = "Create Feature";
            }
            const scrapeBtn = document.getElementById("Scrape");
            const scrapeUIBtn = document.getElementById("scrapeUI");
            if (scrapeBtn) { scrapeBtn.disabled = false; scrapeBtn.style.backgroundColor = "#2F8BCC"; }
            if (scrapeUIBtn) { scrapeUIBtn.disabled = false; scrapeUIBtn.style.backgroundColor = "#2F8BCC"; }
        }

        document.getElementById("touchBtn").style.background = "#2F8BCC";
        document.getElementById("touchBtn").style.color = "#fff";

        document.getElementById("tapBtn").style.background = "transparent";
        document.getElementById("tapBtn").style.color = "#333";

    });

    function enableImageDragging(img) {

        const container = getScreenViewport();

        img.addEventListener("mousedown", (e) => {

            if (zoomLevel <= 1) {
                return;
            }

            isDragging = true;
            hasDragged = false;

            dragStartX = e.clientX;
            dragStartY = e.clientY;

            scrollStartLeft = container.scrollLeft;
            scrollStartTop = container.scrollTop;

            img.style.cursor = "grabbing";

            e.preventDefault();

        });

        document.addEventListener("mousemove", (e) => {

            if (!isDragging)
                return;

            hasDragged = true;

            container.scrollLeft =
                scrollStartLeft -
                (e.clientX - dragStartX);

            container.scrollTop =
                scrollStartTop -
                (e.clientY - dragStartY);

        });

        document.addEventListener("mouseup", () => {

            if (!isDragging) return;

            isDragging = false;

            img.style.cursor =
                zoomLevel > 1 ? "grab" : "default";

            setTimeout(() => {
                hasDragged = false;
            }, 50);

        });

    }


    const changeTokenBtn = document.getElementById("changeTokenBtn");

        changeTokenBtn.addEventListener("click", () => {
            const tokenInput = document.getElementById("tokenInput");

            // Remove saved token payload
            localStorage.removeItem("algoQAUser");

            // Restore token input field
            tokenInput.value = "";
            tokenInput.style.setProperty("display", "inline-block", "important");
            tokenInput.disabled = false;
            tokenInput.readOnly = false;
            tokenInput.removeAttribute("disabled");
            tokenInput.removeAttribute("readonly");

            // Strictly hide the change button and connected status
            changeTokenBtn.style.setProperty("display", "none", "important");
            document.getElementById("tokenStatus").style.setProperty("display", "none", "important");

            // Lock down dependent feature buttons until re-authenticated
            const lockButtons = ["Run", "Scrape", "scrapeUI", "reset", "algoQA"];
            lockButtons.forEach(btnId => {
                const btn = document.getElementById(btnId);
                if (btn) {
                    btn.disabled = true;
                    btn.style.backgroundColor = "#B6B6B4";
                }
            });

            // Explicitly guarantee that download actions bypass this freeze block completely
            const downloadBtn = document.getElementById("download");
            if (downloadBtn && tableCreated) {
                downloadBtn.disabled = false;
                downloadBtn.style.backgroundColor = "#2F8BCC";
            }

            tokenInput.focus();
        });





   //Xpath Generation
   function generateUniqueXPath(node) {
           if (!node || node.nodeType !== 1) return "";

           const stopNodes = ["AppiumAUT", "XCUIElementTypeApplication", "hierarchy", "XCUIElementTypeWindow"];
           if (stopNodes.includes(node.nodeName)) {
               return `//${node.nodeName}`;
           }

           // --- STRATEGY 1: Global Unique Attribute Match ---
           // CHANGED: Removed "name" from this array to match the logic above
           const attributes = ["label", "resource-id", "content-desc", "text", "value"];

           for (let attr of attributes) {
               let val = node.getAttribute(attr);
               if (val && val.trim() !== "") {
                   val = val.trim().replace(/"/g, '\\"'); // Escape quotes safely
                   let baseXpath = `//${node.nodeName}[@${attr}="${val}"]`;

                   if (isXPathUnique(baseXpath)) {
                       return baseXpath;
                   }
               }
           }

           // --- STRATEGY 2: Find the Closest Unique Ancestor ---
           // Instead of using global indices like (//Tag)[35], find a unique parent and build a relative path
           let ancestor = node.parentNode;
           let ancestorPath = "";

           while (ancestor && ancestor.nodeType === 1 && !stopNodes.includes(ancestor.nodeName)) {
               for (let attr of attributes) {
                   let val = ancestor.getAttribute(attr);
                   if (val && val.trim() !== "") {
                       val = val.trim().replace(/"/g, '\\"');
                       let testAncestorXpath = `//${ancestor.nodeName}[@${attr}="${val}"]`;

                       if (isXPathUnique(testAncestorXpath)) {
                           ancestorPath = testAncestorXpath;
                           break;
                       }
                   }
               }
               if (ancestorPath) break;
               ancestor = ancestor.parentNode;
           }

           // If we found a unique container parent, pinpoint our element inside it
           if (ancestorPath) {
               let relativeXpath = `${ancestorPath}//${node.nodeName}`;

               // Check if it's unique inside that container
               if (isXPathUnique(relativeXpath)) {
                   return relativeXpath;
               }

               // If duplicates exist inside the unique container, index just within this scope
               let results = window.xmlDoc.evaluate(relativeXpath, window.xmlDoc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
               for (let i = 0; i < results.snapshotLength; i++) {
                   if (results.snapshotItem(i) === node) {
                       return `(${relativeXpath})[${i + 1}]`;
                   }
               }
           }

           // --- STRATEGY 3: Local Index Relative to Immediate Parent ---
           // If no unique text or container is found, fall back to structural tag placement: Parent/Child[Index]
           let parent = node.parentNode;
           if (parent && parent.nodeType === 1 && !stopNodes.includes(parent.nodeName)) {
               let siblings = parent.childNodes;
               let sameTagIndex = 0;
               let matchIndex = 1;

               for (let i = 0; i < siblings.length; i++) {
                   if (siblings[i].nodeType === 1 && siblings[i].nodeName === node.nodeName) {
                       sameTagIndex++;
                       if (siblings[i] === node) {
                           matchIndex = sameTagIndex;
                       }
                   }
               }

               // Recursively build path for the parent structure
               let parentXpath = generateUniqueXPath(parent);
               return `${parentXpath}/${node.nodeName}[${matchIndex}]`;
           }

           // --- STRATEGY 4: Absolute Global Fallback ---
           let fallbackXpath = `//${node.nodeName}`;
           let globalResults = window.xmlDoc.evaluate(fallbackXpath, window.xmlDoc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
           for (let i = 0; i < globalResults.snapshotLength; i++) {
               if (globalResults.snapshotItem(i) === node) {
                   return `(${fallbackXpath})[${i + 1}]`;
               }
           }

           return fallbackXpath;
       }

    // Helper utility to check absolute uniqueness of a generated path string
    function isXPathUnique(xpath) {
        try {
            let results = window.xmlDoc.evaluate(xpath, window.xmlDoc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            return results.snapshotLength === 1;
        } catch (e) {
            return false;
        }
    }



// Get All Possible XPaths
function getAllPossibleXPaths(node) {
    if (!node || node.nodeType !== 1) return [];

    let candidates = [];
    const tagName = node.nodeName;

    if (tagName === "AppiumAUT" || tagName === "XCUIElementTypeApplication" || tagName === "XCUIElementTypeWindow" || tagName === "hierarchy") {
        return [`//${tagName}`];
    }

    // 1. Calculate Coordinate (COMMENTED OUT)
    /*
    let x = parseFloat(node.getAttribute("x"));
    let y = parseFloat(node.getAttribute("y"));
    let width = parseFloat(node.getAttribute("width"));
    let height = parseFloat(node.getAttribute("height"));

    let coordXPath = null;
    if (!isNaN(x) && !isNaN(y) && !isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
        let centerX = Math.round(x + (width / 2));
        let centerY = Math.round(y + (height / 2));
        coordXPath = `COORDINATE(${centerX},${centerY})`;
    }
    */

    const isGeneric = (tagName === "XCUIElementTypeOther" || tagName === "Other" || tagName === "android.view.View" || tagName === "XCUIElementTypeCell");

    // Prefer strongest / most specific locators first so Identification Type is not always AccessibilityId
    const isAndroidNode = (typeof isAndroidPlatform === "function" && isAndroidPlatform()) || tagName.startsWith("android.");
    const attributes = isAndroidNode
        ? ["resource-id", "id", "text", "content-desc", "hint"]
        : ["name", "label", "value", "id"];

    for (let attr of attributes) {
        let val = node.getAttribute(attr);
        if (val && val.trim() !== "") {
            let cleanVal = val.trim().replace(/"/g, '');
            let xpath = `//${tagName}[@${attr}="${cleanVal}"]`;
            if (!candidates.includes(xpath)) {
                candidates.push(xpath);
            }
        }
    }

    // 2b. If generic tag has NO direct attributes, resolve via nearest labeled Parent Context
    if (candidates.length === 0 && isGeneric) {
        let ancestor = node.parentNode;
        let ancestorXpath = "";

        while (ancestor && ancestor.nodeType === 1 && !["XCUIElementTypeApplication", "hierarchy", "AppiumAUT"].includes(ancestor.nodeName)) {
            for (let attr of attributes) {
                let parentVal = ancestor.getAttribute(attr);
                if (parentVal && parentVal.trim() !== "") {
                    let cleanParentVal = parentVal.trim().replace(/"/g, '');
                    ancestorXpath = `//${ancestor.nodeName}[@${attr}="${cleanParentVal}"]`;
                    break;
                }
            }
            if (ancestorXpath) break;
            ancestor = ancestor.parentNode;
        }

        if (ancestorXpath) {
            let relativePath = `${ancestorXpath}//${tagName}`;
            let scopedResults = window.xmlDoc.evaluate(relativePath, window.xmlDoc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < scopedResults.snapshotLength; i++) {
                if (scopedResults.snapshotItem(i) === node) {
                    candidates.push(`(${relativePath})[${i + 1}]`);
                    break;
                }
            }
        }
    }

    // 3. Process index fallback if not generic, OR if generic has no parent attributes found
    if (!isGeneric || candidates.length === 0) {
        let fallbackXpath = `//${tagName}`;
        let globalResults = window.xmlDoc.evaluate(fallbackXpath, window.xmlDoc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < globalResults.snapshotLength; i++) {
            if (globalResults.snapshotItem(i) === node) {
                let indexedXpath = `(${fallbackXpath})[${i + 1}]`;
                if (!candidates.includes(indexedXpath)) {
                    candidates.push(indexedXpath);
                }
                break;
            }
        }
    }

    // 4. Ensure coordinates are always in the list (COMMENTED OUT)
    /*
    if (coordXPath && !candidates.includes(coordXPath)) {
        if (isGeneric) {
            // For "Other" elements, prioritize the Coordinate at the top of the dropdown
            candidates.unshift(coordXPath);
        } else {
            // For standard buttons/text, put Coordinate at the bottom
            candidates.push(coordXPath);
        }
    }
    */

    return candidates.length > 0 ? candidates : [`(${tagName})[1]`];
}




// --- GLOBAL PAGE NAME VALIDATOR ---
function isGlobalPageNameValid(name) {
    if (!name || name.trim() === '') return false; // Empty is invalid

    // 1. Minimum 3 Characters Check
    if (name.trim().length < 3) return false;

    // NEW: Reserve "All" so it cannot be used as a real scraped page name
    if (name.trim().toLowerCase() === 'all') return false;

    const format = /[!@#$%^&*()+\-=\[\]{};':"\\|,.<>\/?]+/;
    const onlySpecialCharsRegex = /^[!@#$%^&*(),.?":{}|<>]*$/;

    if (format.test(name) || /^\d+$/.test(name) || name.includes("  ") || name.startsWith(" ") || name.endsWith(" ") || onlySpecialCharsRegex.test(name)) {
        return false;
    }
    return true;
}

function syncRegisteredPageNames() {
    if (!window.registeredPageNames) window.registeredPageNames = new Set();
    // REMOVED the .clear() command so we don't wipe out empty pages!

    // 1. Sync from existing table rows
    const tableBody = document.getElementById('myTable');
    if (tableBody) {
        const pageCells = tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row) .page');
        pageCells.forEach(cell => {
            const val = cell.innerText.trim();
            if (val && val !== "All") window.registeredPageNames.add(val);
        });
    }

    // 2. Sync from Scenario Data memory (keeps empty pages alive if they have scenario data)
    if (window.pageScenarioData) {
        Object.keys(window.pageScenarioData).forEach(p => {
            if (p && p !== "All") window.registeredPageNames.add(p);
        });
    }
}

function handleInvalidPageNameAttempt() {
    const pageNameInput = document.getElementById('pagename_searchbox');
    if (pageNameInput) {
        pageNameInput.style.borderColor = "#dc3545"; // Red
        pageNameInput.focus();
    }
    if (typeof flashPageNameError === "function") flashPageNameError(); // Flashes the badge red

    // NEW: Updated alert text to mention "All" is reserved
    showCustomAlert("Invalid Page Name", "Please enter a valid Page Name. It must be at least 3 characters, can accept alphanumeric characters, a single space between words, and must start with an alphabet.", "warning");
}

function verifyPageNameSavedBeforeScraping() {
    if (typeof window.isPageNameReadyForScraping === 'function') {
        const check = window.isPageNameReadyForScraping();
        if (!check.valid) {
            const pageNameInput = document.getElementById('pagename_searchbox');
            if (pageNameInput) {
                pageNameInput.focus();
            }
            if (typeof flashPageNameError === "function") flashPageNameError();

            if (check.reason === "unsaved") {
                showCustomAlert(
                    "Save Page Name",
                    "Please save the Page Name (click the green checkmark) before scraping.",
                    "warning"
                );
            } else if (check.reason === "empty") {
                showCustomAlert(
                    "Page Name Required",
                    "Please enter and save a Page Name before scraping.",
                    "warning"
                );
            } else if (check.reason === "all_reserved") {
                showCustomAlert(
                    "Action Restricted",
                    "Cannot scrape while viewing 'All' pages. Please select or create a specific Page Name first.",
                    "warning"
                );
            } else {
                handleInvalidPageNameAttempt();
            }
            return false;
        }
        return true;
    }

    const pageNameInput = document.getElementById('pagename_searchbox');
    const pageName = pageNameInput ? pageNameInput.value.trim() : "";
    if (!isGlobalPageNameValid(pageName)) {
        handleInvalidPageNameAttempt();
        return false;
    }
    return true;
}

    //finding xpath (works for both iOS and Android page source)
// ===========================================================================
// [SCRAPE] Tap-to-select (misnamed findIOSLocator — used for Android + iOS)
// Finds smallest node under click coords via parseNodeRect; builds locators;
// falls back to COORDINATE(x,y) when no XML node matches.
// ===========================================================================
    async function findIOSLocator(clickX, clickY) {
        if (!verifyPageNameSavedBeforeScraping()) {
            return;
        }

        const pageNameInput = document.getElementById("pagename_searchbox");
        const pageName = pageNameInput ? pageNameInput.value.trim() : "";

            // CHECK: Is the click within a registered feature area?
            let effectiveFeatureName = "";
            let smallestAreaFound = Number.MAX_VALUE;

            for (const area of registeredFeatureAreas) {
                const { x, y, width, height } = area.rect;
                if (clickX >= x && clickX <= (x + width) && clickY >= y && clickY <= (y + height)) {
                    const rectArea = width * height;
                    if (rectArea < smallestAreaFound) {
                        smallestAreaFound = rectArea;
                        effectiveFeatureName = area.name;
                    }
                }
            }

            const nodes = window.xmlDoc.getElementsByTagName("*");
            let matchedNode = null;
            let smallestArea = Number.MAX_VALUE;
            let bestScore = -1;

            const rootTypes = [
                "AppiumAUT",
                "XCUIElementTypeApplication",
                "XCUIElementTypeWindow",
                "hierarchy"
            ];

            function getElementScore(node) {
                const tag = typeof getUiNodeName === 'function' ? getUiNodeName(node) : node.nodeName;
                if (tag.includes("Button") || tag.includes("TextField") || tag.includes("EditText") || tag.includes("SearchField") || tag.includes("StaticText") || tag.includes("TextView")) {
                    return 10;
                }
                if (tag.includes("Image") || tag.includes("Icon") || tag.includes("ImageView")) {
                    return 8;
                }
                if (tag.includes("CheckBox") || tag.includes("Switch") || tag.includes("RadioButton") || tag.includes("Toggle")) {
                    return 7;
                }
                if (tag.includes("Cell")) {
                    return 5;
                }
                if (tag.includes("Other") || tag.includes("View") || tag.includes("Layout")) {
                    const hasText = node.getAttribute("label") || node.getAttribute("name") || node.getAttribute("value") || node.getAttribute("content-desc") || node.getAttribute("text");
                    return hasText ? 4 : 2;
                }
                return 1;
            }

            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];

                if (rootTypes.includes(node.nodeName)) {
                    continue;
                }

                const rect = parseNodeRect(node);
                if (!rect || rect.width <= 0 || rect.height <= 0) {
                    continue;
                }

                const { x, y, width, height } = rect;

                if (clickX >= x && clickX <= (x + width) && clickY >= y && clickY <= (y + height)) {

                    const area = width * height;
                    const score = getElementScore(node);

                    if (area < smallestArea) {
                        smallestArea = area;
                        bestScore = score;
                        matchedNode = node;
                    } else if (area === smallestArea) {
                        if (score > bestScore) {
                            bestScore = score;
                            matchedNode = node;
                        }
                    }
                }
            }

            if (!matchedNode) {
                createAndAppendTable([
                    {
                        ControlName: `coord_${Math.round(clickX)}_${Math.round(clickY)}`,
                        ControlType: "Coordinate",
                        ControlId: [`COORDINATE(${Math.round(clickX)},${Math.round(clickY)})`],
                        IdentificationType: "Coordinate",
                        FeatureName: effectiveFeatureName || pageName,
                        rect: { x: Math.round(clickX), y: Math.round(clickY), width: 1, height: 1 }
                    }
                ]);
                return;
            }

            // 1. Generate Clean Variable Name & Type normally
                        let controlName = generateProfessionalControlName(matchedNode);
                        let controlType = mapControlType(typeof getUiNodeName === 'function' ? getUiNodeName(matchedNode) : matchedNode.nodeName);

                        // 2. Fetch XPaths
                        let allXPaths = getAllPossibleXPaths(matchedNode);

                        // NEW: Extract the input value if the element is a text/search field
                        let controlValue = getInputControlValue(matchedNode);
                        let nodeRect = parseNodeRect(matchedNode);

                        createAndAppendTable([
                            {
                                ControlName: controlName,
                                ControlType: controlType,
                                ControlId: allXPaths,
                                ControlValue: controlValue, // Added this to pass the value
                                IdentificationType: inferIdentificationType(allXPaths[0]),
                                FeatureName: effectiveFeatureName || pageName,
                                Fingerprint: generateNodeFingerprint(matchedNode),
                                rect: nodeRect
                            }
                        ]);
                    }

    async function handleFeatureClick(clickX, clickY, options = {}) {
        if (!window.xmlDoc) return;

        if (!verifyPageNameSavedBeforeScraping()) {
            return;
        }

        const preferFullPage = !!(options && options.preferFullPage);
        const matched = resolveFeatureTargetAt(clickX, clickY, preferFullPage);

        if (!preferFullPage && !matched) {
            showCustomAlert(
                "No Control Selected",
                "Click a visible control to create a feature inside the page.",
                "info"
            );
            return;
        }

        let matchedNode = matched ? matched.node : null;
        let targetRect = matched ? matched.rect : { x: Math.round(clickX), y: Math.round(clickY), width: 1, height: 1 };
        const isFullPage = !!(matched && matched.fullPage) ||
            !!(preferFullPage && targetRect && targetRect.width > 10 && targetRect.height > 10);

        // CHECK: Does this exact area already exist in registeredFeatureAreas?
        if (targetRect) {
            const existing = registeredFeatureAreas.find(area =>
                area.rect.x === targetRect.x &&
                area.rect.y === targetRect.y &&
                area.rect.width === targetRect.width &&
                area.rect.height === targetRect.height
            );

            if (existing) {
                showCustomAlert("Feature Already Registered", `This section is already mapped to feature: <b>${existing.name}</b>`, "info");
                return;
            }
        }

        if (!matchedNode || isFullPage) {
            pendingFeatureData = {
                ControlName: isFullPage ? "page_FullScreen" : `coord_${Math.round(clickX)}_${Math.round(clickY)}`,
                ControlType: isFullPage ? "Page" : "Coordinate",
                ControlId: isFullPage
                    ? [`//XCUIElementTypeApplication`, `//hierarchy`]
                    : [`COORDINATE(${Math.round(clickX)},${Math.round(clickY)})`],
                IdentificationType: isFullPage ? "XPath" : "Coordinate",
                rect: targetRect,
                fullPage: !!isFullPage
            };
        } else {
            pendingFeatureData = {
                ControlName: generateProfessionalControlName(matchedNode),
                ControlType: mapControlType(matchedNode.nodeName),
                ControlId: getAllPossibleXPaths(matchedNode),
                ControlValue: getInputControlValue(matchedNode),
                Fingerprint: generateNodeFingerprint(matchedNode),
                rect: targetRect,
                fullPage: false
            };
        }

        const modal = document.getElementById("createFeatureModal");
        const overlay = document.getElementById("overlay");
        const featureNameInputOnOpen = document.getElementById("feature_name_input");
        if (featureNameInputOnOpen) {
            featureNameInputOnOpen.value = "";
            featureNameInputOnOpen.classList.remove("input-error-border");
            const errIcon = document.getElementById("feature_name_error_icon");
            if (errIcon) errIcon.style.display = "none";
        }
        if (modal) modal.style.display = "block";
        if (overlay) overlay.style.display = "block";
        if (featureNameInputOnOpen) {
            setTimeout(() => featureNameInputOnOpen.focus(), 50);
        }
    }

    function syncExistingRowsWithNewFeature(area) {
        const tableBody = document.getElementById('myTable');
        if (!tableBody || !area || !area.rect) return;

        const { x: ax, y: ay, width: aw, height: ah } = area.rect;
        const allRows = tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)');

        allRows.forEach(row => {
            const rectStr = row.dataset.rect;
            if (!rectStr) return;

            try {
                const rect = JSON.parse(rectStr);
                if (!rect) return;

                // Calculate center point of the element
                const centerX = rect.x + rect.width / 2;
                const centerY = rect.y + rect.height / 2;

                // Check if center point is within the new feature area
                if (centerX >= ax && centerX <= (ax + aw) && centerY >= ay && centerY <= (ay + ah)) {
                    const featureNameCell = row.querySelector('.featureName');
                    if (featureNameCell) {
                        featureNameCell.innerText = area.name;
                    }
                }
            } catch (e) {
                console.error("Sync: Failed to parse row rect", e);
            }
        });
    }

    //Add Rows number
        function updateRowNumbers() {
            const rows = document.querySelectorAll("#myTable tr");
            let visibleIndex = 1; // Start counting from 1 for the filtered view

            rows.forEach((row) => {
                // Only skip the "No Results" search error row
                if (row.classList.contains("no-results-row")) {
                    return;
                }

                // Assign a sequence number to ALL visible rows (Data + Empty Placeholders)
                if (!row.classList.contains("page-hidden") && !row.classList.contains("search-hidden")) {
                    const indexCell = row.querySelector(".row-index");
                    if (indexCell) {
                        indexCell.textContent = visibleIndex++;
                    }
                }
            });
        }

    // Helper to count custom columns added by user
    function getCustomColsCount() {
        var headerRow = document.querySelector('#mainTable thead tr');
        return headerRow ? headerRow.querySelectorAll('.custom-editable-header').length : 0;
    }



    function createEmptyRowHtml() {
            var allHeaders = Array.from(document.querySelectorAll('#mainTable thead tr > *'));
            var rowHtml = "";

            allHeaders.forEach((th) => {
                var thText = (th.textContent || th.innerText || '').replace('Delete Column', '').replace('Add Column', '').trim().toUpperCase();
                var isHidden = window.getComputedStyle(th).display === 'none';
                var displayStyle = isHidden ? 'display: none !important;' : '';

                if (th.classList.contains('excel-header-corner')) {
                    rowHtml += `<td class="row-index" style="${displayStyle}"></td>`;
                } else if (th.id === 'add_empty_column') {
                    rowHtml += `<td class="add-col-cell" style="${displayStyle}">&nbsp;</td>`;
                } else if (th.classList.contains('custom-editable-header')) {
                    rowHtml += `<td contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">&nbsp;</td>`;
                } else if (thText.includes('CONTROL TYPE')) {
                    rowHtml += `<td class="ct pt-3-half" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">&nbsp;</td>`;
                } else if (thText.includes('CONTROL ID')) {
                    rowHtml += `<td class="xpath pt-3-half" style="border-color: black; text-align: center; ${displayStyle}"></td>`;
                } else if (thText.includes('APP URL') || th.id === 'appUrl') {
                    rowHtml += `<td class="appUrl" style="display:none;"></td>`;
                } else if (th.classList.contains('fingerprint')) {
                    rowHtml += `<td class="fingerprint" style="display:none;"></td>`;
                } else if (thText.includes('DELETE') || th.innerText.includes('Delete') || th.id === 'delete_header') {
                    // Completely empty cell for placeholder rows so no icons or checkboxes ever appear
                    rowHtml += `<td class="delete-cell" style="border-color:black; ${displayStyle}"></td>`;
                } else {
                    rowHtml += `<td class="cn pt-3-half" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}"></td>`;
                }
            });
            return rowHtml;
        }

        function adjustEmptyRows() {
            const container = document.getElementById('table-container');
            const tbody = document.getElementById('myTable');

            // Prevent execution if the container is hidden or layout hasn't rendered yet
            if (!container || !tbody || container.style.display === "none" || container.clientHeight === 0) return;

            const headerRow = document.querySelector('#mainTable thead tr');
            const headerHeight = headerRow ? headerRow.getBoundingClientRect().height : 32;
            const sampleRow = tbody.querySelector('tr');
            const measuredRowH = sampleRow ? sampleRow.getBoundingClientRect().height : 0;
            // Prefer measured row height so empty rows fill #table-container with no grey gap
            const rowHeight = measuredRowH > 0 ? measuredRowH : 28;

            // Shared on Windows + macOS: grow with the table pane (capped for safety)
            const MAX_VISIBLE_ROWS = 50;
            const availableHeight = Math.max(0, container.clientHeight - headerHeight);
            let targetRowCount = Math.max(1, Math.ceil(availableHeight / Math.max(rowHeight, 1)));
            targetRowCount = Math.min(MAX_VISIBLE_ROWS, Math.max(1, targetRowCount));

            let currentRows = Array.from(tbody.querySelectorAll('tr'));
                let emptyRows = Array.from(tbody.querySelectorAll('tr.empty-excel-row'));

                // Count ONLY the data rows that are currently VISIBLE on the active page
                let dataRowCount = 0;
                currentRows.forEach(row => {
                    if (!row.classList.contains('empty-excel-row') &&
                        !row.classList.contains('no-results-row') &&
                        row.style.display !== 'none') {
                        dataRowCount++;
                    }
                });

                let desiredEmptyRows = targetRowCount - dataRowCount;
                if (desiredEmptyRows < 0) desiredEmptyRows = 0;

            if (emptyRows.length < desiredEmptyRows) {
                // Fill missing space with blank rows
                const rowsToAdd = desiredEmptyRows - emptyRows.length;
                for (let i = 0; i < rowsToAdd; i++) {
                    const row = document.createElement('tr');
                    row.className = "empty-excel-row";
                    row.innerHTML = createEmptyRowHtml();
                    tbody.appendChild(row);
                }
                updateRowNumbers();
                initResizableTable();
            } else if (emptyRows.length > desiredEmptyRows) {
                // Trim excess blank rows if window shrinks
                const rowsToRemove = emptyRows.length - desiredEmptyRows;
                for(let i = 0; i < rowsToRemove; i++) {
                    if(emptyRows[emptyRows.length - 1 - i]) {
                        emptyRows[emptyRows.length - 1 - i].remove();
                    }
                }
                updateRowNumbers();
            }
            if (typeof applyColumnVisibility === 'function') applyColumnVisibility();
        }

        function renderDefaultExcelGrid() {
            const tbody = document.getElementById('myTable');
            if (tbody) tbody.innerHTML = ''; // Wipe existing rows

            // Automatically inject the precise number of rows needed
            adjustEmptyRows();
        }

        // Initialize and track window resizing automatically
        window.addEventListener("DOMContentLoaded", () => {
            document.getElementById('table-container').style.display = "block";
            renderDefaultExcelGrid();
            initResizableTable();
            applyPagination();
            initCustomizeColumnsDropdown();
            applyColumnVisibility();
        });

        window.addEventListener('resize', () => {
            requestAnimationFrame(() => {
                adjustEmptyRows();
                const ss = document.getElementById('screenshot');
                if (ss && ss.style.display !== 'none') {
                    adjustDevicePreviewSize(ss);
                    applyScreenshotZoom(ss);
                }
            });
        });

    // Function to delete a custom column by index across headers and body rows
    function deleteCustomColumn(colIndex) {
        var table = document.getElementById('mainTable');
        if (!table) return;

        // Remove the TH header at colIndex
        var headerRow = table.querySelector('thead tr');
        if (headerRow && headerRow.cells[colIndex]) {
            headerRow.cells[colIndex].remove();
        }

        // Remove matching TD in all body rows
        var bodyRows = table.querySelectorAll('tbody tr');
        bodyRows.forEach(row => {
            if (row.cells[colIndex]) {
                row.cells[colIndex].remove();
            }
        });
    }









// --- CUSTOMIZE TABLE COLUMNS SYSTEM ---
const TABLE_COL_CONFIG = [
    { key: 'number', label: '# (Number)', selector: 'th.excel-header-corner', locked: true },
    { key: 'control_name', label: 'Control Name', selector: 'th[id*="cn"]', locked: true },
    { key: 'control_type', label: 'Control Type', selector: 'th[id*="ct"]', locked: true },
    { key: 'control_id', label: 'Control ID', selector: 'th[id*="xpath"]', locked: false },
    { key: 'page_name', label: 'Page Name', selector: 'th[id*="page"]', locked: true },
    { key: 'identification_type', label: 'Identification Type', selector: 'th[id*="identificationType"]', locked: false },
    { key: 'control_value', label: 'Control Value', selector: 'th[id*="controlValue"]', locked: false },
    { key: 'feature_name', label: 'Feature Name', selector: 'th[id*="featureName"]', locked: false },
    { key: 'node_name', label: 'Node Name', selector: 'th.nodeName, th[id*="nodeName"]', locked: false },
    { key: 'delete', label: 'Delete', selector: 'th#delete_header', locked: true }
];

function getColumnVisibilityState() {
    try {
        const saved = localStorage.getItem('algo_column_visibility');
        if (saved) return JSON.parse(saved);
    } catch (e) {}
    const state = {};
    TABLE_COL_CONFIG.forEach(col => { state[col.key] = true; });
    return state;
}

function saveColumnVisibilityState(state) {
    try {
        localStorage.setItem('algo_column_visibility', JSON.stringify(state));
    } catch (e) {}
}

function applyColumnVisibility() {
    const table = document.getElementById('mainTable');
    if (!table) return;
    const headerRow = table.querySelector('thead tr');
    if (!headerRow) return;

    const state = getColumnVisibilityState();

    TABLE_COL_CONFIG.forEach(col => {
        const isVisible = col.locked ? true : (state[col.key] !== false);
        const th = headerRow.querySelector(col.selector);
        if (!th) return;

        const colIndex = Array.from(headerRow.children).indexOf(th);
        if (colIndex === -1) return;

        if (isVisible) {
            th.style.removeProperty('display');
        } else {
            th.style.setProperty('display', 'none', 'important');
        }

        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
            const cell = row.children[colIndex];
            if (cell) {
                if (isVisible) {
                    cell.style.removeProperty('display');
                } else {
                    cell.style.setProperty('display', 'none', 'important');
                }
            }
        });
    });

    if (typeof initResizableTable === 'function') initResizableTable();
}

function updateCustomizeColumnsCounter() {
    const counter = document.getElementById('customizeColumnsCounter');
    if (!counter) return;
    const state = getColumnVisibilityState();
    let visibleCount = 0;
    TABLE_COL_CONFIG.forEach(col => {
        if (col.locked || state[col.key] !== false) {
            visibleCount++;
        }
    });
    counter.textContent = `${visibleCount}/${TABLE_COL_CONFIG.length}`;
}

function renderCustomizeColumnsMenu() {
    const listContainer = document.getElementById('customizeColumnsList');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    const state = getColumnVisibilityState();
    updateCustomizeColumnsCounter();

    TABLE_COL_CONFIG.forEach(col => {
        const isChecked = col.locked ? true : (state[col.key] !== false);

        const item = document.createElement('div');
        item.className = `customize-col-item ${isChecked ? 'is-checked' : ''} ${col.locked ? 'is-locked' : ''}`;

        const leftWrap = document.createElement('div');
        leftWrap.className = 'customize-col-label-wrap';

        // Custom styled modern checkbox box
        const checkCustom = document.createElement('span');
        checkCustom.className = 'customize-col-checkbox-box';
        checkCustom.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        `;

        const labelSpan = document.createElement('span');
        labelSpan.className = 'customize-col-text';
        labelSpan.innerText = col.label;

        leftWrap.appendChild(checkCustom);
        leftWrap.appendChild(labelSpan);
        item.appendChild(leftWrap);

        if (col.locked) {
            const badge = document.createElement('span');
            badge.className = 'customize-col-badge';
            badge.innerHTML = `
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
                Fixed
            `;
            item.appendChild(badge);
        } else {
            item.addEventListener('click', () => {
                const curState = getColumnVisibilityState();
                const willBeChecked = !(curState[col.key] !== false);
                curState[col.key] = willBeChecked;
                saveColumnVisibilityState(curState);
                item.classList.toggle('is-checked', willBeChecked);
                applyColumnVisibility();
                updateCustomizeColumnsCounter();
            });
        }

        listContainer.appendChild(item);
    });
}

function initCustomizeColumnsDropdown() {
    const btn = document.getElementById('customizeColumnsBtn');
    const dropdown = document.getElementById('customizeColumnsDropdown');
    const wrapper = btn ? btn.closest('.toolWrapper') : null;
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.style.display !== 'none';
        if (!isOpen) {
            renderCustomizeColumnsMenu();
            dropdown.style.display = 'block';
            if (wrapper) wrapper.classList.add('is-open');
        } else {
            dropdown.style.display = 'none';
            if (wrapper) wrapper.classList.remove('is-open');
        }
    });

    document.addEventListener('click', (e) => {
        if (dropdown && !dropdown.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
            dropdown.style.display = 'none';
            if (wrapper) wrapper.classList.remove('is-open');
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dropdown) {
            dropdown.style.display = 'none';
            if (wrapper) wrapper.classList.remove('is-open');
        }
    });
}

// --- COLUMN HIDING / UNHIDING STATE MANAGEMENT ---
let hiddenColumns = [];

function updateEyeButtonState() {
    const eyeBtn = document.getElementById("unhide_col_btn");
    const unhideMenu = document.getElementById("unhide_col_menu");

    if (!eyeBtn || !unhideMenu) return;

    if (hiddenColumns.length > 0) {
        eyeBtn.disabled = false;
        eyeBtn.classList.add("active");

        unhideMenu.innerHTML = "";
        hiddenColumns.forEach((col, arrIdx) => {
            const item = document.createElement("div");
            item.className = "unhide-item";
            item.innerText = `Unhide: ${col.name}`;
            item.addEventListener("click", (e) => {
                e.stopPropagation();
                unhideColumn(arrIdx);
            });
            unhideMenu.appendChild(item);
        });
    } else {
        eyeBtn.disabled = true;
        eyeBtn.classList.remove("active");
        unhideMenu.classList.remove("show");
        unhideMenu.innerHTML = "";
    }
}

//function hideColumn(colIndex) {
//    const table = document.getElementById("mainTable");
//    if (!table) return;
//
//    const headerRow = table.querySelector("thead tr");
//    if (!headerRow || !headerRow.cells[colIndex]) return;
//
//    const th = headerRow.cells[colIndex];
//    let colName = th.querySelector("span")?.innerText.trim() || th.innerText.trim();
//    colName = colName.replace("Delete Column", "").replace("Add Column", "").trim();
//
//    if (!colName || colName === "") {
//        if (th.classList.contains("excel-header-corner")) {
//            colName = "# (Index)";
//        } else if (th.id === "add_empty_column") {
//            colName = "+ (Add Column)";
//        } else {
//            colName = "Column " + (colIndex + 1);
//        }
//    }
//
//    th.style.setProperty("display", "none", "important");
//    const bodyRows = table.querySelectorAll("tbody tr");
//    bodyRows.forEach(row => {
//        if (row.cells[colIndex]) {
//            row.cells[colIndex].style.setProperty("display", "none", "important");
//        }
//    });
//
//    hiddenColumns.push({ index: colIndex, name: colName });
//    updateEyeButtonState();
//}
//
//function unhideColumn(arrayIndex) {
//    const colInfo = hiddenColumns[arrayIndex];
//    if (!colInfo) return;
//
//    const table = document.getElementById("mainTable");
//    if (!table) return;
//
//    const headerRow = table.querySelector("thead tr");
//    if (headerRow && headerRow.cells[colInfo.index]) {
//        headerRow.cells[colInfo.index].style.display = "";
//    }
//
//    const bodyRows = table.querySelectorAll("tbody tr");
//    bodyRows.forEach(row => {
//        if (row.cells[colInfo.index]) {
//            row.cells[colInfo.index].style.display = "";
//        }
//    });
//
//    hiddenColumns.splice(arrayIndex, 1);
//    updateEyeButtonState();
//}

// --- ROW HIDING / UNHIDING STATE MANAGEMENT ---
let hiddenRows = []; // Stores the physical row elements

function updateRowEyeButtonState() {
    const eyeBtn = document.getElementById("unhide_row_btn");
    const unhideMenu = document.getElementById("unhide_row_menu");

    if (!eyeBtn || !unhideMenu) return;

    if (hiddenRows.length > 0) {
        eyeBtn.disabled = false;
        eyeBtn.classList.add("active");

        unhideMenu.innerHTML = "";
        hiddenRows.forEach((rowObj, arrIdx) => {
            const item = document.createElement("div");
            item.className = "unhide-item";
            item.innerText = `Unhide: ${rowObj.label}`;
            item.addEventListener("click", (e) => {
                e.stopPropagation();
                unhideRow(arrIdx);
            });
            unhideMenu.appendChild(item);
        });
    } else {
        eyeBtn.disabled = true;
        eyeBtn.classList.remove("active");
        unhideMenu.classList.remove("show");
        unhideMenu.innerHTML = "";
    }
}

//function hideRow(rowIndexElem, trElement) {
//    let rowNum = rowIndexElem.innerText.trim();
//    let controlNameInput = trElement.querySelector('.cn');
//    let label = (controlNameInput && controlNameInput.innerText.trim() !== "")
//        ? `Row ${rowNum} (${controlNameInput.innerText.trim()})`
//        : `Row ${rowNum}`;
//
//    trElement.style.setProperty("display", "none", "important");
//    hiddenRows.push({ rowElement: trElement, label: label });
//    updateRowEyeButtonState();
//}
//
//function unhideRow(arrayIndex) {
//    const rowObj = hiddenRows[arrayIndex];
//    if (!rowObj || !rowObj.rowElement) return;
//
//    rowObj.rowElement.style.display = "";
//    hiddenRows.splice(arrayIndex, 1);
//    updateRowEyeButtonState();
//}

// --- RIGHT-CLICK CONTEXT MENU EVENT LISTENERS ---
//let selectedColIndexToHide = null;
//let selectedRowToHide = null;
//
//document.addEventListener("DOMContentLoaded", () => {
//    const mainTable = document.getElementById("mainTable");
//
//    // Column Menu Variables
//    const colContextMenu = document.getElementById("colContextMenu");
//    const hideColOption = document.getElementById("hideColOption");
//    const colEyeBtn = document.getElementById("unhide_col_btn");
//    const unhideColMenu = document.getElementById("unhide_col_menu");
//
//    // Row Menu Variables
//    const rowContextMenu = document.getElementById("rowContextMenu");
//    const hideRowOption = document.getElementById("hideRowOption");
//    const rowEyeBtn = document.getElementById("unhide_row_btn");
//    const unhideRowMenu = document.getElementById("unhide_row_menu");
//
//    if (mainTable) {
//        // Right-Click Context Menu on HEADERS (Columns)
//        mainTable.querySelector("thead").addEventListener("contextmenu", (e) => {
//            const th = e.target.closest("th");
//            if (!th) return;
//
//            e.preventDefault();
//            selectedColIndexToHide = th.cellIndex;
//
//            if (colContextMenu) {
//                const menuWidth = 140;
//                const posX = (e.clientX + menuWidth > window.innerWidth) ? e.clientX - menuWidth : e.clientX;
//                colContextMenu.style.left = `${posX}px`;
//                colContextMenu.style.top = `${e.clientY}px`;
//                colContextMenu.style.display = "block";
//                if (rowContextMenu) rowContextMenu.style.display = "none";
//            }
//        });
//
//        // Right-Click Context Menu on ROW INDEX (Rows)
//        mainTable.querySelector("tbody").addEventListener("contextmenu", (e) => {
//            const td = e.target.closest("td.row-index");
//            if (!td) return; // Only trigger if right-clicking the grey '#' index column
//
//            e.preventDefault();
//            const tr = td.closest("tr");
//            selectedRowToHide = { td: td, tr: tr };
//
//            if (rowContextMenu) {
//                const menuWidth = 140;
//                const posX = (e.clientX + menuWidth > window.innerWidth) ? e.clientX - menuWidth : e.clientX;
//                rowContextMenu.style.left = `${posX}px`;
//                rowContextMenu.style.top = `${e.clientY}px`;
//                rowContextMenu.style.display = "block";
//                if (colContextMenu) colContextMenu.style.display = "none";
//            }
//        });
//    }
//
//    // Hide Column Action
//    if (hideColOption) {
//        hideColOption.addEventListener("click", () => {
//            if (selectedColIndexToHide !== null) {
//                hideColumn(selectedColIndexToHide);
//                selectedColIndexToHide = null;
//            }
//            if (colContextMenu) colContextMenu.style.display = "none";
//        });
//    }
//
//    // Hide Row Action
//    if (hideRowOption) {
//        hideRowOption.addEventListener("click", () => {
//            if (selectedRowToHide !== null) {
//                hideRow(selectedRowToHide.td, selectedRowToHide.tr);
//                selectedRowToHide = null;
//            }
//            if (rowContextMenu) rowContextMenu.style.display = "none";
//        });
//    }
//
//    // Toggle Column Eye Dropdown
//    if (colEyeBtn && unhideColMenu) {
//        colEyeBtn.addEventListener("click", (e) => {
//            e.stopPropagation();
//            if (unhideRowMenu) unhideRowMenu.classList.remove("show"); // Close row menu
//            if (hiddenColumns.length > 0) {
//                unhideColMenu.classList.toggle("show");
//            }
//        });
//    }
//
//    // Toggle Row Eye Dropdown
//    if (rowEyeBtn && unhideRowMenu) {
//        rowEyeBtn.addEventListener("click", (e) => {
//            e.stopPropagation();
//            if (unhideColMenu) unhideColMenu.classList.remove("show"); // Close col menu
//            if (hiddenRows.length > 0) {
//                unhideRowMenu.classList.toggle("show");
//            }
//        });
//    }
//
//    // Dismiss Menus on Outside Click
//    document.addEventListener("click", (e) => {
//        if (colContextMenu) colContextMenu.style.display = "none";
//        if (rowContextMenu) rowContextMenu.style.display = "none";
//
//        if (unhideColMenu && !unhideColMenu.contains(e.target) && e.target !== colEyeBtn) {
//            unhideColMenu.classList.remove("show");
//        }
//        if (unhideRowMenu && !unhideRowMenu.contains(e.target) && e.target !== rowEyeBtn) {
//            unhideRowMenu.classList.remove("show");
//        }
//    });
//});

// 3. Warning Prompt Helper
    function showHiddenColumnsWarning() {
            const popup = document.getElementById('confirmationPopup');
            if (!popup) return;

            showConfirmDialog({
                title: "Export Warning",
                mainText: "Warning: Rows or Columns are hidden!",
                subText: "Hidden data will not be included in your export.",
                theme: "warning"
                // pendingExportAction already set by caller (download / algoQA)
            });
        }

    // 4. Clean Unified "Okay" Button Handler
    const okayBtn = document.getElementById("okay_btn");
    const newOkayBtn = okayBtn.cloneNode(true);
    okayBtn.parentNode.replaceChild(newOkayBtn, okayBtn);

    const extraBtn = document.getElementById("extra_btn");
    const newExtraBtn = extraBtn.cloneNode(true);
    extraBtn.parentNode.replaceChild(newExtraBtn, extraBtn);

   //popup extra button (for sub-feature)
   newExtraBtn.addEventListener('click', async () => {
        document.getElementById('confirmationPopup').style.display = 'none';
        document.getElementById('overlay').style.display = 'none';

        if (pendingExportAction === "renameFeature" && pendingFeatureRename) {
            const { newName, cellElement } = pendingFeatureRename;

            // Sub-feature: Update ONLY the current cell
            cellElement.innerText = newName;

            // Register this specific area as a new feature
            const tr = cellElement.closest('tr');
            if (tr && tr.dataset.rect) {
                try {
                    const rect = JSON.parse(tr.dataset.rect);
                    if (rect) {
                        const newArea = {
                            rect: rect,
                            name: newName
                        };
                        registeredFeatureAreas.push(newArea);
                        syncExistingRowsWithNewFeature(newArea);
                    }
                } catch (e) {
                    console.error("Failed to parse row rect for sub-feature registration:", e);
                }
            }
        }

        pendingFeatureRename = null;
        pendingExportAction = null;
   });

   //popup okay button
   newOkayBtn.addEventListener('click', async () => {
           document.getElementById('confirmationPopup').style.display = 'none';
           document.getElementById('overlay').style.display = 'none';

           // Reset popup text and buttons back to default generic state
           setTimeout(() => {
               const popup = document.getElementById('confirmationPopup');
               if (popup) {
                   document.getElementById('popup_title').innerText = "Confirm Action";
                   document.getElementById('popup_main_text').innerText = "";
                   document.getElementById('popup_sub_text').innerText = "";

                   // Restore buttons for next time
                   document.getElementById('back_btn').style.display = 'inline-block';
                   document.getElementById('okay_btn').innerText = 'Confirm';
               }
           }, 200);

           if (pendingExportAction === "alertOnly") {
               pendingExportAction = null;

               // YAHAN HATEGA LOADER USER KE OKAY CLICK PAR
               hideLocalDeviceLoader();
               touchInProgress = false;

               if (pendingFeatureRename && pendingFeatureRename.cellElement) {
                   pendingFeatureRename.cellElement.innerText = pendingFeatureRename.oldName;
               }
               pendingFeatureRename = null;

               return;
           } else if (pendingExportAction === "renameFeature" || pendingExportAction === "createNewFeature") {
               const currentAction = pendingExportAction;
               pendingExportAction = null;

               if (pendingFeatureRename) {
                   const { oldName, newName, cellElement } = pendingFeatureRename;

                   if (currentAction === "renameFeature") {
                        // Complete Rename: Update all matching cells in the table
                        const allFeatureCells = document.querySelectorAll("#myTable .featureName");
                        allFeatureCells.forEach(cell => {
                            if (cell.innerText.trim() === oldName) {
                                cell.innerText = newName;
                            }
                        });

                        // Update internal registered storage (rename existing entry)
                        registeredFeatureAreas.forEach(area => {
                            if (area.name === oldName) {
                                area.name = newName;
                            }
                        });
                   } else if (currentAction === "createNewFeature") {
                        // Create New: Update ONLY the current cell and register area
                        cellElement.innerText = newName;

                        const tr = cellElement.closest('tr');
                        if (tr && tr.dataset.rect) {
                            try {
                                const rect = JSON.parse(tr.dataset.rect);
                                if (rect) {
                                    const newArea = {
                                        rect: rect,
                                        name: newName
                                    };
                                    registeredFeatureAreas.push(newArea);
                                    syncExistingRowsWithNewFeature(newArea);
                                }
                            } catch (e) {
                                console.error("Failed to parse row rect for new feature registration:", e);
                            }
                        }
                   }
               }
               pendingFeatureRename = null;

           } else if (pendingExportAction === "download") {
               pendingExportAction = null;
               downloadTableAsJSON('myTable');

           } else if (pendingExportAction === "algoQA") {
               pendingExportAction = null;
               await sendTableDataToAPI("myTable");

           } else if (pendingExportAction === "deleteRow") {
               pendingExportAction = null;

               // Row deletion no longer automatically deletes the page name or switches views
               if (rowToDelete) {
                   rowToDelete.remove();
                   rowToDelete = null;

                   updateRowNumbers();
                   applyPagination();

                   const tbody = document.getElementById('myTable');
                   if (tbody && tbody.querySelectorAll('tr').length < 5) adjustEmptyRows();
               }

           // --- MULTI-DELETE LOGIC ---
           } else if (pendingExportAction === "bulkDelete") {
               pendingExportAction = null;

               // Bulk deletion no longer automatically deletes the page name or switches views
               if (window.pendingBulkDeleteRows && window.pendingBulkDeleteRows.length > 0) {
                   window.pendingBulkDeleteRows.forEach(row => row.remove());
                   window.pendingBulkDeleteRows = null;

                   const headerCheckbox = document.getElementById('selectAllCheckbox');
                   if (headerCheckbox) headerCheckbox.checked = false;

                   updateRowNumbers();
                   applyPagination();

                   const tbody = document.getElementById('myTable');
                   if (tbody && tbody.querySelectorAll('tr').length < 5) adjustEmptyRows();

                   const toggleMultiDeleteOpt = document.getElementById('toggleMultiDeleteOpt');
                   if (toggleMultiDeleteOpt && isMultiDeleteMode) {
                       toggleMultiDeleteOpt.click();
                   }
               }

           // --- EXPLICIT PAGE DELETE LOGIC ---
           } else if (pendingExportAction === "deletePage") {
               pendingExportAction = null;
               const page = window.pageToDelete;

               if (page) {
                   // 1. Remove the page from the global memory bank
                   if (window.registeredPageNames) {
                       window.registeredPageNames.delete(page);
                   }

                   // Ensure Scenario Outline & Name are wiped from memory completely
                   if (window.pageScenarioData) {
                       delete window.pageScenarioData[page];
                   }

                   // 2. Remove all rows associated with this specific page
                   const tableBody = document.getElementById('myTable');
                   if (tableBody) {
                       const allDataRows = Array.from(tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)'));
                       allDataRows.forEach(row => {
                           const pageCell = row.querySelector('.page');
                           if (pageCell && pageCell.innerText.trim() === page) {
                               row.remove();
                           }
                       });

                       updateRowNumbers();
                       applyPagination();
                       if (typeof adjustEmptyRows === 'function') requestAnimationFrame(adjustEmptyRows);
                   }

                   // 3. Check remaining pages count
                   const pageNameInput = document.getElementById('pagename_searchbox');
                   const remainingPages = window.registeredPageNames ? Array.from(window.registeredPageNames).filter(p => p && p.trim() && p !== 'All') : [];
                   const currentActive = pageNameInput ? pageNameInput.value.trim() : "";

                   const editPenIcon = document.querySelector('.edit-icon');
                   const addPageIcon = document.querySelector('.add-page-icon');
                   const confirmIcon = document.querySelector('.confirm-edit-icon');
                   const cancelIcon = document.querySelector('.cancel-edit-icon');
                   const scenarioOutlineBar = document.getElementById("scenarioOutlineBar");
                   const scenarioOutlineText = document.getElementById("scenarioOutlineText");
                   const recordScenarioBtn = document.getElementById("recordScenarioBtn");
                   const recordScenarioWrapper = document.getElementById('recordScenarioWrapper');
                   const addScenarioBtn = document.getElementById("addScenarioBtn");

                   if (remainingPages.length === 0) {
                       // ZERO pages remain: reset to clean, editable initial state (Create Page / Record Scenario)
                       if (pageNameInput) {
                           pageNameInput.value = "";
                           pageNameInput.placeholder = "Create Page";
                           pageNameInput.removeAttribute('readonly');
                           pageNameInput.readOnly = false;
                           pageNameInput.style.cursor = 'text';
                           pageNameInput.disabled = false;
                       }
                       if (typeof applyPageNameFilter === 'function') applyPageNameFilter("");
                       if (typeof restoreValidBlueState === 'function') restoreValidBlueState();

                       if (editPenIcon) editPenIcon.style.display = 'none';
                       if (confirmIcon) confirmIcon.style.display = 'none';
                       if (cancelIcon) cancelIcon.style.display = 'none';
                       if (addPageIcon) addPageIcon.style.display = 'inline-block';

                       if (scenarioOutlineBar) scenarioOutlineBar.style.display = "none";
                       if (scenarioOutlineText) {
                           scenarioOutlineText.value = "";
                           scenarioOutlineText.placeholder = "Create Scenario";
                       }

                       if (recordScenarioBtn) recordScenarioBtn.style.setProperty("display", "inline-flex", "important");
                       if (recordScenarioWrapper) recordScenarioWrapper.style.setProperty("display", "inline-flex", "important");
                       if (addScenarioBtn) addScenarioBtn.style.setProperty("display", "none", "important");
                   } else if (remainingPages.length === 1) {
                       // EXACTLY ONE page remains: switch directly to that page rather than "All"
                       const singlePage = remainingPages[0];
                       if (window.setGlobalPageName) window.setGlobalPageName(singlePage);
                   } else {
                       // Multiple pages remain: switch to "All" if user deleted active page, otherwise stay on active
                       if (currentActive === page || currentActive === "All" || !currentActive) {
                           if (window.setGlobalPageName) window.setGlobalPageName("All");
                       } else {
                           if (window.setGlobalPageName) window.setGlobalPageName(currentActive);
                       }
                   }

                   // 4. If no scenario data remains in the entire project, hide scenario outline bar & reset to Record Scenario
                   const hasAnyScenario = window.pageScenarioData && Object.values(window.pageScenarioData).some(data => data && data.scenarioOutline);
                   if (!hasAnyScenario) {
                       if (scenarioOutlineBar) scenarioOutlineBar.style.display = "none";
                       if (scenarioOutlineText) scenarioOutlineText.value = "";
                       if (recordScenarioBtn) recordScenarioBtn.style.setProperty("display", "inline-flex", "important");
                       if (recordScenarioWrapper) recordScenarioWrapper.style.setProperty("display", "inline-flex", "important");
                       if (addScenarioBtn) addScenarioBtn.style.setProperty("display", "none", "important");
                   }

                   window.pageToDelete = null;
               }

            // --- CONFIRM RECORD SCENARIO (CLEAR ALL PAGES & START FRESH) ---
            } else if (pendingExportAction === "confirmRecordScenarioClear") {
                pendingExportAction = null;
                if (typeof window.clearAllPagesAndScrapedDataForNewScenario === 'function') {
                    window.clearAllPagesAndScrapedDataForNewScenario();
                }
                if (typeof window.openScenarioModalDirectly === 'function') {
                    window.openScenarioModalDirectly("RECORD");
                }

           // --- GENERAL RESET LOGIC ---
           } else if (pendingExportAction === "reset") {
               pendingExportAction = null;
               await executeResetAction();
           } else {
               pendingExportAction = null;
           }
       });




    const backBtn = document.getElementById("back_btn");
    const newBackBtn = backBtn.cloneNode(true);
    backBtn.parentNode.replaceChild(newBackBtn, backBtn);

    newBackBtn.addEventListener('click', () => {
        document.getElementById('overlay').style.display = 'none';
        document.getElementById('confirmationPopup').style.display = 'none';

        if ((pendingExportAction === "renameFeature" || pendingExportAction === "createNewFeature") && pendingFeatureRename) {
            pendingFeatureRename.cellElement.innerText = pendingFeatureRename.oldName;
        }
        pendingFeatureRename = null;
        pendingExportAction = null;

        const popup = document.getElementById('confirmationPopup');
        if (popup) {
            popup.querySelector('p:nth-of-type(1)').textContent = "Do you really want to reset?";
            popup.querySelector('p:nth-of-type(2)').textContent = "You will not be able to recover the data!";
        }
    });

    // Encapsulated Reset Function
    // Reset session + form lock (keeps table shell, clears rows) — see applyPostResetUI()
    function executeResetAction() {
            try {


                // 1. Safely hide status bars and errors
                const statusBar = document.getElementById('sttus_bar_div');
                if (statusBar) statusBar.style.display = 'none';

                const brokenText = document.getElementById('brokenText');
                if (brokenText) brokenText.style.display = 'none';

                // 2. Clear application state variables
                counter = 0;
                initialData = [];
                xpath_id = 0;
                screenNameList = [];
                showElement = false;
                zoomLevel = 1;
                refreshShouldLaunchApp = true;

                const dyingDriver = driver;
                driver = null;

                // 3. Clear existing screenshots
                const imgElement = document.getElementById('screenshot');
                if (imgElement) imgElement.remove();

                // 4. Restore idle phone preview message
                showDummyDeviceMessage({
                    theme: 'info',
                    title: getIdleDummyTitle()
                });

                imgTagFlag = false;
                const ssElement = document.getElementById('ss');
                if (ssElement) ssElement.remove();
                ssflag = false;

                const splitDiv3 = document.getElementById("split-div3");
                if (splitDiv3) splitDiv3.style.display = "none";

                const previewContainer = document.getElementById("image-container_ss");
                if (previewContainer) previewContainer.innerHTML = "";

                // 5. Clear TABLE DATA only — keep table + auto empty rows visible
                const tbody = document.getElementById('myTable');
                if (tbody) {
                    Array.from(tbody.querySelectorAll('tr')).forEach((row) => {
                        if (!row.classList.contains('empty-excel-row')) {
                            row.remove();
                        }
                    });
                }
                if (typeof renderDefaultExcelGrid === 'function') {
                    renderDefaultExcelGrid();
                } else if (typeof adjustEmptyRows === 'function') {
                    adjustEmptyRows();
                }
                if (typeof updateRowNumbers === 'function') updateRowNumbers();
                if (typeof applyPagination === 'function') {
                    currentPage = 1;
                    applyPagination();
                }

                const tableContainer = document.getElementById('table-container');
                if (tableContainer) tableContainer.style.display = "block";
                tableCreated = false;

                // Hide Scenario Outline + clear scenario memory so Download/Send
                // after Reset returns to normal scrape JSON (not record-scenario shape)
                window.pageScenarioData = {};
                window.registeredPageNames = new Set();

                const scenarioOutlineBar = document.getElementById("scenarioOutlineBar");
                const scenarioOutlineText = document.getElementById("scenarioOutlineText");

                if (scenarioOutlineBar) {
                    scenarioOutlineBar.style.display = "none";
                }

                if (scenarioOutlineText) {
                    scenarioOutlineText.value = "";
                }

                // 6. HELPER: Safely delete old screenshots without crashing the app
                function safelyDeletePngs(dirPath) {
                    if (!dirPath || !fs.existsSync(dirPath)) return;
                    fs.readdir(dirPath, (err, files) => {
                        if (err) return;
                        files.forEach(file => {
                            const filePath = path.join(dirPath, file);
                            if (path.extname(filePath) === '.png') {
                                fs.unlink(filePath, e => {});
                            }
                        });
                    });
                }

                safelyDeletePngs(folderPath);

                // 7. Reset Input Fields (page/search only — keep platform/app/device values)
                const pageNameSearch = document.getElementById('pagename_searchbox');
                if (pageNameSearch) pageNameSearch.value = '';

                const searchBox = document.getElementById('searchbox');
                if (searchBox) searchBox.value = '';

                if (typeof window.resetConfirmedPageNameUI === 'function') {
                    window.resetConfirmedPageNameUI();
                }

                // 8. Lock UI immediately: Launch + top 3 fields only
                applyPostResetUI();

                // Quit session in background (driver already cleared so Refresh launches fresh)
                (async () => {
                    const platform = typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : 'Android';
                    const udid = document.getElementById('udid')?.value;
                    const packageName = document.getElementById('apppackage')?.value;
                    const bundleId = document.getElementById('bundleID')?.value;
                    const session = dyingDriver;

                    try {
                        if (session) {
                            try {
                                if (platform === 'Android' && packageName) {
                                    await session.executeScript("mobile: terminateApp", { appId: packageName });
                                } else if (bundleId) {
                                    await session.executeScript("mobile: terminateApp", { bundleId: bundleId });
                                }
                            } catch (termErr) {
                                console.log("terminateApp skipped:", termErr.message);
                            }
                            try {
                                await session.quit();
                            } catch (quitErr) {
                                console.log("driver.quit skipped:", quitErr.message);
                            }
                        }
                    } catch (e) {
                        console.log("Session cleanup error:", e);
                    }

                    if (platform === 'Android' && packageName) {
                        const cmd = udid
                            ? `adb -s ${udid} shell am force-stop ${packageName}`
                            : `adb shell am force-stop ${packageName}`;
                        exec(cmd, () => {});
                    }
                })();

                // Make sure token session and Change button remain visually intact
                const tokenInput = document.getElementById("tokenInput");
                if (tokenInput && localStorage.getItem("algoQAUser")) {
                    const changeTokenBtn = document.getElementById("changeTokenBtn");
                    if (changeTokenBtn) changeTokenBtn.style.setProperty("display", "inline-block", "important");
                }

                // 9. Reset Pagination State
                currentPage = 1;
                const rppSelect = document.getElementById('rows_per_page');
                if (rppSelect) {
                    rppSelect.value = '25';
                }

            } catch (err) {
                // Log any unexpected errors instead of completely freezing the UI
                console.error("Reset encountered an error, but was caught safely:", err);
            }
        }




// Get Professional control name (Android + iOS attributes)
function generateProfessionalControlName(node) {
    if (!node) return "unknown_control";

    // 1. Prefer visible labels / text — include iOS `name` (common on XCUI nodes)
    let rawName = node.getAttribute("label") ||
                  node.getAttribute("name") ||
                  node.getAttribute("text") ||
                  node.getAttribute("value") ||
                  node.getAttribute("content-desc") ||
                  "";

    if (!rawName.trim()) {
        let resId = node.getAttribute("resource-id");
        if (resId && resId.includes('/')) {
            rawName = resId.split('/')[1];
        }
    }

    rawName = rawName.trim();

    // 2. Identify UI Type for Prefix (COMMENTED OUT)
    /*
    let prefix = "elm_";
    const tag = node.nodeName.toLowerCase();

    if (tag.includes("button")) prefix = "btn_";
    else if (tag.includes("textfield") || tag.includes("edittext") || tag.includes("searchfield") || tag.includes("input")) prefix = "txt_";
    else if (tag.includes("image") || tag.includes("icon")) prefix = "img_";
    else if (tag.includes("statictext") || tag.includes("textview") || tag.includes("label")) prefix = "lbl_";
    else if (tag.includes("checkbox") || tag.includes("toggle") || tag.includes("switch") || tag.includes("radio")) prefix = "chk_";
    else if (tag.includes("cell")) prefix = "cell_";
    */

    // 3. Fallback if no readable text
    if (!rawName) {
        let cleanTag = (typeof getUiNodeName === 'function' ? getUiNodeName(node) : node.nodeName)
            .replace("XCUIElementType", "")
            .replace("android.widget.", "")
            .replace("android.view.", "");

        // return `${prefix}${cleanTag}`; // COMMENTED OUT
        return cleanTag;
    }

    // 4. Smart Sanitize and Format
    // Remove special characters but keep spaces to detect word boundaries
    let cleanText = rawName.replace(/[^a-zA-Z0-9 ]/g, "").trim();

    // Split the text into an array of words
    let words = cleanText.split(/\s+/).filter(w => w.length > 0);

    // Keep only the first 3 meaningful words so the name doesn't get infinitely long
    let selectedWords = words.slice(0, 3);

    // Join the words with underscores
    let cleanName = selectedWords.join("_");

    // Failsafe: If someone has an incredibly long single word without spaces, cap it safely
    if (cleanName.length > 40) {
        cleanName = cleanName.substring(0, 40).replace(/_+$/, ""); // Cap and remove trailing underscores if any
    }

    // Prevent starting with a number
    if (/^\d/.test(cleanName)) {
        cleanName = "num_" + cleanName;
    }

    // return `${prefix}${cleanName}`; // COMMENTED OUT
    return cleanName;
}


function displayScreenshotError(err) {
    // Safely extract just the first line of the error message
    let readableError = "An unknown error occurred while communicating with the device.";
    if (err && err.message) {
        readableError = err.message.split('\n')[0].substring(0, 150);
    } else if (typeof err === 'string') {
        readableError = err.substring(0, 150);
    }

    const screenshotImg = document.getElementById("screenshot");
    if (screenshotImg) screenshotImg.style.display = "none";

    // Always rebuild placeholder — Launch loader replaces the original DOM nodes
    showDummyDeviceMessage({
        theme: 'error',
        title: 'Session interrupted. Keep the app open, then click Launch Application to reconnect.',
        detail: readableError
    });

    // --- BUTTON LOGIC ---
    const runBtn = document.getElementById('Run');
    if (runBtn) {
        runBtn.disabled = false;
        runBtn.style.backgroundColor = '#2F8BCC';
    }

    const actionButtons = ['Scrape', 'scrapeUI', 'reset', 'download', 'algoQA', 'recordScenarioBtn', 'createFeatureBtn'];
    actionButtons.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.disabled = true;
            btn.style.backgroundColor = '#B6B6B4';
        }
    });

    try { if (driver) driver.quit(); } catch (_) {}
    driver = null;
    refreshShouldLaunchApp = true;
    unlockLaunchForm();

    document.getElementById('overlay').style.display = 'none';
    hideLocalDeviceLoader();
    const divStatusBar = document.getElementById("div_status_bar");
    if (divStatusBar) divStatusBar.style.display = "none";
}

//Draw line after hover
function drawCoordinateHoverMarker(x, y) {
        clearOverlay();
        const overlay = document.getElementById("overlayContainer");
        const img = document.getElementById("screenshot");
        if (!overlay || !img || !window.xmlDoc) return;

        const { invScaleX: scaleX, invScaleY: scaleY } = getScreenshotScale(img);

        const imgRect = img.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();

        // Calculate absolute position scaled to screen
        const left = imgRect.left - overlayRect.left + (x * scaleX);
        const top = imgRect.top - overlayRect.top + (y * scaleY);

        const box = document.createElement("div");
        box.style.position = "absolute";

        // Create a 20x20 dashed box centered perfectly on the coordinate point
        box.style.left = (left - 10) + "px";
        box.style.top = (top - 10) + "px";
        box.style.width = "20px";
        box.style.height = "20px";
        box.style.border = "2px dashed blue";
        box.style.boxSizing = "border-box";
        box.style.pointerEvents = "none";
        box.style.zIndex = "9999";

        overlay.appendChild(box);
    }


// Draw Arrow after hover for SWIPE actions
function drawSwipeHoverMarker(startX, startY, endX, endY) {
    clearOverlay();
    const overlay = document.getElementById("overlayContainer");
    const img = document.getElementById("screenshot");
    if (!overlay || !img || !window.xmlDoc) return;

    const { invScaleX: scaleX, invScaleY: scaleY } = getScreenshotScale(img);

    const imgRect = img.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();

    // Calculate absolute positions scaled to screen
    const leftOffset = imgRect.left - overlayRect.left;
    const topOffset = imgRect.top - overlayRect.top;

    const sx = leftOffset + (startX * scaleX);
    const sy = topOffset + (startY * scaleY);
    const ex = leftOffset + (endX * scaleX);
    const ey = topOffset + (endY * scaleY);

    // Create SVG Canvas
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.style.position = "absolute";
    svg.style.left = "0px";
    svg.style.top = "0px";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.pointerEvents = "none";
    svg.style.zIndex = "9999";

    // Create arrowhead marker (Updated to Blue)
    const defs = document.createElementNS(svgNS, "defs");
    const marker = document.createElementNS(svgNS, "marker");
    marker.setAttribute("id", "arrowhead");
    marker.setAttribute("markerWidth", "10");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "3.5");
    marker.setAttribute("orient", "auto");

    const polygon = document.createElementNS(svgNS, "polygon");
    polygon.setAttribute("points", "0 0, 10 3.5, 0 7");
    polygon.setAttribute("fill", "blue"); // Changed from red to blue

    marker.appendChild(polygon);
    defs.appendChild(marker);
    svg.appendChild(defs);

    // Create connecting line (dashed arrow)
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", sx);
    line.setAttribute("y1", sy);
    line.setAttribute("x2", ex);
    line.setAttribute("y2", ey);
    line.setAttribute("stroke", "blue"); // Changed from red to blue
    line.setAttribute("stroke-width", "2"); // Made the line thinner
    line.setAttribute("stroke-dasharray", "5,5"); // Dashed look
    line.setAttribute("marker-end", "url(#arrowhead)");

    // Create start dot
    const startDot = document.createElementNS(svgNS, "circle");
    startDot.setAttribute("cx", sx);
    startDot.setAttribute("cy", sy);
    startDot.setAttribute("r", "4"); // Reduced dot size slightly to match thinner line
    startDot.setAttribute("fill", "blue");

    svg.appendChild(line);
    svg.appendChild(startDot);

    overlay.appendChild(svg);
}


// --- PAGINATION LOGIC ---
let currentPage = 1;
let rowsPerPage = 25;

function applyPagination() {
    const tableBody = document.getElementById('myTable');
    if (!tableBody) return;

    // Get all real data rows (exclude empty placeholder rows & error rows)
    const allDataRows = Array.from(tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)'));

    // Filter out rows hidden by the search feature AND the new page name filter
    const activeRows = allDataRows.filter(row => !row.classList.contains('search-hidden') && !row.classList.contains('page-hidden'));
    const totalRows = activeRows.length;

    const rppSelect = document.getElementById('rows_per_page');
    const rppValue = rppSelect ? rppSelect.value : '25';

    rowsPerPage = rppValue === 'all' ? totalRows : parseInt(rppValue, 10);
    if (isNaN(rowsPerPage) || rowsPerPage <= 0) rowsPerPage = totalRows || 1;

    const totalPages = Math.ceil(totalRows / rowsPerPage) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIndex = (currentPage - 1) * rowsPerPage;
    const endIndex = startIndex + rowsPerPage;

    // Apply the display hiding/showing
    allDataRows.forEach(row => {
        if (row.classList.contains('search-hidden') || row.classList.contains('page-hidden')) {
            row.style.display = 'none'; // Keep hidden by search or page filter
        } else {
            const activeIndex = activeRows.indexOf(row);
            // Show if it falls within current page chunk, otherwise hide
            if (activeIndex >= startIndex && activeIndex < endIndex) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        }
    });

    applyColumnVisibility();
    renderPaginationControls(totalPages);

    // Crucial: Fire your existing empty row recalculator to fill screen gaps
    if (typeof adjustEmptyRows === 'function') requestAnimationFrame(adjustEmptyRows);
}

function renderPaginationControls(totalPages) {
    const container = document.getElementById('pagination_pages');
    if (!container) return;
    container.innerHTML = '';

    // Prev Button
    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-btn';
    prevBtn.setAttribute('aria-label', 'Previous Page');
    prevBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';
    prevBtn.disabled = currentPage === 1;
    prevBtn.onclick = () => { if (currentPage > 1) { currentPage--; applyPagination(); } };
    container.appendChild(prevBtn);

    // Page Numbers Layout
    let pages = [];
    if (totalPages <= 5) {
        for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
        if (currentPage <= 3) {
            pages = [1, 2, 3, 4, '...', totalPages];
        } else if (currentPage >= totalPages - 2) {
            pages = [1, '...', totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
        } else {
            pages = [1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages];
        }
    }

    pages.forEach(p => {
        if (p === '...') {
            const dot = document.createElement('span');
            dot.className = 'page-dots';
            dot.innerText = '...';
            container.appendChild(dot);
        } else {
            const btn = document.createElement('button');
            btn.className = `page-btn ${p === currentPage ? 'active' : ''}`;
            btn.innerText = p;
            btn.onclick = () => { currentPage = p; applyPagination(); };
            container.appendChild(btn);
        }
    });

    // Next Button
    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-btn';
    nextBtn.setAttribute('aria-label', 'Next Page');
    nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.onclick = () => { if (currentPage < totalPages) { currentPage++; applyPagination(); } };
    container.appendChild(nextBtn);
}


// HELPER: Flashes the Page Name badge red for 2 seconds
function flashPageNameError() {
    const badgeWrapper = document.querySelector('.screen-name-badge');
    const badgeLabel = document.querySelector('.badge-label');
    const pageNameInput = document.getElementById('pagename_searchbox');

    if (badgeWrapper && badgeLabel) {
        // 1. Change border and label to Error Red
        badgeWrapper.style.transition = 'all 0.3s ease';
        badgeLabel.style.transition = 'all 0.3s ease';

        badgeWrapper.style.setProperty('border-color', '#dc3545', 'important');
        badgeLabel.style.setProperty('background-color', '#dc3545', 'important');

        if (pageNameInput) pageNameInput.focus(); // Bring cursor back

        // 2. Revert back to original Blue after 2 seconds
        setTimeout(() => {
            badgeWrapper.style.setProperty('border-color', '#2F8BCC', 'important');
            badgeLabel.style.setProperty('background-color', '#2F8BCC', 'important');
        }, 2000);
    }
}

//Page Name lock/unlock logic drop down of page
function initPageNameLogic() {
    const pageNameInput = document.getElementById('pagename_searchbox');
    const addPageIcon = document.querySelector('.add-page-icon');
    const editPenIcon = document.querySelector('.edit-icon');
    const confirmIcon = document.querySelector('.confirm-edit-icon');
    const cancelIcon = document.querySelector('.cancel-edit-icon');
    const errorIconWrapper = document.querySelector('.error-icon-wrapper');
    const dropdownIcon = document.querySelector('.dropdown-icon');
    const dropdownMenu = document.getElementById('pageNameDropdown');
    const badgeWrapper = document.querySelector('.screen-name-badge');
    const badgeLabel = document.querySelector('.badge-label');
    const resetButton = document.getElementById('reset');

    let previousPageName = "";
    let isEditMode = false;
    let isRenameMode = false;
    let renameTarget = "";
    let lastConfirmedPageName = pageNameInput ? pageNameInput.value.trim() : "";

    if (!pageNameInput) return;

    function isValidPageName(name) {
        if (!isGlobalPageNameValid(name)) return false;

        // Duplicate Check (only when creating or renaming)
        if (isEditMode) {
            const trimmedName = name.trim();
            // Sync before check to be absolutely sure
            syncRegisteredPageNames();

            // If renaming, ignore the original name
            if (isRenameMode && trimmedName === renameTarget) return true;

            if (window.registeredPageNames && window.registeredPageNames.has(trimmedName)) return false;
        }

        return true;
    }

    window.isPageNameReadyForScraping = function() {
        if (!pageNameInput) return { valid: false, reason: "empty" };

        const val = pageNameInput.value.trim();

        if (!val) {
            return { valid: false, reason: "empty" };
        }

        if (val.toLowerCase() === "all") {
            return { valid: false, reason: "all_reserved" };
        }

        if (!isGlobalPageNameValid(val)) {
            return { valid: false, reason: "invalid_format" };
        }

        const isConfirmVisible = confirmIcon && confirmIcon.style.display !== 'none' && window.getComputedStyle(confirmIcon).display !== 'none';
        const isCancelVisible = cancelIcon && cancelIcon.style.display !== 'none' && window.getComputedStyle(cancelIcon).display !== 'none';

        if (isEditMode || isRenameMode || isConfirmVisible || isCancelVisible || !pageNameInput.readOnly || lastConfirmedPageName !== val) {
            return { valid: false, reason: "unsaved", pageName: val };
        }

        return { valid: true, pageName: val };
    };

    function restoreValidBlueState() {
        if (badgeWrapper) badgeWrapper.style.setProperty('border-color', '#2F8BCC', 'important');
        if (badgeLabel) badgeLabel.style.setProperty('background-color', '#2F8BCC', 'important');
        if (errorIconWrapper) errorIconWrapper.style.display = 'none';

        if (!isEditMode && dropdownIcon) {
            dropdownIcon.style.display = 'inline-block';
        }
    }

    function applyPageNameFilter(pageName) {
        const tableBody = document.getElementById('myTable');
        if (!tableBody) return;
        const allDataRows = Array.from(tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)'));

        allDataRows.forEach(row => {
            const pageCell = row.querySelector('.page');
            if (pageCell) {
                const cellText = pageCell.innerText.trim();
                if (pageName === "" || pageName === "All" || cellText === pageName) {
                    row.classList.remove('page-hidden');
                } else {
                    row.classList.add('page-hidden');
                }
            }
        });

        currentPage = 1;
        applyPagination();
        updateRowNumbers();
    }

    window.setGlobalPageName = function(name) {
        if (!window.registeredPageNames) window.registeredPageNames = new Set();
        if (name && name !== "All" && isValidPageName(name)) {
            window.registeredPageNames.add(name);
        }
        pageNameInput.value = name;
        lastConfirmedPageName = name;
        applyPageNameFilter(name);

        const scenarioOutlineBar = document.getElementById("scenarioOutlineBar");
        const scenarioOutlineText = document.getElementById("scenarioOutlineText");
        const addScenarioBtn = document.getElementById("addScenarioBtn");
        const recordScenarioBtn = document.getElementById("recordScenarioBtn");
        const soEditIcon = document.getElementById("so_edit_icon");
        const pageEditIcon = document.querySelector(".edit-icon");

        if (name === "All") {
            if (pageEditIcon) pageEditIcon.style.display = 'none';
            if (pageNameInput) {
                pageNameInput.readOnly = true;
                pageNameInput.style.cursor = 'default';
            }

            if (scenarioOutlineBar && scenarioOutlineText) {
                // Check if any scenario data exists in the project
                const hasAnyScenario = window.pageScenarioData && Object.values(window.pageScenarioData).some(data => data && data.scenarioOutline);

                if (hasAnyScenario) {
                    scenarioOutlineBar.style.display = "inline-flex";
                    scenarioOutlineText.value = "All";
                    scenarioOutlineText.readOnly = true;
                    scenarioOutlineText.style.cursor = 'default';

                    const recWrap = document.getElementById('recordScenarioWrapper');
                    if (recordScenarioBtn) recordScenarioBtn.style.setProperty("display", "inline-flex", "important");
                    if (recWrap) recWrap.style.setProperty("display", "inline-flex", "important");
                    if (addScenarioBtn) addScenarioBtn.style.setProperty("display", "none", "important");
                    if (soEditIcon) soEditIcon.style.display = 'none';
                } else {
                    scenarioOutlineBar.style.display = "none";
                }
            }
        } else {
            if (pageEditIcon) pageEditIcon.style.display = 'inline-block';

            if (scenarioOutlineBar && scenarioOutlineText) {
                const recWrap = document.getElementById('recordScenarioWrapper');
                if (window.pageScenarioData && window.pageScenarioData[name] && window.pageScenarioData[name].scenarioOutline) {
                    scenarioOutlineText.value = window.pageScenarioData[name].scenarioOutline;
                    scenarioOutlineBar.style.display = "inline-flex";

                    if (recordScenarioBtn) recordScenarioBtn.style.setProperty("display", "none", "important");
                    if (recWrap) recWrap.style.setProperty("display", "none", "important");
                    if (addScenarioBtn) {
                        addScenarioBtn.style.setProperty("display", "inline-flex", "important");
                        addScenarioBtn.disabled = false;
                        addScenarioBtn.style.backgroundColor = '#2F8BCC';
                    }
                    if (soEditIcon) soEditIcon.style.display = 'inline-block';
                } else {
                    // Hide the bar if no scenario data exists for this specific page
                    scenarioOutlineBar.style.display = "none";
                    scenarioOutlineText.value = "";

                    if (recordScenarioBtn) recordScenarioBtn.style.setProperty("display", "inline-flex", "important");
                    if (recWrap) recWrap.style.setProperty("display", "inline-flex", "important");
                    if (addScenarioBtn) addScenarioBtn.style.setProperty("display", "none", "important");
                    if (soEditIcon) soEditIcon.style.display = 'inline-block';
                }
            }
        }
    };

    // --- MODERN DROPDOWN HOVER LOGIC ---
        if (dropdownIcon && dropdownMenu) {
            let pageDropdownTimer; // Timer to hold the delay

            // 1. Show on Hover (Icon)
            dropdownIcon.addEventListener('mouseenter', function(e) {
                clearTimeout(pageDropdownTimer); // Stop it from closing if returning
                if (isEditMode) return;

                if (!window.registeredPageNames) window.registeredPageNames = new Set();
                const currentActivePage = pageNameInput.value.trim();
                if (currentActivePage && isValidPageName(currentActivePage) && currentActivePage !== "All") {
                    window.registeredPageNames.add(currentActivePage);
                }

                const uniquePages = new Set(window.registeredPageNames);
                const tableBody = document.getElementById('myTable');
                if (tableBody) {
                    const pageCells = tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row) .page');
                    pageCells.forEach(cell => {
                        const val = cell.innerText.trim();
                        if(val) uniquePages.add(val);
                    });
                }

                if (uniquePages.size === 0) {
                    dropdownMenu.style.display = 'none';
                    return;
                }

                dropdownMenu.innerHTML = '';

                // Render "All"
                if (uniquePages.size > 1) {
                    const allItem = document.createElement('div');
                    allItem.innerText = "All";
                    allItem.style.padding = '7px 10px';
                    allItem.style.margin = '2px 0';
                    allItem.style.borderRadius = '6px';
                    allItem.style.cursor = 'pointer';
                    allItem.style.fontSize = '12px';
                    allItem.style.textAlign = 'left';
                    allItem.style.transition = 'background-color 0.15s ease';

                    if (currentActivePage === "All" || currentActivePage === "") {
                        allItem.style.color = '#2F8BCC';
                        allItem.style.fontWeight = '600';
                        allItem.style.backgroundColor = '#eff6ff';
                    } else {
                        allItem.style.color = '#334155';
                        allItem.style.fontWeight = '500';
                        allItem.style.backgroundColor = 'transparent';
                    }

                    allItem.addEventListener('mouseover', () => {
                        if (currentActivePage !== "All" && currentActivePage !== "") allItem.style.backgroundColor = '#f1f5f9';
                    });
                    allItem.addEventListener('mouseout', () => {
                        allItem.style.backgroundColor = (currentActivePage === "All" || currentActivePage === "") ? '#eff6ff' : 'transparent';
                    });

                    allItem.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        window.setGlobalPageName("All");
                        dropdownMenu.style.display = 'none';

                        pageNameInput.readOnly = true;
                        pageNameInput.style.cursor = 'default';
                        isEditMode = false;
                        restoreValidBlueState();

                        if (confirmIcon) confirmIcon.style.display = 'none';
                        if (cancelIcon) cancelIcon.style.display = 'none';
                        if (addPageIcon) addPageIcon.style.display = 'inline-block';
                        if (dropdownIcon) dropdownIcon.style.display = 'inline-block';
                        if (editPenIcon) editPenIcon.style.display = 'none';
                    });
                    dropdownMenu.appendChild(allItem);
                }

                // Render Page Options
                uniquePages.forEach(page => {
                    const item = document.createElement('div');
                    item.style.display = 'flex';
                    item.style.justifyContent = 'space-between';
                    item.style.alignItems = 'center';
                    item.style.padding = '7px 10px';
                    item.style.margin = '2px 0';
                    item.style.borderRadius = '6px';
                    item.style.cursor = 'pointer';
                    item.style.fontSize = '12px';
                    item.style.textAlign = 'left';
                    item.style.transition = 'background-color 0.15s ease';

                    const textSpan = document.createElement('span');
                    textSpan.innerText = page;

                    if (currentActivePage === page) {
                        item.style.color = '#2F8BCC';
                        item.style.fontWeight = '600';
                        item.style.backgroundColor = '#eff6ff';
                    } else {
                        item.style.color = '#334155';
                        item.style.fontWeight = '500';
                        item.style.backgroundColor = 'transparent';
                    }

                    item.addEventListener('mouseover', () => {
                        if (currentActivePage !== page) item.style.backgroundColor = '#f1f5f9';
                    });
                    item.addEventListener('mouseout', () => {
                        item.style.backgroundColor = (currentActivePage === page) ? '#eff6ff' : 'transparent';
                    });

                    item.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        window.setGlobalPageName(page);
                        dropdownMenu.style.display = 'none';

                        pageNameInput.readOnly = true;
                        pageNameInput.style.cursor = 'default';
                        isEditMode = false;
                        restoreValidBlueState();

                        if (confirmIcon) confirmIcon.style.display = 'none';
                        if (cancelIcon) cancelIcon.style.display = 'none';
                        if (addPageIcon) addPageIcon.style.display = 'inline-block';
                        if (dropdownIcon) dropdownIcon.style.display = 'inline-block';
                        if (editPenIcon) editPenIcon.style.display = 'inline-block';
                    });

                    // Trash Icon
                    const delIcon = document.createElement('div');
                    delIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px; color: #ef4444; transition: transform 0.15s ease;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
                    delIcon.style.padding = '4px';
                    delIcon.style.marginRight = '-2px';
                    delIcon.style.borderRadius = '4px';
                    delIcon.title = "Delete Page";

                    delIcon.addEventListener('mouseover', () => {
                        delIcon.style.backgroundColor = '#fee2e2';
                        delIcon.querySelector('svg').style.transform = 'scale(1.15)';
                    });
                    delIcon.addEventListener('mouseout', () => {
                        delIcon.style.backgroundColor = 'transparent';
                        delIcon.querySelector('svg').style.transform = 'scale(1)';
                    });

                    delIcon.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        window.pageToDelete = page;

                        showConfirmDialog({
                            title: "Confirm Page Deletion",
                            mainText: `Are you sure you want to delete the page <b>"${page}"</b>?`,
                            subText: `All scraped elements mapped to this page will also be removed.`,
                            action: "deletePage",
                            theme: "confirm"
                        });

                        dropdownMenu.style.display = 'none';
                    });

                    item.appendChild(textSpan);
                    item.appendChild(delIcon);
                    dropdownMenu.appendChild(item);
                });

                dropdownMenu.style.display = 'block';
            });

            // 2. Start timer when leaving the icon
            dropdownIcon.addEventListener('mouseleave', function() {
                pageDropdownTimer = setTimeout(() => {
                    dropdownMenu.style.display = 'none';
                }, 200); // 500ms gap allowance
            });

            // 3. Keep menu open if mouse enters the dropdown itself
            dropdownMenu.addEventListener('mouseenter', function() {
                clearTimeout(pageDropdownTimer);
            });

            // 4. Hide menu when mouse finally leaves the dropdown
            dropdownMenu.addEventListener('mouseleave', function() {
                pageDropdownTimer = setTimeout(() => {
                    dropdownMenu.style.display = 'none';
                }, 300);
            });
        }

    pageNameInput.addEventListener('input', function() {
            const val = this.value;
            const errorTooltip = errorIconWrapper ? errorIconWrapper.querySelector('.error-info-tooltip') : null;

            if (!pageNameInput.readOnly) {
                let errorMsg = "";
                let isValid = true;
                const trimmedName = val.trim();

                // 1. Real-Time Validation Checks
                if (trimmedName === "") {
                    errorMsg = "Page Name cannot be empty.";
                    isValid = false;
                } else if (trimmedName.length < 3) {
                    errorMsg = "Page Name must be at least 3 characters.";
                    isValid = false;
                } else if (!isGlobalPageNameValid(val)) {
                    errorMsg = "Invalid Format: Must start with a letter and contain only alphanumeric chars or single spaces.";
                    isValid = false;
                } else if (isEditMode) {

                    // Gather all known pages from memory to prevent ANY duplicates
                    let allKnownPages = new Set(window.registeredPageNames || []);

                    // Include pages that have scenario data but might not be in the table
                    if (window.pageScenarioData) {
                        Object.keys(window.pageScenarioData).forEach(p => allKnownPages.add(p));
                    }

                    // CRITICAL FIX: Include the page we just navigated away from via the '+' icon.
                    // If the table was empty, the sync function forgets it, causing the duplicate bug.
                    if (typeof previousPageName !== 'undefined' && previousPageName && previousPageName !== "All") {
                        allKnownPages.add(previousPageName);
                    }

                    // Check for duplicates (Case-Insensitive for better UX)
                    let isDuplicate = false;
                    for (let existingPage of allKnownPages) {
                        if (existingPage.toLowerCase() === trimmedName.toLowerCase()) {
                            // If we are renaming (pencil icon), it's allowed to match its own original name
                            if (!(isRenameMode && typeof renameTarget !== 'undefined' && renameTarget.toLowerCase() === trimmedName.toLowerCase())) {
                                isDuplicate = true;
                                break;
                            }
                        }
                    }

                    if (isDuplicate) {
                        errorMsg = "Page Name already exists.";
                        isValid = false;
                    }
                }

                // 2. Real-Time UI Updates based on Validation State
                if (!isValid) {
                    // INVALID STATE: Hide Confirm (Green Check), Show Cancel (Red X), Show Error Info (Red i)
                    if (confirmIcon) confirmIcon.style.display = 'none';
                    if (cancelIcon) cancelIcon.style.display = 'inline-block';

                    if (addPageIcon) addPageIcon.style.display = 'none';
                    if (editPenIcon) editPenIcon.style.display = 'none';
                    if (dropdownIcon) dropdownIcon.style.display = 'none';

                    if (errorIconWrapper) {
                        errorIconWrapper.style.display = 'inline-flex';
                        if (errorTooltip) errorTooltip.innerText = errorMsg;
                    }

                    // Real-time Red error styling
                    if (badgeWrapper) badgeWrapper.style.setProperty('border-color', '#dc3545', 'important');
                    if (badgeLabel) badgeLabel.style.setProperty('background-color', '#dc3545', 'important');
                } else {
                    // VALID STATE: Show Confirm (Green Check) and Cancel (Red X), Hide Error Info
                    restoreValidBlueState();

                    if (confirmIcon) confirmIcon.style.display = 'inline-block';
                    if (cancelIcon) cancelIcon.style.display = 'inline-block';

                    if (addPageIcon) addPageIcon.style.display = 'none';
                    if (editPenIcon) editPenIcon.style.display = 'none';
                    if (dropdownIcon) dropdownIcon.style.display = 'none';
                }
            }
        });

    if (addPageIcon) {
            addPageIcon.addEventListener('click', function() {
                // NEW: Check if the user is in Record Scenario mode
                var isRecordMode = window.pageScenarioData && Object.keys(window.pageScenarioData).length > 0;
                if (isRecordMode) {
                    showCustomAlert(
                        "Action Restricted",
                        "You cannot create a new page manually while in Record Scenario mode. Please use the 'Add Scenario' button to create new scenarios and pages.",
                        "warning"
                    );
                    return; // Stop execution so the input doesn't switch to edit mode
                }

                syncRegisteredPageNames();
                isEditMode = true;
                isRenameMode = false;
                previousPageName = pageNameInput.value;

                pageNameInput.value = "";
                pageNameInput.readOnly = false;
                pageNameInput.style.cursor = 'text';
                pageNameInput.focus();

                addPageIcon.style.display = 'none';
                editPenIcon.style.display = 'none';
                if (dropdownIcon) dropdownIcon.style.display = 'none';
                if (confirmIcon) confirmIcon.style.display = 'none';
                if (cancelIcon) cancelIcon.style.display = 'inline-block';
            });
        }

    if (editPenIcon) {
        editPenIcon.addEventListener('click', function() {
            syncRegisteredPageNames();
            if (pageNameInput.value.trim() === '') {
                pageNameInput.focus();
                flashPageNameError();
                return;
            }

            isEditMode = true;
            isRenameMode = true;
            previousPageName = pageNameInput.value;
            renameTarget = pageNameInput.value.trim();

            pageNameInput.readOnly = false;
            pageNameInput.style.cursor = 'text';
            pageNameInput.focus();

            addPageIcon.style.display = 'none';
            editPenIcon.style.display = 'none';
            if (dropdownIcon) dropdownIcon.style.display = 'none';
            if (confirmIcon) confirmIcon.style.display = 'inline-block';
            if (cancelIcon) cancelIcon.style.display = 'inline-block';
        });
    }

    if (confirmIcon) {
            confirmIcon.addEventListener('click', function() {
                if (pageNameInput.value.trim() === '') {
                    pageNameInput.value = lastConfirmedPageName;
                } else if (!isValidPageName(pageNameInput.value)) {
                    pageNameInput.focus();
                    flashPageNameError();
                    showCustomAlert("Invalid Format", "Please provide a valid Page Name without special characters.", "warning");
                    return;
                }

                const newName = pageNameInput.value.trim();
                if (!window.registeredPageNames) window.registeredPageNames = new Set();

                if (isRenameMode && renameTarget !== "" && renameTarget !== newName) {
                    // 1. Rename in Page Memory
                    window.registeredPageNames.delete(renameTarget);
                    window.registeredPageNames.add(newName);

                    // 2. Transfer Scenario Outline Data to the new name
                    if (window.pageScenarioData && window.pageScenarioData[renameTarget]) {
                        window.pageScenarioData[newName] = window.pageScenarioData[renameTarget];
                        delete window.pageScenarioData[renameTarget];
                    }

                    // 3. Update Table Cells
                    const tableBody = document.getElementById('myTable');
                    if (tableBody) {
                        const allDataRows = Array.from(tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)'));
                        allDataRows.forEach(row => {
                            const pageCell = row.querySelector('.page');
                            if (pageCell && pageCell.innerText.trim() === renameTarget) {
                                pageCell.innerText = newName;
                            }
                        });
                    }
                } else {
                    window.registeredPageNames.add(newName);
                }

                window.setGlobalPageName(newName);

                pageNameInput.readOnly = true;
                pageNameInput.style.cursor = 'default';
                isEditMode = false;

                confirmIcon.style.display = 'none';
                cancelIcon.style.display = 'none';
                if (addPageIcon) addPageIcon.style.display = 'inline-block';
                if (editPenIcon) editPenIcon.style.display = 'inline-block';
                if (dropdownIcon) dropdownIcon.style.display = 'inline-block';
            });
        }

    function triggerCancel() {
        const fallbackName = (previousPageName || lastConfirmedPageName || "").trim();
        pageNameInput.value = fallbackName;

        isEditMode = false;
        isRenameMode = false;
        restoreValidBlueState();

        if (confirmIcon) confirmIcon.style.display = 'none';
        if (cancelIcon) cancelIcon.style.display = 'none';
        if (errorIconWrapper) errorIconWrapper.style.display = 'none';

        if (fallbackName === "") {
            // First time or no saved page: return to exact starting face
            pageNameInput.readOnly = false;
            pageNameInput.style.cursor = 'text';
            if (addPageIcon) addPageIcon.style.display = 'inline-block';
            if (editPenIcon) editPenIcon.style.display = 'inline-block';
            if (dropdownIcon) dropdownIcon.style.display = 'inline-block';
        } else {
            // Reverted to a saved valid page: lock to readOnly
            window.setGlobalPageName(fallbackName);
            pageNameInput.readOnly = true;
            pageNameInput.style.cursor = 'default';
            if (addPageIcon) addPageIcon.style.display = 'inline-block';
            if (dropdownIcon) dropdownIcon.style.display = 'inline-block';

            if (fallbackName === "All") {
                if (editPenIcon) editPenIcon.style.display = 'none';
            } else {
                if (editPenIcon) editPenIcon.style.display = 'inline-block';
            }
        }
    }

    if (cancelIcon) {
        cancelIcon.addEventListener('click', triggerCancel);
    }

    pageNameInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            if (this.value.trim() === '') {
                if (confirmIcon && confirmIcon.style.display !== 'none') confirmIcon.click();
            } else if (!isValidPageName(this.value) && this.value !== "") {
                flashPageNameError();
            } else if (confirmIcon && confirmIcon.style.display !== 'none') {
                confirmIcon.click();
            } else if (this.value.trim() !== '' && isValidPageName(this.value)) {
                this.blur();
            }
        } else if (e.key === 'Escape' && isEditMode) {
            triggerCancel();
        }
    });

    window.resetConfirmedPageNameUI = function() {
        if (!pageNameInput) return;
        pageNameInput.value = '';
        lastConfirmedPageName = '';
        previousPageName = '';
        pageNameInput.readOnly = false;
        pageNameInput.style.cursor = 'text';
        isEditMode = false;
        isRenameMode = false;

        restoreValidBlueState();

        if (addPageIcon) addPageIcon.style.display = 'inline-block';
        if (editPenIcon) editPenIcon.style.display = 'inline-block';
        if (dropdownIcon) dropdownIcon.style.display = 'inline-block';
        if (confirmIcon) confirmIcon.style.display = 'none';
        if (cancelIcon) cancelIcon.style.display = 'none';
        if (errorIconWrapper) errorIconWrapper.style.display = 'none';
        if (typeof setPageNameBoxEnabled === 'function') setPageNameBoxEnabled(false);
    };

    if (typeof setPageNameBoxEnabled === 'function') {
        setPageNameBoxEnabled(!!driver);
    }
}



// --- Scenario Outline Logic (Final Clean Version) ---
function flashScenarioOutlineError() {
    const soBar = document.getElementById('scenarioOutlineBar');
    const soLabel = document.getElementById('so_badge_label');
    const soInput = document.getElementById('scenarioOutlineText');
    const soErrorIconWrapper = document.getElementById('so_error_icon_wrapper');
    const soConfirmIcon = document.getElementById('so_confirm_icon');
    const soCancelIcon = document.getElementById('so_cancel_icon');

    if (soBar && soLabel) {
        soBar.style.borderColor = '#d9534f';
        soLabel.style.backgroundColor = '#d9534f';

        if (soInput) soInput.focus();

        if (soConfirmIcon) soConfirmIcon.style.display = 'none';
        if (soCancelIcon) soCancelIcon.style.display = 'none';
        if (soErrorIconWrapper) soErrorIconWrapper.style.display = 'inline-flex';

        setTimeout(() => {
            if (soInput && (isGlobalPageNameValid(soInput.value) || soInput.value.trim() === '')) {
                soBar.style.borderColor = '#2F8BCC';
                soLabel.style.backgroundColor = '#2F8BCC';
                if (soErrorIconWrapper) soErrorIconWrapper.style.display = 'none';

                if (!soInput.readOnly) {
                    if (soConfirmIcon && soInput.value.trim() !== '') soConfirmIcon.style.display = 'inline-block';
                    if (soCancelIcon) soCancelIcon.style.display = 'inline-block';
                }
            }
        }, 2000);
    }
}


function initScenarioOutlineLogic() {
    const soInput = document.getElementById('scenarioOutlineText');
    const soEditIcon = document.getElementById('so_edit_icon');
    const soDropdownIcon = document.getElementById('so_dropdown_icon');
    const soDropdownMenu = document.getElementById('scenarioOutlineDropdown');

    // New Edit Modal Elements
    const editModal = document.getElementById('editScenarioModal');
    const editScenarioNameInput = document.getElementById('edit_scenarioname');
    const editScenarioOutlineInput = document.getElementById('edit_scenariooutline');
    const editCloseBtn = document.getElementById('edit_close_btn');
    const editUpdateBtn = document.getElementById('edit_update_btn');
    const overlay = document.getElementById('overlay');

    if (!soInput) return;

    // --- MODERN DROPDOWN HOVER LOGIC ---
    if (soDropdownIcon && soDropdownMenu) {
        let soDropdownTimer;

        soDropdownIcon.addEventListener('mouseenter', function(e) {
            clearTimeout(soDropdownTimer);

            if (!window.pageScenarioData || Object.keys(window.pageScenarioData).length === 0) {
                soDropdownMenu.style.display = 'none';
                return;
            }

            const currentActivePage = document.getElementById('pagename_searchbox').value.trim();
            soDropdownMenu.innerHTML = '';
            let hasItems = false;

            const validPages = Object.keys(window.pageScenarioData).filter(p => window.pageScenarioData[p] && window.pageScenarioData[p].scenarioOutline);

            if (validPages.length === 0) {
                soDropdownMenu.style.display = 'none';
                return;
            }

            // Render "All" option
            if (validPages.length > 1) {
                const allItem = document.createElement('div');
                allItem.innerText = "All";
                allItem.style.padding = '7px 10px';
                allItem.style.margin = '2px 0';
                allItem.style.borderRadius = '6px';
                allItem.style.cursor = 'pointer';
                allItem.style.fontSize = '12px';
                allItem.style.textAlign = 'left';
                allItem.style.transition = 'background-color 0.15s ease';

                if (currentActivePage === "All" || currentActivePage === "") {
                    allItem.style.color = '#2F8BCC';
                    allItem.style.fontWeight = '600';
                    allItem.style.backgroundColor = '#eff6ff';
                } else {
                    allItem.style.color = '#334155';
                    allItem.style.fontWeight = '500';
                    allItem.style.backgroundColor = 'transparent';
                }

                allItem.addEventListener('mouseover', () => {
                    if (currentActivePage !== "All" && currentActivePage !== "") allItem.style.backgroundColor = '#f1f5f9';
                });
                allItem.addEventListener('mouseout', () => {
                    allItem.style.backgroundColor = (currentActivePage === "All" || currentActivePage === "") ? '#eff6ff' : 'transparent';
                });

                allItem.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    window.setGlobalPageName("All");
                    soDropdownMenu.style.display = 'none';
                });

                soDropdownMenu.appendChild(allItem);
                hasItems = true;
            }

            // Render Scenario Options
            validPages.forEach(page => {
                hasItems = true;
                const scenarioData = window.pageScenarioData[page];
                const outlineText = scenarioData.scenarioOutline;

                const item = document.createElement('div');
                item.style.display = 'flex';
                item.style.justifyContent = 'space-between';
                item.style.alignItems = 'center';
                item.style.padding = '7px 10px';
                item.style.margin = '2px 0';
                item.style.borderRadius = '6px';
                item.style.cursor = 'pointer';
                item.style.fontSize = '12px';
                item.style.textAlign = 'left';
                item.style.transition = 'background-color 0.15s ease';

                const textSpan = document.createElement('span');
                textSpan.innerText = outlineText.length > 28 ? outlineText.substring(0, 28) + '...' : outlineText;
                textSpan.title = `Page: ${page}\nOutline: ${outlineText}`;

                if (currentActivePage === page) {
                    item.style.color = '#2F8BCC';
                    item.style.fontWeight = '600';
                    item.style.backgroundColor = '#eff6ff';
                } else {
                    item.style.color = '#334155';
                    item.style.fontWeight = '500';
                    item.style.backgroundColor = 'transparent';
                }

                item.addEventListener('mouseover', () => {
                    if (currentActivePage !== page) item.style.backgroundColor = '#f1f5f9';
                });
                item.addEventListener('mouseout', () => {
                    item.style.backgroundColor = (currentActivePage === page) ? '#eff6ff' : 'transparent';
                });

                item.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    window.setGlobalPageName(page);
                    soDropdownMenu.style.display = 'none';
                });

                // Trash Icon
                const delIcon = document.createElement('div');
                delIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px; color: #ef4444; transition: transform 0.15s ease;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
                delIcon.style.padding = '4px';
                delIcon.style.marginRight = '-2px';
                delIcon.style.borderRadius = '4px';
                delIcon.title = "Delete Scenario & Page";

                delIcon.addEventListener('mouseover', () => {
                    delIcon.style.backgroundColor = '#fee2e2';
                    delIcon.querySelector('svg').style.transform = 'scale(1.15)';
                });
                delIcon.addEventListener('mouseout', () => {
                    delIcon.style.backgroundColor = 'transparent';
                    delIcon.querySelector('svg').style.transform = 'scale(1)';
                });

                delIcon.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    window.pageToDelete = page;

                    showConfirmDialog({
                        title: "Confirm Deletion",
                        mainText: `Are you sure you want to delete this Scenario Outline?`,
                        subText: `The associated page <b>"${page}"</b> and all its scraped elements will also be permanently deleted.`,
                        action: "deletePage",
                        theme: "confirm"
                    });

                    soDropdownMenu.style.display = 'none';
                });

                item.appendChild(textSpan);
                item.appendChild(delIcon);
                soDropdownMenu.appendChild(item);
            });

            if (!hasItems) {
                soDropdownMenu.style.display = 'none';
                return;
            }

            soDropdownMenu.style.display = 'block';
        });

        soDropdownIcon.addEventListener('mouseleave', function() {
            soDropdownTimer = setTimeout(() => {
                soDropdownMenu.style.display = 'none';
            }, 500);
        });

        soDropdownMenu.addEventListener('mouseenter', function() {
            clearTimeout(soDropdownTimer);
        });

        soDropdownMenu.addEventListener('mouseleave', function() {
            soDropdownTimer = setTimeout(() => {
                soDropdownMenu.style.display = 'none';
            }, 200);
        });
    }

    // --- NEW EDIT SCENARIO POPUP LOGIC ---

    function showEditError(inputEl, iconId, textId, message) {
        inputEl.classList.add("input-error-border");
        const icon = document.getElementById(iconId);
        const text = document.getElementById(textId);
        if (icon) icon.style.display = "flex";
        if (text) text.innerText = message;
    }

    function clearEditError(inputEl, iconId) {
        inputEl.classList.remove("input-error-border");
        const icon = document.getElementById(iconId);
        if (icon) icon.style.display = "none";
    }

    if (soEditIcon) {
        soEditIcon.addEventListener('click', function() {
            const currentActivePage = document.getElementById('pagename_searchbox').value.trim();
            if (!currentActivePage || currentActivePage === "All" || !window.pageScenarioData || !window.pageScenarioData[currentActivePage]) {
                return;
            }

            // Pre-fill the modal with the saved data
            editScenarioNameInput.value = window.pageScenarioData[currentActivePage].scenarioName || "";
            editScenarioOutlineInput.value = window.pageScenarioData[currentActivePage].scenarioOutline || "";

            // Clear any lingering error states
            clearEditError(editScenarioNameInput, "edit_scenario_error_icon");
            clearEditError(editScenarioOutlineInput, "edit_outline_error_icon");

            // Display modal
            editModal.style.display = "block";
            overlay.style.display = "block";
        });
    }

    // Real-Time Validation Triggers
    if (editScenarioNameInput) {
        editScenarioNameInput.addEventListener("input", function() {
            const val = this.value.trim();
            if (!val) {
                showEditError(this, "edit_scenario_error_icon", "edit_scenario_error_text", "Scenario Name is required");
            } else if (val.length < 3) {
                showEditError(this, "edit_scenario_error_icon", "edit_scenario_error_text", "Scenario Name must be at least 3 characters");
            } else if (!/^[A-Za-z][A-Za-z0-9_]*(\s[A-Za-z0-9_]+)*$/.test(val)) {
                showEditError(this, "edit_scenario_error_icon", "edit_scenario_error_text", "Must start with a letter and contain only alphanumeric chars or single spaces.");
            } else {
                clearEditError(this, "edit_scenario_error_icon");
            }
        });
    }

    if (editScenarioOutlineInput) {
        editScenarioOutlineInput.addEventListener("input", function() {
            const val = this.value.trim();
            if (!val) {
                showEditError(this, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline is required");
            } else if (val.length < 3) {
                showEditError(this, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline must be at least 3 characters");
            } else {
                clearEditError(this, "edit_outline_error_icon");
            }
        });
    }

    // Close button (discards changes)
    if (editCloseBtn) {
        editCloseBtn.addEventListener('click', function() {
            editModal.style.display = "none";
            overlay.style.display = "none";
        });
    }

    // Update button (validates and saves)
    if (editUpdateBtn) {
        editUpdateBtn.addEventListener('click', function() {
            const currentActivePage = document.getElementById('pagename_searchbox').value.trim();
            let isValid = true;

            const nameVal = editScenarioNameInput.value.trim();
            const outlineVal = editScenarioOutlineInput.value.trim();

            // Validate Name
            if (!nameVal) {
                showEditError(editScenarioNameInput, "edit_scenario_error_icon", "edit_scenario_error_text", "Scenario Name is required");
                isValid = false;
            } else if (nameVal.length < 3) {
                showEditError(editScenarioNameInput, "edit_scenario_error_icon", "edit_scenario_error_text", "Scenario Name must be at least 3 characters");
                isValid = false;
            } else if (!/^[A-Za-z][A-Za-z0-9_]*(\s[A-Za-z0-9_]+)*$/.test(nameVal)) {
                showEditError(editScenarioNameInput, "edit_scenario_error_icon", "edit_scenario_error_text", "Must start with a letter and contain only alphanumeric chars or single spaces.");
                isValid = false;
            }

            // Validate Outline
            if (!outlineVal) {
                showEditError(editScenarioOutlineInput, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline is required");
                isValid = false;
            } else if (outlineVal.length < 3) {
                showEditError(editScenarioOutlineInput, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline must be at least 3 characters");
                isValid = false;
            }

            if (!isValid) return;

            // Save to memory
            if (window.pageScenarioData && window.pageScenarioData[currentActivePage]) {
                window.pageScenarioData[currentActivePage].scenarioName = nameVal;
                window.pageScenarioData[currentActivePage].scenarioOutline = outlineVal;
            }

            // Update main view Scenario Outline Box
            soInput.value = outlineVal;

            // Close Modal
            editModal.style.display = "none";
            overlay.style.display = "none";
        });
    }
}


// Bind dropdown change event and initialize our methods
document.addEventListener('DOMContentLoaded', () => {
    const rppSelect = document.getElementById('rows_per_page');
    if (rppSelect) {
        rppSelect.addEventListener('change', () => {
            currentPage = 1; // Reset to page 1 on resize
            applyPagination();
        });
    }

    // --- Initialize the new Page Name logic ---
    initPageNameLogic();


    // --- Initialize Scenario Outline logic ---
        initScenarioOutlineLogic();
});




// ===========================================================================
// [MODALS] Custom #confirmationPopup themes + helpers
// Types: success (green) | info (blue) | warning (amber) | error (red) | confirm
// showCustomAlert → Okay only (alertOnly). showConfirmDialog → Cancel+Confirm.
// ===========================================================================
function normalizeModalType(type, title) {
    const allowed = new Set(["success", "info", "warning", "error", "confirm"]);
    const t = String(type || "").toLowerCase().trim();
    if (allowed.has(t)) return t;

    const titleL = String(title || "").toLowerCase();
    if (/success|shared successfully|saved successfully/.test(titleL)) return "success";
    if (/error|failed|cannot launch|authentication/.test(titleL)) return "error";
    if (/confirm|delete|reset|bulk deletion|page deletion/.test(titleL)) return "confirm";
    if (/scroll complete|connected successfully/.test(titleL)) return "info";
    if (/missing|invalid|warning|restricted|not available|no device|no data|no rows/.test(titleL)) return "warning";
    return "warning";
}

/// HELPER: Swaps the colors and icon of the modal header
function setModalTheme(type) {
    const header = document.getElementById('modal_header');
    const iconContainer = document.getElementById('modal_icon_container');
    const theme = normalizeModalType(type);

    if (header) header.className = `modal-header header-${theme}`;

    if (!iconContainer) return;

    if (theme === "success") {
        iconContainer.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="warning-icon"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
    } else if (theme === "info") {
        iconContainer.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="warning-icon"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    } else if (theme === "error") {
        iconContainer.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="warning-icon"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
    } else if (theme === "confirm") {
        iconContainer.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="warning-icon"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else {
        // warning — amber triangle
        iconContainer.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="warning-icon"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    }
}

/// HELPER: Alert-only modal (Okay, no Cancel) with correct icon/color indication
function showCustomAlert(title, message, type) {
    const theme = normalizeModalType(type, title);
    setModalTheme(theme);

    document.getElementById('popup_title').innerText = title;
    document.getElementById('popup_main_text').innerHTML = message;
    document.getElementById('popup_sub_text').innerText = "";

    document.getElementById('back_btn').style.display = 'none';
    document.getElementById('extra_btn').style.display = 'none';
    document.getElementById('okay_btn').innerText = 'Okay';

    pendingExportAction = "alertOnly";

    document.getElementById('confirmationPopup').style.display = 'block';
    document.getElementById('overlay').style.display = 'block';
}

/// HELPER: Confirm modal (Cancel + Confirm) for destructive / export actions
function showConfirmDialog({ title, mainText, subText, action, theme, okayBtnText, extraBtnText }) {
    setModalTheme(theme || "confirm");

    document.getElementById('back_btn').style.display = 'inline-block';

    const okayBtn = document.getElementById('okay_btn');
    okayBtn.innerText = okayBtnText || 'Confirm';

    const extraBtn = document.getElementById('extra_btn');
    if (extraBtnText) {
        extraBtn.innerText = extraBtnText;
        extraBtn.style.display = 'inline-block';
    } else {
        extraBtn.style.display = 'none';
    }

    document.getElementById('popup_title').innerText = title || "Confirm Action";
    document.getElementById('popup_main_text').innerHTML = mainText || "";
    document.getElementById('popup_sub_text').innerHTML = subText || "";

    if (action) pendingExportAction = action;

    document.getElementById('confirmationPopup').style.display = 'block';
    document.getElementById('overlay').style.display = 'block';
}


// ===========================================================================
// [SCENARIO] Record / Add Scenario + Scenario Outline bar
// pageScenarioData[pageName] = { scenarioName, scenarioOutline }
// Download/Send switches to nested SCENARIOS when this object has entries.
// Reset clears pageScenarioData so export returns to normal scrape JSON.
// ===========================================================================
document.addEventListener("DOMContentLoaded", () => {
    const recordScenarioBtn = document.getElementById("recordScenarioBtn");
    const addScenarioBtn = document.getElementById("addScenarioBtn");
    const recordModal = document.getElementById("recordScenarioModal");
    const overlay = document.getElementById("overlay");
    const pageNameInput = document.getElementById("pagename_searchbox");

    const recPageNameInput = document.getElementById("rec_pagename");
    const recScenarioNameInput = document.getElementById("rec_scenarioname");
    const recScenarioOutlineInput = document.getElementById("rec_scenariooutline");

    const recCloseBtn = document.getElementById("rec_close_btn");
    const recStartBtn = document.getElementById("rec_start_btn");

    const scenarioOutlineBar = document.getElementById("scenarioOutlineBar");
    const scenarioOutlineText = document.getElementById("scenarioOutlineText");

    // Tracks if we are "Renaming" (Record) or "Creating New" (Add)
    let currentScenarioMode = "";
    let initialModalPageName = "";
    let liveTrackingName = ""; // Used to safely track real-time keystroke changes

    function validatePageName(val) {
        if (!val || val.trim() === '') return "Page Name is required";
        if (val.trim().length < 3) return "Page Name must be at least 3 characters";

        // Check if page already exists
        const trimmedName = val.trim();
        if (window.registeredPageNames && window.registeredPageNames.has(trimmedName)) {
            // If in Record Scenario mode (renaming current page), allow it.
            // But if in Add Scenario mode (new page), it must be unique.
            if (!(currentScenarioMode === "RECORD" && trimmedName === initialModalPageName)) {
                return "Page Name already exists.";
            }
        }

        if (typeof isGlobalPageNameValid === 'function' && !isGlobalPageNameValid(val)) {
            return "Page Name must start with a letter and can contain only letters, numbers, _, and single spaces.";
        }
        return "";
    }

    function validateScenarioName(val) {
        if (!val || val.trim() === '') return "Scenario Name is required";
        if (val.trim().length < 3) return "Scenario Name must be at least 3 characters";
        const regex = /^[A-Za-z][A-Za-z0-9_]*(\s[A-Za-z0-9_]+)*$/;
        if (!regex.test(val)) return "Scenario Name must start with a letter and can contain only letters, numbers, _, and single spaces.";
        return "";
    }

    function validateScenarioOutline(val) {
        if (!val || val.trim() === '') return "Scenario Outline is required";
        if (val.trim().length < 3) return "Scenario Outline must be at least 3 characters";
        return "";
    }

    function showError(inputEl, iconId, textId, message) {
        inputEl.classList.add("input-error-border");
        const icon = document.getElementById(iconId);
        const text = document.getElementById(textId);
        if (icon) icon.style.display = "flex";
        if (text) text.innerText = message;
    }

    function clearError(inputEl, iconId) {
        inputEl.classList.remove("input-error-border");
        const icon = document.getElementById(iconId);
        if (icon) icon.style.display = "none";
    }

    if (recordScenarioBtn && addScenarioBtn) {
        // Initial State
        const recWrap = document.getElementById('recordScenarioWrapper');
        recordScenarioBtn.style.setProperty("display", "inline-flex", "important");
        if (recWrap) recWrap.style.setProperty("display", "inline-flex", "important");
        addScenarioBtn.style.setProperty("display", "none", "important");

        if (recPageNameInput) {
            recPageNameInput.removeAttribute("readonly");
        }

        // Live validation and REAL-TIME updating logic
        if(recPageNameInput) {
            recPageNameInput.addEventListener("input", function() {
                const errorMsg = validatePageName(this.value);
                if (errorMsg) showError(this, "rec_page_error_icon", "rec_page_error_text", errorMsg);
                else clearError(this, "rec_page_error_icon");

                // --- REAL-TIME RENAME: Only happens if user clicked Record Scenario ---
                if (currentScenarioMode === "RECORD") {
                    const newPageName = this.value;
                    // Never blank the main Page Name while typing (avoids "Page name" placeholder flash)
                    if (pageNameInput && newPageName.trim() !== "") {
                        pageNameInput.value = newPageName;
                    }

                    // Update matching table cells instantly
                    const tableBody = document.getElementById('myTable');
                    if (tableBody && liveTrackingName !== "" && newPageName.trim() !== "") {
                        const allDataRows = Array.from(tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)'));
                        allDataRows.forEach(row => {
                            const pageCell = row.querySelector('.page');
                            // Only update cells that match our current active track
                            if (pageCell && pageCell.innerText.trim() === liveTrackingName) {
                                pageCell.innerText = newPageName;
                            }
                        });
                    }
                    // Sync the tracker so the next keystroke finds the right cells
                    if (newPageName.trim() !== "") {
                        liveTrackingName = newPageName;
                    }
                }
            });
        }

        if(recScenarioNameInput) {
            recScenarioNameInput.addEventListener("input", function() {
                const errorMsg = validateScenarioName(this.value);
                if (errorMsg) showError(this, "rec_scenario_error_icon", "rec_scenario_error_text", errorMsg);
                else clearError(this, "rec_scenario_error_icon");
            });
        }

        if(recScenarioOutlineInput) {
            recScenarioOutlineInput.addEventListener("input", function() {
                const errorMsg = validateScenarioOutline(this.value);
                if (errorMsg) showError(this, "rec_outline_error_icon", "rec_outline_error_text", errorMsg);
                else clearError(this, "rec_outline_error_icon");
            });
        }

        function hasExistingPagesOrScrapedData() {
            const hasRegisteredPages = window.registeredPageNames && window.registeredPageNames.size > 0;
            const hasScenarioData = window.pageScenarioData && Object.keys(window.pageScenarioData).length > 0;
            const tableBody = document.getElementById('myTable');
            const hasDataRows = tableBody && tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)').length > 0;
            const pageVal = document.getElementById('pagename_searchbox')?.value.trim() || "";
            const hasPageName = pageVal !== "" && pageVal.toLowerCase() !== "all";

            return hasRegisteredPages || hasScenarioData || hasDataRows || hasPageName;
        }

        window.clearAllPagesAndScrapedDataForNewScenario = function() {
            // 1. Clear memory banks
            window.registeredPageNames = new Set();
            window.pageScenarioData = {};
            window.pageToDelete = null;

            // 2. Clear table data rows (keep empty Excel grid)
            const tbody = document.getElementById('myTable');
            if (tbody) {
                Array.from(tbody.querySelectorAll('tr')).forEach((row) => {
                    if (!row.classList.contains('empty-excel-row')) {
                        row.remove();
                    }
                });
            }
            if (typeof updateRowNumbers === 'function') updateRowNumbers();
            if (typeof applyPagination === 'function') {
                currentPage = 1;
                applyPagination();
            }
            if (typeof adjustEmptyRows === 'function') {
                adjustEmptyRows();
            }

            // 3. Clear Page Name input and dropdown
            const pageNameInput = document.getElementById('pagename_searchbox');
            if (pageNameInput) {
                pageNameInput.value = "";
                pageNameInput.readOnly = false;
                pageNameInput.style.cursor = 'text';
            }
            const pageNameDropdown = document.getElementById('pageNameDropdown');
            if (pageNameDropdown) {
                pageNameDropdown.innerHTML = "";
                pageNameDropdown.style.display = "none";
            }

            // 4. Hide Scenario Outline bar
            const scenarioOutlineBar = document.getElementById("scenarioOutlineBar");
            const scenarioOutlineText = document.getElementById("scenarioOutlineText");
            if (scenarioOutlineBar) scenarioOutlineBar.style.display = "none";
            if (scenarioOutlineText) scenarioOutlineText.value = "";

            // 5. Clear Search box and empty states
            const searchBox = document.getElementById('searchbox');
            if (searchBox) searchBox.value = "";
            const emptyStateEl = document.getElementById('tableSearchEmptyState');
            if (emptyStateEl) emptyStateEl.style.display = "none";

            // 6. Reset icons
            const confirmIcon = document.querySelector('.confirm-edit-icon');
            const cancelIcon = document.querySelector('.cancel-edit-icon');
            const addPageIcon = document.querySelector('.add-page-icon');
            const editPenIcon = document.querySelector('.edit-icon');
            const dropdownIcon = document.querySelector('.dropdown-icon');
            if (confirmIcon) confirmIcon.style.display = 'none';
            if (cancelIcon) cancelIcon.style.display = 'none';
            if (addPageIcon) addPageIcon.style.display = 'inline-block';
            if (dropdownIcon) dropdownIcon.style.display = 'inline-block';
            if (editPenIcon) editPenIcon.style.display = 'inline-block';

            // 7. Reset counters
            counter = 0;
            initialData = [];
            xpath_id = 0;
            screenNameList = [];
        };

        window.openScenarioModalDirectly = function(mode) {
            openScenarioModal(mode);
        };

        function openScenarioModal(mode) {
            currentScenarioMode = mode;

            let pageNameValue = "";
            let savedScenarioName = "";
            let savedScenarioOutline = "";

            // --- SEPARATE LOGIC FOR RECORD (EDIT) VS ADD (NEW) ---
            if (mode === "RECORD") {
                pageNameValue = pageNameInput ? pageNameInput.value.trim() : "";
                if (pageNameValue.toLowerCase() === "all" || (typeof isGlobalPageNameValid === 'function' && !isGlobalPageNameValid(pageNameValue))) {
                    pageNameValue = "";
                }

                initialModalPageName = pageNameValue;
                liveTrackingName = pageNameValue;

                // Fetch existing scenario data
                if (pageNameValue && window.pageScenarioData && window.pageScenarioData[pageNameValue]) {
                    savedScenarioName = window.pageScenarioData[pageNameValue].scenarioName || "";
                    savedScenarioOutline = window.pageScenarioData[pageNameValue].scenarioOutline || "";
                }
            } else {
                // If ADDING a new scenario, start with a completely clean slate
                initialModalPageName = "";
                liveTrackingName = "";
                pageNameValue = "";
            }

            // Populate the inputs based on the mode
            if (recPageNameInput) {
                recPageNameInput.value = pageNameValue; // Blank for ADD or empty, current name for RECORD
                clearError(recPageNameInput, "rec_page_error_icon");
            }

            if (recScenarioNameInput) {
                recScenarioNameInput.value = savedScenarioName;
                clearError(recScenarioNameInput, "rec_scenario_error_icon");
            }

            if (recScenarioOutlineInput) {
                recScenarioOutlineInput.value = savedScenarioOutline;
                clearError(recScenarioOutlineInput, "rec_outline_error_icon");
            }

            if (recordModal) recordModal.style.display = "block";
            if (overlay) overlay.style.display = "block";
        }

        function getUniquePageCount() {
            const pages = new Set();
            if (window.registeredPageNames) {
                window.registeredPageNames.forEach(p => {
                    if (p && p.trim() && p.toLowerCase() !== 'all') pages.add(p.trim());
                });
            }
            if (window.pageScenarioData) {
                Object.keys(window.pageScenarioData).forEach(p => {
                    if (p && p.trim() && p.toLowerCase() !== 'all') pages.add(p.trim());
                });
            }
            const tableBody = document.getElementById('myTable');
            if (tableBody) {
                tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row) .page').forEach(td => {
                    const val = (td.innerText || "").trim();
                    if (val && val.toLowerCase() !== 'all') pages.add(val);
                });
            }
            return pages.size;
        }

        function hasScrapedTableData() {
            const tableBody = document.getElementById('myTable');
            if (!tableBody) return false;
            const dataRows = tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)');
            return dataRows.length > 0;
        }

        function handleRecordScenarioClick() {
            const pageCount = getUniquePageCount();

            // Only remove/clear pages if multiple pages have been created
            if (pageCount > 1) {
                if (hasScrapedTableData()) {
                    showConfirmDialog({
                        title: "Record Scenario",
                        mainText: "Starting a new Scenario recording will clear all previously created pages and their scraped data.",
                        subText: "If any of this data is important, please <b>Download</b> it before proceeding.<br><br>Do you want to clear all existing pages and start a new scenario?",
                        action: "confirmRecordScenarioClear",
                        theme: "warning",
                        okayBtnText: "Continue & Record"
                    });
                } else {
                    if (typeof window.clearAllPagesAndScrapedDataForNewScenario === 'function') {
                        window.clearAllPagesAndScrapedDataForNewScenario();
                    }
                    openScenarioModal("RECORD");
                }
            } else {
                // First time or only 1 page name created: DO NOT remove the page name, open directly
                openScenarioModal("RECORD");
            }
        }

        // Pass 'RECORD' or 'ADD' so the system knows what to do
        recordScenarioBtn.addEventListener("click", handleRecordScenarioClick);
        addScenarioBtn.addEventListener("click", () => openScenarioModal("ADD"));

        const createFeatureBtn = document.getElementById("createFeatureBtn");
        if (createFeatureBtn) {
            createFeatureBtn.addEventListener("click", () => {
                const turningOn = !createFeatureMode;

                if (turningOn) {
                    const pageVal = (document.getElementById("pagename_searchbox")?.value || "").trim();
                    if (!pageVal || (typeof isGlobalPageNameValid === "function" && !isGlobalPageNameValid(pageVal))) {
                        showCustomAlert(
                            "Page Name Required",
                            "Please enter a valid Page Name before Create Feature mode.",
                            "warning"
                        );
                        return;
                    }

                    // Create Feature only works in Tap mode
                    tapMode = true;
                    const tapBtn = document.getElementById("tapBtn");
                    const touchBtn = document.getElementById("touchBtn");
                    if (tapBtn) { tapBtn.style.background = "#2F8BCC"; tapBtn.style.color = "#fff"; }
                    if (touchBtn) { touchBtn.style.background = "transparent"; touchBtn.style.color = "#333"; }
                }

                createFeatureMode = turningOn;
                clearOverlay();

                const scrapeBtn = document.getElementById('Scrape');
                const scrapeUIBtn = document.getElementById('scrapeUI');
                const btnSpan = createFeatureBtn.querySelector('span');

                if (createFeatureMode) {
                    createFeatureBtn.style.backgroundColor = "#34A853";
                    if (btnSpan) btnSpan.innerText = "Exit Feature";
                    if (scrapeBtn) { scrapeBtn.disabled = true; scrapeBtn.style.backgroundColor = '#B6B6B4'; }
                    if (scrapeUIBtn) { scrapeUIBtn.disabled = true; scrapeUIBtn.style.backgroundColor = '#B6B6B4'; }

                    showCustomAlert("Feature Mode Started", "First click maps the <b>full page</b>. After that, click a control to add a feature <b>inside</b> the page. Hold <b>Shift</b> and click to map a control anytime.", "success");
                } else {
                    createFeatureBtn.style.backgroundColor = "#2F8BCC";
                    if (btnSpan) btnSpan.innerText = "Create Feature";
                    if (scrapeBtn) { scrapeBtn.disabled = false; scrapeBtn.style.backgroundColor = '#2F8BCC'; }
                    if (scrapeUIBtn) { scrapeUIBtn.disabled = false; scrapeUIBtn.style.backgroundColor = '#2F8BCC'; }
                }
            });
        }

        const featureSaveBtn = document.getElementById("feature_save_btn");
        const featureCancelBtn = document.getElementById("feature_cancel_btn");
        const featureNameInput = document.getElementById("feature_name_input");
        const featureModal = document.getElementById("createFeatureModal");

        function validateFeatureName(val) {
            if (!val || val.trim() === '') return "Feature Name is required";
            if (val.trim().length < 3) return "Feature Name must be at least 3 characters";

            const trimmed = val.trim();
            const formatRegex = /^[A-Za-z][A-Za-z0-9_]*(\s[A-Za-z0-9_]+)*$/;
            if (!formatRegex.test(trimmed)) {
                return "Feature Name must start with a letter and can contain only letters, numbers, _, and single spaces.";
            }

            const lower = trimmed.toLowerCase();
            const nameUsedAsFeature = (registeredFeatureAreas || []).some(
                (area) => area && area.name && area.name.trim().toLowerCase() === lower
            );
            if (nameUsedAsFeature) {
                return "Feature Name already exists.";
            }

            const nameUsedAsPage = Array.from(window.registeredPageNames || []).some(
                (p) => String(p).trim().toLowerCase() === lower
            );
            if (nameUsedAsPage) {
                return "Feature Name already used as a Page Name.";
            }

            return "";
        }

        function showFeatureNameError(message) {
            if (!featureNameInput) return;
            featureNameInput.classList.add("input-error-border");
            const icon = document.getElementById("feature_name_error_icon");
            const text = document.getElementById("feature_name_error_text");
            if (icon) icon.style.display = "flex";
            if (text) text.innerText = message;
        }

        function clearFeatureNameError() {
            if (!featureNameInput) return;
            featureNameInput.classList.remove("input-error-border");
            const icon = document.getElementById("feature_name_error_icon");
            if (icon) icon.style.display = "none";
        }

        if (featureNameInput) {
            featureNameInput.addEventListener("input", function () {
                const errorMsg = validateFeatureName(this.value);
                if (errorMsg) showFeatureNameError(errorMsg);
                else clearFeatureNameError();
            });
        }

        if (featureSaveBtn) {
            featureSaveBtn.addEventListener("click", () => {
                const featureName = featureNameInput ? featureNameInput.value.trim() : "";
                const errorMsg = validateFeatureName(featureNameInput ? featureNameInput.value : "");
                if (errorMsg) {
                    showFeatureNameError(errorMsg);
                    return;
                }

                if (pendingFeatureData && pendingFeatureData.rect) {
                    const newArea = {
                        rect: pendingFeatureData.rect,
                        name: featureName,
                        fullPage: !!pendingFeatureData.fullPage
                    };
                    registeredFeatureAreas.push(newArea);
                    syncExistingRowsWithNewFeature(newArea);
                    // Name shows only when hovering that feature — do not leave a sticky label
                    clearOverlay();
                }

                if (featureModal) featureModal.style.display = "none";
                const overlay = document.getElementById("overlay");
                if (overlay) overlay.style.display = "none";
                pendingFeatureData = null;
                if (featureNameInput) featureNameInput.value = "";
                clearFeatureNameError();
            });
        }

        if (featureCancelBtn) {
            featureCancelBtn.addEventListener("click", () => {
                if (featureModal) featureModal.style.display = "none";
                const overlay = document.getElementById("overlay");
                if (overlay) overlay.style.display = "none";
                pendingFeatureData = null;
                if (featureNameInput) featureNameInput.value = "";
                clearFeatureNameError();
            });
        }

        // Helper to undo real-time changes if the user clicks "Cancel" or "Close"
        function revertRealTimeChanges() {
            if (currentScenarioMode === "RECORD" && liveTrackingName !== initialModalPageName) {
                if (pageNameInput) pageNameInput.value = initialModalPageName;
                const tableBody = document.getElementById('myTable');
                if (tableBody) {
                    const allDataRows = Array.from(tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)'));
                    allDataRows.forEach(row => {
                        const pageCell = row.querySelector('.page');
                        if (pageCell && pageCell.innerText.trim() === liveTrackingName) {
                            pageCell.innerText = initialModalPageName;
                        }
                    });
                }
                liveTrackingName = initialModalPageName;
            }
        }

        if (recCloseBtn) {
            recCloseBtn.addEventListener("click", () => {
                revertRealTimeChanges(); // Undo any typing if canceled

                if (recordModal) recordModal.style.display = "none";
                if (overlay) overlay.style.display = "none";

                if (addScenarioBtn.style.display === "none" && scenarioOutlineBar) {
                    scenarioOutlineBar.style.display = "none";
                }
            });
        }

        if (recStartBtn) {
           recStartBtn.addEventListener("click", () => {
               let isValid = true;

               if (recPageNameInput) {
                   const pageError = validatePageName(recPageNameInput.value);
                   if (pageError) {
                       showError(recPageNameInput, "rec_page_error_icon", "rec_page_error_text", pageError);
                       isValid = false;
                   }
               }

               const nameError = validateScenarioName(recScenarioNameInput.value);
               if (nameError) {
                   showError(recScenarioNameInput, "rec_scenario_error_icon", "rec_scenario_error_text", nameError);
                   isValid = false;
               }

               const outlineError = validateScenarioOutline(recScenarioOutlineInput.value);
               if (outlineError) {
                   showError(recScenarioOutlineInput, "rec_outline_error_icon", "rec_outline_error_text", outlineError);
                   isValid = false;
               }

               if (!isValid) return;

               const newPageName = recPageNameInput.value.trim();
               const newScenarioName = recScenarioNameInput.value.trim(); // NEW: Grab Scenario Name
               const newScenarioOutline = recScenarioOutlineInput.value.trim(); // NEW: Grab Scenario Outline

               // Make sure global memory objects exist
               if (!window.registeredPageNames) window.registeredPageNames = new Set();
               if (!window.pageScenarioData) window.pageScenarioData = {}; // NEW: Ensure object exists

               // --- RECORD vs ADD MEMORY LOGIC ---
               if (currentScenarioMode === "RECORD") {

                   // RECORD: Delete old name from memory, save new name.
                   if (initialModalPageName !== "" && initialModalPageName !== newPageName) {
                       window.registeredPageNames.delete(initialModalPageName);
                       window.registeredPageNames.add(newPageName);

                       // NEW: Transfer scenario data to the new page name
                       window.pageScenarioData[newPageName] = {
                           scenarioName: newScenarioName,
                           scenarioOutline: newScenarioOutline
                       };
                       delete window.pageScenarioData[initialModalPageName]; // Clean up old memory

                   } else if (initialModalPageName === newPageName && newPageName !== "") {
                       window.registeredPageNames.add(newPageName);

                       // NEW: Update existing page data
                       window.pageScenarioData[newPageName] = {
                           scenarioName: newScenarioName,
                           scenarioOutline: newScenarioOutline
                       };
                   }

               } else if (currentScenarioMode === "ADD") {

                   // ADD: Keep old name, save new name. DO NOT touch old table cells.
                   if (initialModalPageName !== "") {
                       window.registeredPageNames.add(initialModalPageName);
                   }
                   if (newPageName !== "") {
                       window.registeredPageNames.add(newPageName);

                       // NEW: Save data for newly added page
                       window.pageScenarioData[newPageName] = {
                           scenarioName: newScenarioName,
                           scenarioOutline: newScenarioOutline
                       };
                   }
               }

               // Update the main top searchbox and filter so the user sees the new page context
               // Note: Calling window.setGlobalPageName here automatically renders the outline we just saved!
               if (pageNameInput) {
                   pageNameInput.value = newPageName;
                   if (window.setGlobalPageName) {
                       window.setGlobalPageName(newPageName);
                   }
               }

               // Close Popup
               if (recordModal) recordModal.style.display = "none";
               if (overlay) overlay.style.display = "none";

               // Update main UI components
               if (scenarioOutlineBar && scenarioOutlineText) {
                   scenarioOutlineText.value = newScenarioOutline;
                   scenarioOutlineBar.style.display = "inline-flex";
               }

               // Swap buttons — Add Scenario must be enabled (reset leaves it disabled)
               const recWrap = document.getElementById('recordScenarioWrapper');
               if (recWrap) recWrap.style.setProperty("display", "none", "important");
               recordScenarioBtn.style.setProperty("display", "none", "important");
               addScenarioBtn.style.setProperty("display", "inline-flex", "important");
               addScenarioBtn.disabled = false;
               addScenarioBtn.style.backgroundColor = '#2F8BCC';
           });
        }
    }
});

// ==========================================
// MULTI-DELETE (BULK DELETE) LOGIC ENGINE
// ==========================================
let isMultiDeleteMode = false;

// 1. Right-Click Context Menu Logic for the Delete Header
const deleteHeader = document.getElementById('delete_header');
const deleteContextMenu = document.getElementById('deleteContextMenu');
const toggleMultiDeleteOpt = document.getElementById('toggleMultiDeleteOpt');

if (deleteHeader) {
    deleteHeader.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (deleteContextMenu) {
            const menuWidth = 140;
            const posX = (e.clientX + menuWidth > window.innerWidth) ? e.clientX - menuWidth : e.clientX;
            deleteContextMenu.style.left = `${posX}px`;
            deleteContextMenu.style.top = `${e.clientY}px`;
            deleteContextMenu.style.display = "block";
        }
    });
}

// Hide context menu on outside click
document.addEventListener('click', (e) => {
    if (deleteContextMenu && !deleteContextMenu.contains(e.target)) {
        deleteContextMenu.style.display = "none";
    }
});

// 2. Toggle Multi-Delete Mode
if (toggleMultiDeleteOpt) {
    toggleMultiDeleteOpt.addEventListener('click', () => {
        // If we are about to ENABLE multi-delete, check if the table actually contains data first
        if (!isMultiDeleteMode) {
            if (typeof hasValidTableData === 'function' && !hasValidTableData('myTable')) {
                showCustomAlert("No Data Found", "There is no data available in the table to perform multi-delete.", "warning");
                if (deleteContextMenu) deleteContextMenu.style.display = "none";
                return; // Halt execution, do not enable mode
            }
        }

        isMultiDeleteMode = !isMultiDeleteMode;

        const bulkDeleteBtn = document.getElementById('bulk_delete_btn');
        const headerCheckbox = document.getElementById('selectAllCheckbox');
        const headerTrashIcon = document.getElementById('headerDeleteIcon');
        const dataDeleteCells = document.querySelectorAll('#myTable tr:not(.empty-excel-row):not(.no-results-row) .delete-cell');

        if (isMultiDeleteMode) {
            // Enable Mode
            toggleMultiDeleteOpt.innerText = "Disable Multi-Delete";
            if(bulkDeleteBtn) bulkDeleteBtn.style.setProperty("display", "inline-flex", "important");
            if(headerCheckbox) headerCheckbox.style.display = "inline-block";
            if(headerTrashIcon) headerTrashIcon.style.display = "none";

            // Swap icons in rows
            dataDeleteCells.forEach(cell => {
                const cb = cell.querySelector('.bulk-delete-cb');
                const trash = cell.querySelector('.deleteBtn');
                if (cb) { cb.style.display = "inline-block"; cb.checked = false; }
                if (trash) trash.style.display = "none";
            });
            if (headerCheckbox) headerCheckbox.checked = false;

        } else {
            // Disable Mode
            toggleMultiDeleteOpt.innerText = "Enable Multi-Delete";
            if(bulkDeleteBtn) bulkDeleteBtn.style.setProperty("display", "none", "important");
            if(headerCheckbox) headerCheckbox.style.display = "none";
            if(headerTrashIcon) headerTrashIcon.style.display = "inline-block";

            // Swap icons in rows back to normal
            dataDeleteCells.forEach(cell => {
                const cb = cell.querySelector('.bulk-delete-cb');
                const trash = cell.querySelector('.deleteBtn');
                if (cb) cb.style.display = "none";
                if (trash) trash.style.display = "inline-block";
            });
        }

        if (deleteContextMenu) deleteContextMenu.style.display = "none";
    });
}

// 3. Header "Select All" Logic
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const visibleRows = document.querySelectorAll('#myTable tr:not(.empty-excel-row):not(.no-results-row):not(.page-hidden):not(.search-hidden)');

        visibleRows.forEach(row => {
            const cb = row.querySelector('.bulk-delete-cb');
            if (cb) cb.checked = isChecked;
        });
    });
}

// 4. Execute "Delete Selected" Button
const bulkDeleteBtn = document.getElementById('bulk_delete_btn');
if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener('click', () => {
            const checkedBoxes = document.querySelectorAll('.bulk-delete-cb:checked');

            if (checkedBoxes.length === 0) {
                showCustomAlert("No Rows Selected", "Please select at least one row to delete.", "warning");
                return;
            }

            // Build Confirmation Text without page-wiping warnings
            let mainText = `Are you sure you want to delete the ${checkedBoxes.length} selected row(s)?`;
            let subText = `This action cannot be undone.`;

            showConfirmDialog({
                title: "Confirm Bulk Deletion",
                mainText: mainText,
                subText: subText,
                action: "bulkDelete",
                theme: "confirm"
            });

            // Pass payload of checked boxes to the global scope so the Confirm handler can access it
            window.pendingBulkDeleteRows = Array.from(checkedBoxes).map(cb => cb.closest('tr'));
        });
}


// ===========================================================================
// [XML-HELPERS] Dual-platform page-source helpers
// Android hierarchy: bounds="[x1,y1][x2,y2]", class=, resource-id=, text=, ...
// iOS hierarchy:     x/y/width/height attrs, name=, label=, type=, ...
// parseNodeRect() normalizes both into {x,y,width,height} for hover/tap/scrape
// inferIdentificationType() maps primary locator → Id|Name|Label|Text|XPath|...
// ===========================================================================

// --- Dual-platform helpers (Android bounds + iOS x/y/width/height) ---

function getSelectedPlatform() {
    const el = document.getElementById('platformname');
    if (!el) return 'Android';
    if (el.tagName === 'INPUT') return el.value || 'Android';
    return el.value || (el.options[el.selectedIndex] && el.options[el.selectedIndex].text) || 'Android';
}

function isAndroidPlatform() {
    return getSelectedPlatform() === 'Android';
}

function isIOSPlatform() {
    const p = getSelectedPlatform();
    return p === 'IOS' || p === 'iOS';
}

/** Package name (Android) or Bundle ID (iOS) — used in table APP URL cell (export clears it). */
function getCurrentAppIdentity() {
    if (isIOSPlatform()) {
        return (document.getElementById('bundleID')?.value || '').trim();
    }
    return (document.getElementById('apppackage')?.value || '').trim();
}

/** Map primary Control ID string → Identification Type (Id, Name, Label, XPath, …). */
function inferIdentificationType(locatorOrType) {
    const v = String(locatorOrType || '').trim();
    if (!v) return "";

    // Explicit action / gesture locators
    if (v.startsWith("COORDINATE(") || /^coordinate$/i.test(v)) return "Coordinate";
    if (v.startsWith("SWIPE(") || /^scroll$/i.test(v)) return "Scroll";

    // Attribute-based locators → identification strategy (not always XPath)
    const attrMatch = v.match(/\[@([a-zA-Z0-9_-]+)\s*=/);
    if (attrMatch) {
        const attr = attrMatch[1].toLowerCase();
        if (attr === "resource-id" || attr === "resourceid" || attr === "id") return "Id";
        if (attr === "name") return "Name";
        if (attr === "content-desc" || attr === "contentdescription") return "AccessibilityId";
        if (attr === "label") return "Label";
        if (attr === "text") return "Text";
        if (attr === "value") return "Value";
        if (attr === "hint") return "Hint";
        if (attr === "class" || attr === "classname") return "ClassName";
    }

    // Pure class / tag index without attributes
    // e.g. (//android.widget.Button)[1] or //XCUIElementTypeButton
    if (/^\(?\/{1,2}[A-Za-z0-9._]+\)?(\[\d+\])?$/.test(v) || /^\(\/\/[A-Za-z0-9._]+\)\[\d+\]$/.test(v)) {
        return "ClassName";
    }

    // Indexed / nested / complex path
    return "XPath";
}

/** Normalize Android bounds= or iOS x/y/width/height into {x,y,width,height}. */
function parseNodeRect(node) {
    if (!node || typeof node.getAttribute !== 'function') return null;

    const bounds = node.getAttribute('bounds');
    if (bounds) {
        const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
        if (match) {
            const x = parseFloat(match[1]);
            const y = parseFloat(match[2]);
            const x2 = parseFloat(match[3]);
            const y2 = parseFloat(match[4]);
            return { x, y, width: x2 - x, height: y2 - y };
        }
    }

    const x = parseFloat(node.getAttribute('x'));
    const y = parseFloat(node.getAttribute('y'));
    const width = parseFloat(node.getAttribute('width'));
    const height = parseFloat(node.getAttribute('height'));
    if (!isNaN(x) && !isNaN(y) && !isNaN(width) && !isNaN(height)) {
        return { x, y, width, height };
    }
    return null;
}

/** Android XML bounds often differ from screenshot pixels; iOS sizes already match. */
function getXmlHierarchySize() {
    if (!window.xmlDoc) return { width: 0, height: 0 };

    let rootNode = window.xmlDoc.getElementsByTagName("hierarchy")[0];
    if (!rootNode) {
        rootNode = window.xmlDoc.getElementsByTagName("XCUIElementTypeApplication")[0];
    }

    if (rootNode) {
        const bounds = rootNode.getAttribute("bounds");
        if (bounds) {
            const match = bounds.match(/\[\d+,\d+\]\[(\d+),(\d+)\]/);
            if (match) {
                const width = parseFloat(match[1]);
                const height = parseFloat(match[2]);
                if (width > 0 && height > 0) return { width, height };
            }
        }
        const w = parseFloat(rootNode.getAttribute("width"));
        const h = parseFloat(rootNode.getAttribute("height"));
        if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) {
            return { width: w, height: h };
        }
    }

    const all = window.xmlDoc.getElementsByTagName("*");
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < all.length; i++) {
        const rect = parseNodeRect(all[i]);
        if (!rect) continue;
        maxX = Math.max(maxX, rect.x + rect.width);
        maxY = Math.max(maxY, rect.y + rect.height);
    }
    return { width: maxX, height: maxY };
}

function nodeRectOnScreenshot(node) {
    return parseNodeRect(node);
}

function getScreenshotScale(img) {
    const dims = getDeviceDimensions();
    const rect = img.getBoundingClientRect();
    return {
        scaleX: dims.width / rect.width,
        scaleY: dims.height / rect.height,
        invScaleX: rect.width / dims.width,
        invScaleY: rect.height / dims.height,
        dims,
        rect
    };
}

function getUiNodeName(node) {
    if (!node) return '';
    const cls = node.getAttribute && node.getAttribute('class');
    if (cls && String(cls).trim()) return String(cls).trim();
    return node.nodeName || '';
}

function isMeaningfulControlNode(node) {
    if (!node) return false;
    const tag = getUiNodeName(node);
    const name = node.nodeName || '';
    if (['AppiumAUT', 'XCUIElementTypeApplication', 'XCUIElementTypeWindow', 'hierarchy'].includes(name)) {
        return false;
    }

    const attr = (key) => {
        const v = node.getAttribute(key);
        return v && String(v).trim() !== '';
    };
    const flag = (key) => String(node.getAttribute(key) || '').toLowerCase() === 'true';

    const hasLabel = attr('label') || attr('name') || attr('value') || attr('content-desc') || attr('text') || attr('hint');
    const hasId = attr('resource-id') || attr('id');
    const interactive = flag('clickable') || flag('long-clickable') || flag('checkable') || flag('scrollable') || flag('focusable');
    const isWidget = /Button|EditText|TextView|ImageView|ImageButton|CheckBox|Switch|Radio|Spinner|CheckedTextView|Toggle|SeekBar|Chip|RecyclerView|ListView|GridView|FloatingActionButton|CompoundButton|StaticText|TextField|SearchField|Image$/i.test(tag);

    if (isWidget && (hasLabel || hasId || interactive || /TextView|ImageView|Button|EditText|StaticText|Image$/i.test(tag))) {
        return true;
    }
    if (hasLabel) return true;
    if (interactive && (hasId || hasLabel || /View$|Layout$|Other$|Cell$|node$/i.test(tag))) return true;
    if (hasId && interactive) return true;
    if (name.startsWith('XCUIElementType') && name !== 'XCUIElementTypeOther' && name !== 'XCUIElementTypeCell') return true;
    if (name === 'XCUIElementTypeOther' || name === 'XCUIElementTypeCell') return hasLabel;
    return false;
}

function mapControlType(nodeName) {
    const n = nodeName || '';
    if (n === 'XCUIElementTypeButton' || n === 'android.widget.Button' || n === 'android.widget.ImageButton') {
        return 'Button';
    }
    if (
        n === 'XCUIElementTypeTextField' ||
        n === 'XCUIElementTypeSecureTextField' ||
        n === 'XCUIElementTypeSearchField' ||
        n === 'XCUIElementTypeTextView' ||
        n === 'android.widget.EditText' ||
        n === 'android.widget.AutoCompleteTextView' ||
        n === 'android.widget.MultiAutoCompleteTextView'
    ) {
        return 'TextBox';
    }
    if (n === 'XCUIElementTypeStaticText' || n === 'android.widget.TextView' || n === 'android.widget.CheckedTextView') {
        return 'Label';
    }
    if (n === 'XCUIElementTypeImage' || n === 'android.widget.ImageView') {
        return 'Image';
    }
    if (
        n === 'XCUIElementTypeSwitch' ||
        n === 'android.widget.Switch' ||
        n === 'android.widget.ToggleButton' ||
        n === 'android.widget.CheckBox'
    ) {
        return 'CheckBox';
    }
    if (n === 'android.widget.RadioButton') {
        return 'RadioButton';
    }
    if (n === 'android.widget.Spinner') {
        return 'DropDownList';
    }
    return n.replace('XCUIElementType', '').replace('android.widget.', '').replace('android.view.', '') || 'Other';
}

function generateNodeFingerprint(node) {
    if (!node) return "";
    try {
        const getAttr = (n, attr) => n.getAttribute ? (n.getAttribute(attr) || "") : "";

        // Ancestors
        const ancestorClasses = [];
        let curr = node.parentNode;
        while (curr && curr.nodeType === 1) { // Node.ELEMENT_NODE
            ancestorClasses.unshift(curr.nodeName);
            curr = curr.parentNode;
        }
        if (curr && curr.nodeName === "hierarchy") {
            ancestorClasses.unshift("hierarchy");
        }

        // Siblings
        const siblingsClasses = [];
        const siblingsTexts = [];
        if (node.parentNode) {
            Array.from(node.parentNode.childNodes).forEach(child => {
                if (child.nodeType === 1) {
                    siblingsClasses.push(child.nodeName);
                    siblingsTexts.push(getAttr(child, "text") || getAttr(child, "label") || getAttr(child, "name") || "");
                }
            });
        }

        const fingerprint = {
            "class": node.nodeName,
            "resourceId": getAttr(node, "resource-id"),
            "text": getAttr(node, "text") || getAttr(node, "label") || getAttr(node, "name") || "",
            "contentDesc": getAttr(node, "content-desc"),
            "package": getAttr(node, "package"),
            "clickable": getAttr(node, "clickable"),
            "enabled": getAttr(node, "enabled"),
            "parentClass": node.parentNode ? node.parentNode.nodeName : null,
            "ancestorClasses": ancestorClasses,
            "previousSiblingClass": node.previousElementSibling ? node.previousElementSibling.nodeName : null,
            "nextSiblingClass": node.nextElementSibling ? node.nextElementSibling.nodeName : null,
            "childCount": node.children ? node.children.length : 0,
            "context": {
                "siblings": siblingsClasses,
                "texts": siblingsTexts
            }
        };
        return JSON.stringify(fingerprint, null, 4);
    } catch (e) {
        console.error("Error generating fingerprint:", e);
        return "";
    }
}

function getInputControlValue(node) {
    if (!node) return '';
    const textInputs = [
        'XCUIElementTypeTextField',
        'XCUIElementTypeSecureTextField',
        'XCUIElementTypeSearchField',
        'XCUIElementTypeTextView',
        'android.widget.EditText',
        'android.widget.AutoCompleteTextView',
        'android.widget.MultiAutoCompleteTextView'
    ];
    if (!textInputs.includes(node.nodeName)) return '';

    if (node.nodeName.startsWith('android.')) {
        return node.getAttribute('text') || '';
    }

    let controlValue = node.getAttribute('value') || '';
    const label = node.getAttribute('label') || '';
    const name = node.getAttribute('name') || '';
    const placeholder = node.getAttribute('placeholderValue') || '';
    if (controlValue === placeholder || controlValue === label || controlValue === name) {
        controlValue = '';
    }
    return controlValue;
}

function getLoadPageTags() {
    if (isAndroidPlatform()) {
        return [
            'android.widget.Button',
            'android.widget.ImageButton',
            'android.widget.TextView',
            'android.widget.EditText',
            'android.widget.ImageView',
            'android.widget.CheckBox',
            'android.widget.RadioButton',
            'android.widget.Switch',
            'android.widget.ToggleButton',
            'android.widget.Spinner',
            'android.widget.CheckedTextView'
        ];
    }
    return [
        'XCUIElementTypeButton',
        'XCUIElementTypeStaticText',
        'XCUIElementTypeTextField',
        'XCUIElementTypeSecureTextField',
        'XCUIElementTypeSearchField',
        'XCUIElementTypeImage',
        'XCUIElementTypeTextView'
    ];
}

function buildLocatorCandidates(node) {
    const tagName = node.nodeName;
    const candidates = [];
    const attrs = isAndroidPlatform() || tagName.startsWith('android.')
        ? ['resource-id', 'id', 'text', 'content-desc', 'hint']
        : ['name', 'label', 'value', 'id'];

    for (const attr of attrs) {
        const val = node.getAttribute(attr);
        if (val && val.trim() !== '') {
            const cleanVal = val.trim().replace(/"/g, '');
            const xpath = `//${tagName}[@${attr}="${cleanVal}"]`;
            if (!candidates.includes(xpath)) candidates.push(xpath);
        }
    }

    if (candidates.length === 0) {
        candidates.push(`//${tagName}`);
    }
    return candidates;
}

// Show/hide Android fields (package/activity) vs iOS field (bundle ID) + set automationName.
// Called on platform change and after Reset so the form matches the selected platform.
function updatePlatformUI() {
    const selectedPlatform = getSelectedPlatform();
    const automationNameInput = document.getElementById('automationName');
    const bundleIdDiv = document.getElementById('bndlID');
    const bundleIdInput = document.getElementById('bundleID');
    const appPkgDiv = document.getElementById('appPkg');
    const appPkgInput = document.getElementById('apppackage');
    const appActvtyDiv = document.getElementById('appActvty');
    const appActvtyInput = document.getElementById('appactivity');
    const pfVersion = document.getElementById('pfVersion');
    const platformVersionInput = document.getElementById('platformversion');
    const automationeName = document.getElementById('automatione_name');
    const udidLabel = document.getElementById('udidLabel');
    const udidInput = document.getElementById('udid');

    const statPlatform = document.getElementById('configStatPlatform');
    const statEngine = document.getElementById('configStatEngine');

    if (pfVersion) pfVersion.style.display = 'block';
    if (automationeName) automationeName.style.display = 'block';

    if (selectedPlatform === 'Android') {
        if (automationNameInput) automationNameInput.value = 'UiAutomator2';
        if (platformVersionInput && (!platformVersionInput.dataset.userEdited || platformVersionInput.value === '17.2')) {
            platformVersionInput.value = '14';
        }
        if (udidLabel) udidLabel.textContent = 'Device Identifier (Serial / ID)';
        if (udidInput) {
            udidInput.placeholder = 'Android serial / device ID..';
            udidInput.disabled = false;
        }
        if (bundleIdDiv) bundleIdDiv.style.display = 'none';
        if (bundleIdInput) bundleIdInput.disabled = true;
        if (appPkgDiv) appPkgDiv.style.display = 'block';
        if (appPkgInput) appPkgInput.disabled = false;
        if (appActvtyDiv) appActvtyDiv.style.display = 'block';
        if (appActvtyInput) appActvtyInput.disabled = false;
        if (statPlatform) statPlatform.textContent = 'Android';
        if (statEngine) statEngine.textContent = 'UiAutomator2';
    } else {
        if (automationNameInput) automationNameInput.value = 'XCUITest';
        if (platformVersionInput && (!platformVersionInput.dataset.userEdited || platformVersionInput.value === '14')) {
            platformVersionInput.value = '17.2';
        }
        if (udidLabel) udidLabel.textContent = 'Device Identifier (UDID)';
        if (udidInput) {
            udidInput.placeholder = 'iOS UDID..';
            udidInput.disabled = false;
        }
        if (bundleIdDiv) bundleIdDiv.style.display = 'block';
        if (bundleIdInput) bundleIdInput.disabled = false;
        if (appPkgDiv) appPkgDiv.style.display = 'none';
        if (appPkgInput) appPkgInput.disabled = true;
        if (appActvtyDiv) appActvtyDiv.style.display = 'none';
        if (appActvtyInput) appActvtyInput.disabled = true;
        if (statPlatform) statPlatform.textContent = 'iOS';
        if (statEngine) statEngine.textContent = 'XCUITest';
    }

    if (automationNameInput) automationNameInput.disabled = false;
    const appiumUrlInput = document.getElementById('appiumurl');
    if (appiumUrlInput) appiumUrlInput.disabled = false;
    if (platformVersionInput) platformVersionInput.disabled = false;

    // After Reset, keep only Platform / App / Device Name editable
    if (typeof resetFormLockActive !== 'undefined' && resetFormLockActive && typeof lockSecondaryLaunchFields === 'function') {
        lockSecondaryLaunchFields();
    }
    if (typeof updateConfigDashboard === 'function') {
        updateConfigDashboard();
    }
}

function getDeviceDimensions() {
    const xml = getXmlHierarchySize();
    if (xml.width > 0 && xml.height > 0) {
        return xml;
    }

    const img = document.getElementById("screenshot");
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
        return { width: img.naturalWidth, height: img.naturalHeight };
    }

    return { width: 1080, height: 2400 };
}

// --- Platform dropdown change ---
// Gate Android ↔ iOS switch: refresh devices via IPC; if none for target, stay put + alert.
// Windows: block IOS entirely (no XCUITest in Windows packages).
(function bindPlatformNameChange() {
    const platformSelect = document.getElementById('platformname');
    if (!platformSelect || platformSelect.tagName !== 'SELECT') {
        // Windows readonly Android field — no platform switching UI
        if (typeof updatePlatformUI === 'function') updatePlatformUI();
        return;
    }
    platformSelect.addEventListener('change', async function() {
    const platformSelect = this;
    const nextPlatform = platformSelect.value;
    const previousPlatform = (typeof lastSelectedPlatform !== 'undefined' && lastSelectedPlatform)
        ? lastSelectedPlatform
        : nextPlatform;

    // Programmatic switch from device load/selection — skip device gate
    if (typeof applyingPlatformFromDevice !== 'undefined' && applyingPlatformFromDevice) {
        lastSelectedPlatform = nextPlatform;
        updatePlatformUI();
        if (typeof resetFormLockActive !== 'undefined' && resetFormLockActive) {
            lockSecondaryLaunchFields();
        }
        return;
    }

    if (platformSwitchInProgress) {
        platformSelect.value = previousPlatform;
        return;
    }

    // Same platform re-selected
    if (normalizePlatformName(nextPlatform) === normalizePlatformName(previousPlatform)) {
        lastSelectedPlatform = nextPlatform;
        updatePlatformUI();
        if (typeof resetFormLockActive !== 'undefined' && resetFormLockActive) {
            lockSecondaryLaunchFields();
        }
        return;
    }

    // Windows packages have no XCUITest — block iOS platform selection
    if (process.platform === 'win32' && normalizePlatformName(nextPlatform) === 'IOS') {
        platformSelect.value = previousPlatform;
        showCustomAlert(
            "iOS Not Available",
            "This Windows build scrapes Android only. Use the macOS app for iOS Simulator / iPhone.",
            "warning"
        );
        return;
    }

    // Do NOT switch UI yet — revert dropdown, show blur loader, then check
    platformSwitchInProgress = true;
    platformSelect.value = previousPlatform;
    platformSelect.disabled = true;
    showPlatformSwitchLoader(
        normalizePlatformName(nextPlatform) === 'IOS'
            ? 'Checking for iOS Simulator / iPhone...'
            : 'Checking for Android emulator / device...'
    );

    try {
        const allDevices = await refreshConnectedDevicesList();
        const matching = devicesForPlatform(nextPlatform, allDevices);

        if (!matching.length) {
            lastSelectedPlatform = previousPlatform;
            updatePlatformUI();
            if (typeof resetFormLockActive !== 'undefined' && resetFormLockActive) {
                lockSecondaryLaunchFields();
            }

            const isTargetIos = normalizePlatformName(nextPlatform) === 'IOS';
            const toLabel = isTargetIos ? 'iOS' : 'Android';
            const deviceHint = isTargetIos
                ? 'Please open an iOS Simulator or connect an iPhone, then try again.'
                : 'Please launch an Android emulator or connect a physical device, then try again.';

            hidePlatformSwitchLoader();
            showCustomAlert(
                "No Device Connected",
                `No active <b>${toLabel}</b> emulator or device was detected.<br><br>${deviceHint}`,
                "warning"
            );
            return;
        }

        // Check passed — now apply the platform switch
        applyingPlatformFromDevice = true;
        platformSelect.value = nextPlatform;
        lastSelectedPlatform = nextPlatform;
        applyingPlatformFromDevice = false;

        const selected = populateDeviceDropdown(matching);
        updatePlatformUI();
        if (typeof resetFormLockActive !== 'undefined' && resetFormLockActive) {
            lockSecondaryLaunchFields();
        }

        if (selected) {
            if (normalizePlatformName(nextPlatform) === 'Android') {
                try {
                    const ver = await ipcRenderer.invoke("get-android-version", selected.id);
                    if (ver) {
                        const pv = document.getElementById('platformversion');
                        if (pv) {
                            pv.value = ver;
                            pv.dataset.userEdited = 'true';
                        }
                    }
                } catch (_) {}
            }
            ipcRenderer.send("get-installed-apps", selected);
        }
    } catch (err) {
        console.error("Platform switch device check failed:", err);
        platformSelect.value = previousPlatform;
        lastSelectedPlatform = previousPlatform;
        updatePlatformUI();
        showCustomAlert(
            "Device Check Failed",
            "Could not verify connected devices. Staying on the previous platform.",
            "warning"
        );
    } finally {
        hidePlatformSwitchLoader();
        platformSwitchInProgress = false;
        // Keep platform editable when there is no active session
        if (!driver) {
            platformSelect.disabled = false;
            if (typeof resetFormLockActive !== 'undefined' && resetFormLockActive) {
                ["platformname", "appname", "devicename"].forEach((id) => {
                    const el = document.getElementById(id);
                    if (el) el.disabled = false;
                });
                lockSecondaryLaunchFields();
            }
        }
    }
});
})();

const platformVersionField = document.getElementById('platformversion');
if (platformVersionField) {
    platformVersionField.addEventListener('input', function () {
        this.dataset.userEdited = 'true';
    });
}