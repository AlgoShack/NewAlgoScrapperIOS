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
     * FEATURE LOGIC (OS / device parity — do not fork by win32/darwin)
     *   Create Feature, name format rules, global name uniqueness, “already created”
     *   area checks, screen signatures, table rename, and repo feature counts share
     *   ONE code path for: Windows Android, Mac Android, Mac iOS — real device,
     *   emulator, or simulator. Only locators / page-source capture differ by platform.
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
    window.registeredFeatureAreas = registeredFeatureAreas;
    window.activeProjectSessionMode = null;
    window.activeResumedProjectKey = null;
    window.activeResumedAppName = null;
    window._resumedProjectSnapshot = null;

    function isFeatureAreaApplicableToPage(area, targetPageName) {
        // Page name is optional metadata only — uniqueness is by screen, not page name.
        // Keep helper for callers that still pass a page, but never block cross-screen features.
        if (!area || !area.rect) return false;
        const target = (targetPageName || '').trim().toLowerCase();
        if (!target || target === 'all') return true;
        const areaPage = (area.pageName || '').trim().toLowerCase();
        if (!areaPage || areaPage === 'all') return true;
        return areaPage === target;
    }
    window.isFeatureAreaApplicableToPage = isFeatureAreaApplicableToPage;

    function computeScreenSignature(doc) {
        if (!doc) return "";
        try {
            const nodes = (typeof extractContentNodes === 'function') ? extractContentNodes(doc) : [];
            if (!nodes || nodes.length === 0) return "";

            const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
            const textKeys = [];
            const geoKeys = [];
            nodes.forEach(n => {
                if (!n || !n.key) return;
                if (n.text) textKeys.push(n.key);
                else geoKeys.push(n.key);
            });

            // Prefer labeled controls; pad with geometry keys when the screen is sparse
            const primary = uniq(textKeys);
            const secondary = uniq(geoKeys);
            const keyPool = (primary.length >= 8 ? primary : primary.concat(secondary));
            const keyPart = keyPool.slice(0, 48).sort().join("||");

            // Y-band layout fingerprint — separates screens that share the same chrome labels
            const bandPart = uniq(nodes
                .filter(n => n && n.text)
                .map(n => `${Math.round((n.y || 0) / 80)}:${n.key}`)
            ).sort().slice(0, 36).join(",");

            return `${keyPart}##${nodes.length}##${bandPart}`;
        } catch (e) {
            return "";
        }
    }
    window.computeScreenSignature = computeScreenSignature;

    function parseScreenSignatureParts(sig) {
        const s = String(sig || '');
        if (!s) return { keys: [], bands: [], count: 0 };
        if (s.includes('##')) {
            const parts = s.split('##');
            return {
                keys: (parts[0] || '').split('||').map(x => x.trim()).filter(Boolean),
                count: parseInt(parts[1], 10) || 0,
                bands: (parts[2] || '').split(',').map(x => x.trim()).filter(Boolean)
            };
        }
        // Legacy signatures were plain key||key||key
        const keys = s.split('||').map(x => x.trim()).filter(Boolean);
        return { keys, bands: [], count: keys.length };
    }

    function jaccardSimilarity(aKeys, bKeys) {
        if (!aKeys.length || !bKeys.length) return 0;
        const bSet = new Set(bKeys);
        const inter = aKeys.filter(k => bSet.has(k)).length;
        const union = new Set(aKeys.concat(bKeys)).size;
        return union > 0 ? (inter / union) : 0;
    }

    function screenSignatureSimilarity(sigA, sigB) {
        if (!sigA || !sigB) return 0;
        if (sigA === sigB) return 1;
        const a = parseScreenSignatureParts(sigA);
        const b = parseScreenSignatureParts(sigB);
        const keySim = jaccardSimilarity(a.keys, b.keys);
        const countA = a.count || a.keys.length;
        const countB = b.count || b.keys.length;
        const countRatio = Math.min(countA, countB) / Math.max(countA, countB, 1);
        // Legacy signatures have no layout bands — lean on keys so validation still works after refresh
        if (!a.bands.length || !b.bands.length) {
            return (keySim * 0.85) + (countRatio * 0.15);
        }
        const bandSim = jaccardSimilarity(a.bands, b.bands);
        // Layout bands weigh heavily so shared nav chrome alone cannot pass as same screen
        return (keySim * 0.4) + (bandSim * 0.45) + (countRatio * 0.15);
    }
    window.screenSignatureSimilarity = screenSignatureSimilarity;

    /** Same UI screen? Tolerates refresh drift; rejects clearly different pages. */
    function isSameFeatureScreen(area, doc) {
        if (!area) return false;
        const currentDoc = doc || window.xmlDoc;
        if (!currentDoc) return true;
        const currentSig = computeScreenSignature(currentDoc);

        if (area.screenSignature && currentSig) {
            const sim = screenSignatureSimilarity(area.screenSignature, currentSig);
            // Same screen (including mild refresh drift)
            if (sim >= 0.68) return true;
            // Clearly navigated to another page
            if (sim < 0.40) return false;

            // Ambiguous: tie-break with content still present in the feature rect
            if (Array.isArray(area.screenContentKeys) && area.screenContentKeys.length > 0 && area.rect) {
                const currentKeys = computeScreenContentKeys(currentDoc, area.rect);
                if (currentKeys.length > 0) {
                    const overlap = area.screenContentKeys.filter(k => currentKeys.includes(k)).length;
                    const ratio = overlap / Math.min(area.screenContentKeys.length, currentKeys.length);
                    return ratio >= 0.30;
                }
            }
            return false;
        }

        if (Array.isArray(area.screenContentKeys) && area.screenContentKeys.length > 0 && area.rect) {
            const currentKeys = computeScreenContentKeys(currentDoc, area.rect);
            if (currentKeys.length > 0) {
                const overlap = area.screenContentKeys.filter(k => currentKeys.includes(k)).length;
                const ratio = overlap / Math.min(area.screenContentKeys.length, currentKeys.length);
                return ratio >= 0.45;
            }
            return false;
        }

        // No screen identity on the saved feature: never bind onto a known hierarchy
        if (currentSig) return false;
        return true;
    }
    window.isSameFeatureScreen = isSameFeatureScreen;

    /** Keep live feature screen stamps aligned after refresh so validation keeps working. */
    function realignLiveFeatureScreensToCurrentDoc() {
        const doc = window.xmlDoc;
        if (!doc) return;
        const currentSig = computeScreenSignature(doc);
        if (!currentSig) return;
        (registeredFeatureAreas || []).forEach(area => {
            if (!area || !area.screenSignature) return;
            if (!isSameFeatureScreen(area, doc)) return;
            area.screenSignature = currentSig;
            if (area.rect && typeof computeScreenContentKeys === 'function') {
                const keys = computeScreenContentKeys(doc, area.rect);
                if (keys && keys.length) area.screenContentKeys = keys;
            }
        });
        window.registeredFeatureAreas = registeredFeatureAreas;
    }
    window.realignLiveFeatureScreensToCurrentDoc = realignLiveFeatureScreensToCurrentDoc;

    function noteDeviceScreenChanged() {
        try {
            const sig = computeScreenSignature(window.xmlDoc);
            const prev = window._lastDeviceScreenSignature || '';
            window._lastDeviceScreenSignature = sig || '';
            if (prev && sig && screenSignatureSimilarity(prev, sig) < 0.40) {
                if (typeof clearOverlay === 'function') clearOverlay();
            } else if (sig) {
                realignLiveFeatureScreensToCurrentDoc();
            }
        } catch (_) {}
    }
    window.noteDeviceScreenChanged = noteDeviceScreenChanged;

    function computeScreenContentKeys(doc, rect) {
        if (!doc || !rect) return [];
        try {
            const nodes = (typeof extractContentNodes === 'function') ? extractContentNodes(doc) : [];
            if (!nodes || nodes.length === 0) return [];
            return nodes
                .filter(n => {
                    const cx = n.x + n.width / 2;
                    const cy = n.y + n.height / 2;
                    return cx >= rect.x - 4 && cx <= rect.x + rect.width + 4 &&
                           cy >= rect.y - 4 && cy <= rect.y + rect.height + 4;
                })
                .map(n => n.key)
                .filter(Boolean);
        } catch (e) {
            return [];
        }
    }
    window.computeScreenContentKeys = computeScreenContentKeys;

    function extractNodeUniqueIdentifier(node, clickX, clickY) {
        if (!node || node.nodeType !== 1) {
            return (typeof clickX === 'number' && typeof clickY === 'number')
                ? `COORDINATE(${Math.round(clickX)},${Math.round(clickY)})`
                : "";
        }

        const tagName = node.nodeName;

        // Android attributes
        const resourceId = (node.getAttribute("resource-id") || node.getAttribute("id") || "").trim();
        const text = (node.getAttribute("text") || "").trim();
        const contentDesc = (node.getAttribute("content-desc") || "").trim();

        // iOS attributes
        const name = (node.getAttribute("name") || "").trim();
        const label = (node.getAttribute("label") || "").trim();
        const value = (node.getAttribute("value") || "").trim();
        const identifier = (node.getAttribute("identifier") || "").trim();

        if (resourceId) return `${tagName}[id=${resourceId}]`;
        if (identifier) return `${tagName}[id=${identifier}]`;
        if (name) return `${tagName}[name=${name}]`;
        if (label) return `${tagName}[label=${label}]`;
        if (contentDesc) return `${tagName}[desc=${contentDesc}]`;
        if (text) return `${tagName}[text=${text}]`;
        if (value) return `${tagName}[value=${value}]`;

        if (typeof getAllPossibleXPaths === 'function') {
            const xpaths = getAllPossibleXPaths(node);
            if (xpaths && xpaths.length > 0) return xpaths[0];
        }

        return (typeof clickX === 'number' && typeof clickY === 'number')
            ? `${tagName}@(${Math.round(clickX)},${Math.round(clickY)})`
            : `${tagName}`;
    }
    window.extractNodeUniqueIdentifier = extractNodeUniqueIdentifier;

    function isNodeRelatedToFeature(node, area) {
        if (!node || !area) return false;
        try {
            const uid = extractNodeUniqueIdentifier(node);
            if (uid && area.uniqueIdentifier && uid === area.uniqueIdentifier) return true;

            if (area.xpaths && Array.isArray(area.xpaths) && typeof getAllPossibleXPaths === 'function') {
                const xpaths = getAllPossibleXPaths(node);
                if (xpaths && xpaths.some(xp => area.xpaths.includes(xp))) return true;
            }

            // Check if node is child or descendant of feature element
            let curr = node.parentNode;
            while (curr && curr.nodeType === 1) {
                const aId = extractNodeUniqueIdentifier(curr);
                if (aId && area.uniqueIdentifier && aId === area.uniqueIdentifier) return true;
                if (area.xpaths && Array.isArray(area.xpaths) && typeof getAllPossibleXPaths === 'function') {
                    const aXPaths = getAllPossibleXPaths(curr);
                    if (aXPaths && aXPaths.some(xp => area.xpaths.includes(xp))) return true;
                }
                curr = curr.parentNode;
            }
        } catch (e) {}
        return false;
    }
    window.isNodeRelatedToFeature = isNodeRelatedToFeature;

    function isFeatureIdentifierPresentOnScreen(doc, area) {
        if (!doc || !area) return false;
        if (!area.uniqueIdentifier || area.uniqueIdentifier.startsWith("COORDINATE")) return true;
        try {
            const allNodes = doc.getElementsByTagName("*");
            for (let i = 0; i < allNodes.length; i++) {
                const n = allNodes[i];
                const uid = extractNodeUniqueIdentifier(n);
                if (uid && uid === area.uniqueIdentifier) return true;
                if (area.xpaths && Array.isArray(area.xpaths) && typeof getAllPossibleXPaths === 'function') {
                    const xps = getAllPossibleXPaths(n);
                    if (xps && xps.some(xp => area.xpaths.includes(xp))) return true;
                }
            }
        } catch (e) {}
        return false;
    }
    window.isFeatureIdentifierPresentOnScreen = isFeatureIdentifierPresentOnScreen;

    function isFeatureAreaApplicableToCurrentScreen(area, currentScreenDoc, x, y, pageNameOverride) {
        if (!area || !area.rect) return false;

        const doc = currentScreenDoc || window.xmlDoc;
        if (!doc) return true;

        // Hard gate: feature only lives on the device screen it was created on
        if (!isSameFeatureScreen(area, doc)) {
            return false;
        }

        // Unique Identifier Screen Presence (skip coordinate-only ids)
        if (area.uniqueIdentifier && !String(area.uniqueIdentifier).startsWith("COORDINATE")) {
            if (!isFeatureIdentifierPresentOnScreen(doc, area)) {
                return false;
            }
        }

        // Cursor hover node identity check — only when we have a real element id
        if (area.uniqueIdentifier && !String(area.uniqueIdentifier).startsWith("COORDINATE")
            && typeof x === 'number' && typeof y === 'number' && typeof findHoveredNode === 'function') {
            const currentNode = findHoveredNode(x, y);
            if (currentNode) {
                const isRelated = isNodeRelatedToFeature(currentNode, area);
                if (!isRelated) {
                    return false;
                }
            }
        }

        return true;
    }
    window.isFeatureAreaApplicableToCurrentScreen = isFeatureAreaApplicableToCurrentScreen;

    function applyTableFeatureSubFeature(cell, newName) {
        if (!cell || !newName) return;
        const trimmed = String(newName).trim();
        cell.innerText = trimmed;
        const lower = trimmed.toLowerCase();
        const tr = cell.closest('tr');
        const pageCell = tr ? tr.querySelector('.page') : null;
        const pageName = (pageCell && pageCell.innerText.trim())
            || ((typeof getActiveHomePageName === 'function') ? getActiveHomePageName() : '');

        const alreadyRegistered = (registeredFeatureAreas || []).some(a =>
            a && a.name && String(a.name).trim().toLowerCase() === lower && isFeatureAreaApplicableToPage(a, pageName)
        );
        if (!alreadyRegistered) {
            let rect = null;
            try {
                rect = tr && tr.dataset.rect ? JSON.parse(tr.dataset.rect) : null;
            } catch (_) {
                rect = null;
            }
            registeredFeatureAreas.push({
                rect: rect,
                name: trimmed,
                fullPage: false,
                pageName: pageName,
                screenSignature: computeScreenSignature(window.xmlDoc),
                screenContentKeys: computeScreenContentKeys(window.xmlDoc, rect),
                nodeText: (tr && tr.querySelector('.ControlName')) ? tr.querySelector('.ControlName').innerText.trim() : ""
            });
            window.registeredFeatureAreas = registeredFeatureAreas;
            if (typeof window.saveFeatureToRepo === 'function') {
                window.saveFeatureToRepo(trimmed, rect, false, null, null, pageName, computeScreenSignature(window.xmlDoc), computeScreenContentKeys(window.xmlDoc, rect));
            }
        }
        if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
    }
    window.applyTableFeatureSubFeature = applyTableFeatureSubFeature;

    function applyTableFeatureRenameAll(oldName, newName, pageName) {
        const oldLower = String(oldName || '').trim().toLowerCase();
        const trimmed = String(newName || '').trim();
        if (!oldLower || !trimmed) return;
        const currentSig = computeScreenSignature(window.xmlDoc);

        document.querySelectorAll('#myTable .featureName').forEach(cell => {
            if ((cell.innerText || '').replace(/\u00a0/g, ' ').trim().toLowerCase() !== oldLower) return;
            const tr = cell.closest('tr');
            const rowSig = tr && tr.dataset ? (tr.dataset.screenSignature || '') : '';
            // Only rename rows from the same device screen (Page Name can stay unchanged)
            if (rowSig && currentSig && screenSignatureSimilarity(rowSig, currentSig) < 0.68) return;
            if (!rowSig && currentSig) {
                // legacy rows without signature: only touch if feature area matches current screen
                const rect = (() => { try { return tr && tr.dataset.rect ? JSON.parse(tr.dataset.rect) : null; } catch (_) { return null; } })();
                const areaHit = (registeredFeatureAreas || []).some(a =>
                    a && a.name && a.name.trim().toLowerCase() === oldLower
                    && isSameFeatureScreen(a, window.xmlDoc)
                    && (!rect || (a.rect && Math.abs((a.rect.x || 0) - (rect.x || 0)) < 4))
                );
                if (!areaHit) return;
            }
            cell.innerText = trimmed;
        });
        (registeredFeatureAreas || []).forEach(area => {
            if (!area || !area.name) return;
            if (String(area.name).trim().toLowerCase() !== oldLower) return;
            if (!isSameFeatureScreen(area, window.xmlDoc)) return;
            area.name = trimmed;
        });
        window.registeredFeatureAreas = registeredFeatureAreas;
        if (typeof window.renameFeatureInRepo === 'function') {
            window.renameFeatureInRepo(oldName, trimmed, pageName, currentSig);
        }
        if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
    }
    window.applyTableFeatureRenameAll = applyTableFeatureRenameAll;

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

    /** Returns true if Launch Application button is allowed to be enabled. */
    function canEnableLaunch() {
        if (launchedViaProtocol) return true;
        return hasConnectedToken();
    }

    /** Enable/disable #Run and sync button styling. */
    function setLaunchEnabled(enabled) {
        const runBtn = document.getElementById("Run");
        if (!runBtn) return;
        runBtn.disabled = !enabled;
        runBtn.style.backgroundColor = enabled ? "#2F8BCC" : "#B6B6B4";
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

    function showErrorPopup(title, error, hint = "") {
        const titleElem = document.getElementById('launchErrorTitle');
        const logElem = document.getElementById('launchErrorLog');
        const hintElem = document.getElementById('launchErrorHint');
        const popupElem = document.getElementById('launchErrorPopup');
        const overlayElem = document.getElementById('overlay');
        const appRunningPopup = document.getElementById('AppRunningPopup');

        if (appRunningPopup) appRunningPopup.style.display = 'none';
        if (overlayElem) overlayElem.style.display = 'block';

        if (titleElem) titleElem.innerText = title || "Application Launch Error";
        if (hintElem) {
            if (hint) {
                hintElem.innerHTML = `<b>Recommended Action:</b> ${escapeDummyHtml(hint)}`;
                hintElem.style.display = 'block';
            } else {
                hintElem.style.display = 'none';
            }
        }
        if (logElem) {
            let logText = "";
            if (error && error.message) {
                logText = error.message;
                if (error.stack && error.stack !== error.message) {
                    logText += "\n\n--- Stack Trace ---\n" + error.stack;
                }
            } else {
                logText = String(error || "No log recorded.");
            }
            logElem.innerText = logText;
        }

        if (popupElem) popupElem.style.display = 'block';

        const okBtn = document.getElementById("okay_button");
        if (okBtn) {
            okBtn.onclick = () => {
                if (popupElem) popupElem.style.display = 'none';
                if (overlayElem) overlayElem.style.display = 'none';
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

    function updateDeviceFrameStyle(platform) {
        const currentPlatform = platform || (typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : (document.getElementById('platformname')?.value || 'Android'));
        const isIos = (typeof normalizePlatformName === 'function' ? normalizePlatformName(currentPlatform) : (String(currentPlatform).toUpperCase() === 'IOS')) === 'IOS';
        const phoneStage = document.querySelector('.phone-stage');
        const phoneBezel = document.querySelector('.phone-bezel');

        if (phoneStage) {
            phoneStage.classList.toggle('device-stage-ios', isIos);
            phoneStage.classList.toggle('device-stage-android', !isIos);
        }
        if (phoneBezel) {
            phoneBezel.classList.toggle('device-bezel-ios', isIos);
            phoneBezel.classList.toggle('device-bezel-android', !isIos);
            phoneBezel.style.aspectRatio = isIos ? "9 / 19.5" : "9 / 20";
            phoneBezel.style.width = "";
        }
    }

    /**
     * Phone preview placeholder messages (info | warning | error | loading).
     * Keeps icon + colors consistent across launch / reset / session errors.
     */
    function showDummyDeviceMessage(options = {}) {
        const dummy = document.getElementById("dummyDevice");
        if (!dummy) return;

        updateDeviceFrameStyle();

        let theme = options.theme || 'info';
        let title = options.title || getIdleDummyTitle();
        let detail = options.detail || options.desc || '';

        const rawTitle = String(title || '');
        const rawDetail = String(detail || '');
        const lowerTitle = rawTitle.toLowerCase();
        const lowerDetail = rawDetail.toLowerCase();

        // Detect loading: ALWAYS use the user's loader GIF only
        if (theme === 'loading' || lowerTitle.includes('starting session') || lowerTitle.includes('launching')) {
            theme = 'loading';
            if (!title || lowerTitle.includes('starting session')) title = 'Starting session and loading screen…';
            dummy.style.display = "block";
            dummy.innerHTML = `
                <div class="phone-welcome-overlay phone-welcome-loading">
                    <img class="phone-welcome-loader" src="icon/load-8510_256.gif" alt="" />
                    <p id="dummyMainText" class="phone-welcome-title">${escapeDummyHtml(title)}</p>
                    ${detail ? `<p id="dummyErrorText" class="phone-welcome-detail">${escapeDummyHtml(detail)}</p>` : `<p id="dummyErrorText" class="phone-welcome-detail" style="display:none;"></p>`}
                </div>
            `;
            return;
        }

        // Detect app in background
        if (lowerTitle.includes('session interrupted') || lowerDetail.includes('closed or running in the background') || lowerTitle.includes('in the background')) {
            theme = 'warning';
            title = 'Application is closed or running in the background.';
            detail = 'Keep the app open, then click Launch Application to reconnect.';
        } else if (lowerTitle.includes('disconnected') || lowerDetail.includes('disconnected') || lowerTitle.includes('offline')) {
            theme = 'error';
            title = 'Device Disconnected';
            detail = 'Please reconnect your device and click Launch Application.';
        }

        let svgPath = '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>';
        if (theme === 'warning') {
            svgPath = '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>';
        } else if (theme === 'error') {
            svgPath = '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>';
        }

        dummy.style.display = "block";
        dummy.innerHTML = `
            <div class="phone-welcome-overlay phone-welcome-${theme}">
                <svg id="dummyIcon" class="info-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    ${svgPath}
                </svg>
                <p id="dummyMainText" class="phone-welcome-title">${escapeDummyHtml(title)}</p>
                <p id="dummyErrorText" class="phone-welcome-detail" style="${detail ? 'display:block;' : 'display:none;'}">${escapeDummyHtml(detail)}</p>
            </div>
        `;
    }

    function getIdleDummyTitle() {
        return 'Select platform, app and device, then click Launch Application.';
    }

    function resetLaunchPlaceholder(message, theme = 'error') {
        if (!message) {
            showDummyDeviceMessage({ theme: 'info', title: getIdleDummyTitle(), detail: '' });
            return;
        }

        let title = message;
        let detail = '';
        if (message.includes(':')) {
            const parts = message.split(':');
            title = parts[0].trim();
            detail = parts.slice(1).join(':').trim();
        }

        showDummyDeviceMessage({
            theme,
            title: title || 'Launch Notice',
            detail: detail
        });
    }

    let resetFormLockActive = false;

    function setPlatformAppDeviceEditable(editable) {
        const isLocked = !editable;
        ["platformname", "appname", "devicename"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.disabled = isLocked;
                if (typeof el._rebuildCustomSelect === 'function') {
                    el._rebuildCustomSelect();
                }
            }
        });
    }
    window.setPlatformAppDeviceEditable = setPlatformAppDeviceEditable;

    function lockLaunchForm() {
        setPlatformAppDeviceEditable(false);
        ["udid", "appiumurl", "platformversion", "automationName", "bundleID", "apppackage", "appactivity"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = true;
        });
        setLaunchEnabled(false);
    }
    window.lockLaunchForm = lockLaunchForm;

    function unlockLaunchForm() {
        resetFormLockActive = false;
        setPlatformAppDeviceEditable(true);
        ["udid", "appiumurl", "platformversion", "automationName", "bundleID", "apppackage", "appactivity"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = false;
        });
        setLaunchEnabled(canEnableLaunch());
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
        const infoWrapper = document.querySelector('.info-icon-wrapper');

        if (badgeWrapper) {
            badgeWrapper.classList.toggle('is-disabled', !enabled);
            if (!enabled) {
                badgeWrapper.style.setProperty('cursor', 'not-allowed', 'important');
                badgeWrapper.style.setProperty('opacity', '0.85', 'important');
                badgeWrapper.style.setProperty('border-color', '#cbd5e1', 'important');
                if (badgeLabel) {
                    badgeLabel.style.setProperty('background-color', '#94a3b8', 'important');
                }
                if (pageNameInput) {
                    pageNameInput.disabled = true;
                    pageNameInput.style.setProperty('pointer-events', 'none', 'important');
                }
                if (infoWrapper) {
                    infoWrapper.style.setProperty('display', 'none', 'important');
                    infoWrapper.style.setProperty('pointer-events', 'none', 'important');
                    infoWrapper.style.setProperty('opacity', '0', 'important');
                    infoWrapper.style.setProperty('visibility', 'hidden', 'important');
                }
            } else {
                badgeWrapper.style.removeProperty('pointer-events');
                badgeWrapper.style.removeProperty('cursor');
                badgeWrapper.style.removeProperty('opacity');
                badgeWrapper.style.setProperty('border-color', '#2F8BCC', 'important');
                if (badgeLabel) {
                    badgeLabel.style.setProperty('background-color', '#2F8BCC', 'important');
                }
                if (pageNameInput) {
                    pageNameInput.disabled = false;
                    pageNameInput.style.removeProperty('pointer-events');
                }
                if (infoWrapper) {
                    infoWrapper.style.removeProperty('display');
                    infoWrapper.style.removeProperty('pointer-events');
                    infoWrapper.style.removeProperty('opacity');
                    infoWrapper.style.removeProperty('visibility');
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
        window.registeredFeatureAreas = registeredFeatureAreas;
        createFeatureMode = false;

        // Only Launch Application enabled if token is connected
        setLaunchEnabled(canEnableLaunch());

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

        // Top 3 selectable fields editable after reset
        setPlatformAppDeviceEditable(true);

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
        if (!cipherText || typeof cipherText !== "string") return null;
        const cleaned = cipherText.trim();
        if (!cleaned) return null;

        // 1. Strict Base64 validation (disallows appended characters, bad padding, or non-base64 characters)
        const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
        if (!base64Regex.test(cleaned) || cleaned.length % 4 !== 0) {
            console.warn("Token validation failed: Invalid base64 format or alignment");
            return null;
        }

        try {
            // 2. Parse OpenSSL cipher parameters
            const cipherParams = CryptoJS.format.OpenSSL.parse(cleaned);

            // Must contain a valid 8-byte salt
            if (!cipherParams.salt || cipherParams.salt.sigBytes !== 8) {
                console.warn("Token validation failed: Invalid salt structure");
                return null;
            }

            // Must contain ciphertext whose byte length is a non-zero multiple of 16 (AES block size)
            if (!cipherParams.ciphertext || cipherParams.ciphertext.sigBytes === 0 || cipherParams.ciphertext.sigBytes % 16 !== 0) {
                console.warn("Token validation failed: Invalid ciphertext block alignment");
                return null;
            }

            // 3. Exact Canonical Match (rejects appended characters like xyzabc where xyz is valid)
            const canonicalBase64 = CryptoJS.format.OpenSSL.stringify(cipherParams);
            if (canonicalBase64 !== cleaned) {
                console.warn("Token validation failed: Ciphertext does not match canonical base64 representation");
                return null;
            }

            // 4. AES Decryption with strict UTF-8 decoding
            const bytes = CryptoJS.AES.decrypt(cipherParams, secretKey);
            if (!bytes || bytes.sigBytes <= 0) {
                console.warn("Token validation failed: Decrypted byte stream is empty or corrupt");
                return null;
            }

            const decrypted = bytes.toString(CryptoJS.enc.Utf8);
            if (!decrypted || decrypted.trim() === "") {
                console.warn("Token validation failed: Decrypted string is empty");
                return null;
            }

            // 5. Strict JSON verification
            const parsed = JSON.parse(decrypted);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                console.warn("Token validation failed: Decrypted payload is not a valid JSON object");
                return null;
            }

            // Validate structural fields
            if (!parsed.userID && !parsed.baseUrl && !parsed.token && !parsed.username && !parsed.id) {
                console.warn("Token validation failed: Missing required authentication fields");
                return null;
            }

            console.log("Token successfully verified and decrypted");
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
                const fieldWrap = wrap.closest('.home-field');
                const fieldRect = fieldWrap ? fieldWrap.getBoundingClientRect() : rect;

                // Anchor menu under the full chip with ample min-width so text is fully visible
                const menuLeft = Math.round(fieldWrap ? fieldRect.left : rect.left);
                const minW = Math.round(fieldWrap ? fieldRect.width : rect.width);

                menu.style.left = `${menuLeft}px`;
                menu.style.minWidth = `${Math.max(minW, 140)}px`;
                menu.style.width = 'auto';
                menu.style.maxWidth = '400px';
                menu.style.top = `${Math.round(rect.bottom + 4)}px`;
                menu.style.bottom = 'auto';

                // Prevent overflowing off-screen on the right
                requestAnimationFrame(() => {
                    const mRect = menu.getBoundingClientRect();
                    if (mRect.right > window.innerWidth - 12) {
                        const shift = mRect.right - (window.innerWidth - 12);
                        menu.style.left = `${Math.max(10, mRect.left - shift)}px`;
                    }
                });

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

    function setNoDeviceConnectedState() {
        const deviceSelect = document.getElementById('devicename');
        if (deviceSelect) {
            deviceSelect.innerHTML = '<option value="">No device connected</option>';
            deviceSelect.value = '';
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
            appSelect.innerHTML = '<option value="">No device connected</option>';
            appSelect.value = '';
            if (typeof appSelect._rebuildCustomSelect === 'function') {
                appSelect._rebuildCustomSelect();
            }
        }

        const pkgInput = document.getElementById('apppackage');
        if (pkgInput) pkgInput.value = '';
        const actInput = document.getElementById('appactivity');
        if (actInput) actInput.value = '';
        const bundleInput = document.getElementById('bundleID');
        if (bundleInput) bundleInput.value = '';
        const pvInput = document.getElementById('platformversion');
        if (pvInput && !pvInput.dataset.userEdited) pvInput.value = '';

        if (typeof updateConfigDashboard === 'function') {
            updateConfigDashboard();
        }

        const runBtn = document.getElementById('Run');
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.style.backgroundColor = '#B6B6B4';
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
    }
    window.setNoDeviceConnectedState = setNoDeviceConnectedState;

    function populateDeviceDropdown(devices) {
        const deviceSelect = document.getElementById('devicename');
        if (!deviceSelect) return null;

        // Safety: strictly filter by the selected/active platform
        const platformSelect = document.getElementById('platformname');
        const activePlatform = platformSelect?.value || lastSelectedPlatform || 'Android';
        const targetPlatform = normalizePlatformName(activePlatform);
        const filtered = devicesForPlatform(targetPlatform, devices);

        deviceSelect.innerHTML = '';

        if (!filtered || filtered.length === 0) {
            setNoDeviceConnectedState();
            return null;
        }

        const ordered = preferAndroidDevicesFirst(filtered);

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

        if (normalizePlatformName(ordered[0].platform) === 'Android') {
            ipcRenderer.invoke("get-android-version", ordered[0].id).then((ver) => {
                if (ver) {
                    const pv = document.getElementById('platformversion');
                    if (pv) { pv.value = ver; pv.dataset.userEdited = 'true'; }
                }
            }).catch(() => {});
        } else {
            if (ordered[0].version) {
                const pv = document.getElementById('platformversion');
                if (pv) { pv.value = ordered[0].version; pv.dataset.userEdited = 'true'; }
            } else {
                ipcRenderer.invoke("get-ios-version", ordered[0].id).then((ver) => {
                    if (ver) {
                        const pv = document.getElementById('platformversion');
                        if (pv) { pv.value = ver; pv.dataset.userEdited = 'true'; }
                    }
                }).catch(() => {});
            }
        }

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
            } else {
                connectedDevices = [];
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

        const platformSelect = document.getElementById('platformname');
        let activePlatform = platformSelect ? platformSelect.value : lastSelectedPlatform;
        let targetPlatform = normalizePlatformName(activePlatform);

        let platformDevices = devicesForPlatform(targetPlatform, connectedDevices);

        // If current platform has no devices, but alternate platform has devices on macOS, switch platform
        if (platformDevices.length === 0 && connectedDevices.length > 0 && process.platform !== 'win32') {
            const alternatePlatform = targetPlatform === 'Android' ? 'IOS' : 'Android';
            const altDevices = devicesForPlatform(alternatePlatform, connectedDevices);
            if (altDevices.length > 0) {
                targetPlatform = alternatePlatform;
                platformDevices = altDevices;
                if (platformSelect) {
                    applyingPlatformFromDevice = true;
                    platformSelect.value = alternatePlatform;
                    lastSelectedPlatform = alternatePlatform;
                    if (typeof updatePlatformUI === 'function') updatePlatformUI();
                    if (typeof platformSelect._rebuildCustomSelect === 'function') {
                        platformSelect._rebuildCustomSelect();
                    }
                    applyingPlatformFromDevice = false;
                }
            }
        }

        if (platformDevices.length > 0) {
            const selectedDevice = populateDeviceDropdown(platformDevices);
            if (selectedDevice) {
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

                if (typeof window.switchAppTab === 'function') {
                    window.switchAppTab('home');
                }
            } else {
                setNoDeviceConnectedState();
                if (typeof window.switchAppTab === 'function') {
                    window.switchAppTab('repository');
                }
            }
        } else {
            setNoDeviceConnectedState();
            if (typeof window.switchAppTab === 'function') {
                window.switchAppTab('repository');
            }
        }

        lastKnownDeviceFingerprint = computeDeviceFingerprint(connectedDevices);
        // Start continuous real-time device monitoring
        startRealtimeDeviceMonitoring();
    });

    // Also start monitoring immediately in case message-from-main arrived prior or is empty
    setTimeout(() => {
        if (!realtimeDeviceMonitorInterval) {
            startRealtimeDeviceMonitoring();
        }
    }, 500);

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
                        lastKnownDeviceFingerprint = "";
                        markSessionInterrupted(new Error(`device disconnected: ${deviceName || activeUdid}`));
                        return;
                    }
                }

                // --- 2. IDLE / FORM REAL-TIME UPDATE ---
                const deviceSelect = document.getElementById('devicename');
                const appSelect = document.getElementById('appname');
                const isUiShowingNoDevice = !deviceSelect || !deviceSelect.value || deviceSelect.value === 'No device connected' || (appSelect && appSelect.value === 'No device connected');
                const deviceStateChanged = (freshFingerprint !== lastKnownDeviceFingerprint) || (freshDevices.length > 0 && isUiShowingNoDevice) || (freshDevices.length === 0 && !isUiShowingNoDevice);

                if (!driver && deviceStateChanged) {
                    const wasDeviceConnectedBefore = !!lastKnownDeviceFingerprint && !isUiShowingNoDevice;
                    lastKnownDeviceFingerprint = freshFingerprint;

                    const closeDeviceDisconnectedAlertIfOpen = () => {
                        const popup = document.getElementById('confirmationPopup');
                        const overlay = document.getElementById('overlay');
                        const popupTitle = document.getElementById('popup_title')?.innerText || '';
                        if (popup && popup.style.display === 'block' && popupTitle.toLowerCase().includes('disconnected')) {
                            popup.style.display = 'none';
                            if (overlay) overlay.style.display = 'none';
                            window._customAlertOnOkay = null;
                        }
                    };

                    const platformSelect = document.getElementById('platformname');
                    const activePlatform = platformSelect ? platformSelect.value : lastSelectedPlatform;
                    const platformTarget = typeof normalizePlatformName === 'function' ? normalizePlatformName(activePlatform) : activePlatform;
                    let matching = devicesForPlatform(platformTarget, freshDevices);

                    // If current platform has no devices, but alternate platform has devices, auto-switch platform
                    let activeTarget = platformTarget;
                    if (matching.length === 0 && freshDevices.length > 0 && process.platform !== 'win32') {
                        const alternateTarget = platformTarget === 'Android' ? 'IOS' : 'Android';
                        const alternateMatching = devicesForPlatform(alternateTarget, freshDevices);
                        if (alternateMatching.length > 0) {
                            activeTarget = alternateTarget;
                            matching = alternateMatching;
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
                        }
                    }

                    const currentUdid = document.getElementById('udid')?.value || deviceId;
                    const currentDeviceOption = document.getElementById('devicename')?.value;
                    const isCurrentSelectedStillConnected = !!(currentUdid && matching.some(d => d.id === currentUdid || d.name === currentDeviceOption));

                    if (matching.length > 0) {
                        closeDeviceDisconnectedAlertIfOpen();

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

                        if (typeof setPlatformAppDeviceEditable === 'function') {
                            setPlatformAppDeviceEditable(true);
                        }
                        setLaunchEnabled(canEnableLaunch());
                    } else {
                        // NO devices connected on ANY platform!
                        setNoDeviceConnectedState();

                        if (wasDeviceConnectedBefore) {
                            showCustomAlert(
                                "Device Disconnected",
                                `The connected device was disconnected and no other device is available.<br><br>Please connect an Android device${process.platform !== 'win32' ? ' or start an iOS simulator' : ''}.`,
                                "warning",
                                () => {
                                    setNoDeviceConnectedState();
                                }
                            );
                        }
                    }
                }
            } catch (pollErr) {
                console.warn("[Real-time Monitor] polling tick skipped:", pollErr);
            }
        }, 1500);
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
            } else {
                try {
                    let ver = selectedDevice.version;
                    if (!ver) {
                        ver = await ipcRenderer.invoke("get-ios-version", selectedDevice.id);
                    }
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

            const platform = (document.getElementById('platformname') && document.getElementById('platformname').value) || 'Android';
            const platformKey = platform.toLowerCase().includes('ios') ? 'IOS' : 'Android';
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

            // Retrieve saved last selected app for this platform
            let savedAppBundle = null;
            let savedAppName = null;
            try {
                savedAppBundle = localStorage.getItem('algo_last_selected_app_' + platformKey)
                    || localStorage.getItem('algo_last_selected_app_' + platform);
                savedAppName = localStorage.getItem('algo_last_selected_app_name_' + platformKey)
                    || localStorage.getItem('algo_last_selected_app_name_' + platform);
            } catch (_) {}

            let targetValue = null;
            if (previousValue && apps.some((app) => app.bundleId === previousValue)) {
                targetValue = previousValue;
            } else if (savedAppBundle && apps.some((app) => app.bundleId === savedAppBundle)) {
                targetValue = savedAppBundle;
            } else if (savedAppName && apps.some((app) => (app.name && app.name.toLowerCase() === savedAppName.toLowerCase()))) {
                const matched = apps.find((app) => app.name && app.name.toLowerCase() === savedAppName.toLowerCase());
                if (matched) targetValue = matched.bundleId;
            }

            if (targetValue) {
                dropdown.value = targetValue;
            } else {
                dropdown.selectedIndex = 0;
            }

            dropdown.dispatchEvent(new Event('change'));
        });

        document.getElementById("appname").addEventListener("change", function(){
            const platform = (document.getElementById('platformname') && document.getElementById('platformname').value) || 'Android';
            const platformKey = platform.toLowerCase().includes('ios') ? 'IOS' : 'Android';

            // Prefill first page name with the selected app name & save last selected app
            const appSelect = this;
            let cleanApp = '';
            if (appSelect.options && appSelect.selectedIndex >= 0) {
                const opt = appSelect.options[appSelect.selectedIndex];
                cleanApp = typeof getCleanAppName === 'function' ? getCleanAppName(opt.text || opt.innerText || appSelect.value) : (opt.text || appSelect.value);
            }

            if (this.value && this.value !== 'No device connected' && this.value !== 'Loading Apps...') {
                try {
                    localStorage.setItem('algo_last_selected_app_' + platformKey, this.value);
                    localStorage.setItem('algo_last_selected_app_' + platform, this.value);
                    if (cleanApp && cleanApp !== 'Select App' && cleanApp !== 'No device connected') {
                        localStorage.setItem('algo_last_selected_app_name_' + platformKey, cleanApp);
                        localStorage.setItem('algo_last_selected_app_name_' + platform, cleanApp);
                        localStorage.setItem('algo_last_global_configured_app', cleanApp);
                    }
                    localStorage.setItem('algo_last_global_configured_platform', platformKey);
                } catch (_) {}
            }

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

            if (typeof updateConfigDashboard === 'function') {
                updateConfigDashboard();
            }

            if (cleanApp && cleanApp !== 'Select App' && cleanApp !== 'Active App' && cleanApp !== 'Loading Apps...') {
                const currentVal = document.getElementById('pagename_searchbox')?.value.trim();
                if (!currentVal || currentVal === 'DefaultPage' || currentVal === 'home' || currentVal === 'Page' || currentVal === '') {
                    if (typeof window.setGlobalPageName === 'function') {
                        window.setGlobalPageName(cleanApp);
                    } else {
                        const pageInput = document.getElementById('pagename_searchbox');
                        if (pageInput) pageInput.value = cleanApp;
                    }
                }
            }
        });

        // Receive the Android Activity from main.js and populate the field
        ipcRenderer.on("receive-android-activity", (event, activity) => {
            const actEl = document.getElementById("appactivity");
            if (actEl) {
                actEl.value = activity || "";
            }
            if (typeof updateConfigDashboard === 'function') {
                updateConfigDashboard();
            }
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
        setLaunchEnabled(canEnableLaunch());
    } else if (typeof applyLaunchModeState === 'function') {
        applyLaunchModeState();
    }

    let pendingLaunchProjectData = null;

    function triggerScreenshotLoader() {
        if (process.platform !== 'win32') {
            document.getElementById('overlay').style.display = 'block';
        }
        const appRunning = document.getElementById('AppRunningPopup');
        if (appRunning) appRunning.style.display = 'none';
        if (typeof showDummyDeviceMessage === 'function') {
            showDummyDeviceMessage({
                theme: 'loading',
                title: 'Starting session and loading screen…'
            });
        }
    }

    function projectHasLaunchableData(project) {
        if (!project) return false;
        const feats = (typeof countProjectFeatures === 'function')
            ? countProjectFeatures(project)
            : ((project.features || []).length);
        return ((project.pages || []).length > 0)
            || ((project.scenarios || []).length > 0)
            || feats > 0;
    }

    function findExistingRepoProjects(appName, platform) {
        const store = typeof getProjectStore === 'function' ? getProjectStore() : {};
        const cleanApp = (typeof getCleanAppName === 'function' ? getCleanAppName(appName) : (appName || '')).trim().toLowerCase();
        const platNorm = (platform || 'Android').toLowerCase().includes('ios') ? 'iOS' : 'Android';
        if (!cleanApp) return [];

        const matches = [];
        Object.keys(store).forEach(k => {
            const proj = store[k];
            if (!proj || !projectHasLaunchableData(proj)) return;
            const pApp = (typeof getCleanAppName === 'function' ? getCleanAppName(proj.appName || '') : (proj.appName || '')).trim().toLowerCase();
            const pPlat = (proj.platform || k || '').toLowerCase().includes('ios') ? 'iOS' : 'Android';
            if (pApp === cleanApp && pPlat === platNorm) {
                matches.push({ key: k, project: proj });
            }
        });
        matches.sort((a, b) => (b.project.lastUpdated || a.project.createdAt || 0) - (a.project.lastUpdated || a.project.createdAt || 0));
        return matches;
    }

    function findExistingRepoProject(appName, platform) {
        const matches = findExistingRepoProjects(appName, platform);
        return matches.length ? matches[0] : null;
    }

    function getAppConfigStorageKey(appName, platform) {
        const clean = (typeof getCleanAppName === 'function' ? getCleanAppName(appName) : (appName || '')).trim().toLowerCase();
        const plat = String(platform || '').toLowerCase().includes('ios') ? 'ios' : 'android';
        return `algo_last_configured_project_${clean}_${plat}`;
    }
    window.getAppConfigStorageKey = getAppConfigStorageKey;

    function setGlobalLastConfiguredProject(projectKey, project) {
        if (!projectKey) return;
        try {
            localStorage.setItem('algo_last_configured_project_global_key', projectKey);
            window.activeConfiguredProjectKey = projectKey;
            const store = typeof getProjectStore === 'function' ? getProjectStore() : {};
            const p = project || store[projectKey];
            if (p) {
                const plat = String(p.platform || projectKey).toLowerCase().includes('ios') ? 'ios' : 'android';
                localStorage.setItem('algo_last_configured_project_platform_key_' + plat, projectKey);
                if (p.appName) {
                    setAppConfiguredProject(p.appName, p.platform || (plat === 'ios' ? 'iOS' : 'Android'), projectKey);
                }
            }
        } catch (_) {}
    }
    window.setGlobalLastConfiguredProject = setGlobalLastConfiguredProject;

    function getGlobalLastConfiguredProject(platform) {
        try {
            const store = typeof getProjectStore === 'function' ? getProjectStore() : {};
            let key = null;
            if (platform) {
                const plat = String(platform).toLowerCase().includes('ios') ? 'ios' : 'android';
                key = localStorage.getItem('algo_last_configured_project_platform_key_' + plat);
            }
            if (!key) {
                key = localStorage.getItem('algo_last_configured_project_global_key');
            }
            if (key) {
                const found = typeof findProjectKeyInStore === 'function' ? findProjectKeyInStore(store, key) : null;
                if (found && found.project) return { key: found.key || key, project: found.project };
                if (store[key]) return { key: key, project: store[key] };
            }
            // Fallback: Pick the most recently updated project from the store
            const storeKeys = Object.keys(store);
            if (storeKeys.length > 0) {
                let candidates = [];
                storeKeys.forEach(k => {
                    const pr = store[k];
                    if (pr && projectHasLaunchableData(pr)) {
                        const platNorm = String(pr.platform || k).toLowerCase().includes('ios') ? 'iOS' : 'Android';
                        if (!platform || platNorm === (platform.toLowerCase().includes('ios') ? 'iOS' : 'Android')) {
                            candidates.push({ key: k, project: pr });
                        }
                    }
                });
                if (candidates.length > 0) {
                    candidates.sort((a, b) => (b.project.lastUpdated || b.project.createdAt || 0) - (a.project.lastUpdated || a.project.createdAt || 0));
                    return candidates[0];
                }
            }
        } catch (_) {}
        return null;
    }
    window.getGlobalLastConfiguredProject = getGlobalLastConfiguredProject;

    function setAppConfiguredProject(appName, platform, projectKey) {
        if (!appName) return;
        const storageKey = getAppConfigStorageKey(appName, platform);
        if (projectKey) {
            localStorage.setItem(storageKey, projectKey);
            window.activeConfiguredProjectKey = projectKey;
            try {
                localStorage.setItem('algo_last_configured_project_global_key', projectKey);
                const plat = String(platform || '').toLowerCase().includes('ios') ? 'ios' : 'android';
                localStorage.setItem('algo_last_configured_project_platform_key_' + plat, projectKey);
            } catch (_) {}
        } else {
            localStorage.removeItem(storageKey);
        }
    }
    window.setAppConfiguredProject = setAppConfiguredProject;

    function getAppConfiguredProject(appName, platform) {
        if (!appName) return null;
        const storageKey = getAppConfigStorageKey(appName, platform);
        const key = localStorage.getItem(storageKey);
        if (key) {
            const store = typeof getProjectStore === 'function' ? getProjectStore() : {};
            const found = typeof findProjectKeyInStore === 'function' ? findProjectKeyInStore(store, key) : null;
            if (found && found.project) return found.key || key;
            if (store[key]) return key;
        }
        return null;
    }
    window.getAppConfiguredProject = getAppConfiguredProject;

    window.openActiveProjectInRepo = function() {
        const key = window.activeConfiguredProjectKey || window.activeResumedProjectKey;
        if (typeof switchAppTab === 'function') switchAppTab('repository');
        if (key) {
            currentSelectedProjectKey = key;
            currentRepoFilter = 'all';
            if (typeof closeRepoSideView === 'function') closeRepoSideView();
            if (typeof window.renderRepositoryView === 'function') window.renderRepositoryView();
        }
    };

    window.launchConfiguredProject = async function() {
        if (typeof canEnableLaunch === 'function' && !canEnableLaunch()) {
            if (typeof showCustomAlert === 'function') {
                showCustomAlert("Authentication Required", "Please paste and connect a valid token before launching the application.", "warning");
            }
            return;
        }

        const store = typeof getProjectStore === 'function' ? getProjectStore() : {};
        const configuredInfo = (typeof getGlobalLastConfiguredProject === 'function')
            ? getGlobalLastConfiguredProject()
            : null;
        const key = window.activeConfiguredProjectKey || (configuredInfo ? configuredInfo.key : null);
        const project = key ? store[key] : (configuredInfo ? configuredInfo.project : null);

        const currentPlatform = (typeof getSelectedPlatform === 'function') ? getSelectedPlatform() : (document.getElementById('platformname')?.value || 'Android');
        const projPlatform = project ? (String(project.platform || '').toLowerCase().includes('ios') ? 'IOS' : 'Android') : currentPlatform;
        const isIos = projPlatform === 'IOS' || projPlatform === 'iOS';

        // 1. Windows platform guard
        if (process.platform === 'win32' && isIos) {
            if (typeof showCustomAlert === 'function') {
                showCustomAlert(
                    "Platform Not Supported on Windows",
                    "iOS automation requires macOS with Xcode and Apple developer tools.<br><br>Windows only supports Android devices and emulators. Please switch Platform to <b>Android</b>.",
                    "error"
                );
            }
            return;
        }

        // 2. Synchronize Platform & App in Home page if a project is configured
        if (project) {
            window.activeResumedProjectKey = key;
            window.activeConfiguredProjectKey = key;
            window.activeResumedAppName = project.appName;

            // Sync platform select if different
            const pSelect = document.getElementById('platformname');
            if (pSelect && pSelect.value !== projPlatform) {
                pSelect.value = projPlatform;
                if (typeof updatePlatformUI === 'function') updatePlatformUI();
            }

            // Sync app in dropdown if present
            const appSelect = document.getElementById('appname');
            if (appSelect && appSelect.options) {
                const targetAppName = (project.appName || '').toLowerCase();
                for (let i = 0; i < appSelect.options.length; i++) {
                    const opt = appSelect.options[i];
                    const optText = (opt.text || opt.innerText || '').toLowerCase();
                    if (optText === targetAppName || opt.value === targetAppName) {
                        appSelect.selectedIndex = i;
                        appSelect.dispatchEvent(new Event('change'));
                        break;
                    }
                }
            }
        }

        const devName = (document.getElementById('devicename')?.value || '').trim();
        const udidName = (document.getElementById('udid')?.value || '').trim();
        const appName = (document.getElementById('appname')?.value || '').trim();
        const bundleID = (document.getElementById('bundleID')?.value || '').trim();
        const appPackage = (document.getElementById('apppackage')?.value || '').trim();
        const appActivity = (document.getElementById('appactivity')?.value || '').trim();
        const appiumURL = (document.getElementById('appiumurl')?.value || '').trim();

        // 3. Device connectivity validation
        if (!devName || devName === 'No device connected' || devName === 'Select Device' || !udidName) {
            if (typeof showCustomAlert === 'function') {
                showCustomAlert(
                    "Device Required",
                    "No connected device or simulator detected.<br><br>Please connect a physical device via USB or start an emulator/simulator before launching.",
                    "warning"
                );
            }
            return;
        }

        // 4. Application package / bundle validation
        if (!appName || appName === 'No device connected' || appName === 'Select App' || appName === 'Loading Apps...') {
            if (typeof showCustomAlert === 'function') {
                showCustomAlert("Application Required", "Please select an installed application from the App dropdown before launching.", "warning");
            }
            return;
        }

        if (isIos && !bundleID) {
            if (typeof showCustomAlert === 'function') {
                showCustomAlert("Bundle Identifier Required", "Please specify a valid iOS Bundle ID in Configuration before launching.", "warning");
            }
            return;
        }

        if (!isIos) {
            if (!appPackage) {
                if (typeof showCustomAlert === 'function') {
                    showCustomAlert("App Package Required", "Please specify a valid Android Package identifier before launching.", "warning");
                }
                return;
            }
            if (!appActivity || appActivity.toLowerCase() === 'loading activity...') {
                if (typeof showCustomAlert === 'function') {
                    showCustomAlert("App Activity Required", "Android Activity is still resolving. Please wait a moment or specify MainActivity before launching.", "warning");
                }
                return;
            }
        }

        if (!appiumURL) {
            if (typeof showCustomAlert === 'function') {
                showCustomAlert("Appium Gateway Required", "Appium server URL is missing. Please ensure Appium is running on port 4723.", "warning");
            }
            return;
        }

        // 5. Navigate to Home tab for live preview & canvas transition
        if (typeof switchAppTab === 'function') {
            switchAppTab('home');
        }

        // 6. Build launch parameters
        var platformVersion = (document.getElementById('platformversion')?.value || '').trim();
        var automationName = (document.getElementById('automationName')?.value || (isIos ? 'XCUITest' : 'UiAutomator2')).trim();
        if (!platformVersion) {
            platformVersion = isIos ? '17.0' : '14';
        }

        const launchParams = [
            projPlatform,
            devName,
            platformVersion,
            automationName,
            appiumURL,
            udidName,
            bundleID,
            appPackage,
            appActivity
        ];

        // 7. Execute direct application launch (auto-run saved project without picker modal)
        if (typeof setLaunchEnabled === 'function') {
            setLaunchEnabled(true);
        }

        if (project && key && typeof resumeExistingProjectAndLaunch === 'function') {
            await resumeExistingProjectAndLaunch(key, project, launchParams);
        } else if (typeof startCreateNewProjectLaunch === 'function') {
            const cleanApp = (typeof getCleanAppName === 'function' ? getCleanAppName(appName) : appName) || appName;
            await startCreateNewProjectLaunch(cleanApp, projPlatform, launchParams);
        } else {
            const runBtn = document.getElementById('Run');
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.click();
            }
        }
    };

    function restoreProjectDataToHomePage(project) {
        if (!project) return;
        const skipSyncPrev = window._restoringProject;
        window._restoringProject = true;

        // 1. Wipe existing rows in #myTable
        const tbody = document.getElementById('myTable');
        if (tbody) {
            tbody.innerHTML = '';
        }

        // 2. Restore memory banks (must mutate the live arrays used by scrape/feature code)
        window.registeredPageNames = new Set();
        window.pageScenarioData = {};
        registeredFeatureAreas = [];
        window.registeredFeatureAreas = registeredFeatureAreas;

        function restoreFeatureArea(f, pageName) {
            if (!f || !f.name) return;
            const name = String(f.name).trim();
            if (!name) return;
            const resolvedPage = (f.pageName && f.pageName !== 'Default' && f.pageName !== 'DefaultPage') ? f.pageName : (pageName || '');
            // Keep every stored feature — only skip exact same id (or same name+uid when no id)
            const existing = registeredFeatureAreas.find(a => {
                if (!a || !a.name) return false;
                if (f.id && a.id) return a.id === f.id;
                return a.name.trim().toLowerCase() === name.toLowerCase()
                    && String(a.uniqueIdentifier || '') === String(f.uniqueIdentifier || '')
                    && repoNameKey(a.pageName || '') === repoNameKey(resolvedPage || '');
            });
            if (existing) {
                if ((!existing.pageName || existing.pageName === 'Default' || existing.pageName === 'DefaultPage') && resolvedPage) {
                    existing.pageName = resolvedPage;
                }
                if (!existing.id && f.id) existing.id = f.id;
                return;
            }
            registeredFeatureAreas.push({
                id: f.id || ('feat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
                name: name,
                rect: f.rect || null,
                fullPage: !!f.fullPage,
                pageName: resolvedPage,
                uniqueIdentifier: f.uniqueIdentifier || "",
                xpaths: Array.isArray(f.xpaths) ? f.xpaths : [],
                screenSignature: f.screenSignature || "",
                screenContentKeys: Array.isArray(f.screenContentKeys) ? f.screenContentKeys : [],
                nodeText: f.nodeText || "",
                nodeFingerprint: f.nodeFingerprint || ""
            });
        }

        // Restore from scenarios and pages first to ensure accurate page ownership
        (project.scenarios || []).forEach(s => {
            (s.features || []).forEach(f => restoreFeatureArea(f, s.pageName || s.name));
        });
        (project.pages || []).forEach(pg => {
            (pg.features || []).forEach(f => restoreFeatureArea(f, pg.pageName));
        });
        (project.features || []).forEach(f => restoreFeatureArea(f, f && f.pageName));

        // Restore scenarios (names, outlines, and any captured elements)
        if (Array.isArray(project.scenarios)) {
            project.scenarios.forEach(s => {
                if (!s) return;
                const pName = s.pageName || s.name || (project.pages && project.pages[0] ? project.pages[0].pageName : 'DefaultPage');
                if (s.name || s.outline) {
                    window.pageScenarioData[pName] = {
                        scenarioName: s.name || '',
                        scenarioOutline: s.outline || ''
                    };
                }
                if (pName && pName.toLowerCase() !== 'all') {
                    window.registeredPageNames.add(pName);
                }
            });
        }

        // Restore pages and their table rows (pages first, then scenario-only element lists)
        const allHeaders = Array.from(document.querySelectorAll('#mainTable thead tr > *'));
        const allControlTypes = [
            "TextBox", "Button", "RadioButton", "CheckBox", "Link",
            "DropDownList", "Image", "TextArea", "FileUpload", "Label",
            "Page", "AnchorTag", "Mouse", "Scroll", "Window",
            "NewTab", "Parent"
        ];

        let rowCount = 0;
        const seenRowKeys = new Set();

        function appendRestoredElements(pageName, elements) {
            if (!tbody || !Array.isArray(elements) || elements.length === 0) return;
            const pName = pageName || 'DefaultPage';
            elements.forEach(el => {
                if (!el) return;
                const name = (el['CONTROL NAME'] || el.ControlName || '').trim().toLowerCase();
                const xpRaw = el['XPATH'] || el.ControlId || '';
                const xp = (Array.isArray(xpRaw) ? xpRaw[0] : xpRaw);
                const rowKey = pName.trim().toLowerCase() + '|' + name + '|' + String(xp || '').trim().toLowerCase();
                if (name || String(xp || '').trim()) {
                    if (seenRowKeys.has(rowKey)) return;
                    seenRowKeys.add(rowKey);
                }
                const tr = tbody.insertRow(0);
                tr.dataset.rect = JSON.stringify(el.rect || null);

                let xpaths = Array.isArray(el['XPATH'] || el.ControlId)
                    ? (el['XPATH'] || el.ControlId)
                    : [(el['XPATH'] || el.ControlId || '')];

                let selectOptionsHtml = xpaths.map(xp =>
                    `<option value="${String(xp).replace(/"/g, '&quot;')}" onmousemove="onOptionHover('${String(xp).replace(/'/g, "\\'")}')">${xp}</option>`
                ).join('');

                let controlIdCellHtml = `<select class="xpath-dropdown" onchange="onDropdownChange(this)" onmouseleave="onShowElementLeave(event)" style="width: 100%; border: none; background: transparent; font-size: 11px; font-weight: 600;">${selectOptionsHtml}</select>`;

                let currentControlType = el['CONTROL TYPE'] || el.ControlType || "";
                let optionsList = [...new Set([currentControlType, ...allControlTypes])].filter(Boolean);
                let ctSelectOptionsHtml = optionsList.map(type =>
                    `<option value="${type}" ${type === currentControlType ? 'selected' : ''}>${type}</option>`
                ).join('');
                let controlTypeCellHtml = `<select class="xpath-dropdown" style="width: 100%; border: none; background: transparent; font-size: 11px; font-weight: 600;">${ctSelectOptionsHtml}</select>`;

                const primaryLocator = (xpaths[0] || "").trim();
                const identificationType = (el['IDENTIFICATION TYPE'] || el.IdentificationType || "").trim()
                    || (typeof inferIdentificationType === "function" ? inferIdentificationType(primaryLocator) : "");

                let rowDataMap = {
                    "#": "",
                    "CONTROL NAME": el['CONTROL NAME'] || el.ControlName || "",
                    "CONTROL TYPE": controlTypeCellHtml,
                    "CONTROL ID": controlIdCellHtml,
                    "PAGE NAME": el['PAGE NAME'] || el.PageName || pName,
                    "IDENTIFICATION TYPE": identificationType,
                    "CONTROL VALUE": el['CONTROL VALUE'] || el.ControlValue || "",
                    "FEATURE NAME": el['FEATURE NAME'] || el.FeatureName || pName,
                    "NODE NAME": el['NODE NAME'] || el.NodeName || pName,
                    "DELETE": `<img src="icon/icons8-delete_red.svg" id="del_${rowCount}" alt="delete" class="deleteBtn" style="margin: 0 auto; max-width:17px; overflow: hidden; cursor: pointer; -webkit-user-drag: none; display:inline-block;">`,
                    "FINGERPRINT": (el['FINGERPRINT'] || el.Fingerprint || "").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
                    "APP URL": el['APP URL'] || el.AppUrl || (typeof getCurrentAppIdentity === 'function' ? getCurrentAppIdentity() : '')
                };

                let rowHtml = "";
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
                    } else if (thText.includes('CONTROL NAME')) {
                        rowHtml += `<td class="cn pt-3-half" id="cn_${rowCount}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["CONTROL NAME"]}</td>`;
                    } else if (thText.includes('CONTROL TYPE')) {
                        rowHtml += `<td class="ct pt-3-half" id="ct_${rowCount}" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["CONTROL TYPE"]}</td>`;
                    } else if (thText.includes('CONTROL ID')) {
                        rowHtml += `<td class="xpath pt-3-half" id="xpath_${rowCount}" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["CONTROL ID"]}</td>`;
                    } else if (thText.includes('PAGE NAME')) {
                        rowHtml += `<td class="page pt-3-half" id="page_${rowCount}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["PAGE NAME"]}</td>`;
                    } else if (thText.includes('IDENTIFICATION TYPE')) {
                        rowHtml += `<td class="identificationType pt-3-half" id="identificationType_${rowCount}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["IDENTIFICATION TYPE"]}</td>`;
                    } else if (thText.includes('CONTROL VALUE')) {
                        rowHtml += `<td class="controlValue pt-3-half" id="controlValue_${rowCount}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["CONTROL VALUE"]}</td>`;
                    } else if (thText.includes('FEATURE NAME')) {
                        rowHtml += `<td class="featureName pt-3-half" id="featureName_${rowCount}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["FEATURE NAME"]}</td>`;
                    } else if (thText.includes('NODE NAME')) {
                        rowHtml += `<td class="nodeName pt-3-half" id="nodeName_${rowCount}" contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">${rowDataMap["NODE NAME"]}</td>`;
                    } else if (th.classList.contains('fingerprint')) {
                        rowHtml += `<td class="fingerprint" style="display:none;">${rowDataMap["FINGERPRINT"]}</td>`;
                    } else if (th.id === 'appUrl' || thText.includes('APP URL')) {
                        rowHtml += `<td class="appUrl" style="display:none;">${rowDataMap["APP URL"] || ""}</td>`;
                    } else if (thText.includes('DELETE')) {
                        rowHtml += `<td class="delete-cell" style="border-color:black; ${displayStyle}">
                            <input type="checkbox" class="bulk-delete-cb" style="display:none; cursor:pointer; margin:0 auto;">
                            <img src="icon/icons8-delete_red.svg" alt="delete" class="deleteBtn" style="margin: 0 auto; max-width:17px; cursor: pointer; -webkit-user-drag: none; display:inline-block;">
                        </td>`;
                    } else {
                        rowHtml += `<td contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">&nbsp;</td>`;
                    }
                });

                tr.innerHTML = rowHtml;
                rowCount++;
            });
        }

        if (Array.isArray(project.pages) && tbody) {
            project.pages.forEach(pageObj => {
                const pName = pageObj.pageName || 'DefaultPage';
                if (pName && pName.toLowerCase() !== 'all') {
                    window.registeredPageNames.add(pName);
                }
                appendRestoredElements(pName, pageObj.elements || []);
            });
        }

        if (Array.isArray(project.scenarios)) {
            project.scenarios.forEach(s => {
                const pName = s.pageName || s.name || 'DefaultPage';
                if (Array.isArray(s.elements) && s.elements.length > 0) {
                    appendRestoredElements(pName, s.elements);
                }
            });
        }

        tableCreated = rowCount > 0;
        const downloadBtn = document.getElementById('download');
        const tableContainer = document.getElementById('table-container');
        if (tableContainer) tableContainer.style.display = "block";
        if (tableCreated && downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.style.backgroundColor = '#2F8BCC';
        }

        if (typeof adjustEmptyRows === 'function') adjustEmptyRows();
        if (typeof updateRowNumbers === 'function') updateRowNumbers();
        if (typeof initResizableTable === 'function') initResizableTable();
        if (typeof applyPagination === 'function') applyPagination();
        if (typeof applyColumnVisibility === 'function') applyColumnVisibility();
        if (typeof syncRegisteredPageNames === 'function') syncRegisteredPageNames();

        // Show every restored page / scenario together when the project has multiple names
        const pagesList = Array.from(window.registeredPageNames).filter(p => p && p.toLowerCase() !== 'all');
        const scenarioCount = Object.keys(window.pageScenarioData || {}).length;
        const savedActive = (project.lastActivePageName || '').trim();
        let activePage = savedActive;
        if (pagesList.length > 1 || scenarioCount > 1 || savedActive.toLowerCase() === 'all') {
            activePage = 'All';
        } else if (!activePage || (activePage.toLowerCase() !== 'all' && !pagesList.some(p => p.toLowerCase() === activePage.toLowerCase()))) {
            activePage = pagesList.length > 0 ? pagesList[pagesList.length - 1] : (project.appName || 'home');
        }
        if (window.setGlobalPageName) {
            window.setGlobalPageName(activePage);
        }

        const pageNameInput = document.getElementById('pagename_searchbox');
        if (pageNameInput) {
            pageNameInput.readOnly = true;
            pageNameInput.style.cursor = 'default';
        }
        const confirmIcon = document.querySelector('.confirm-edit-icon');
        const cancelIcon = document.querySelector('.cancel-edit-icon');
        const addPageIcon = document.querySelector('.add-page-icon');
        const editPenIcon = document.querySelector('.edit-icon');
        const dropdownIcon = document.querySelector('.dropdown-icon, .page-dropdown-icon');
        if (confirmIcon) confirmIcon.style.display = 'none';
        if (cancelIcon) cancelIcon.style.display = 'none';
        if (addPageIcon) addPageIcon.style.display = 'inline-block';
        if (editPenIcon && activePage !== 'All') editPenIcon.style.display = 'inline-block';
        if (dropdownIcon) dropdownIcon.style.display = 'inline-block';

        if (typeof window.switchAppTab === "function") {
            window.switchAppTab("home");
        }

        window._restoringProject = skipSyncPrev;
    }
    window.restoreProjectDataToHomePage = restoreProjectDataToHomePage;

    function removeHomeRowsForPage(pageName) {
        const tbody = document.getElementById('myTable');
        if (!tbody || !pageName) return;
        const key = String(pageName).trim().toLowerCase();
        Array.from(tbody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)')).forEach(row => {
            const pageCell = row.querySelector('.page');
            const rowPage = pageCell ? pageCell.innerText.trim().toLowerCase() : '';
            if (rowPage === key) row.remove();
        });
    }

    function finishHomeTableRefresh() {
        if (typeof updateRowNumbers === 'function') updateRowNumbers();
        if (typeof applyPagination === 'function') applyPagination();
        if (typeof adjustEmptyRows === 'function') {
            const tbody = document.getElementById('myTable');
            if (tbody && tbody.querySelectorAll('tr').length < 5) adjustEmptyRows();
        }
        if (typeof applyColumnVisibility === 'function') applyColumnVisibility();
    }

    /**
     * Repo → Home live link. Applies a repository delete/update to the Home
     * workspace when it belongs to the currently launched project.
     */
    window.applyRepoChangeToHome = function(change) {
        if (!change || window._restoringProject) return;
        const activeKey = window.activeResumedProjectKey;
        if (change.projectKey && activeKey && change.projectKey !== activeKey && !change.wipeSession) {
            return;
        }

        window._applyingRepoToHome = true;
        try {
            if (change.wipeSession) {
                const tbody = document.getElementById('myTable');
                if (tbody) tbody.innerHTML = '';
                window.pageScenarioData = {};
                window.registeredPageNames = new Set();
                if (typeof registeredFeatureAreas !== 'undefined') {
                    registeredFeatureAreas = [];
                    window.registeredFeatureAreas = registeredFeatureAreas;
                }
                const appName = window.activeResumedAppName || (typeof resolveActiveAppName === 'function' ? resolveActiveAppName() : '');
                if (typeof window.setGlobalPageName === 'function' && appName) {
                    window.setGlobalPageName(appName);
                }
                finishHomeTableRefresh();
                return;
            }

            if (change.type === 'feature' && change.featureName && typeof window.removeFeatureCompletely === 'function') {
                window.removeFeatureCompletely(change.featureName, change.projectKey);
                finishHomeTableRefresh();
                return;
            }

            if ((change.type === 'page' || change.type === 'scenario') && change.pageName) {
                const pageName = String(change.pageName).trim();
                removeHomeRowsForPage(pageName);
                if (window.registeredPageNames) window.registeredPageNames.delete(pageName);
                if (window.pageScenarioData) {
                    delete window.pageScenarioData[pageName];
                    Object.keys(window.pageScenarioData).forEach(k => {
                        const s = window.pageScenarioData[k];
                        if (s && (s.scenarioName || '').trim().toLowerCase() === pageName.toLowerCase()) {
                            delete window.pageScenarioData[k];
                        }
                    });
                }
                const remaining = window.registeredPageNames
                    ? Array.from(window.registeredPageNames).filter(p => p && p.trim() && p.toLowerCase() !== 'all')
                    : [];
                if (remaining.length === 0) {
                    const appName = window.activeResumedAppName || (typeof resolveActiveAppName === 'function' ? resolveActiveAppName() : '');
                    if (typeof window.setGlobalPageName === 'function' && appName) {
                        window.setGlobalPageName(appName);
                    }
                } else if (remaining.length === 1) {
                    if (typeof window.setGlobalPageName === 'function') window.setGlobalPageName(remaining[0]);
                } else if (typeof window.setGlobalPageName === 'function') {
                    window.setGlobalPageName('All');
                }
                finishHomeTableRefresh();
            }
        } finally {
            window._applyingRepoToHome = false;
        }
    };

    async function resumeExistingProjectAndLaunch(projectKey, fallbackProject, launchParams) {
        if (window._resumeOldProjectLaunchInFlight) return;
        window._resumeOldProjectLaunchInFlight = true;
        window._resettingHome = false;
        try {
            let snapshot = (typeof fetchRepoProjectSnapshot === 'function')
                ? fetchRepoProjectSnapshot(projectKey, fallbackProject)
                : null;
            if (!snapshot && fallbackProject) {
                try {
                    snapshot = JSON.parse(JSON.stringify(fallbackProject));
                } catch (_) {
                    snapshot = fallbackProject;
                }
            }
            if (!snapshot) {
                console.warn('Continue with Old: no project snapshot found for', projectKey);
                return;
            }

            window._resumedProjectSnapshot = snapshot;
            window.activeProjectSessionMode = 'resumed';
            const resolvedKeyInfo = (typeof findProjectKeyInStore === 'function')
                ? findProjectKeyInStore(getProjectStore(), projectKey, snapshot)
                : { key: projectKey };
            window.activeResumedProjectKey = resolvedKeyInfo.key
                || projectKey
                || (snapshot.projectId ? `${snapshot.appName} (${snapshot.platform})::${snapshot.projectId}` : `${snapshot.appName} (${snapshot.platform})`);
            window.activeResumedAppName = snapshot.appName || resolveActiveAppName();

            if (typeof setAppConfiguredProject === 'function') {
                setAppConfiguredProject(snapshot.appName || resolveActiveAppName(), snapshot.platform || (launchParams && launchParams[0]), window.activeResumedProjectKey);
            }
            if (typeof setGlobalLastConfiguredProject === 'function') {
                setGlobalLastConfiguredProject(window.activeResumedProjectKey, snapshot);
            }

            pendingLaunchProjectData = null;
            window.pendingLaunchProjectData = null;
            pendingExportAction = null;
            window.pendingExportAction = null;

            triggerScreenshotLoader();
            resetFormLockActive = false;
            initialData = launchParams;

            // Block Home→Repo sync for the whole launch. An empty table sync here
            // was wiping the saved project and then restoring that empty copy.
            window._restoringProject = true;
            try {
                await launchApp(launchParams);
                restoreProjectDataToHomePage(snapshot);
                window._resumedProjectSnapshot = snapshot;
            } finally {
                window._restoringProject = false;
            }
        } catch (err) {
            console.error('Continue with Old failed:', err);
            window._restoringProject = false;
            throw err;
        } finally {
            window._resumeOldProjectLaunchInFlight = false;
        }
    }

    function formatLaunchPickerDate(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    }

    function hideLaunchProjectPicker() {
        const modal = document.getElementById('launchProjectModal');
        if (modal) modal.style.display = 'none';
        const overlay = document.getElementById('overlay');
        if (overlay) overlay.style.display = 'none';
    }

    function cancelLaunchProjectPicker() {
        hideLaunchProjectPicker();
        pendingLaunchProjectData = null;
        window.pendingLaunchProjectData = null;
        pendingExportAction = null;
        window.pendingExportAction = null;
        if (typeof unlockLaunchForm === 'function') unlockLaunchForm();
    }

    async function startCreateNewProjectLaunch(activeApp, plateformOption, launchParams) {
        if (window._createNewProjectLaunchInFlight) return;
        window._createNewProjectLaunchInFlight = true;
        try {
            hideLaunchProjectPicker();
            const uniqueInfo = (typeof createFreshRepoProject === 'function')
                ? createFreshRepoProject(activeApp, plateformOption)
                : { key: `${activeApp} (${plateformOption})::${Date.now().toString(36)}`, appName: activeApp };

            if (typeof setAppConfiguredProject === 'function') {
                setAppConfiguredProject(activeApp, plateformOption, uniqueInfo.key);
            }
            if (typeof setGlobalLastConfiguredProject === 'function') {
                setGlobalLastConfiguredProject(uniqueInfo.key, { appName: activeApp, platform: plateformOption, projectId: uniqueInfo.projectId });
            }

            pendingLaunchProjectData = null;
            window.pendingLaunchProjectData = null;
            pendingExportAction = null;
            window.pendingExportAction = null;

            if (typeof window.clearAllPagesAndScrapedDataForNewScenario === 'function') {
                window.clearAllPagesAndScrapedDataForNewScenario();
            }
            if (typeof window.setGlobalPageName === 'function') {
                window.setGlobalPageName(uniqueInfo.appName);
            }

            triggerScreenshotLoader();
            resetFormLockActive = false;
            if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
            initialData = launchParams;
            await launchApp(launchParams);
        } finally {
            window._createNewProjectLaunchInFlight = false;
        }
    }

    function showLaunchProjectPicker({ appName, platform, projects, launchParams }) {
        const modal = document.getElementById('launchProjectModal');
        const list = document.getElementById('launchPickerList');
        const titleEl = document.getElementById('launchPickerTitle');
        const mainEl = document.getElementById('launchPickerMain');
        const subEl = document.getElementById('launchPickerSub');
        const continueBtn = document.getElementById('launchPickerContinueBtn');
        const createBtn = document.getElementById('launchPickerCreateBtn');
        const cancelBtn = document.getElementById('launchPickerCancelBtn');
        const searchWrap = document.getElementById('launchPickerSearchWrap');
        const searchInput = document.getElementById('launchPickerSearch');
        if (!modal || !list || !continueBtn) return;

        const items = Array.isArray(projects) ? projects.slice() : [];
        const displayApp = appName || 'this app';
        const esc = (typeof escapeDummyHtml === 'function') ? escapeDummyHtml : (v) => String(v || '');
        const configuredKey = (typeof getAppConfiguredProject === 'function') ? getAppConfiguredProject(appName, platform) : null;
        let selectedKey = (configuredKey && items.some(it => it.key === configuredKey))
            ? configuredKey
            : (items[0] ? items[0].key : '');

        titleEl.textContent = `Launch ${displayApp}`;
        if (items.length > 1) {
            mainEl.innerHTML = `<b>${items.length}</b> saved projects for <b>${esc(displayApp)}</b> (${esc(platform)}).`;
            subEl.textContent = 'Choose one to continue, or Create New for a separate workspace.';
        } else {
            mainEl.innerHTML = `A saved project for <b>${esc(displayApp)}</b> (${esc(platform)}) already exists.`;
            subEl.textContent = 'Continue with Old restores it. Create New starts a separate project.';
        }
        if (searchWrap) searchWrap.style.display = items.length > 5 ? 'flex' : 'none';
        if (searchInput) searchInput.value = '';

        function syncContinueEnabled() {
            continueBtn.disabled = !selectedKey;
        }

        function selectProjectKey(key) {
            selectedKey = key || '';
            list.querySelectorAll('.launch-picker-card').forEach(card => {
                const on = card.getAttribute('data-project-key') === selectedKey;
                card.classList.toggle('is-selected', on);
                card.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            const selectedItem = items.find(it => it.key === selectedKey);
            if (selectedItem) {
                pendingLaunchProjectData = {
                    key: selectedItem.key,
                    project: selectedItem.project,
                    initialData: launchParams
                };
                window.pendingLaunchProjectData = pendingLaunchProjectData;
            }
            syncContinueEnabled();
        }

        list.innerHTML = items.map((item, idx) => {
            const p = item.project || {};
            const isIos = String(p.platform || platform || '').toLowerCase().includes('ios');
            const platCls = isIos ? 'is-ios' : 'is-android';
            const title = (typeof getProjectCardTitle === 'function') ? getProjectCardTitle(p, item.key) : (p.appName || displayApp);
            const shortId = (typeof getProjectShortId === 'function') ? getProjectShortId(p, item.key) : (p.projectId || '');
            const initial = String(title || 'A').charAt(0).toUpperCase();
            const pages = (p.pages || []).length;
            const scens = (p.scenarios || []).length;
            const feats = (typeof countProjectFeatures === 'function') ? countProjectFeatures(p) : ((p.features || []).length);
            const updated = formatLaunchPickerDate(p.lastUpdated || p.createdAt);
            const isConfigured = (item.key === configuredKey);
            const isSelected = (item.key === selectedKey);
            const searchBits = `${title} ${shortId} ${item.key}`.toLowerCase();
            return `
                <button type="button" class="launch-picker-card${isSelected ? ' is-selected' : ''}" data-project-key="${esc(item.key)}" data-search="${esc(searchBits)}" title="${esc(title)}${shortId ? ` · ${shortId}` : ''} · Updated ${esc(updated)}" role="option" aria-selected="${isSelected ? 'true' : 'false'}">
                    <span class="launch-picker-radio" aria-hidden="true"></span>
                    <span class="launch-picker-avatar ${platCls}">${esc(initial)}</span>
                    <span class="launch-picker-info">
                        <span class="launch-picker-name">${esc(title)}</span>
                        ${shortId ? `<span class="launch-picker-id">${esc(shortId)}</span>` : ''}
                        ${isConfigured ? `<span class="launch-picker-linked-pill" title="Configured project for this app">Linked</span>` : ''}
                    </span>
                    <span class="launch-picker-stats">
                        <span class="launch-picker-stat is-scen" title="${scens} Scenarios">${scens}s</span>
                        <span class="launch-picker-stat is-feat" title="${feats} Features">${feats}f</span>
                        <span class="launch-picker-stat is-page" title="${pages} Pages">${pages}p</span>
                    </span>
                    <span class="launch-picker-updated">${esc(updated)}</span>
                </button>`;
        }).join('');

        const rowH = 36;
        const gapH = 4;
        const visibleCount = Math.min(items.length, 5);
        const listH = visibleCount > 0
            ? (visibleCount * rowH) + (Math.max(0, visibleCount - 1) * gapH)
            : 0;
        list.style.height = `${listH}px`;
        list.style.maxHeight = `${listH}px`;
        list.style.overflowY = items.length > 5 ? 'auto' : 'hidden';

        list.onclick = (e) => {
            const card = e.target.closest('.launch-picker-card');
            if (!card || !list.contains(card)) return;
            selectProjectKey(card.getAttribute('data-project-key'));
        };
        list.ondblclick = (e) => {
            const card = e.target.closest('.launch-picker-card');
            if (!card || !list.contains(card)) return;
            selectProjectKey(card.getAttribute('data-project-key'));
            continueBtn.click();
        };
        if (searchInput) {
            searchInput.oninput = () => {
                const q = (searchInput.value || '').trim().toLowerCase();
                let visible = 0;
                list.querySelectorAll('.launch-picker-card').forEach(card => {
                    const hay = (card.getAttribute('data-search') || '').toLowerCase();
                    const show = !q || hay.includes(q);
                    card.style.display = show ? 'flex' : 'none';
                    if (show) visible += 1;
                });
                let emptyEl = list.querySelector('.launch-picker-empty');
                if (!visible) {
                    if (!emptyEl) {
                        emptyEl = document.createElement('div');
                        emptyEl.className = 'launch-picker-empty';
                        emptyEl.textContent = 'No matching projects';
                        list.appendChild(emptyEl);
                    }
                    emptyEl.style.display = 'block';
                } else if (emptyEl) {
                    emptyEl.style.display = 'none';
                }
            };
        }

        continueBtn.onclick = async () => {
            const chosen = items.find(it => it.key === selectedKey);
            if (!chosen || window._resumeOldProjectLaunchInFlight) return;
            if (typeof setAppConfiguredProject === 'function') {
                setAppConfiguredProject(appName, platform, chosen.key);
            }
            hideLaunchProjectPicker();
            await resumeExistingProjectAndLaunch(chosen.key, chosen.project, launchParams);
        };
        createBtn.onclick = async () => {
            await startCreateNewProjectLaunch(appName, platform, launchParams);
        };
        cancelBtn.onclick = () => cancelLaunchProjectPicker();

        pendingExportAction = "confirmExistingProjectLaunch";
        window.pendingExportAction = "confirmExistingProjectLaunch";
        selectProjectKey(selectedKey);

        modal.style.display = 'flex';
        document.getElementById('overlay').style.display = 'block';
    }

    document.getElementById("Run").addEventListener('click', async () => {
            if (!canEnableLaunch()) {
                showCustomAlert("Authentication Required", "Please paste and connect a valid token before launching the application.", "warning");
                return;
            }
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

            // Windows compatibility check: iOS automation is strictly macOS only
            if (process.platform === 'win32' && plateformOption === 'IOS') {
                showCustomAlert(
                    "Platform Not Supported on Windows",
                    "iOS automation requires macOS with Xcode and Apple developer tools.<br><br>Windows only supports Android devices and emulators. Please switch Platform to <b>Android</b>.",
                    "error"
                );
                return;
            }

            // 1. Smart Validation based on Platform
            let isValid = true;
            const missingFields = [];

            if (!appName.trim() || appName.toLowerCase() === 'select app' || appName.toLowerCase() === 'loading apps...') {
                document.getElementById('appname').style.borderColor = 'red';
                isValid = false;
                missingFields.push("App Name");
            } else {
                document.getElementById('appname').style.borderColor = '';
            }

            if (!deviceName.trim() || deviceName.toLowerCase() === 'select device') {
                document.getElementById('devicename').style.borderColor = 'red';
                isValid = false;
                missingFields.push("Device / Emulator");
            } else {
                document.getElementById('devicename').style.borderColor = '';
            }

            if (!udidName.trim()) {
                document.getElementById('udid').style.borderColor = 'red';
                isValid = false;
                missingFields.push("Device UDID");
            } else {
                document.getElementById('udid').style.borderColor = '';
            }

            if (!appiumURL.trim()) {
                document.getElementById('appiumurl').style.borderColor = 'red';
                isValid = false;
                missingFields.push("Appium URL");
            } else {
                document.getElementById('appiumurl').style.borderColor = '';
            }

            if (!automationName.trim()) {
                document.getElementById('automationName').style.borderColor = 'red';
                isValid = false;
                missingFields.push("Automation Name");
            } else {
                document.getElementById('automationName').style.borderColor = '';
            }

            if (plateformOption === 'Android') {
                if (!appPackage.trim()) {
                    document.getElementById('apppackage').style.borderColor = 'red';
                    isValid = false;
                    missingFields.push("App Package");
                } else {
                    document.getElementById('apppackage').style.borderColor = '';
                }

                if (!appActivity.trim() || appActivity.trim().toLowerCase() === 'loading activity...') {
                    document.getElementById('appactivity').style.borderColor = 'red';
                    isValid = false;
                    missingFields.push("App Activity");
                } else {
                    document.getElementById('appactivity').style.borderColor = '';
                }

                if (!platformVersion.trim()) {
                    platformVersion = '14';
                    document.getElementById('platformversion').value = platformVersion;
                }
            } else {
                if (!bundleID.trim()) {
                    document.getElementById('bundleID').style.borderColor = 'red';
                    isValid = false;
                    missingFields.push("Bundle ID");
                } else {
                    document.getElementById('bundleID').style.borderColor = '';
                }

                if (!platformVersion.trim()) {
                    platformVersion = '17.0';
                    document.getElementById('platformversion').value = platformVersion;
                }
            }

            if (!isValid) {
                showCustomAlert(
                    "Missing Required Fields",
                    `Please fill in or select the required field(s) before launching:<br><br>• <b>${missingFields.join('</b><br>• <b>')}</b>`,
                    "warning"
                );
                return;
            }

            // 2. Launch if Valid
            initialData = [plateformOption, deviceName, platformVersion, automationName, appiumURL, udidName, bundleID, appPackage, appActivity];

            const appSelect = document.getElementById('appname');
            let selectedAppName = '';
            if (appSelect && appSelect.options && appSelect.selectedIndex >= 0) {
                const opt = appSelect.options[appSelect.selectedIndex];
                selectedAppName = (opt.text || opt.innerText || '').trim();
            }
            if (!selectedAppName || selectedAppName.toLowerCase() === 'select app' || selectedAppName.toLowerCase() === 'loading apps...') {
                selectedAppName = (appSelect?.value || appName || '').trim();
            }
            const activeApp = (typeof getCleanAppName === 'function' ? getCleanAppName(selectedAppName) : selectedAppName) || appName;
            const existingProjects = (typeof findExistingRepoProjects === 'function')
                ? findExistingRepoProjects(activeApp, plateformOption)
                : [];

            if (existingProjects.length > 0) {
                const configuredKey = (typeof getAppConfiguredProject === 'function')
                    ? getAppConfiguredProject(activeApp, plateformOption)
                    : null;
                if (configuredKey) {
                    const cfgIdx = existingProjects.findIndex(p => p.key === configuredKey);
                    if (cfgIdx > 0) {
                        const [cfgProj] = existingProjects.splice(cfgIdx, 1);
                        existingProjects.unshift(cfgProj);
                    }
                }
                const chosenInitial = existingProjects[0];
                const launchParams = [
                    plateformOption,
                    deviceName,
                    platformVersion,
                    automationName,
                    appiumURL,
                    udidName,
                    bundleID,
                    appPackage,
                    appActivity
                ];
                pendingLaunchProjectData = {
                    key: chosenInitial.key,
                    project: chosenInitial.project,
                    initialData: launchParams
                };
                window.pendingLaunchProjectData = pendingLaunchProjectData;
                pendingExportAction = "confirmExistingProjectLaunch";
                window.pendingExportAction = "confirmExistingProjectLaunch";
                showLaunchProjectPicker({
                    appName: activeApp,
                    platform: plateformOption,
                    projects: existingProjects,
                    launchParams
                });
                return;
            }

            const store = getProjectStore();
            const uniqueInfo = generateUniqueProjectKey(store, activeApp, plateformOption);
            window.activeProjectSessionMode = 'new';
            window.activeResumedProjectKey = uniqueInfo.key;
            window.activeResumedAppName = uniqueInfo.appName;
            if (typeof setAppConfiguredProject === 'function') {
                setAppConfiguredProject(uniqueInfo.appName, plateformOption, uniqueInfo.key);
            }

            if (!store[uniqueInfo.key]) {
                store[uniqueInfo.key] = {
                    projectId: uniqueInfo.projectId || null,
                    appName: uniqueInfo.appName,
                    platform: plateformOption,
                    createdAt: Date.now(),
                    lastUpdated: Date.now(),
                    lastActivePageName: uniqueInfo.appName,
                    scenarios: [],
                    features: [],
                    pages: [buildInitialProjectPage(uniqueInfo.appName, plateformOption)]
                };
                persistProjectStore(store);
            }

            triggerScreenshotLoader();
            resetFormLockActive = false;
            if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
            launchApp(initialData);
    });

    function formatLaunchFailure(error, platform, deviceName, udid, details = {}) {
        const rawMsg = String((error && error.message) || error || "");
        const isAndroid = platform === 'Android';
        const appRef = isAndroid ? (details.appPackage || details.appName || 'application') : (details.bundleID || details.appName || 'application');

        // Extract original cause from Appium / WebDriver response
        let cleanCause = rawMsg;
        const origMatch = rawMsg.match(/Original error:\s*([^\n\r]+)/i);
        if (origMatch) {
            cleanCause = origMatch[1].trim();
        } else {
            cleanCause = cleanCause
                .replace(/^(WebDriverError|SessionNotCreatedError|Error):\s*/i, '')
                .replace(/^Response code \d+\.?\s*Message:\s*/i, '')
                .replace(/^An unknown server-side error occurred while processing the command\.?\s*/i, '')
                .trim();
        }

        let title = "Application Launch Failed";
        let friendlyMessage = cleanCause;
        let hint = "";

        if (/ECONNREFUSED|connect ECONNREFUSED|127\.0\.0\.1:4723|Appium is not running/i.test(rawMsg)) {
            title = "Appium Server Unreachable";
            friendlyMessage = `Cannot connect to Appium server at ${details.serverURL || '127.0.0.1:4723'}. The service is not responding.`;
            hint = "Restart AlgoScraper or ensure port 4723 is not occupied by another process.";
        } else if (/unauthorized/i.test(rawMsg)) {
            title = "Device Unauthorized";
            friendlyMessage = `Device "${deviceName || udid}" is connected but unauthorized.`;
            hint = "Unlock your phone and tap 'Allow' or 'Always allow' on the USB debugging authorization dialog on your phone screen.";
        } else if (/device.*offline/i.test(rawMsg)) {
            title = "Device Offline";
            friendlyMessage = `Device "${deviceName || udid}" is in an offline state.`;
            hint = "Unplug and reconnect the USB cable, or restart the device/emulator.";
        } else if (/device '[^']+' not found|could not find a device with udid|device.*not found/i.test(rawMsg)) {
            title = "Device Not Found";
            friendlyMessage = `Could not locate device with identifier "${udid || deviceName}".`;
            hint = isAndroid
                ? "Ensure your Android device has USB debugging enabled or emulator is running, then click refresh."
                : "Ensure the iOS Simulator is booted or your physical iPhone is connected and trusted.";
        } else if (/Could not find a driver for automationName 'UiAutomator2'/i.test(rawMsg)) {
            title = "UiAutomator2 Driver Missing";
            friendlyMessage = "Appium cannot find the UiAutomator2 automation driver for Android.";
            hint = "Restart AlgoScraper or run 'appium driver install uiautomator2' in your terminal.";
        } else if (/Could not find a driver for automationName 'XCUITest'/i.test(rawMsg)) {
            title = "XCUITest Driver Missing";
            friendlyMessage = "Appium cannot find the XCUITest automation driver for iOS.";
            hint = "Run 'appium driver install xcuitest' in your terminal on macOS.";
        } else if (/not installed|was not found on the device|does not exist/i.test(rawMsg)) {
            title = isAndroid ? "Android App Not Installed" : "iOS App Not Installed";
            friendlyMessage = `The application "${appRef}" is not installed on device "${deviceName || udid}".`;
            hint = isAndroid
                ? "Install the APK on the device or select the correct app from the App dropdown."
                : "Install the app on the simulator/device or select the correct Bundle ID from the dropdown.";
        } else if (/Developer Mode/i.test(rawMsg)) {
            title = "iOS Developer Mode Disabled";
            friendlyMessage = "Developer Mode is required on iOS 16+ devices to run automation.";
            hint = "On your iPhone, go to Settings → Privacy & Security → Developer Mode, turn it ON, and restart the device.";
        } else if (/passcode|locked/i.test(rawMsg)) {
            title = "Device Screen Locked";
            friendlyMessage = "The device screen is locked with a passcode or PIN.";
            hint = "Unlock the device screen and keep it unlocked while using AlgoScraper.";
        } else if (/WebDriverAgent|xcodebuild/i.test(rawMsg)) {
            title = "iOS WebDriverAgent Failed";
            friendlyMessage = `WebDriverAgent failed to start: ${cleanCause}`;
            hint = "For physical iPhones, ensure your developer profile is trusted in Settings → General → VPN & Device Management. For simulators, check Xcode Command Line Tools.";
        } else if (/process crashed|instrumentation crashed/i.test(rawMsg)) {
            title = "UiAutomator2 Instrumentation Crashed";
            friendlyMessage = `UiAutomator2 process was terminated by Android OS: ${cleanCause}`;
            hint = "On Xiaomi/OPPO/Vivo/Realme devices, enable 'Install via USB' and 'USB Debugging (Security Settings)' in Developer Options.";
        } else if (/ANDROID_HOME|ANDROID_SDK_ROOT/i.test(rawMsg)) {
            title = "Android SDK Missing";
            friendlyMessage = "Android SDK tools (adb) were not found.";
            hint = "Install Android platform-tools or configure the ANDROID_HOME environment variable.";
        } else if (/did not open/i.test(rawMsg)) {
            title = "Application Did Not Open";
            friendlyMessage = cleanCause;
            hint = "Check if the app package and activity are correct, or launch the app manually on the device.";
        } else {
            title = "Launch Error";
            friendlyMessage = cleanCause || "An unexpected error occurred during launch.";
            hint = "Review the log details below to identify the problem.";
        }

        return {
            title,
            friendlyMessage,
            hint,
            technicalError: error
        };
    }

    async function launchApp(initialData) {
            window.launchApp = launchApp;
            window._resettingHome = false;
            if (typeof lockLaunchForm === 'function') {
                lockLaunchForm();
            }
            if (!Array.isArray(initialData) || initialData.length < 9 || !initialData[0] || (!initialData[1] && !initialData[5])) {
                const pOpt = typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : 'Android';
                initialData = [
                    pOpt,
                    document.getElementById('devicename')?.value || '',
                    document.getElementById('platformversion')?.value || '',
                    document.getElementById('automationName')?.value || '',
                    document.getElementById('appiumurl')?.value || '',
                    document.getElementById('udid')?.value || '',
                    document.getElementById('bundleID')?.value || '',
                    document.getElementById('apppackage')?.value || '',
                    document.getElementById('appactivity')?.value || ''
                ];
            }
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
                const udidLower = String(udid || '').trim().toLowerCase();
                const nameLower = String(deviceName || '').trim().toLowerCase();
                const matchedDevice = platformDevices.find(d => {
                    const dId = String(d.id || '').trim().toLowerCase();
                    const dName = String(d.name || '').trim().toLowerCase();
                    return (udidLower && dId === udidLower) || (nameLower && dName === nameLower);
                });

                if (!matchedDevice) {
                    const isIos = platformTarget === 'IOS';
                    const hint = isIos
                        ? 'Please launch an iOS Simulator from Xcode or connect an iPhone with Trust enabled, then click refresh.'
                        : 'Please connect an Android device with USB debugging or start an emulator from Android Studio, then click refresh.';
                    unlockLaunchForm();
                    document.getElementById('overlay').style.display = 'none';
                    resetLaunchPlaceholder(
                        `${isIos ? 'iOS' : 'Android'} device not connected: "${deviceName || udid}". Reconnect device and click Launch Application.`,
                        "error"
                    );
                    showCustomAlert(
                        "Device Not Connected",
                        `The selected ${isIos ? 'iOS' : 'Android'} device (<b>${deviceName || udid}</b>) is not detected.<br><br>${hint}`,
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
                            || "Android SDK tools (adb) were not found on this machine."
                        );
                        showErrorPopup("Android SDK Not Found", err, "Set ANDROID_HOME or install Android platform-tools, and ensure adb is on PATH.");
                        unlockLaunchForm();
                        resetLaunchPlaceholder(
                            `Android SDK Not Found: ${(sdk && sdk.message) || 'Missing adb'}. Check Android tools and try Launch again.`,
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
                    throw new Error(boot && boot.error ? boot.error : "Appium is not responding on port 4723.");
                }
            } catch (bootErr) {
                console.error("Appium ensure failed:", bootErr);
                showErrorPopup("Appium Server Unreachable", bootErr, "Check if port 4723 is occupied by another process, or restart AlgoScraper.");
                unlockLaunchForm();
                resetLaunchPlaceholder(
                    "Appium Server Unreachable: Appium is not responding on port 4723. Restart AlgoScraper.",
                    "error"
                );
                return;
            }

            const isAndroid = platform === 'Android';

            // Auto-detect platform version from device when possible
            if (isAndroid && udid) {
                try {
                    const detected = await ipcRenderer.invoke("get-android-version", udid);
                    if (detected) {
                        platformVersion = String(detected);
                        const pv = document.getElementById('platformversion');
                        if (pv) pv.value = platformVersion;
                    }
                } catch (_) {}
            } else if (!isAndroid && udid) {
                try {
                    const detected = await ipcRenderer.invoke("get-ios-version", udid);
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

            // Quit any previous driver so session is clean
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
                "appium:automationName": automationName,
                "appium:udid": udid,
                "appium:newCommandTimeout": 500000
            };
            if (platformVersion && platformVersion.trim()) {
                caps["appium:platformVersion"] = platformVersion.trim();
            }

            if (isAndroid) {
                // Clean leftover UIA2 / go HOME before creating session
                try {
                    await ipcRenderer.invoke("android-prepare-device", udid);
                    await new Promise(r => setTimeout(r, 800));
                } catch (prepErr) {
                    console.log("Android prepare skipped:", prepErr.message);
                }

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
                caps["appium:settings"] = {
                    ignoreUnimportantViews: false,
                    allowInvisibleElements: true,
                    enableMultiWindows: false,
                    snapshotMaxDepth: 100
                };
            } else {
                caps["appium:bundleId"] = bundleID.trim();
                caps["appium:noReset"] = true;
                caps["appium:simpleIsVisibleCheck"] = true;
                caps["appium:preventWDAAttachments"] = true;
                caps["appium:useJSONSource"] = false;
                caps["appium:wdaLaunchTimeout"] = 90000;
                caps["appium:wdaConnectionTimeout"] = 90000;
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
                    if (/Could not find a driver|UiAutomator2|XCUITest|automationName/i.test(msg)) {
                        console.warn("Automation driver missing on Appium — restarting engine and retrying");
                        await ipcRenderer.invoke("ensure-appium", { forceRestart: true });
                        driver = await buildSession();
                    } else {
                        throw firstErr;
                    }
                }

                // After session is healthy: launch target app and verify foreground state
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
                    await assertAndroidAppOpened(appPackage, udid);
                } else {
                    try {
                        await mobileExecute("mobile: activateApp", { bundleId: bundleID });
                    } catch (activateErr) {
                        console.log("activate/soft-launch skipped:", activateErr.message);
                    }
                    await waitMs(1500);
                    await assertIOSAppOpened(bundleID);
                }

                if (isAndroid) {
                    try { await applyAndroidFullHierarchySettings(); } catch (setErr) {
                        console.warn("Android hierarchy settings skipped:", setErr.message || setErr);
                    }
                }
            } catch (error) {
                console.error("Failed to initialize driver session:", error);
                driver = null;
                const diag = formatLaunchFailure(error, platform, deviceName, udid, {
                    appName: document.getElementById('appname')?.value || '',
                    appPackage,
                    appActivity,
                    bundleID,
                    serverURL
                });

                showErrorPopup(diag.title, diag.technicalError, diag.hint);
                unlockLaunchForm();
                resetLaunchPlaceholder(`${diag.title}: ${diag.friendlyMessage}`, "error");
                return;
            }

            // Enable UI buttons upon successful launch
            document.getElementById('Run').disabled = true;
            document.getElementById('Run').style.backgroundColor = '#B6B6B4';
            setPlatformAppDeviceEditable(false);
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

            // Set initial page name to the App Name as the first page
            // Resumed projects already restored their saved page / table state — do not overwrite it.
            if (window.activeProjectSessionMode !== 'resumed') {
                const initialCleanApp = resolveActiveAppName();
                if (initialCleanApp && initialCleanApp !== 'Active App' && initialCleanApp !== 'Select App' && initialCleanApp !== 'Loading Apps...') {
                    const currentPageVal = document.getElementById('pagename_searchbox')?.value.trim();
                    if (!currentPageVal || currentPageVal === 'DefaultPage' || currentPageVal === 'home' || currentPageVal === 'Page' || (window.registeredPageNames && window.registeredPageNames.size <= 1)) {
                        if (typeof window.setGlobalPageName === 'function') {
                            window.setGlobalPageName(initialCleanApp);
                        } else {
                            const pInput = document.getElementById('pagename_searchbox');
                            if (pInput) pInput.value = initialCleanApp;
                        }
                    }
                }
            }

            try {
                await loadFirstScreen();
                refreshShouldLaunchApp = false;
                if (typeof window.switchAppTab === "function") window.switchAppTab("home");
                if (window.activeProjectSessionMode !== 'resumed' && typeof window.syncActiveProjectToRepo === "function") {
                    window.syncActiveProjectToRepo();
                }
            } catch (screenErr) {
                console.error("loadFirstScreen failed:", screenErr);
                displayScreenshotError(screenErr);
            }
        }
        window.launchApp = launchApp;


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
            if (typeof noteDeviceScreenChanged === 'function') noteDeviceScreenChanged();

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
                    var controlType = mapControlType(node.nodeName, node);
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

                        let controlValue = getInputControlValue(node, controlName);

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
            if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();

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
    let pendingRepoDelete = null;

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

            // Always download full scraped dataset completely, regardless of column visibility
            downloadTableAsJSON('myTable');
        });

    function extractAllTableData(tableId) {
        const table = document.getElementById(tableId || 'myTable');
        if (!table) return [];

        const allHeaderElements = Array.from(document.querySelectorAll('#mainTable thead tr th'));
        const rows = table.querySelectorAll('tr');
        const extractedData = [];

        // Map column index to field key for any custom headers
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
            else if (th.classList.contains('fingerprint') || thText.includes('FINGERPRINT')) colIndexToField[idx] = "FINGERPRINT";
            else if (th.id === 'appUrl' || thText.includes('APP URL')) colIndexToField[idx] = "APP URL";
            else if (th.classList.contains('custom-editable-header')) {
                const colName = th.querySelector('span')?.textContent?.trim() || thText;
                colIndexToField[idx] = colName;
            } else {
                colIndexToField[idx] = null;
            }
        });

        const activeApp = (typeof getCurrentAppIdentity === 'function') ? getCurrentAppIdentity() : '';
        const resolvedDefaultPage = (typeof window.resolveHomePageNameForScrape === 'function')
            ? window.resolveHomePageNameForScrape()
            : (document.getElementById('pagename_searchbox')?.value || '').trim();

        rows.forEach((row) => {
            if (row.classList.contains('empty-excel-row') || row.classList.contains('no-results-row')) return;

            const allCells = Array.from(row.querySelectorAll('td'));
            if (allCells.length === 0) return;

            function getCellValue(cell) {
                if (!cell) return "";
                const selectEl = cell.querySelector('select');
                if (selectEl) {
                    if (selectEl.value !== undefined && selectEl.value !== null && selectEl.value !== "") {
                        return String(selectEl.value).trim();
                    }
                    if (selectEl.selectedIndex >= 0 && selectEl.options[selectEl.selectedIndex]) {
                        return String(selectEl.options[selectEl.selectedIndex].text).trim();
                    }
                    return "";
                }
                const inputEl = cell.querySelector('input[type="text"], textarea');
                if (inputEl) {
                    return (inputEl.value || "").trim();
                }
                // textContent correctly retrieves text even when display: none !important is active on hidden columns
                return (cell.textContent || "").trim();
            }

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

            // 1. Direct semantic class extraction (guaranteed 100% complete data even if columns are hidden)
            const cnCell = row.querySelector('td.cn, td[id*="cn_"]');
            const ctCell = row.querySelector('td.ct, td[id*="ct_"]');
            const xpathCell = row.querySelector('td.xpath, td[id*="xpath_"]');
            const pageCell = row.querySelector('td.page, td[id*="page_"]');
            const identCell = row.querySelector('td.identificationType, td[id*="identificationType_"]');
            const valCell = row.querySelector('td.controlValue, td[id*="controlValue_"]');
            const featCell = row.querySelector('td.featureName, td[id*="featureName_"]');
            const nodeCell = row.querySelector('td.nodeName, td[id*="nodeName_"]');
            const fingerprintCell = row.querySelector('td.fingerprint, .fingerprint');
            const appUrlCell = row.querySelector('td.appUrl, .appUrl');

            if (cnCell) rowObj["CONTROL NAME"] = getCellValue(cnCell);
            if (ctCell) rowObj["CONTROL TYPE"] = getCellValue(ctCell);
            if (xpathCell) rowObj["XPATH"] = getCellValue(xpathCell);
            if (pageCell) rowObj["PAGE NAME"] = getCellValue(pageCell);
            if (identCell) rowObj["IDENTIFICATION TYPE"] = getCellValue(identCell);
            if (valCell) rowObj["CONTROL VALUE"] = getCellValue(valCell);
            if (featCell) rowObj["FEATURE NAME"] = getCellValue(featCell);
            if (nodeCell) rowObj["NODE NAME"] = getCellValue(nodeCell);
            if (fingerprintCell) rowObj["FINGERPRINT"] = getCellValue(fingerprintCell);
            rowObj["APP URL"] = "";

            // 2. Map custom or position-based cells if present
            allCells.forEach((cell, cellIndex) => {
                const fieldName = colIndexToField[cellIndex];
                if (!fieldName || fieldName === "APP URL") return;
                const cellVal = getCellValue(cell);
                if (!rowObj[fieldName] || (fieldName !== "CONTROL NAME" && fieldName !== "CONTROL TYPE" && fieldName !== "XPATH" && fieldName !== "PAGE NAME" && fieldName !== "IDENTIFICATION TYPE" && fieldName !== "CONTROL VALUE" && fieldName !== "FEATURE NAME" && fieldName !== "NODE NAME")) {
                    rowObj[fieldName] = cellVal;
                }
            });

            // 3. Robust field fallbacks
            if (!rowObj["PAGE NAME"] || rowObj["PAGE NAME"].trim().toLowerCase() === 'all') {
                rowObj["PAGE NAME"] = (resolvedDefaultPage && resolvedDefaultPage.toLowerCase() !== 'all') ? resolvedDefaultPage : 'DefaultPage';
            }

            if (!rowObj["FEATURE NAME"]) {
                rowObj["FEATURE NAME"] = rowObj["PAGE NAME"];
            }

            if (!rowObj["NODE NAME"]) {
                rowObj["NODE NAME"] = rowObj["PAGE NAME"];
            }

            // Identification Type: ensure it's always populated even if column was hidden
            if (!rowObj["IDENTIFICATION TYPE"]) {
                const loc = rowObj["XPATH"] || "";
                if (typeof inferIdentificationType === 'function') {
                    rowObj["IDENTIFICATION TYPE"] = inferIdentificationType(loc);
                } else {
                    rowObj["IDENTIFICATION TYPE"] = (loc.startsWith("//") || loc.startsWith("(")) ? "XPath" : (loc ? "AccessibilityId" : "Name");
                }
            }

            rowObj["APP URL"] = "";

            if (!rowObj["FINGERPRINT"] && row.dataset.fingerprint) {
                rowObj["FINGERPRINT"] = row.dataset.fingerprint;
            }

            try {
                rowObj.rect = row.dataset.rect ? JSON.parse(row.dataset.rect) : null;
            } catch (_) {
                rowObj.rect = null;
            }

            // Validate that row has actual data (Control Name, XPath, Control Type, or Page Name)
            const hasData = rowObj["CONTROL NAME"] || rowObj["XPATH"] || rowObj["CONTROL TYPE"] || rowObj["PAGE NAME"];
            if (hasData) {
                extractedData.push(rowObj);
            }
        });

        return extractedData;
    }
    window.extractAllTableData = extractAllTableData;

    function sanitizeExportRow(row) {
        if (!row || typeof row !== 'object') return row;
        const clean = { ...row };
        delete clean.rect;
        delete clean.DELETE;
        clean["APP URL"] = "";
        return clean;
    }
    window.sanitizeExportRow = sanitizeExportRow;

    function downloadTableAsJSON(tableId) {
        const statusBar = document.getElementById('sttus_bar_div');
        if (statusBar) statusBar.style.display = 'none';

        const now = new Date();
        const dateTime = now.toISOString().split('T')[0] + 'T' + now.toTimeString().split(' ')[0];

        const rawControls = extractAllTableData(tableId);
        const dashboardControls = rawControls.map(sanitizeExportRow);

        // Detect if we are in Record Scenario Mode based on whether scenario data was created
        const isRecordMode = window.pageScenarioData && Object.keys(window.pageScenarioData).length > 0;
        let jsonContent;

        if (isRecordMode) {
            const scenariosList = [];
            const stepsByPage = {};

            // Group extracted rows (steps) by Page Name (case-insensitive)
            dashboardControls.forEach(step => {
                const page = (step["PAGE NAME"] || "").trim().toLowerCase();
                if (!stepsByPage[page]) stepsByPage[page] = [];
                stepsByPage[page].push(step);
            });

            // Build the Scenario payload mapping the steps to their corresponding Scenario
            for (const pageName in window.pageScenarioData) {
                const scenarioInfo = window.pageScenarioData[pageName];
                if (scenarioInfo && scenarioInfo.scenarioName) {
                    const pageKey = pageName.trim().toLowerCase();
                    const matchedSteps = (stepsByPage[pageKey] || []).map(sanitizeExportRow);
                    scenariosList.push({
                        "SCENARIO_NAME": scenarioInfo.scenarioName,
                        "SCENARIO_OUTLINE": scenarioInfo.scenarioOutline || "",
                        "STEPS": matchedSteps
                    });
                }
            }

            // Fallback: If no scenario matched or scenariosList is empty, include all steps
            if (scenariosList.length === 0 && dashboardControls.length > 0) {
                scenariosList.push({
                    "SCENARIO_NAME": "Scenario",
                    "SCENARIO_OUTLINE": "",
                    "STEPS": dashboardControls
                });
            }

            jsonContent = {
                "isRecordscenario": true,
                "dashboardControls": {
                    "APP URL": "",
                    "SCENARIOS": scenariosList
                }
            };
        } else {
            // Normal scraping: Scrape UI, element-by-element click scraping, etc.
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
                if (typeof updateTableEmptyState === 'function') updateTableEmptyState();
            } else {
                emptyStateEl.style.display = 'none';
                if (typeof updateTableEmptyState === 'function') updateTableEmptyState();
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
            const newFeatureNameValue = (e.target.innerText || "").replace(/\u00a0/g, " ").trim();
            const tr = e.target.closest('tr');
            const pageCell = tr ? tr.querySelector('.page') : null;
            const rowPageName = (pageCell ? pageCell.innerText.trim() : '') || document.getElementById('pagename_searchbox')?.value || 'Default';
            const oldName = oldFeatureNameValue;
            oldFeatureNameValue = "";

            const revertCell = (value) => {
                e.target.innerText = value || rowPageName;
            };

            const getFeatureIdentityError = (name) => {
                const lower = String(name || '').trim().toLowerCase();
                if (!lower) return "";
                if (rowPageName && lower === rowPageName.toLowerCase()) return "";
                const pageHit = Array.from(window.registeredPageNames || []).some(p => p && String(p).trim().toLowerCase() === lower);
                if (pageHit) return "This name is already used as a Page Name.";
                if (window.pageScenarioData) {
                    for (const key of Object.keys(window.pageScenarioData)) {
                        const scen = window.pageScenarioData[key];
                        if (scen && scen.scenarioName && scen.scenarioName.trim().toLowerCase() === lower) {
                            return "This name is already used as a Scenario Name.";
                        }
                    }
                }
                // Unique across all pages — allow keeping/renaming to the same current value only
                if (typeof isFeatureNameAlreadyUsed === 'function' && isFeatureNameAlreadyUsed(name, oldName)) {
                    return "Feature Name already exists. Please choose a different name.";
                }
                return "";
            };

            // Empty or page-name default: this row is not a created feature
            if (newFeatureNameValue === "" || newFeatureNameValue.toLowerCase() === rowPageName.toLowerCase()) {
                revertCell(rowPageName);
                if (oldName && oldName.toLowerCase() !== rowPageName.toLowerCase()) {
                    const otherCellsUsingIt = Array.from(document.querySelectorAll('#myTable .featureName')).some(c => {
                        if (c === e.target) return false;
                        if (c.innerText.trim().toLowerCase() !== oldName.toLowerCase()) return false;
                        const otherTr = c.closest('tr');
                        const otherPage = otherTr && otherTr.querySelector('.page') ? otherTr.querySelector('.page').innerText.trim() : '';
                        return otherPage.toLowerCase() === rowPageName.toLowerCase();
                    });
                    if (!otherCellsUsingIt && typeof window.removeFeatureCompletely === 'function') {
                        window.removeFeatureCompletely(oldName, null, rowPageName);
                    }
                }
                if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
                return;
            }

            if (newFeatureNameValue === oldName) {
                return;
            }

            const formatErr = (typeof getFeatureNameFormatError === 'function')
                ? getFeatureNameFormatError(newFeatureNameValue)
                : "";
            if (formatErr) {
                revertCell(oldName || rowPageName);
                showCustomAlert("Invalid Feature Name", formatErr, "warning");
                if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
                return;
            }

            const identityErr = getFeatureIdentityError(newFeatureNameValue);
            if (identityErr) {
                revertCell(oldName || rowPageName);
                showCustomAlert("Invalid Feature Name", identityErr, "warning");
                if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
                return;
            }

            const wasPageDefault = !oldName || oldName.toLowerCase() === rowPageName.toLowerCase();

            // Page-name default → always a sub-feature for this row only.
            // A later edit of that same created name uses Rename All / Sub-feature / Cancel.
            if (wasPageDefault) {
                if (typeof window.applyTableFeatureSubFeature === 'function') {
                    window.applyTableFeatureSubFeature(e.target, newFeatureNameValue);
                } else {
                    e.target.innerText = newFeatureNameValue;
                }
                return;
            }

            pendingFeatureRename = {
                oldName: oldName,
                newName: newFeatureNameValue,
                cellElement: e.target,
                pageName: rowPageName
            };
            showConfirmDialog({
                title: "Update Feature Name",
                mainText: `How would you like to apply "<b>${newFeatureNameValue}</b>"?`,
                subText: "Rename All updates this feature on the current device screen only. Sub-feature applies it to this element only. Cancel keeps the previous name.",
                action: "renameFeature",
                theme: "confirm",
                okayBtnText: "Rename All",
                extraBtnText: "Sub-feature"
            });
            return;
        }

        if (typeof window.syncActiveProjectToRepo === 'function') {
            window.syncActiveProjectToRepo();
        }
    });

    tableEl.addEventListener("change", (e) => {
        if (typeof window.syncActiveProjectToRepo === 'function') {
            window.syncActiveProjectToRepo();
        }
    });

    if (!tableEl.dataset.repoLiveSyncObs) {
        tableEl.dataset.repoLiveSyncObs = 'true';
        let liveSyncTimer = null;
        const liveSyncObserver = new MutationObserver(() => {
            if (window._restoringProject || window._applyingRepoToHome || window._resettingHome || pendingFeatureRename) return;
            clearTimeout(liveSyncTimer);
            liveSyncTimer = setTimeout(() => {
                if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
            }, 80);
        });
        liveSyncObserver.observe(tableEl, { childList: true, subtree: true, characterData: true });
    }

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

                        // Check if this coordinate belongs to a feature area on the current page and show it
                        const centerX = rect.x + rect.width / 2;
                        const centerY = rect.y + rect.height / 2;
                        const activeHoverPage = ((typeof getActiveHomePageName === 'function' ? getActiveHomePageName() : '') || '').trim();
                        let matchedArea = null;
                        let minArea = Number.MAX_VALUE;
                        for (const area of registeredFeatureAreas) {
                            if (!isFeatureAreaApplicableToCurrentScreen(area, window.xmlDoc, centerX, centerY)) continue;
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

                        // Check if this coordinate belongs to a feature area on the current page and show it
                        const centerX = rect.x + rect.width / 2;
                        const centerY = rect.y + rect.height / 2;
                        const activeHoverPage = ((typeof getActiveHomePageName === 'function' ? getActiveHomePageName() : '') || '').trim();
                        let matchedArea = null;
                        let minArea = Number.MAX_VALUE;
                        for (const area of registeredFeatureAreas) {
                            if (!isFeatureAreaApplicableToCurrentScreen(area, window.xmlDoc, centerX, centerY)) continue;
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
    const isAppBackground = /closed or running in the background|not running|background/i.test(rawMsg);

    const platform = typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : 'Android';
    const isAndroid = platform === 'Android';

    const screenshotImg = document.getElementById("screenshot");
    if (screenshotImg) screenshotImg.style.display = "none";

    if (isDeviceDisconnected) {
        showDummyDeviceMessage({
            theme: 'error',
            title: isAndroid ? 'Android Device Disconnected' : 'iOS Device Disconnected',
            detail: 'Please reconnect your device and click Launch Application.'
        });
    } else if (isAppBackground) {
        showDummyDeviceMessage({
            theme: 'warning',
            title: 'Application is closed or running in the background.',
            detail: 'Keep the app open, then click Launch Application to reconnect.'
        });
    } else {
        showDummyDeviceMessage({
            theme: 'error',
            title: 'Session Interrupted',
            detail: readableError || 'Communication with the application was interrupted.'
        });
    }

    setLaunchEnabled(canEnableLaunch());

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
        setNoDeviceConnectedState();
        showCustomAlert(
            "Device Disconnected",
            `The connected <b>${isAndroid ? 'Android' : 'iOS'}</b> device was unplugged or disconnected, and no other device is available.<br><br>Please connect a device or start an emulator/simulator to continue.`,
            "warning",
            () => {
                setNoDeviceConnectedState();
            }
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

    // If driver is still active and app is open, do not kill the session
    if (driver && !isDeadSessionError(err) && !isAppClosedOrBackgroundError(err)) {
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
    const code = Number(state);
    if (code === 4) return;

    // Attempt to bring the app back to foreground before giving up
    try {
        await mobileExecute("mobile: activateApp", isIos ? { bundleId: appId } : { appId });
        await waitMs(600);
        const again = Number(await mobileExecute("mobile: queryAppState", isIos ? { bundleId: appId } : { appId }));
        if (again === 4) return;
    } catch (_) {}

    // On Android: check foreground window via ADB before giving up
    if (!isIos) {
        try {
            const udid = document.getElementById('udid') && document.getElementById('udid').value;
            const fg = await ipcRenderer.invoke("android-foreground-package", udid);
            const focused = fg && fg.pkg ? String(fg.pkg) : '';
            if (focused && (focused === appId || focused.startsWith(appId + '.') || appId.startsWith(focused))) {
                return;
            }
        } catch (_) {}

        if (opts.soft !== false && process.platform === 'win32') {
            console.warn("Windows Android foreground check soft-passed (queryAppState=", code, ")");
            return;
        }
    }

    throw new Error("Application is closed or running in the background.");
}

async function assertAndroidAppOpened(pkg, udid) {
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

    for (let i = 0; i < 4; i++) {
        const code = await queryState();
        if (code === 4) return; // In foreground
        if (code === 0) {
            throw new Error(`Application "${appId}" is not installed on this Android device or emulator.`);
        }
        if (i === 0) {
            try {
                await mobileExecute("mobile: activateApp", { appId });
            } catch (_) {}
        }
        await waitMs(1000);
    }

    const finalCode = await queryState();
    if (finalCode === 4) return;

    const deviceUdid = udid || (document.getElementById('udid') && document.getElementById('udid').value);
    let focused = '';
    try {
        const fg = await ipcRenderer.invoke("android-foreground-package", deviceUdid);
        focused = fg && fg.pkg ? String(fg.pkg) : '';
        if (focused && (focused === appId || focused.startsWith(appId + '.') || appId.startsWith(focused))) {
            return;
        }
        // If a system permission dialog is up, the app is open behind it
        if (focused && (focused.includes('permissioncontroller') || focused.includes('packageinstaller') || focused === 'android')) {
            return;
        }
    } catch (_) {}

    if (finalCode === 0) {
        throw new Error(`Application "${appId}" is not installed on the selected device.`);
    } else if (finalCode === 1) {
        throw new Error(`Application "${appId}" failed to run (process not running). It may have crashed or package/activity may be wrong.`);
    } else if (focused) {
        throw new Error(`Application "${appId}" did not appear in foreground. Current active screen on device is "${focused}".`);
    } else {
        throw new Error(`Application "${appId}" did not appear in foreground. Please unlock your device and verify the app opens.`);
    }
}

async function assertIOSAppOpened(bundleId) {
    const bId = String(bundleId || '').trim();
    if (!bId) {
        throw new Error("iOS Bundle ID is missing. Select an app, then click Launch Application.");
    }

    const queryState = async () => {
        try {
            return Number(await mobileExecute("mobile: queryAppState", { bundleId: bId }));
        } catch (_) {
            return NaN;
        }
    };

    for (let i = 0; i < 4; i++) {
        const code = await queryState();
        if (code === 4) return; // In foreground
        if (code === 0) {
            throw new Error(`Application with Bundle ID "${bId}" is not installed on this iOS device or simulator.`);
        }
        if (i === 0) {
            try {
                await mobileExecute("mobile: activateApp", { bundleId: bId });
            } catch (_) {}
        }
        await waitMs(1000);
    }

    const finalCode = await queryState();
    if (finalCode === 4 || isNaN(finalCode)) return;

    if (finalCode === 0) {
        throw new Error(`Application with Bundle ID "${bId}" is not installed on this iOS device or simulator.`);
    } else if (finalCode === 1) {
        throw new Error(`Application "${bId}" failed to start on the iOS device (state: not running). Check if the app crashed or needs trust permission in Settings.`);
    } else if (finalCode === 2 || finalCode === 3) {
        throw new Error(`Application "${bId}" is suspended or running in the background and could not be brought to the foreground.`);
    }
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
            handleFeatureClick(clickX, clickY);
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
        if (typeof noteDeviceScreenChanged === 'function') noteDeviceScreenChanged();

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



/**
 * Extracts meaningful content nodes (ignoring status bars, home indicators, and root wrappers)
 * with robust identification keys and bounding rectangles.
 */
function extractContentNodes(xmlDoc) {
    if (!xmlDoc) return [];
    const all = xmlDoc.getElementsByTagName("*");
    // Same ignore set for Windows + Mac Android and Mac iOS so screen signatures stay comparable
    const ignoreTypes = new Set([
        "AppiumAUT", "XCUIElementTypeApplication", "XCUIElementTypeWindow",
        "hierarchy", "android.widget.FrameLayout", "android.view.ViewGroup",
        "XCUIElementTypeStatusBar", "XCUIElementTypeHomeIndicator",
        "XCUIElementTypeScrollBar"
    ]);

    const items = [];
    for (let i = 0; i < all.length; i++) {
        const node = all[i];
        const tag = node.nodeName;

        if (
            ignoreTypes.has(tag) ||
            tag.includes("StatusBar") ||
            tag.includes("HomeIndicator") ||
            tag.includes("ActivityIndicator") ||
            tag.includes("ScrollBar")
        ) {
            continue;
        }

        // Android system chrome (real device + emulator on Windows/Mac) — same idea as iOS StatusBar skip
        const pkg = String(node.getAttribute("package") || "").toLowerCase();
        if (pkg === "com.android.systemui") continue;
        const rid = String(node.getAttribute("resource-id") || "").toLowerCase();
        if (
            rid.includes("status_bar") ||
            rid.includes("navigation_bar") ||
            rid.includes("/nav_bar") ||
            rid.endsWith(":id/navigationbarbackground")
        ) {
            continue;
        }

        const rect = typeof parseNodeRect === "function" ? parseNodeRect(node) : null;
        if (!rect || rect.width <= 6 || rect.height <= 6) continue;

        let text = node.getAttribute("label")
            || node.getAttribute("text")
            || node.getAttribute("content-desc")
            || node.getAttribute("name")
            || node.getAttribute("value")
            || node.getAttribute("resource-id")
            || "";
        text = String(text).trim();

        // Skip transient clock, battery, wifi text
        if (text && (/^\d{1,2}:\d{2}/.test(text) || /battery/i.test(text) || /wifi/i.test(text) || /carrier/i.test(text))) {
            continue;
        }

        const roundW = Math.round(rect.width / 6) * 6;
        const roundH = Math.round(rect.height / 6) * 6;
        const key = text ? `${tag}:${text}` : `${tag}#${roundW}x${roundH}`;

        items.push({
            key,
            text,
            tag,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
        });
    }
    return items;
}

/**
 * Accurately determines if content meaningfully moved during a swipe.
 * Distinguishes true scrolling from unscrollable pages or elastic rubber-band bounces.
 */
function hasScreenContentScrolled(preDoc, postDoc, preImage, postImage) {
    if (preDoc && postDoc) {
        const preItems = extractContentNodes(preDoc);
        const postItems = extractContentNodes(postDoc);

        if (preItems.length > 0 && postItems.length > 0) {
            const preMap = new Map();
            for (const item of preItems) {
                if (!preMap.has(item.key)) preMap.set(item.key, []);
                preMap.get(item.key).push(item.y);
            }

            const postMap = new Map();
            for (const item of postItems) {
                if (!postMap.has(item.key)) postMap.set(item.key, []);
                postMap.get(item.key).push(item.y);
            }

            let newItemsCount = 0;
            let removedItemsCount = 0;
            const yDeltas = [];

            for (const [key, postYs] of postMap.entries()) {
                if (!preMap.has(key)) {
                    newItemsCount += postYs.length;
                } else {
                    const preYs = preMap.get(key);
                    preYs.sort((a, b) => a - b);
                    postYs.sort((a, b) => a - b);
                    for (let i = 0; i < Math.min(preYs.length, postYs.length); i++) {
                        yDeltas.push(Math.abs(postYs[i] - preYs[i]));
                    }
                    if (postYs.length > preYs.length) {
                        newItemsCount += (postYs.length - preYs.length);
                    }
                }
            }

            for (const [key, preYs] of preMap.entries()) {
                if (!postMap.has(key)) {
                    removedItemsCount += preYs.length;
                } else {
                    const postYs = postMap.get(key);
                    if (preYs.length > postYs.length) {
                        removedItemsCount += (preYs.length - postYs.length);
                    }
                }
            }

            // Real movement threshold: >= 28px
            const MIN_SCROLL_SHIFT_PX = 28;

            if (newItemsCount > 0 || removedItemsCount > 0) {
                console.log(`[Scroll Check] Content scrolled: ${newItemsCount} new items, ${removedItemsCount} removed items.`);
                return true;
            }

            if (yDeltas.length > 0) {
                const significantMoves = yDeltas.filter(delta => delta >= MIN_SCROLL_SHIFT_PX);
                if (significantMoves.length >= Math.max(1, Math.round(yDeltas.length * 0.20))) {
                    console.log(`[Scroll Check] Content scrolled: ${significantMoves.length}/${yDeltas.length} elements shifted by >= ${MIN_SCROLL_SHIFT_PX}px.`);
                    return true;
                }
            }

            console.log("[Scroll Check] No meaningful scroll detected (content remained static or bounced back).");
            return false;
        }
    }

    // Fallback if no DOM items: compare image hashes / lengths if available
    if (preImage && postImage) {
        return preImage !== postImage;
    }

    return false;
}

// Perform swipe action on connected device
async function performSwipe(startX, startY, endX, endY) {
    if (touchInProgress) return;
    touchInProgress = true; // Lock interactions instantly

    await showLocalDeviceLoader();

    try {
        const pageName = document.getElementById("pagename_searchbox").value.trim();
        if (pageName === "") {
            document.getElementById("pagename_searchbox").style.borderColor = "red";
            showCustomAlert("Missing Information", "Please enter Page Name before attempting to scroll.", "warning");
            flashPageNameError();
            return;
        }

        await checkAppForegroundState();

        // Fresh pre-swipe snapshot
        let preXmlDoc = null;
        try {
            const preSource = await capturePageSource();
            preXmlDoc = new DOMParser().parseFromString(preSource, "text/xml");
        } catch (_) {}
        if (!preXmlDoc && window.xmlDoc) {
            preXmlDoc = window.xmlDoc;
        }

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
        const direction = Math.abs(dy) >= Math.abs(dx)
            ? (dy < 0 ? 'up' : 'down')
            : (dx < 0 ? 'left' : 'right');
        const areaLeft = Math.max(0, Math.round(dims.width * 0.08));
        const areaTop = Math.max(0, Math.round(dims.height * 0.15));
        const areaWidth = Math.max(40, Math.round(dims.width * 0.84));
        const areaHeight = Math.max(40, Math.round(dims.height * 0.65));
        const travel = Math.sqrt(dx * dx + dy * dy);
        const percent = Math.min(0.95, Math.max(0.35, travel / Math.max(dims.height, dims.width, 1)));

        if (plateformOption === 'Android') {
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
                const actions = driver.actions({ bridge: true, async: false });
                await actions
                    .move({ x: Math.round(startX), y: Math.round(startY) })
                    .press()
                    .move({ x: Math.round(endX), y: Math.round(endY), duration: 250 })
                    .release()
                    .perform();
            }
        } else {
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

        // Allow rubber-band bounce / scroll momentum to fully settle
        await waitMs(1400);

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
        if (typeof noteDeviceScreenChanged === 'function') noteDeviceScreenChanged();
        clearOverlay();

        // Check if content genuinely scrolled
        if (!hasScreenContentScrolled(preXmlDoc, window.xmlDoc, preImage, image)) {
            showCustomAlert(
                "Scroll Complete",
                "No more content to scroll on this page (end of page reached). Swipe was not added to the table.",
                "info"
            );
            return;
        }

        // Record the Scroll Action in the Table ONLY if content actually scrolled
        let rootXPath = (plateformOption === 'IOS' || plateformOption === 'iOS') ? "//XCUIElementTypeApplication" : "//hierarchy";

        const activePageForScroll = (typeof window.resolveHomePageNameForScrape === 'function')
            ? window.resolveHomePageNameForScrape()
            : (document.getElementById('pagename_searchbox')?.value || '').trim() || 'DefaultPage';
        const activeFeatureForScroll = (document.getElementById('featurename_searchbox')?.value || '').trim() || activePageForScroll;

        createAndAppendTable([
            {
                ControlName: `act_Scroll_${Math.round(startX)}_${Math.round(startY)}`,
                ControlType: "Scroll",
                ControlId: [
                    `SWIPE(${Math.round(startX)},${Math.round(startY)},${Math.round(endX)},${Math.round(endY)})`,
                    rootXPath
                ],
                ControlValue: "",
                IdentificationType: "Scroll",
                FeatureName: activeFeatureForScroll,
                NodeName: activePageForScroll,
                Fingerprint: "<Action Type=\"Scroll\" />"
            }
        ]);

    } catch (err) {
        handleDeviceCommandError(err, "Swipe Error:");
    } finally {
        hideLocalDeviceLoader();
        touchInProgress = false;
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

            // Find if current point is within a registered feature area for the current page (prefer smallest)
            let currentFeatureArea = null;
            let smallestAreaFound = Number.MAX_VALUE;
            const currentPreviewPage = ((typeof getActiveHomePageName === 'function' ? getActiveHomePageName() : '') || '').trim();
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
                // Only highlight features that belong to the CURRENT device screen
                if (typeof isSameFeatureScreen === 'function') {
                    if (!isSameFeatureScreen(area, window.xmlDoc)) continue;
                } else if (!isFeatureAreaApplicableToCurrentScreen(area, window.xmlDoc, x, y)) {
                    continue;
                }
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
                drawFeatureHoverAt(x, y);
                if (currentFeatureArea) {
                    drawFeatureAreaHighlight(currentFeatureArea, { active: true });
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

            if (!isNodeVisibleOnScreen(node)) {
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
                           <img src="icon/icons8-delete_red.svg" alt="delete" class="deleteBtn" style="margin: 0 auto; max-width:17px; cursor: pointer; -webkit-user-drag: none; display:inline-block;">
                       </td>`;
                   }else {
                       rowHtml += `<td contenteditable="true" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; font-weight: 600; border-color: black; text-align: center; ${displayStyle}">&nbsp;</td>`;
                   }
               });

               tableTopRow.innerHTML = rowHtml;
               tableCreated = true;
               document.getElementById('table-container').style.display = "block";

               updateRowNumbers();
               if (typeof applyPagination === 'function') applyPagination();
               if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
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

    var pageName = (typeof window.resolveHomePageNameForScrape === 'function')
        ? window.resolveHomePageNameForScrape()
        : document.getElementById('pagename_searchbox').value;
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
        try {
            tr.dataset.screenSignature = (typeof computeScreenSignature === 'function')
                ? (computeScreenSignature(window.xmlDoc) || '')
                : '';
        } catch (_) {
            tr.dataset.screenSignature = '';
        }
        if (dtControls[i].featureId) {
            tr.dataset.featureId = String(dtControls[i].featureId);
        }

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
                            "DELETE": `<img src="icon/icons8-delete_red.svg" id="del_${td_id}" alt="delete" class="deleteBtn" style="margin: 0 auto; max-width:17px; overflow: hidden; cursor: pointer; -webkit-user-drag: none; display:inline-block;">`,
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
                    <img src="icon/icons8-delete_red.svg" alt="delete" class="deleteBtn" style="margin: 0 auto; max-width:17px; cursor: pointer; -webkit-user-drag: none; display:inline-block;">
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
    if (typeof autoAdjustTableLayout === 'function') autoAdjustTableLayout();

    applyPagination();
    if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
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
                    // Minimum column width limit: 30px
                    if (currentWidth >= 30) {
                        th.style.width = `${currentWidth}px`;
                        th.style.minWidth = `${currentWidth}px`;
                        th.dataset.userWidth = String(currentWidth);
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
                    if (typeof autoAdjustTableLayout === 'function') autoAdjustTableLayout();
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
                th.dataset.userWidth = String(maxWidth);
                if (typeof autoAdjustTableLayout === 'function') autoAdjustTableLayout();
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
    }

    function drawFeatureHover(node){
        if (!node) return;
        const rect = nodeRectOnScreenshot(node);
        if (!rect) return;
        drawFeatureHoverAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
    }

    /**
     * Create Feature hover preview — highlights the exact section/control under the cursor (or whole page when hovering empty space).
     */
    function drawFeatureHoverAt(x, y) {
        clearOverlay();

        const overlay = document.getElementById("overlayContainer");
        const img = document.getElementById("screenshot");
        if (!overlay || !img || !window.xmlDoc) return;

        const node = findHoveredNode(x, y);
        if (!node) {
            drawFullPageFeatureFrame(img, overlay);
            return;
        }

        const nodeRect = nodeRectOnScreenshot(node);
        if (!nodeRect || nodeRect.width <= 0 || nodeRect.height <= 0) {
            drawFullPageFeatureFrame(img, overlay);
            return;
        }

        const { invScaleX: scaleX, invScaleY: scaleY } = getScreenshotScale(img);
        const overlayRect = overlay.getBoundingClientRect();
        const imgRect = img.getBoundingClientRect();
        const offsetX = imgRect.left - overlayRect.left;
        const offsetY = imgRect.top - overlayRect.top;

        const box = document.createElement("div");
        box.style.position = "absolute";
        box.style.left = (offsetX + nodeRect.x * scaleX) + "px";
        box.style.top = (offsetY + nodeRect.y * scaleY) + "px";
        box.style.width = (nodeRect.width * scaleX) + "px";
        box.style.height = (nodeRect.height * scaleY) + "px";
        box.style.border = "2px dashed #2F8BCC";
        box.style.backgroundColor = "rgba(47, 139, 204, 0.08)";
        box.style.borderRadius = "3px";
        box.style.pointerEvents = "none";
        box.style.boxSizing = "border-box";
        box.style.zIndex = "100";

        overlay.appendChild(box);
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
            if (typeof noteDeviceScreenChanged === 'function') noteDeviceScreenChanged();
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
            let controlValue = getInputControlValue(node, controlName);

            // CHECK: Is the node center within a feature created on THIS device screen only?
            let nodeEffectiveFeatureName = "";
            let nodeFeatureId = "";
            let nodeSmallestAreaFound = Number.MAX_VALUE;
            if (nodeRect) {
                const nodeCenterX = nodeRect.x + nodeRect.width / 2;
                const nodeCenterY = nodeRect.y + nodeRect.height / 2;
                for (const area of registeredFeatureAreas) {
                    if (!area || !area.rect || !area.name) continue;
                    if (typeof isSameFeatureScreen === 'function') {
                        if (!isSameFeatureScreen(area, window.xmlDoc)) continue;
                    } else if (!isFeatureAreaApplicableToCurrentScreen(area, window.xmlDoc, nodeCenterX, nodeCenterY)) {
                        continue;
                    }
                    const { x, y, width, height } = area.rect;
                    if (nodeCenterX >= x && nodeCenterX <= (x + width) && nodeCenterY >= y && nodeCenterY <= (y + height)) {
                        const rectArea = width * height;
                        if (rectArea < nodeSmallestAreaFound) {
                            nodeSmallestAreaFound = rectArea;
                            nodeEffectiveFeatureName = area.name;
                            nodeFeatureId = area.id || "";
                        }
                    }
                }
            }

            dtControls.push({
                ControlName: controlName,
                ControlType: mapControlType(uiName, node),
                ControlId: allXPaths,
                ControlValue: controlValue,
                IdentificationType: inferIdentificationType(allXPaths[0]),
                FeatureName: nodeEffectiveFeatureName || pageName,
                featureId: nodeFeatureId,
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

        // Always send full scraped dataset completely, regardless of column visibility
        await sendTableDataToAPI("myTable");
    });

    async function sendTableDataToAPI(tableId) {
        const userData = JSON.parse(localStorage.getItem("algoQAUser"));
        if (!userData) {
            showCustomAlert("Authentication Error", "Token data not found.", "error");
            return;
        }

        const rawTableData = extractAllTableData(tableId);
        const tableData = (typeof sanitizeExportRow === 'function')
            ? rawTableData.map(sanitizeExportRow)
            : rawTableData.map(r => { const { rect, DELETE, ...rest } = r; rest["APP URL"] = ""; return rest; });

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

            // Group rows (steps) by their PAGE NAME (case-insensitive)
            tableData.forEach(step => {
                var page = (step["PAGE NAME"] || "").trim().toLowerCase();
                if (!stepsByPage[page]) stepsByPage[page] = [];
                stepsByPage[page].push(step);
            });

            // Assemble SCENARIOS list mapping steps to their relevant scenario details
            for (var pageName in window.pageScenarioData) {
                var scenarioInfo = window.pageScenarioData[pageName];
                if (scenarioInfo && scenarioInfo.scenarioName) {
                    var pageKey = pageName.trim().toLowerCase();
                    var matchedSteps = (stepsByPage[pageKey] || []).map(r => {
                        const { rect, DELETE, ...rest } = r;
                        rest["APP URL"] = "";
                        return rest;
                    });
                    scenariosList.push({
                        "SCENARIO_NAME": scenarioInfo.scenarioName,
                        "SCENARIO_OUTLINE": scenarioInfo.scenarioOutline || "",
                        "STEPS": matchedSteps
                    });
                }
            }

            // Fallback: If no scenario matched or scenariosList is empty, include all steps
            if (scenariosList.length === 0 && tableData.length > 0) {
                scenariosList.push({
                    "SCENARIO_NAME": "Scenario",
                    "SCENARIO_OUTLINE": "",
                    "STEPS": tableData
                });
            }

            finalDataPayload = {
                "dashboardControls": {
                    "APP URL": "",
                    "SCENARIOS": scenariosList
                }
            };
        } else {
            // Normal scraping: Scrape UI, element-by-element click scraping, etc.
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

            const platform = typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : 'Android';
            const udid = (document.getElementById('udid')?.value || '').trim();
            const packageName = (document.getElementById('apppackage')?.value || '').trim();
            const bundleId = (document.getElementById('bundleID')?.value || '').trim();

            if (driver) {
                try {
                    if (platform === 'Android' && packageName) {
                        try {
                            await driver.executeScript("mobile: terminateApp", { appId: packageName });
                        } catch (_) {
                            try { await driver.terminateApp(packageName); } catch (_) {}
                        }
                    } else if (bundleId) {
                        try {
                            await driver.executeScript("mobile: terminateApp", { bundleId: bundleId });
                        } catch (_) {
                            try { await driver.terminateApp(bundleId); } catch (_) {}
                        }
                    }
                } catch (termErr) {
                    console.log("Terminate app on device skipped:", termErr);
                }

                try {
                    await driver.quit();
                } catch (err) {}
                driver = null;
            }

            // Explicit OS/CLI level termination for real Android/iOS devices and emulators/simulators
            try {
                const { exec } = require("child_process");
                if (platform === 'Android' && packageName) {
                    const adbCmd = udid
                        ? `adb -s "${udid}" shell am force-stop "${packageName}"`
                        : `adb shell am force-stop "${packageName}"`;
                    exec(adbCmd, () => {});
                } else if (process.platform === 'darwin' && (platform === 'IOS' || platform === 'iOS')) {
                    if (bundleId) {
                        exec(`xcrun simctl terminate booted "${bundleId}"`, () => {});
                        if (udid) {
                            exec(`xcrun devicectl device process terminate --device "${udid}" "${bundleId}"`, () => {});
                        }
                    }
                    exec("xcrun simctl shutdown all", () => {});
                }
            } catch (cliErr) {
                console.log("CLI termination skipped:", cliErr);
            }

            setTimeout(() => {
                ipcRenderer.send("close-app");
            }, 1200);

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
                if (typeof noteDeviceScreenChanged === 'function') noteDeviceScreenChanged();
                clearOverlay();
                currentFeatureArea = null;

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
/** Feature name format rules — identical on Windows/Mac for Android + iOS (real/emulator/simulator). */
function getFeatureNameFormatError(val) {
    if (!val || String(val).trim() === '') return "Feature Name is required.";
    const trimmed = String(val).trim();
    if (trimmed.length < 3) return "Feature Name must be at least 3 characters.";
    if (trimmed.toLowerCase() === 'all') return "Feature Name cannot be All.";
    if (trimmed.startsWith(" ") || trimmed.endsWith(" ") || /\s{2,}/.test(String(val))) {
        return "Feature Name cannot have leading, trailing, or double spaces.";
    }
    const formatRegex = /^[A-Za-z][A-Za-z0-9_]*(\s[A-Za-z0-9_]+)*$/;
    if (!formatRegex.test(trimmed)) {
        return "Feature Name must start with a letter and can contain only letters, numbers, underscore, and a single space between words.";
    }
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount > 3) {
        return "Feature Name can have at most 3 words.";
    }
    return "";
}
window.getFeatureNameFormatError = getFeatureNameFormatError;

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



const REPO_STORAGE_KEY = 'algoscraper_repository_projects_store_v2';
const LEGACY_STORAGE_KEY = 'algoscraper_repository_store_v1';

const KNOWN_APP_NAMES = {
    'com.apple.mobilecal': 'Calendar',
    'com.apple.preferences': 'Settings',
    'com.apple.mobilesafari': 'Safari',
    'com.apple.mobileaddressbook': 'Contacts',
    'com.apple.mobiletimer': 'Clock',
    'com.apple.reminders': 'Reminders',
    'com.apple.calculator': 'Calculator',
    'com.apple.mobilenotes': 'Notes',
    'com.apple.camera': 'Camera',
    'com.apple.mobileslideshow': 'Photos',
    'com.apple.appstore': 'App Store',
    'com.apple.maps': 'Maps',
    'com.apple.music': 'Music',
    'com.apple.health': 'Health',
    'com.apple.weather': 'Weather',
    'com.apple.mobilemail': 'Mail',
    'com.apple.mobilephone': 'Phone',
    'com.apple.mobilesms': 'Messages',
    'com.apple.documentsapp': 'Files',
    'com.apple.news': 'News',
    'com.apple.podcasts': 'Podcasts',
    'com.apple.stocks': 'Stocks',
    'com.apple.tv': 'Apple TV',
    'com.apple.tips': 'Tips',
    'com.apple.facetime': 'FaceTime',
    'com.android.settings': 'Settings',
    'com.android.chrome': 'Chrome',
    'com.android.camera': 'Camera',
    'com.android.camera2': 'Camera',
    'com.google.android.calendar': 'Calendar',
    'com.google.android.apps.messaging': 'Messages',
    'com.google.android.dialer': 'Phone',
    'com.google.android.calculator': 'Calculator',
    'com.google.android.deskclock': 'Clock',
    'com.google.android.gm': 'Gmail',
    'com.google.android.apps.photos': 'Photos',
    'com.google.android.apps.maps': 'Google Maps',
    'com.google.android.youtube': 'YouTube',
    'com.ril.mobilecal': 'Calendar'
};

function getCleanAppName(raw) {
    if (!raw) return 'App';
    let str = String(raw).trim();
    const lower = str.toLowerCase();
    if (KNOWN_APP_NAMES[lower]) {
        return KNOWN_APP_NAMES[lower];
    }

    if (/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)+$/.test(str)) {
        const parts = str.split('.');
        let last = parts[parts.length - 1] || str;
        if (KNOWN_APP_NAMES[last.toLowerCase()]) {
            return KNOWN_APP_NAMES[last.toLowerCase()];
        }
        if (last.toLowerCase().startsWith('mobile') && last.length > 6) {
            last = last.substring(6);
        }
        return last.charAt(0).toUpperCase() + last.slice(1);
    }
    return str;
}

function resolveActiveAppName() {
    if (window.activeResumedAppName) return window.activeResumedAppName;
    const appSelect = document.getElementById('appname');
    let val = '';
    if (appSelect) {
        if (appSelect.options && appSelect.selectedIndex >= 0 && appSelect.options[appSelect.selectedIndex]) {
            const opt = appSelect.options[appSelect.selectedIndex];
            val = (opt.text || opt.innerText || '').trim();
        }
        if (!val || val.toLowerCase() === 'loading apps...' || val.toLowerCase() === 'select app') {
            val = (appSelect.value || '').trim();
        }
    }
    if (!val || val.toLowerCase() === 'loading apps...' || val.toLowerCase() === 'select app') {
        val = (document.getElementById('bundleID')?.value || document.getElementById('apppackage')?.value || '').trim();
    }
    if (!val || val.toLowerCase() === 'select app') {
        val = 'Active App';
    }
    return getCleanAppName(val);
}

function nextNumericProjectId(store, baseAppName, platform) {
    const cleanApp = (typeof getCleanAppName === 'function' ? getCleanAppName(baseAppName) : (baseAppName || '')).trim().toLowerCase();
    const plat = String(platform || 'Android').toLowerCase().includes('ios') ? 'ios' : 'android';
    let max = 0;
    Object.keys(store || {}).forEach(k => {
        const proj = store[k];
        const pApp = (typeof getCleanAppName === 'function'
            ? getCleanAppName(proj && proj.appName ? proj.appName : String(k).split('::')[0].replace(/\s*\(.*?\)\s*$/, ''))
            : String(k)).trim().toLowerCase();
        const pPlat = String((proj && proj.platform) || k).toLowerCase().includes('ios') ? 'ios' : 'android';
        if (cleanApp && (pApp !== cleanApp || pPlat !== plat)) return;
        const raw = (proj && proj.projectId) || (String(k).includes('::') ? String(k).split('::').pop() : '');
        const m = String(raw).match(/^p_(\d+)$/i);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n > max) max = n;
        }
    });
    return 'p_' + (max + 1);
}

function createProjectId(store, baseAppName, platform) {
    if (store && typeof store === 'object') {
        return nextNumericProjectId(store, baseAppName, platform);
    }
    return 'p_' + String(Date.now()).slice(-6);
}

function repoPlatformLabel(platform) {
    return String(platform || 'Android').toLowerCase().includes('ios') ? 'iOS' : 'Android';
}

function generateUniqueProjectKey(store, baseAppName, platform, options) {
    const forceNew = !!(options && options.forceNew);
    const cleanApp = getCleanAppName(baseAppName) || 'App';
    const plat = repoPlatformLabel(platform);
    const existingKeys = Object.keys(store || {});
    const keyTaken = (key) => existingKeys.some(k => k.toLowerCase() === String(key).toLowerCase());
    const baseKey = `${cleanApp} (${plat})`;

    const matchesAppPlatform = (k) => {
        const proj = store[k];
        const pApp = (typeof getCleanAppName === 'function'
            ? getCleanAppName(proj && proj.appName ? proj.appName : String(k).split('::')[0].replace(/\s*\(.*?\)\s*$/, ''))
            : String(k)).trim().toLowerCase();
        const pPlat = ((proj && proj.platform) || k).toLowerCase().includes('ios') ? 'ios' : 'android';
        return pApp === cleanApp.toLowerCase() && pPlat === plat.toLowerCase();
    };

    if (!forceNew) {
        const exact = existingKeys.find(k => k.toLowerCase() === baseKey.toLowerCase());
        if (exact) {
            return { key: exact, appName: cleanApp, projectId: (store[exact] && store[exact].projectId) || null };
        }
        const anyForApp = existingKeys.some(matchesAppPlatform);
        if (!anyForApp) {
            return { key: baseKey, appName: cleanApp, projectId: null };
        }
    }

    let projectId = createProjectId(store, cleanApp, plat);
    let key = `${baseKey}::${projectId}`;
    let n = parseInt(String(projectId).replace(/^p_/i, ''), 10) || 0;
    while (keyTaken(key)) {
        n += 1;
        projectId = 'p_' + n;
        key = `${baseKey}::${projectId}`;
    }
    return { key, appName: cleanApp, projectId };
}
window.generateUniqueProjectKey = generateUniqueProjectKey;

function getProjectShortId(project, key) {
    if (project && project.projectId) return project.projectId;
    if (key && String(key).includes('::')) return String(key).split('::').pop();
    return '';
}

function isCurrentlyOpenRepoProject(storeKey, project) {
    const liveKey = window.activeResumedProjectKey;
    const liveMode = window.activeProjectSessionMode;
    if (!liveKey || window._resettingHome) return false;
    if (liveMode !== 'new' && liveMode !== 'resumed') return false;
    if (storeKey === liveKey) return true;
    if (String(storeKey).toLowerCase() === String(liveKey).toLowerCase()) return true;
    const liveId = String(liveKey).includes('::') ? String(liveKey).split('::').pop() : '';
    const projId = (project && project.projectId) || (String(storeKey).includes('::') ? String(storeKey).split('::').pop() : '');
    return !!(liveId && projId && liveId === projId);
}
window.isCurrentlyOpenRepoProject = isCurrentlyOpenRepoProject;

function getProjectCardTitle(project, key) {
    if (project && project.appName) return project.appName;
    return String(key || '').split('::')[0].replace(/\s*\(.*?\)\s*$/, '').trim() || 'App';
}

function persistProjectStore(store) {
    if (typeof window.setRepoProjectsStore === 'function') {
        window.setRepoProjectsStore(store);
        return;
    }
    try {
        localStorage.setItem(REPO_STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
        console.error('Error saving repo projects store:', e);
    }
}
window.persistProjectStore = persistProjectStore;

function findProjectKeyInStore(store, preferredKey, hintProject) {
    if (!store || typeof store !== 'object') {
        return { key: preferredKey || null, project: null };
    }
    if (preferredKey && store[preferredKey]) {
        return { key: preferredKey, project: store[preferredKey] };
    }
    if (preferredKey) {
        const lower = String(preferredKey).toLowerCase();
        const foundKey = Object.keys(store).find(k => k.toLowerCase() === lower);
        if (foundKey) return { key: foundKey, project: store[foundKey] };
    }
    const idHint = (preferredKey && String(preferredKey).includes('::'))
        ? String(preferredKey).split('::').pop()
        : ((hintProject && hintProject.projectId) || '');
    if (idHint) {
        const byId = Object.keys(store).find(k =>
            (store[k] && store[k].projectId === idHint) || String(k).endsWith('::' + idHint)
        );
        if (byId) return { key: byId, project: store[byId] };
    }
    return { key: preferredKey || null, project: null };
}
window.findProjectKeyInStore = findProjectKeyInStore;

function fetchRepoProjectSnapshot(projectKey, hintProject) {
    const clone = (p) => {
        try {
            return JSON.parse(JSON.stringify(p));
        } catch (_) {
            return p;
        }
    };
    const richer = (a, b) => {
        if (!a) return b;
        if (!b) return a;
        const score = (p) =>
            ((p.pages || []).length) + ((p.scenarios || []).length) + ((p.features || []).length)
            + ((p.pages || []).reduce((n, pg) => n + ((pg.elements || []).length), 0))
            + ((p.scenarios || []).reduce((n, s) => n + ((s.elements || []).length), 0));
        return score(b) > score(a) ? b : a;
    };

    try {
        const store = getProjectStore();
        let found = null;

        if (projectKey && store[projectKey]) {
            found = store[projectKey];
        }

        if (!found && projectKey) {
            const lower = String(projectKey).toLowerCase();
            const foundKey = Object.keys(store).find(k => k.toLowerCase() === lower);
            if (foundKey) found = store[foundKey];
        }

        const idHint = (projectKey && String(projectKey).includes('::'))
            ? String(projectKey).split('::').pop()
            : ((hintProject && hintProject.projectId) || '');
        if (!found && idHint) {
            const byId = Object.keys(store).find(k =>
                (store[k] && store[k].projectId === idHint) || String(k).endsWith('::' + idHint)
            );
            if (byId) found = store[byId];
        }

        if (!found) {
            const hintApp = (typeof getCleanAppName === 'function'
                ? getCleanAppName((hintProject && hintProject.appName) || '')
                : ((hintProject && hintProject.appName) || '')).trim().toLowerCase();
            const hintPlat = ((hintProject && hintProject.platform) || '').toLowerCase().includes('ios') ? 'ios' : 'android';
            if (hintApp) {
                const matches = Object.keys(store).filter(k => {
                    const p = store[k];
                    if (!p) return false;
                    const pApp = (typeof getCleanAppName === 'function' ? getCleanAppName(p.appName || '') : (p.appName || '')).trim().toLowerCase();
                    const pPlat = (p.platform || k).toLowerCase().includes('ios') ? 'ios' : 'android';
                    return pApp === hintApp && pPlat === hintPlat;
                });
                matches.sort((a, b) => (store[b].lastUpdated || 0) - (store[a].lastUpdated || 0));
                if (matches[0]) found = store[matches[0]];
            }
        }

        const live = found ? clone(found) : null;
        const hint = hintProject ? clone(hintProject) : null;
        return richer(live, hint) || live || hint || null;
    } catch (e) {
        console.error('Error fetching repo project snapshot:', e);
        return hintProject ? clone(hintProject) : null;
    }
}
window.fetchRepoProjectSnapshot = fetchRepoProjectSnapshot;

function createFreshRepoProject(baseAppName, platform) {
    const store = getProjectStore();
    const uniqueInfo = generateUniqueProjectKey(store, baseAppName, platform, { forceNew: true });

    store[uniqueInfo.key] = {
        projectId: uniqueInfo.projectId || null,
        appName: uniqueInfo.appName,
        platform: platform,
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        lastActivePageName: uniqueInfo.appName,
        scenarios: [],
        features: [],
        pages: [buildInitialProjectPage(uniqueInfo.appName, platform)]
    };
    persistProjectStore(store);

    window.activeProjectSessionMode = 'new';
    window.activeResumedProjectKey = uniqueInfo.key;
    window.activeResumedAppName = uniqueInfo.appName;
    if (typeof setAppConfiguredProject === 'function') {
        setAppConfiguredProject(uniqueInfo.appName, platform, uniqueInfo.key);
    }

    return uniqueInfo;
}
window.createFreshRepoProject = createFreshRepoProject;

function repoNameKey(val) {
    return String(val || '').trim().toLowerCase();
}

function buildInitialProjectPage(appName, platform) {
    const name = (typeof getCleanAppName === 'function' ? getCleanAppName(appName) : appName) || 'App';
    return {
        id: 'page_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        pageName: name,
        appName: name,
        count: 0,
        elements: [],
        platform: platform,
        isInitialPage: true,
        timestamp: Date.now()
    };
}

function seedInitialProjectPage(project, appName, platform) {
    if (!project) return null;
    if (!Array.isArray(project.pages)) project.pages = [];
    const name = (typeof getCleanAppName === 'function' ? getCleanAppName(appName) : appName) || '';
    if (!name) return null;
    const existing = project.pages.find(pg => repoNameKey(pg.pageName) === repoNameKey(name));
    if (existing) {
        existing.isInitialPage = true;
        if (!project.lastActivePageName) project.lastActivePageName = existing.pageName;
        return existing;
    }
    const page = buildInitialProjectPage(name, platform || project.platform);
    project.pages.unshift(page);
    project.lastActivePageName = name;
    return page;
}

function isKeptInitialPage(project, page) {
    if (!page) return false;
    if (page.isInitialPage) return true;
    return repoNameKey(page.pageName) === repoNameKey(project && project.appName);
}

function isRepoNameOwnedByScenario(project, name) {
    const key = repoNameKey(name);
    if (!key || !project || !Array.isArray(project.scenarios)) return false;
    return project.scenarios.some(s => repoNameKey(s.pageName) === key || repoNameKey(s.name) === key);
}

function getActiveHomePageName() {
    const el = document.getElementById('pagename_searchbox');
    return (el && el.value ? el.value : '').trim();
}

function resolveHomePageNameForScrape() {
    const raw = getActiveHomePageName();
    if (raw && raw.toLowerCase() !== 'all') return raw;

    const scenarioKeys = Object.keys(window.pageScenarioData || {}).filter(k => k && k.toLowerCase() !== 'all');
    if (scenarioKeys.length === 1) return scenarioKeys[0];

    const snap = window._resumedProjectSnapshot;
    const saved = snap && snap.lastActivePageName ? String(snap.lastActivePageName).trim() : '';
    if (saved && saved.toLowerCase() !== 'all') return saved;

    if (snap && Array.isArray(snap.scenarios) && snap.scenarios.length) {
        const fromScenario = (snap.scenarios[0].pageName || snap.scenarios[0].name || '').trim();
        if (fromScenario && fromScenario.toLowerCase() !== 'all') return fromScenario;
    }

    const pages = Array.from(window.registeredPageNames || []).filter(p => p && String(p).toLowerCase() !== 'all');
    if (pages.length) {
        const appName = (window.activeResumedAppName || '').trim().toLowerCase();
        const owned = pages.filter(p => p.toLowerCase() !== appName);
        return (owned.length ? owned[owned.length - 1] : pages[pages.length - 1]);
    }

    return (window.activeResumedAppName || raw || 'home').trim();
}
window.resolveHomePageNameForScrape = resolveHomePageNameForScrape;

function isDistinctFeatureName(name, pageName) {
    const n = String(name || '').trim();
    if (!n || n.toLowerCase() === 'all') return false;
    if (pageName && repoNameKey(n) === repoNameKey(pageName)) return false;
    return true;
}

function featureIdentityKey(name, pageName, uniqueIdentifier, id, screenSignature) {
    // Count/dedupe by created feature identity — never by scraped element row id
    const n = repoNameKey(name);
    const sig = repoNameKey(String(screenSignature || '').slice(0, 120));
    const uid = repoNameKey(uniqueIdentifier || '');
    if (sig) return `${n}::sig:${sig}`;
    if (uid) return `${n}::uid:${uid}`;
    return `${n}::${repoNameKey(pageName || '')}`;
}
window.featureIdentityKey = featureIdentityKey;

function mergeFeatureItems() {
    const map = new Map();
    Array.from(arguments).forEach(list => {
        (list || []).forEach(f => {
            const name = (f && (f.name || (typeof f === 'string' ? f : ''))) || '';
            const pageHint = (f && typeof f === 'object') ? (f.pageName || '') : '';
            if (!isDistinctFeatureName(name, pageHint)) return;
            const k = featureIdentityKey(name, pageHint, f && f.uniqueIdentifier, null, f && f.screenSignature);
            if (!map.has(k)) {
                map.set(k, {
                    name: String(name).trim(),
                    rect: (f && f.rect) || null,
                    fullPage: !!(f && f.fullPage),
                    pageName: pageHint,
                    id: f && f.id,
                    timestamp: f && f.timestamp,
                    uniqueIdentifier: f && f.uniqueIdentifier,
                    xpaths: f && f.xpaths,
                    screenSignature: f && f.screenSignature,
                    screenContentKeys: f && f.screenContentKeys,
                    nodeText: f && f.nodeText,
                    nodeFingerprint: f && f.nodeFingerprint
                });
            } else {
                const cur = map.get(k);
                if (!cur.rect && f && f.rect) cur.rect = f.rect;
                if (f && f.fullPage) cur.fullPage = true;
                if (!cur.pageName && pageHint) cur.pageName = pageHint;
                if (!cur.uniqueIdentifier && f && f.uniqueIdentifier) cur.uniqueIdentifier = f.uniqueIdentifier;
                if ((!cur.xpaths || !cur.xpaths.length) && f && f.xpaths) cur.xpaths = f.xpaths;
                if (!cur.id && f && f.id) cur.id = f.id;
                if (!cur.screenSignature && f && f.screenSignature) cur.screenSignature = f.screenSignature;
                if (f && f.timestamp && (!cur.timestamp || f.timestamp >= cur.timestamp)) cur.timestamp = f.timestamp;
            }
        });
    });
    return Array.from(map.values());
}

function isUserCreatedFeature(f) {
    if (!f) return false;
    if (typeof f === 'string') return isDistinctFeatureName(f, '');
    if (typeof f !== 'object' || !f.name) return false;
    // Created features carry identity/geometry/timestamp — bare {name,pageName} scrape ghosts do not
    return !!(f.id || f.rect || f.fullPage || f.screenSignature || f.uniqueIdentifier
        || f.timestamp || f.xpaths || f.nodeText || f.nodeFingerprint);
}

function featureItemsFromElements() {
    // Scraped element FEATURE NAME columns are table metadata, not user-created features
    return [];
}

function collectLiveFeatureItemsForPage(pageName) {
    const areas = (typeof window.registeredFeatureAreas !== 'undefined' && Array.isArray(window.registeredFeatureAreas))
        ? window.registeredFeatureAreas
        : [];
    const pageKey = repoNameKey(pageName);
    return areas.filter(a => {
        if (!a || !a.name) return false;
        if (!isDistinctFeatureName(a.name, pageName)) return false;
        if (!pageKey) return false;
        return a.pageName && repoNameKey(a.pageName) === pageKey;
    }).map(a => ({
        name: String(a.name).trim(),
        rect: a.rect || null,
        fullPage: !!a.fullPage,
        pageName: a.pageName || pageName || '',
        id: a.id,
        uniqueIdentifier: a.uniqueIdentifier,
        xpaths: a.xpaths,
        screenSignature: a.screenSignature,
        screenContentKeys: a.screenContentKeys,
        nodeText: a.nodeText,
        nodeFingerprint: a.nodeFingerprint,
        timestamp: a.timestamp
    }));
}

function nestFeatureOnOwner(owner, featureItem) {
    if (!owner || !featureItem || !featureItem.name) return false;
    const pageName = owner.pageName || owner.name || featureItem.pageName || '';
    if (!isDistinctFeatureName(featureItem.name, pageName)) return false;
    if (!Array.isArray(owner.features)) owner.features = [];
    // Upsert by id, else by name+screen (never stack duplicates on every sync)
    let idx = -1;
    if (featureItem.id) {
        idx = owner.features.findIndex(f => f && f.id === featureItem.id);
    }
    if (idx < 0) {
        const key = featureIdentityKey(featureItem.name, featureItem.pageName || pageName, featureItem.uniqueIdentifier, null, featureItem.screenSignature);
        idx = owner.features.findIndex(f =>
            f && featureIdentityKey(f.name, f.pageName || pageName, f.uniqueIdentifier, null, f.screenSignature) === key
        );
    }
    if (idx >= 0) {
        owner.features[idx] = { ...owner.features[idx], ...featureItem };
    } else {
        owner.features.unshift(featureItem);
    }
    return true;
}

function findFeatureOwnerInProject(project, pageName) {
    if (!project) return null;
    const key = repoNameKey(pageName);
    if (key) {
        const scen = (project.scenarios || []).find(s => repoNameKey(s.pageName) === key || repoNameKey(s.name) === key);
        if (scen) return scen;
        const pg = (project.pages || []).find(p => repoNameKey(p.pageName) === key);
        if (pg) return pg;
    }
    return null;
}

function collectProjectFeatureNames(project) {
    const names = new Set();
    if (!project) return names;
    // Only count features the user explicitly created on Home — not scraped element rows
    const add = (f, pageName) => {
        if (!isUserCreatedFeature(f) && !(typeof f === 'string' && isDistinctFeatureName(f, pageName))) return;
        const n = (f && (f.name || (typeof f === 'string' ? f : ''))) || '';
        const p = (f && typeof f === 'object' && f.pageName) || pageName || '';
        if (!isDistinctFeatureName(n, p)) return;
        names.add(featureIdentityKey(n, p, f && f.uniqueIdentifier, null, f && f.screenSignature));
    };
    const fromOwner = (owner, pageName) => {
        if (!owner) return;
        (owner.features || []).forEach(f => add(f, pageName));
    };
    (project.scenarios || []).forEach(s => fromOwner(s, s.pageName || s.name));
    (project.pages || []).forEach(pg => fromOwner(pg, pg.pageName));
    (project.features || []).forEach(f => add(f, f && f.pageName));
    return names;
}

function countProjectFeatures(project) {
    return collectProjectFeatureNames(project).size;
}

function listProjectFeatureDisplayNames(project) {
    const map = new Map();
    const add = (f, pageName) => {
        if (!isUserCreatedFeature(f) && !(typeof f === 'string' && isDistinctFeatureName(f, pageName))) return;
        const n = (f && (f.name || (typeof f === 'string' ? f : ''))) || '';
        const p = (f && typeof f === 'object' && f.pageName) || pageName || '';
        if (!isDistinctFeatureName(n, p)) return;
        const k = featureIdentityKey(n, p, f && f.uniqueIdentifier, null, f && f.screenSignature);
        if (!map.has(k)) map.set(k, String(n).trim());
    };
    const fromOwner = (owner, pageName) => {
        if (!owner) return;
        (owner.features || []).forEach(f => add(f, pageName));
    };
    if (!project) return [];
    (project.scenarios || []).forEach(s => fromOwner(s, s.pageName || s.name));
    (project.pages || []).forEach(pg => fromOwner(pg, pg.pageName));
    (project.features || []).forEach(f => add(f, f && f.pageName));
    return Array.from(map.values());
}

function dedupeProjectFeatureLists(project) {
    if (!project || typeof project !== 'object') return false;
    let modified = false;
    const cleanList = (list) => {
        const kept = (list || []).filter(f => isUserCreatedFeature(f) || (typeof f === 'string' && isDistinctFeatureName(f, '')));
        return mergeFeatureItems(kept);
    };
    if (Array.isArray(project.features)) {
        const next = cleanList(project.features);
        if (next.length !== project.features.length || JSON.stringify(next) !== JSON.stringify(project.features)) {
            project.features = next;
            modified = true;
        }
    }
    (project.pages || []).forEach(pg => {
        if (!Array.isArray(pg.features)) return;
        const next = cleanList(pg.features);
        if (next.length !== pg.features.length) {
            pg.features = next;
            modified = true;
        }
    });
    (project.scenarios || []).forEach(sc => {
        if (!Array.isArray(sc.features)) return;
        const next = cleanList(sc.features);
        if (next.length !== sc.features.length) {
            sc.features = next;
            modified = true;
        }
    });
    return modified;
}
window.dedupeProjectFeatureLists = dedupeProjectFeatureLists;

function migrateStandaloneFeaturesIntoOwners(project) {
    if (!project || typeof project !== 'object') return false;
    let modified = false;
    if (!Array.isArray(project.features)) project.features = [];

    // 1. Ensure any features in project.features are nested on owners
    project.features.forEach(f => {
        if (!f || !f.name) return;
        let owner = findFeatureOwnerInProject(project, f.pageName);
        if (owner && nestFeatureOnOwner(owner, f)) modified = true;
    });

    // 2. Vice-versa: if owners (scenarios / pages) have features, ensure they exist in project.features as cards
    const existingNames = new Set(project.features.map(f => (f && f.name ? f.name.trim().toLowerCase() : '')));
    const restoreToProjectFeatures = (feat, pageName) => {
        if (!feat) return;
        const name = typeof feat === 'string' ? feat.trim() : (feat.name ? feat.name.trim() : '');
        if (!name || existingNames.has(name.toLowerCase())) return;
        if (!isDistinctFeatureName(name, pageName)) return;

        const featItem = {
            id: (typeof feat === 'object' && feat.id) ? feat.id : ('feat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
            name: name,
            rect: (typeof feat === 'object' && feat.rect) ? feat.rect : null,
            fullPage: (typeof feat === 'object') ? !!feat.fullPage : false,
            pageName: (typeof feat === 'object' && feat.pageName) ? feat.pageName : (pageName || 'Default'),
            platform: project.platform || 'Android',
            timestamp: (typeof feat === 'object' && feat.timestamp) ? feat.timestamp : Date.now()
        };
        project.features.push(featItem);
        existingNames.add(name.toLowerCase());
        modified = true;
    };

    (project.scenarios || []).forEach(s => {
        (s.features || []).forEach(f => restoreToProjectFeatures(f, s.pageName || s.name));
        (s.elements || []).forEach(el => {
            const fn = el && (el['FEATURE NAME'] || el.FeatureName);
            if (fn) restoreToProjectFeatures(fn, s.pageName || (el && el['PAGE NAME']));
        });
    });

    (project.pages || []).forEach(p => {
        (p.features || []).forEach(f => restoreToProjectFeatures(f, p.pageName));
        (p.elements || []).forEach(el => {
            const fn = el && (el['FEATURE NAME'] || el.FeatureName);
            if (fn) restoreToProjectFeatures(fn, p.pageName || (el && el['PAGE NAME']));
        });
    });

    return modified;
}

function isRepoNameOwnedByFeature(project, name) {
    const key = repoNameKey(name);
    if (!key || !project) return false;
    for (const id of collectProjectFeatureNames(project)) {
        // identity keys are "featureName::pageName"
        if (String(id).split('::')[0] === key) return true;
    }
    return false;
}

window.countProjectFeatures = countProjectFeatures;
window.listProjectFeatureDisplayNames = listProjectFeatureDisplayNames;
window.mergeFeatureItems = mergeFeatureItems;
window.isUserCreatedFeature = isUserCreatedFeature;
window.featureItemsFromElements = featureItemsFromElements;
window.collectLiveFeatureItemsForPage = collectLiveFeatureItemsForPage;
window.nestFeatureOnOwner = nestFeatureOnOwner;
window.findFeatureOwnerInProject = findFeatureOwnerInProject;
window.getActiveHomePageName = getActiveHomePageName;

/**
 * Ownership rules:
 *  - Scenario owns its page name AND its features. That page is NOT a standalone page.
 *  - Scraped pages own their features. Features are never inspectable repo assets.
 *  - Features only count; they are nested on the owning scenario or page.
 */
function pruneProjectAssetOwnership(project) {
    if (!project || typeof project !== 'object') return false;
    let modified = false;

    if (!Array.isArray(project.scenarios)) project.scenarios = [];
    if (!Array.isArray(project.features)) project.features = [];
    if (!Array.isArray(project.pages)) project.pages = [];

    const scenarioKeys = new Set();
    project.scenarios.forEach(s => {
        const pageKey = repoNameKey(s.pageName);
        const nameKey = repoNameKey(s.name);
        if (pageKey) scenarioKeys.add(pageKey);
        if (nameKey) scenarioKeys.add(nameKey);
    });

    project.scenarios.forEach(s => {
        const sKey = repoNameKey(s.pageName || s.name);
        const matchingPage = project.pages.find(pg => repoNameKey(pg.pageName) === sKey);
        if (!matchingPage) return;
        // Never promote scraped element FEATURE NAME into feature counts
        const mergedFeats = mergeFeatureItems(s.features, matchingPage.features);
        if (JSON.stringify(mergedFeats) !== JSON.stringify(s.features || [])) {
            s.features = mergedFeats;
            modified = true;
        }
        if ((!s.elements || s.elements.length === 0) && Array.isArray(matchingPage.elements) && matchingPage.elements.length > 0) {
            s.elements = JSON.parse(JSON.stringify(matchingPage.elements));
            modified = true;
        }
    });

    project.scenarios.forEach(s => {
        const nested = mergeFeatureItems(s.features);
        if (JSON.stringify(nested) !== JSON.stringify(s.features || [])) {
            s.features = nested;
            modified = true;
        }
    });

    project.pages.forEach(pg => {
        const nested = mergeFeatureItems(pg.features);
        if (JSON.stringify(nested) !== JSON.stringify(pg.features || [])) {
            pg.features = nested;
            modified = true;
        }
    });

    if (migrateStandaloneFeaturesIntoOwners(project)) modified = true;
    if (typeof dedupeProjectFeatureLists === 'function' && dedupeProjectFeatureLists(project)) modified = true;

    const featureKeys = collectProjectFeatureNames(project);
    const featureNameKeys = new Set(Array.from(featureKeys).map(id => String(id).split('::')[0]));

    const keptPages = project.pages.filter(pg => {
        const pKey = repoNameKey(pg.pageName);
        if (!pKey) return false;
        const hasElements = Array.isArray(pg.elements) && pg.elements.length > 0;
        const hasFeatures = Array.isArray(pg.features) && pg.features.length > 0;
        if (scenarioKeys.has(pKey) && !hasElements && !hasFeatures && !isKeptInitialPage(project, pg)) return false;
        if (featureNameKeys.has(pKey) && !hasElements && !hasFeatures && !isKeptInitialPage(project, pg)) return false;
        if (hasElements || hasFeatures) return true;
        return isKeptInitialPage(project, pg);
    });
    if (keptPages.length !== project.pages.length) {
        project.pages = keptPages;
        modified = true;
    }

    return modified;
}
window.pruneProjectAssetOwnership = pruneProjectAssetOwnership;

function getProjectStore() {
    if (window._activeRepoWriteStore) return window._activeRepoWriteStore;
    let store = {};
    try {
        const raw = localStorage.getItem(REPO_STORAGE_KEY);
        if (raw) {
            store = JSON.parse(raw);
        } else {
            const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacyRaw) {
                const legacy = JSON.parse(legacyRaw);
                const sc = Array.isArray(legacy.scenarios) ? legacy.scenarios : [];
                const ft = Array.isArray(legacy.features) ? legacy.features : [];
                const pg = Array.isArray(legacy.pages) ? legacy.pages : [];
                if (sc.length > 0 || ft.length > 0 || pg.length > 0) {
                    const rawAppName = sc[0]?.appName || ft[0]?.appName || pg[0]?.appName || 'Saved Session';
                    const appName = getCleanAppName(rawAppName);
                    const platform = sc[0]?.platform || ft[0]?.platform || pg[0]?.platform || 'Android';
                    const key = `${appName} (${platform})`;
                    store[key] = {
                        appName: appName,
                        platform: platform,
                        createdAt: Date.now(),
                        lastUpdated: Date.now(),
                        scenarios: sc,
                        features: ft,
                        pages: pg
                    };
                }
            }
        }

        if (typeof store !== 'object' || store === null) store = {};

        // Purge empty projects, clean reverse-domain names, and deduplicate items per project
        let modified = false;
        Object.keys(store).forEach(k => {
            const p = store[k];
            if (!p) {
                delete store[k];
                modified = true;
                return;
            }

            // Clean reverse-domain bundle IDs to a human-readable app name.
            // Do not rewrite numbered copies like "Calendar 2" back to "Calendar".
            const rawName = p.appName || k.replace(/\s*\(.*?\)\s*$/, '');
            const keyAppPart = String(k).replace(/\s*\(.*?\)\s*$/, '').trim();
            const isReverseDomainKey = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)+$/.test(keyAppPart);
            const isReverseDomainName = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)+$/.test(String(rawName).trim());
            const cleanName = getCleanAppName(rawName);
            const plat = p.platform || (k.includes('(iOS)') || k.includes('(IOS)') ? 'iOS' : 'Android');
            if (isReverseDomainName || !p.appName) {
                p.appName = cleanName;
            }
            p.platform = plat;

            if (!p.projectId) {
                p.projectId = String(k).includes('::')
                    ? String(k).split('::').pop()
                    : createProjectId(store, p.appName || cleanName, plat);
                modified = true;
            }

            // 1. Deduplicate Features by feature name
            if (Array.isArray(p.features)) {
                const featMap = new Map();
                p.features.forEach(f => {
                    const fKey = (f.name || '').trim().toLowerCase();
                    if (fKey && !featMap.has(fKey)) {
                        featMap.set(fKey, f);
                    }
                });
                if (p.features.length !== featMap.size) {
                    p.features = Array.from(featMap.values());
                    modified = true;
                }
            }

            // 2. Deduplicate Scenarios by pageName or name
            if (Array.isArray(p.scenarios)) {
                const scenMap = new Map();
                p.scenarios.forEach(s => {
                    const sKey = (s.pageName || s.name || '').trim().toLowerCase();
                    if (sKey && !scenMap.has(sKey)) {
                        scenMap.set(sKey, s);
                    }
                });
                if (p.scenarios.length !== scenMap.size) {
                    p.scenarios = Array.from(scenMap.values());
                    modified = true;
                }
            }

            // 2.5 Scenario owns its page name; features are count-only; empty placeholders are not pages
            if (typeof pruneProjectAssetOwnership === 'function') {
                if (pruneProjectAssetOwnership(p)) {
                    modified = true;
                }
            }

            // 3. Deduplicate Standalone Scraped Pages by pageName
            if (Array.isArray(p.pages)) {
                const pageMap = new Map();
                p.pages.forEach(pg => {
                    const pKey = (pg.pageName || '').trim().toLowerCase();
                    if (pKey && !pageMap.has(pKey)) {
                        pageMap.set(pKey, pg);
                    }
                });
                if (p.pages.length !== pageMap.size) {
                    p.pages = Array.from(pageMap.values());
                    modified = true;
                }
            }

            // 3.5 Ensure every item has a valid, non-empty, unique ID
            (p.scenarios || []).forEach((s, idx) => {
                if (!s.id || s.id === 'undefined' || s.id === 'null') {
                    s.id = 'scen_' + (s.name || s.pageName || 'scen').replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + idx;
                    modified = true;
                }
            });
            (p.features || []).forEach((f, idx) => {
                if (!f.id || f.id === 'undefined' || f.id === 'null') {
                    f.id = 'feat_' + (f.name || 'feat').replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + idx;
                    modified = true;
                }
            });
            (p.pages || []).forEach((pg, idx) => {
                if (!pg.id || pg.id === 'undefined' || pg.id === 'null') {
                    pg.id = 'page_' + (pg.pageName || 'page').replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + idx;
                    modified = true;
                }
            });

            const total = (p.scenarios || []).length + (p.features || []).length + (p.pages || []).length;
            if (total === 0 || (p.appName === 'Default App' && total === 0)) {
                delete store[k];
                modified = true;
                return;
            }

            // Never remap unique-id keys such as "Calendar (iOS)::p_abc123"
            const properKey = `${p.appName || cleanName} (${plat})`;
            if (isReverseDomainKey && properKey !== k && String(k).indexOf('::') === -1) {
                if (store[properKey]) {
                    store[properKey].scenarios = (store[properKey].scenarios || []).concat(p.scenarios || []);
                    store[properKey].features = (store[properKey].features || []).concat(p.features || []);
                    store[properKey].pages = (store[properKey].pages || []).concat(p.pages || []);
                } else {
                    store[properKey] = p;
                }
                delete store[k];
                modified = true;
            }
        });

        if (modified) {
            localStorage.setItem(REPO_STORAGE_KEY, JSON.stringify(store));
        }
    } catch (e) {
        console.error('Error reading repo projects store:', e);
        store = {};
    }
    return store;
}
window.getRepoProjectsStore = getProjectStore;

function getRepoAssetsForActiveApp() {
    const pages = new Set();
    const scenarioNames = new Set();
    const scenarioOutlines = new Set();
    const featureNames = new Set();

    // If the active session is in 'new' mode (or has NOT resumed an existing project from repo),
    // do NOT validate against or block names from old repository projects!
    if (window.activeProjectSessionMode === 'new' || !window.activeResumedProjectKey) {
        return {
            pages,
            scenarioNames,
            scenarioOutlines,
            featureNames
        };
    }

    try {
        const store = getProjectStore();
        const found = (typeof findProjectKeyInStore === 'function')
            ? findProjectKeyInStore(store, window.activeResumedProjectKey)
            : { project: store[window.activeResumedProjectKey] };
        const project = found && found.project;
        if (project) {
            if (Array.isArray(project.pages)) {
                project.pages.forEach(p => {
                    if (p && p.pageName && p.pageName.trim()) {
                        pages.add(p.pageName.trim().toLowerCase());
                    }
                    (p.features || []).forEach(f => {
                        const n = (f && f.name) || (typeof f === 'string' ? f : '');
                        if (n && n.trim()) featureNames.add(n.trim().toLowerCase());
                    });
                });
            }
            if (Array.isArray(project.scenarios)) {
                project.scenarios.forEach(s => {
                    if (s) {
                        if (s.pageName && s.pageName.trim()) pages.add(s.pageName.trim().toLowerCase());
                        if (s.name && s.name.trim()) scenarioNames.add(s.name.trim().toLowerCase());
                        if (s.outline && s.outline.trim()) scenarioOutlines.add(s.outline.trim().toLowerCase());
                        (s.features || []).forEach(f => {
                            const n = (f && f.name) || (typeof f === 'string' ? f : '');
                            if (n && n.trim()) featureNames.add(n.trim().toLowerCase());
                        });
                    }
                });
            }
            if (Array.isArray(project.features)) {
                project.features.forEach(f => {
                    if (f && f.name && f.name.trim()) featureNames.add(f.name.trim().toLowerCase());
                });
            }
        }
    } catch (e) {
        console.error("Error retrieving repo assets:", e);
    }

    return {
        pages,
        scenarioNames,
        scenarioOutlines,
        featureNames
    };
}

function getRepoPageNamesForActiveApp() {
    return getRepoAssetsForActiveApp().pages;
}

function isPageNameInRepo(name) {
    if (!name || typeof name !== 'string') return false;
    const lower = name.trim().toLowerCase();
    const assets = getRepoAssetsForActiveApp();
    return assets.pages.has(lower) || assets.scenarioNames.has(lower) || assets.featureNames.has(lower);
}

function isScenarioNameInRepo(name) {
    if (!name || typeof name !== 'string') return false;
    const lower = name.trim().toLowerCase();
    const assets = getRepoAssetsForActiveApp();
    return assets.scenarioNames.has(lower) || assets.pages.has(lower) || assets.featureNames.has(lower);
}

function isScenarioOutlineInRepo(outline) {
    if (!outline || typeof outline !== 'string') return false;
    const lower = outline.trim().toLowerCase();
    const assets = getRepoAssetsForActiveApp();
    return assets.scenarioOutlines.has(lower);
}

function isFeatureNameInRepo(name) {
    if (!name || typeof name !== 'string') return false;
    const lower = name.trim().toLowerCase();
    const assets = getRepoAssetsForActiveApp();
    return assets.featureNames.has(lower) || assets.pages.has(lower) || assets.scenarioNames.has(lower);
}

/** True if feature name is already used anywhere in the live session or active repo project (all OS/devices). */
function isFeatureNameAlreadyUsed(name, excludeName) {
    const lower = String(name || '').trim().toLowerCase();
    if (!lower) return false;
    const exclude = String(excludeName || '').trim().toLowerCase();
    if (exclude && lower === exclude) return false;

    const areas = (typeof window.registeredFeatureAreas !== 'undefined' && Array.isArray(window.registeredFeatureAreas))
        ? window.registeredFeatureAreas
        : ((typeof registeredFeatureAreas !== 'undefined' && Array.isArray(registeredFeatureAreas)) ? registeredFeatureAreas : []);
    if (areas.some(a => a && a.name && String(a.name).trim().toLowerCase() === lower)) {
        return true;
    }

    // Also check table cells (covers features restored into rows)
    const cells = document.querySelectorAll('#myTable .featureName');
    for (const cell of cells) {
        const cellName = (cell.innerText || '').replace(/\u00a0/g, ' ').trim().toLowerCase();
        if (!cellName || cellName !== lower) continue;
        const tr = cell.closest('tr');
        const pageCell = tr ? tr.querySelector('.page') : null;
        const rowPage = pageCell ? pageCell.innerText.trim().toLowerCase() : '';
        // Ignore default page-name placeholders — those are not created features
        if (rowPage && cellName === rowPage) continue;
        return true;
    }

    try {
        const assets = typeof getRepoAssetsForActiveApp === 'function' ? getRepoAssetsForActiveApp() : null;
        if (assets && assets.featureNames && assets.featureNames.has(lower)) return true;
    } catch (_) {}

    return false;
}

window.isFeatureNameAlreadyUsed = isFeatureNameAlreadyUsed;

window.getRepoAssetsForActiveApp = getRepoAssetsForActiveApp;
window.getRepoPageNamesForActiveApp = getRepoPageNamesForActiveApp;
window.isPageNameInRepo = isPageNameInRepo;
window.isScenarioNameInRepo = isScenarioNameInRepo;
window.isScenarioOutlineInRepo = isScenarioOutlineInRepo;
window.isFeatureNameInRepo = isFeatureNameInRepo;

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

function verifyPageNameSavedBeforeScraping(actionLabel) {
    const action = actionLabel || "scraping";
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
                    `Please save the Page Name first (click the green checkmark ✓) before ${action}.`,
                    "warning"
                );
            } else if (check.reason === "empty") {
                showCustomAlert(
                    "Page Name Required",
                    `Please enter and save a Page Name before ${action}.`,
                    "warning"
                );
            } else if (check.reason === "all_reserved") {
                showCustomAlert(
                    "Action Restricted",
                    `Cannot perform action while viewing 'All' pages. Please select or create a specific Page Name first.`,
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

    const confirmIcon = document.querySelector('.confirm-edit-icon');
    const isConfirmVisible = confirmIcon && confirmIcon.style.display !== 'none' && window.getComputedStyle(confirmIcon).display !== 'none';
    if (isConfirmVisible) {
        showCustomAlert(
            "Save Page Name",
            `Please save the Page Name first (click the green checkmark ✓) before ${action}.`,
            "warning"
        );
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

            // CHECK: Only features created on the CURRENT device screen
            let effectiveFeatureName = "";
            let smallestAreaFound = Number.MAX_VALUE;

            for (const area of registeredFeatureAreas) {
                if (!area || !area.rect || !area.name) continue;
                if (typeof isSameFeatureScreen === 'function') {
                    if (!isSameFeatureScreen(area, window.xmlDoc)) continue;
                } else if (!isFeatureAreaApplicableToCurrentScreen(area, window.xmlDoc, clickX, clickY)) {
                    continue;
                }
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

                if (!isNodeVisibleOnScreen(node)) {
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
                        ControlValue: "",
                        IdentificationType: "Coordinate",
                        FeatureName: effectiveFeatureName || pageName,
                        NodeName: pageName,
                        rect: { x: Math.round(clickX), y: Math.round(clickY), width: 1, height: 1 }
                    }
                ]);
                return;
            }

            // 1. Generate Clean Variable Name & Type normally
                        let controlName = generateProfessionalControlName(matchedNode);
                        let controlType = mapControlType(typeof getUiNodeName === 'function' ? getUiNodeName(matchedNode) : matchedNode.nodeName, matchedNode);

                        // 2. Fetch XPaths
                        let allXPaths = getAllPossibleXPaths(matchedNode);

                        // NEW: Extract the input value if the element is a text/search field
                        let controlValue = getInputControlValue(matchedNode, controlName);
                        let nodeRect = parseNodeRect(matchedNode);

                        createAndAppendTable([
                            {
                                ControlName: controlName,
                                ControlType: controlType,
                                ControlId: allXPaths,
                                ControlValue: controlValue,
                                IdentificationType: inferIdentificationType(allXPaths[0]),
                                FeatureName: effectiveFeatureName || pageName,
                                NodeName: pageName,
                                Fingerprint: generateNodeFingerprint(matchedNode),
                                rect: nodeRect
                            }
                        ]);
                    }

    async function handleFeatureClick(clickX, clickY) {
        // Refresh hierarchy so screen identity matches the current device page
        try {
            if (typeof capturePageSource === 'function') {
                const freshSource = await capturePageSource();
                if (freshSource) {
                    const parser = new DOMParser();
                    window.xmlDoc = parser.parseFromString(freshSource, "text/xml");
                    if (typeof noteDeviceScreenChanged === 'function') noteDeviceScreenChanged();
                    else if (typeof realignLiveFeatureScreensToCurrentDoc === 'function') realignLiveFeatureScreensToCurrentDoc();
                }
            }
        } catch (refreshErr) {
            console.warn("Create Feature page-source refresh failed:", refreshErr);
        }

        if (!window.xmlDoc) return;

        if (!verifyPageNameSavedBeforeScraping()) {
            return;
        }

        if (typeof realignLiveFeatureScreensToCurrentDoc === 'function') {
            realignLiveFeatureScreensToCurrentDoc();
        }

        const matchedNode = findHoveredNode(clickX, clickY);
        let targetRect = matchedNode ? parseNodeRect(matchedNode) : null;

        if (!targetRect) {
            const dims = (typeof getDeviceDimensions === "function") ? getDeviceDimensions() : { width: 0, height: 0 };
            targetRect = (dims.width > 0 && dims.height > 0)
                ? { x: 0, y: 0, width: dims.width, height: dims.height }
                : { x: Math.round(clickX), y: Math.round(clickY), width: 1, height: 1 };
        }

        const nodeUniqueId = extractNodeUniqueIdentifier(matchedNode, clickX, clickY);
        const nodeAllXPaths = (matchedNode && typeof getAllPossibleXPaths === 'function') ? getAllPossibleXPaths(matchedNode) : [];

        // If this area/element is already a feature on the CURRENT device screen, block with a clear error.
        // Same area on a different screen is still allowed (new unique feature).
        let existingOnScreen = null;
        let smallestExisting = Number.MAX_VALUE;
        for (const area of (registeredFeatureAreas || [])) {
            if (!area || !area.rect || !area.name) continue;
            if (typeof isSameFeatureScreen === 'function' && !isSameFeatureScreen(area, window.xmlDoc)) continue;

            let matched = false;
            if (area.uniqueIdentifier && nodeUniqueId && area.uniqueIdentifier === nodeUniqueId) {
                matched = true;
            } else if (area.xpaths && Array.isArray(area.xpaths) && nodeAllXPaths.some(xp => area.xpaths.includes(xp))) {
                matched = true;
            } else if (matchedNode && typeof isNodeRelatedToFeature === 'function' && isNodeRelatedToFeature(matchedNode, area)) {
                matched = true;
            } else {
                const { x, y, width, height } = area.rect;
                if (clickX >= x && clickX <= (x + width) && clickY >= y && clickY <= (y + height)) {
                    matched = true;
                }
            }
            if (!matched) continue;

            const rectArea = (Number(area.rect.width) || 0) * (Number(area.rect.height) || 0);
            if (rectArea < smallestExisting) {
                smallestExisting = rectArea;
                existingOnScreen = area;
            }
        }

        if (existingOnScreen) {
            if (typeof drawFeatureAreaHighlight === 'function') {
                drawFeatureAreaHighlight(existingOnScreen, { active: true });
            }
            const existingName = String(existingOnScreen.name || '').trim() || 'this feature';
            showCustomAlert(
                "Feature Already Created",
                `“<b>${existingName}</b>” is already created for this area. Please select a different area.`,
                "warning"
            );
            return;
        }

        const dims = (typeof getDeviceDimensions === "function") ? getDeviceDimensions() : { width: 0, height: 0 };
        const isFullPage = !matchedNode || (dims.width > 0 && dims.height > 0 && targetRect.width >= dims.width * 0.92 && targetRect.height >= dims.height * 0.92);
        const featureNodeText = (matchedNode ? (matchedNode.getAttribute("text") || matchedNode.getAttribute("label") || matchedNode.getAttribute("name") || matchedNode.getAttribute("content-desc") || "") : "").trim();

        if (!matchedNode || isFullPage) {
            pendingFeatureData = {
                ControlName: isFullPage ? "page_FullScreen" : `section_${Math.round(clickX)}_${Math.round(clickY)}`,
                ControlType: isFullPage ? "Page" : "Section",
                ControlId: isFullPage
                    ? [`//XCUIElementTypeApplication`, `//hierarchy`]
                    : [`COORDINATE(${Math.round(clickX)},${Math.round(clickY)})`],
                IdentificationType: isFullPage ? "XPath" : "Coordinate",
                rect: targetRect,
                fullPage: !!isFullPage,
                uniqueIdentifier: nodeUniqueId || (isFullPage ? "FULL_PAGE" : `COORDINATE(${Math.round(clickX)},${Math.round(clickY)})`),
                xpaths: isFullPage ? [`//XCUIElementTypeApplication`, `//hierarchy`] : [],
                nodeText: featureNodeText,
                nodeClass: matchedNode ? matchedNode.nodeName : "",
                screenSignature: computeScreenSignature(window.xmlDoc),
                screenContentKeys: computeScreenContentKeys(window.xmlDoc, targetRect)
            };
        } else {
            const featName = generateProfessionalControlName(matchedNode);
            pendingFeatureData = {
                ControlName: featName,
                ControlType: mapControlType(matchedNode.nodeName, matchedNode),
                ControlId: nodeAllXPaths.length > 0 ? nodeAllXPaths : getAllPossibleXPaths(matchedNode),
                ControlValue: getInputControlValue(matchedNode, featName),
                Fingerprint: generateNodeFingerprint(matchedNode),
                rect: targetRect,
                fullPage: false,
                uniqueIdentifier: nodeUniqueId,
                xpaths: nodeAllXPaths,
                nodeText: featureNodeText,
                nodeClass: matchedNode ? matchedNode.nodeName : "",
                screenSignature: computeScreenSignature(window.xmlDoc),
                screenContentKeys: computeScreenContentKeys(window.xmlDoc, targetRect)
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

    function rowBelongsToFeatureScreen(row, area) {
        if (!row || !area) return false;
        const areaSig = area.screenSignature || '';
        const rowSig = (row.dataset && row.dataset.screenSignature) || '';
        if (areaSig && rowSig) {
            return (typeof screenSignatureSimilarity === 'function')
                ? screenSignatureSimilarity(areaSig, rowSig) >= 0.68
                : areaSig === rowSig;
        }
        // Do not rewrite older rows (or cross-screen rows) when signatures are missing/mismatched
        if (areaSig || rowSig) return false;
        return true;
    }

    function syncExistingRowsWithNewFeature(area) {
        const tableBody = document.getElementById('myTable');
        if (!tableBody || !area || !area.rect) return;

        const { x: ax, y: ay, width: aw, height: ah } = area.rect;
        const allRows = tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)');

        allRows.forEach(row => {
            const featureNameCell = row.querySelector('.featureName');
            if (!featureNameCell) return;

            // Only touch rows scraped on the SAME device screen as this feature
            if (!rowBelongsToFeatureScreen(row, area)) return;

            // Page scoping (metadata) — Page Name can stay the same across screens
            if (area.pageName && area.pageName.toLowerCase() !== 'all') {
                const pageCell = row.querySelector('.page');
                const rowPage = pageCell ? pageCell.innerText.trim().toLowerCase() : '';
                if (rowPage && rowPage !== area.pageName.toLowerCase()) {
                    return;
                }
            }

            if (area.fullPage) {
                featureNameCell.innerText = area.name;
                if (area.id) row.dataset.featureId = String(area.id);
                return;
            }

            const rectStr = row.dataset.rect;
            if (!rectStr) return;

            try {
                const rect = JSON.parse(rectStr);
                if (!rect) return;

                const centerX = rect.x + rect.width / 2;
                const centerY = rect.y + rect.height / 2;

                if (centerX >= ax && centerX <= (ax + aw) && centerY >= ay && centerY <= (ay + ah)) {
                    featureNameCell.innerText = area.name;
                    if (area.id) row.dataset.featureId = String(area.id);
                }
            } catch (e) {
                console.error("Sync: Failed to parse row rect", e);
            }
        });
    }

    //Add Rows number
        function updateRowNumbers() {
            const tbody = document.getElementById("myTable");
            if (!tbody) return;

            const allRows = Array.from(tbody.querySelectorAll("tr"));
            const dataRows = allRows.filter(row => !row.classList.contains("empty-excel-row") && !row.classList.contains("no-results-row"));

            // 1. Number all active data rows sequentially 1, 2, 3...
            let activeDataIndex = 1;
            dataRows.forEach((row) => {
                if (!row.classList.contains("page-hidden") && !row.classList.contains("search-hidden")) {
                    const indexCell = row.querySelector(".row-index");
                    if (indexCell) {
                        indexCell.textContent = activeDataIndex++;
                    }
                }
            });

            // 2. Number the visible empty placeholder rows sequentially following the current page's visible data
            const emptyRows = allRows.filter(row => row.classList.contains("empty-excel-row") && row.style.display !== 'none');

            if (dataRows.length > 0) {
                // Find highest row number currently visible on this active page
                const visibleDataRows = dataRows.filter(r => r.style.display !== 'none' && !r.classList.contains("page-hidden") && !r.classList.contains("search-hidden"));
                let nextIndex = 1;
                if (visibleDataRows.length > 0) {
                    const lastVisibleRow = visibleDataRows[visibleDataRows.length - 1];
                    const lastIndexCell = lastVisibleRow.querySelector(".row-index");
                    const lastNum = parseInt(lastIndexCell ? lastIndexCell.textContent : '0', 10);
                    nextIndex = (!isNaN(lastNum) && lastNum > 0) ? lastNum + 1 : (visibleDataRows.length + 1);
                }

                emptyRows.forEach((row) => {
                    const indexCell = row.querySelector(".row-index");
                    if (indexCell) {
                        indexCell.textContent = nextIndex++;
                    }
                });
            } else {
                // Initial blank spreadsheet grid: 1, 2, 3, 4...
                let emptyIndex = 1;
                emptyRows.forEach((row) => {
                    const indexCell = row.querySelector(".row-index");
                    if (indexCell) {
                        indexCell.textContent = emptyIndex++;
                    }
                });
            }
        }

    // Helper to count custom columns added by user
    function getCustomColsCount() {
        var headerRow = document.querySelector('#mainTable thead tr');
        return headerRow ? headerRow.querySelectorAll('.custom-editable-header').length : 0;
    }

    function createEmptyRowHtml() {
            var allHeaders = Array.from(document.querySelectorAll('#mainTable thead tr > *'));
            var rowHtml = "";

            /* Default placeholder row HTML commented out as per requirement
            allHeaders.forEach((th) => {
                var thText = (th.textContent || th.innerText || '').replace('Delete Column', '').replace('Add Column', '').trim().toUpperCase();
                var isHidden = window.getComputedStyle(th).display === 'none';
                var displayStyle = isHidden ? 'display: none !important;' : '';

                if (th.classList.contains('excel-header-corner')) {
                    rowHtml += `<td class="row-index" style="${displayStyle}"></td>`;
                } else if (th.id === 'add_empty_column') {
                    rowHtml += `<td class="add-col-cell" style="${displayStyle}">&nbsp;</td>`;
                } else if (th.classList.contains('custom-editable-header')) {
                    rowHtml += `<td contenteditable="true" style="${displayStyle}">&nbsp;</td>`;
                } else if (thText.includes('CONTROL TYPE')) {
                    rowHtml += `<td class="ct pt-3-half" style="${displayStyle}">&nbsp;</td>`;
                } else if (thText.includes('CONTROL ID')) {
                    rowHtml += `<td class="xpath pt-3-half" style="${displayStyle}"></td>`;
                } else if (thText.includes('APP URL') || th.id === 'appUrl') {
                    rowHtml += `<td class="appUrl" style="display:none;"></td>`;
                } else if (th.classList.contains('fingerprint')) {
                    rowHtml += `<td class="fingerprint" style="display:none;"></td>`;
                } else if (thText.includes('DELETE') || th.innerText.includes('Delete') || th.id === 'delete_header') {
                    // Completely empty cell for placeholder rows so no icons or checkboxes ever appear
                    rowHtml += `<td class="delete-cell" style="${displayStyle}"></td>`;
                } else {
                    rowHtml += `<td class="cn pt-3-half" contenteditable="true" style="${displayStyle}">&nbsp;</td>`;
                }
            });
            */
            return rowHtml;
        }

        function updateTableEmptyState() {
            const tableBody = document.getElementById('myTable');
            const emptyScrapeState = document.getElementById('tableScrapeEmptyState');
            const searchEmptyState = document.getElementById('tableSearchEmptyState');
            if (!emptyScrapeState) return;

            if (!tableBody) {
                emptyScrapeState.style.display = 'flex';
                return;
            }

            const dataRows = Array.from(tableBody.querySelectorAll('tr:not(.empty-excel-row):not(.no-results-row)')).filter(row => !row.classList.contains('page-hidden'));
            const isSearchEmptyVisible = searchEmptyState && searchEmptyState.style.display !== 'none';

            if (dataRows.length === 0 && !isSearchEmptyVisible) {
                emptyScrapeState.style.display = 'flex';
            } else {
                emptyScrapeState.style.display = 'none';
            }
        }
        window.updateTableEmptyState = updateTableEmptyState;

        function adjustEmptyRows() {
            // Default placeholder rows commented out - replaced by modern centered empty state card (#tableScrapeEmptyState)
            /*
            const container = document.getElementById('table-container');
            const tbody = document.getElementById('myTable');

            // Prevent execution if the container is hidden or layout hasn't rendered yet
            if (!container || !tbody || container.style.display === "none" || container.clientHeight === 0) return;

            const headerRow = document.querySelector('#mainTable thead tr');
            const headerHeight = headerRow ? headerRow.getBoundingClientRect().height : 32;
            const ROW_HEIGHT = 32;

            // Shared on Windows + macOS: grow with the table pane (capped for safety)
            const MAX_VISIBLE_ROWS = 60;
            const containerHeight = Math.max(container.clientHeight, container.getBoundingClientRect().height);
            const availableHeight = Math.max(0, containerHeight - headerHeight);
            // Use Math.ceil with fixed 32px row height so empty rows completely fill the table container down to the bottom border with zero gap
            let targetRowCount = Math.max(1, Math.ceil(availableHeight / ROW_HEIGHT));
            targetRowCount = Math.min(MAX_VISIBLE_ROWS, Math.max(1, targetRowCount));

            // Count ONLY the data rows that are currently VISIBLE on the active page
            let visibleDataRowCount = 0;
            const allRows = Array.from(tbody.querySelectorAll('tr'));
            allRows.forEach(row => {
                if (!row.classList.contains('empty-excel-row') &&
                    !row.classList.contains('no-results-row') &&
                    row.style.display !== 'none') {
                    visibleDataRowCount++;
                }
            });

            let desiredEmptyRows = targetRowCount - visibleDataRowCount;
            if (desiredEmptyRows < 0) desiredEmptyRows = 0;

            let emptyRows = Array.from(tbody.querySelectorAll('tr.empty-excel-row'));

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
                for (let i = 0; i < rowsToRemove; i++) {
                    if (emptyRows[emptyRows.length - 1 - i]) {
                        emptyRows[emptyRows.length - 1 - i].remove();
                    }
                }
                updateRowNumbers();
            } else {
                updateRowNumbers();
            }
            if (typeof applyColumnVisibility === 'function') applyColumnVisibility();
            */
            if (typeof updateTableEmptyState === 'function') {
                updateTableEmptyState();
            }
        }

        function renderDefaultExcelGrid() {
            const tbody = document.getElementById('myTable');
            if (tbody) tbody.innerHTML = ''; // Wipe existing rows

            if (typeof updateTableEmptyState === 'function') {
                updateTableEmptyState();
            }
        }

        // Initialize and track window resizing automatically
        window.addEventListener("DOMContentLoaded", () => {
            document.getElementById('table-container').style.display = "block";
            renderDefaultExcelGrid();
            initResizableTable();
            applyPagination();
            initCustomizeColumnsDropdown();
            applyColumnVisibility();
            if (typeof updateTableEmptyState === 'function') updateTableEmptyState();
        });

        window.addEventListener('resize', () => {
            requestAnimationFrame(() => {
                adjustEmptyRows();
                if (typeof autoAdjustTableLayout === 'function') autoAdjustTableLayout();
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
    { key: 'number', label: '# (Number)', selector: 'th.excel-header-corner', locked: true, defaultVisible: true, minWidth: 48 },
    { key: 'control_name', label: 'Control Name', selector: 'th[id*="cn"]', locked: true, defaultVisible: true, minWidth: 130 },
    { key: 'control_type', label: 'Control Type', selector: 'th[id*="ct"]', locked: true, defaultVisible: true, minWidth: 125 },
    { key: 'control_id', label: 'Control ID', selector: 'th[id*="xpath"]', locked: true, defaultVisible: true, minWidth: 200 },
    { key: 'page_name', label: 'Page Name', selector: 'th[id*="page"]', locked: true, defaultVisible: true, minWidth: 115 },
    { key: 'identification_type', label: 'Identification Type', selector: 'th[id*="identificationType"]', locked: false, defaultVisible: false, minWidth: 180 },
    { key: 'control_value', label: 'Control Value', selector: 'th[id*="controlValue"]', locked: false, defaultVisible: false, minWidth: 145 },
    { key: 'feature_name', label: 'Feature Name', selector: 'th[id*="featureName"]', locked: false, defaultVisible: true, minWidth: 135 },
    { key: 'node_name', label: 'Node Name', selector: 'th.nodeName, th[id*="nodeName"]', locked: false, defaultVisible: false, minWidth: 125 },
    { key: 'delete', label: 'Delete', selector: 'th#delete_header', locked: true, defaultVisible: true, minWidth: 48 }
];

function getColumnVisibilityState() {
    try {
        const saved = localStorage.getItem('algo_column_visibility_v2');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed && typeof parsed === 'object') {
                return parsed;
            }
        }
    } catch (e) {}

    // Clean defaults: what is seen in the table by default is checked, others are unchecked
    const state = {};
    TABLE_COL_CONFIG.forEach(col => {
        state[col.key] = col.defaultVisible !== false;
    });
    return state;
}

function saveColumnVisibilityState(state) {
    try {
        localStorage.setItem('algo_column_visibility_v2', JSON.stringify(state));
    } catch (e) {}
}

function autoAdjustTableLayout() {
    const table = document.getElementById('mainTable');
    const container = document.getElementById('table-container');
    if (!table || !container) return;

    const headerRow = table.querySelector('thead tr');
    if (!headerRow) return;

    const state = getColumnVisibilityState();
    const containerWidth = container.clientWidth;
    if (containerWidth <= 0) return;

    // Gather all currently visible columns
    const visibleCols = [];
    TABLE_COL_CONFIG.forEach(col => {
        const isVisible = col.locked ? true : (state[col.key] !== false);
        if (!isVisible) return;
        const th = headerRow.querySelector(col.selector);
        if (!th) return;
        visibleCols.push({ col, th });
    });

    if (visibleCols.length === 0) return;

    // Measure required text width accurately using a hidden span
    const dummySpan = document.createElement('span');
    dummySpan.style.position = 'absolute';
    dummySpan.style.visibility = 'hidden';
    dummySpan.style.whiteSpace = 'nowrap';
    dummySpan.style.font = '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
    document.body.appendChild(dummySpan);

    let totalRequiredWidth = 0;
    const colMeasurements = [];

    visibleCols.forEach(({ col, th }) => {
        let headerLabel = "";
        for (let i = 0; i < th.childNodes.length; i++) {
            const child = th.childNodes[i];
            if (child.nodeType === Node.TEXT_NODE) {
                headerLabel += child.textContent;
            }
        }
        headerLabel = (headerLabel || th.innerText || col.label || "").replace(/\s+/g, ' ').trim();
        dummySpan.innerText = headerLabel;
        const textWidth = dummySpan.offsetWidth;

        // Base width: measured text width + padding + resizer buffer
        let minW = Math.max(col.minWidth || 100, Math.ceil(textWidth + 36));

        // Fixed narrow columns
        if (col.key === 'number' || col.key === 'delete') {
            minW = 48;
        }

        // Preserve user manual drag resize if set
        if (th.dataset.userWidth) {
            const uw = parseInt(th.dataset.userWidth, 10);
            if (!isNaN(uw) && uw > minW) {
                minW = uw;
            }
        }

        colMeasurements.push({ col, th, minW, key: col.key });
        totalRequiredWidth += minW;
    });

    document.body.removeChild(dummySpan);

    if (totalRequiredWidth <= containerWidth) {
        // Fits container: fill 100% and distribute extra space cleanly
        table.style.width = '100%';
        table.style.minWidth = '100%';

        const extraSpace = containerWidth - totalRequiredWidth;
        const expandable = colMeasurements.filter(c => c.key !== 'number' && c.key !== 'delete');
        const controlIdCol = colMeasurements.find(c => c.key === 'control_id');

        colMeasurements.forEach(c => {
            let finalW = c.minW;
            if (c.key === 'number' || c.key === 'delete') {
                finalW = 48;
            } else if (controlIdCol && c === controlIdCol) {
                // Control ID gets majority of extra space for long XPaths
                finalW += Math.floor(extraSpace * 0.6);
            } else if (expandable.includes(c)) {
                const othersCount = Math.max(1, expandable.length - 1);
                finalW += Math.floor((extraSpace * 0.4) / othersCount);
            }
            c.th.style.width = `${finalW}px`;
            c.th.style.minWidth = `${c.minW}px`;
        });
    } else {
        // Exceeds container: expand table width smoothly so no column is compressed or shows "..."
        table.style.width = `${totalRequiredWidth}px`;
        table.style.minWidth = `${totalRequiredWidth}px`;

        colMeasurements.forEach(c => {
            c.th.style.width = `${c.minW}px`;
            c.th.style.minWidth = `${c.minW}px`;
        });
    }
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

    autoAdjustTableLayout();

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

   //popup extra button (for sub-feature or Create New project launch)
   newExtraBtn.addEventListener('click', async () => {
        try {
            const extraBtnEl = document.getElementById('extra_btn');
            const action = pendingExportAction || window.pendingExportAction;
            const extraText = (extraBtnEl ? extraBtnEl.innerText : '').trim().toLowerCase();
            const modalTitle = (document.getElementById('popup_title')?.innerText || '').trim().toLowerCase();
            const isCreateNewAction = action === "confirmExistingProjectLaunch" || extraText.includes("create new") || modalTitle.includes("existing project");

            // Primary Create New path is showConfirmDialog extraBtn.onclick / onExtra.
            // Skip this listener so we do not create a second project or launch twice.
            if (isCreateNewAction && extraBtnEl && typeof extraBtnEl.onclick === 'function') {
                return;
            }
            if (isCreateNewAction && window._createNewProjectLaunchInFlight) {
                return;
            }

            document.getElementById('confirmationPopup').style.display = 'none';
            document.getElementById('overlay').style.display = 'none';
            if (extraBtnEl) extraBtnEl.style.display = 'none';

            if (isCreateNewAction) {
                window._createNewProjectLaunchInFlight = true;
                try {
                const launchData = pendingLaunchProjectData || window.pendingLaunchProjectData;
                const existingProj = launchData ? launchData.project : null;
                const activeApp = (existingProj && existingProj.appName) || resolveActiveAppName();
                const plateformOption = (existingProj && existingProj.platform) || (typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : 'Android');

                let dataToLaunch = launchData ? launchData.initialData : null;
                if (!dataToLaunch || !Array.isArray(dataToLaunch) || dataToLaunch.length < 9) {
                    dataToLaunch = [
                        plateformOption,
                        document.getElementById('devicename')?.value || '',
                        document.getElementById('platformversion')?.value || '',
                        document.getElementById('automationName')?.value || '',
                        document.getElementById('appiumurl')?.value || '',
                        document.getElementById('udid')?.value || '',
                        document.getElementById('bundleID')?.value || '',
                        document.getElementById('apppackage')?.value || '',
                        document.getElementById('appactivity')?.value || ''
                    ];
                }

                pendingLaunchProjectData = null;
                window.pendingLaunchProjectData = null;
                pendingExportAction = null;
                window.pendingExportAction = null;

                const uniqueInfo = (typeof createFreshRepoProject === 'function')
                    ? createFreshRepoProject(activeApp, plateformOption)
                    : { key: `${activeApp} (${plateformOption})::${Date.now().toString(36)}`, appName: activeApp };

                if (typeof window.clearAllPagesAndScrapedDataForNewScenario === 'function') {
                    window.clearAllPagesAndScrapedDataForNewScenario();
                }

                if (typeof window.setGlobalPageName === 'function') {
                    window.setGlobalPageName(uniqueInfo.appName);
                }

                if (typeof triggerScreenshotLoader === 'function') triggerScreenshotLoader();
                resetFormLockActive = false;
                if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();

                const fnLaunch = (typeof launchApp === 'function') ? launchApp : window.launchApp;
                if (typeof fnLaunch === 'function' && dataToLaunch) {
                    await fnLaunch(dataToLaunch);
                }
                return;
                } finally {
                    window._createNewProjectLaunchInFlight = false;
                }
            }

        if (pendingExportAction === "renameFeature" && pendingFeatureRename) {
            const { newName, cellElement } = pendingFeatureRename;
            applyTableFeatureSubFeature(cellElement, newName);
        }

        pendingFeatureRename = null;
        pendingExportAction = null;
        } catch (extraErr) {
            console.error("Error in newExtraBtn handler:", extraErr);
        }
   });

   //popup okay button
   newOkayBtn.addEventListener('click', async () => {
           const okayBtnEl = document.getElementById('okay_btn');
           const continueAction = pendingExportAction || window.pendingExportAction;
           const okayText = (okayBtnEl ? okayBtnEl.innerText : '').trim().toLowerCase();
           const isContinueOldAction = continueAction === "confirmExistingProjectLaunch" || okayText.includes("continue with old");
           // Primary path is showConfirmDialog okayBtn.onclick / onOkay.
           if (isContinueOldAction && okayBtnEl && typeof okayBtnEl.onclick === 'function') {
               return;
           }
           if (isContinueOldAction && window._resumeOldProjectLaunchInFlight) {
               return;
           }

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

               const alertCb = window._customAlertOnOkay;
               window._customAlertOnOkay = null;
               if (typeof alertCb === 'function') {
                   try { alertCb(); } catch (cbErr) { console.error("Error in alertOnOkay callback:", cbErr); }
               }

               return;
           } else if (pendingExportAction === "renameFeature" || pendingExportAction === "createNewFeature") {
               const currentAction = pendingExportAction;
               pendingExportAction = null;

               if (pendingFeatureRename) {
                   const { oldName, newName, cellElement, pageName } = pendingFeatureRename;

                   if (currentAction === "renameFeature") {
                        applyTableFeatureRenameAll(oldName, newName, pageName);
                   } else if (currentAction === "createNewFeature") {
                        applyTableFeatureSubFeature(cellElement, newName);
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
                   if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
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
                   if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
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

                   try {
                       const store = getProjectStore();
                       const appName = window.activeResumedAppName || resolveActiveAppName();
                       const platform = typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : 'Android';
                       const projectKey = window.activeResumedProjectKey || `${appName} (${platform})`;
                       if (store[projectKey] && Array.isArray(store[projectKey].pages)) {
                           store[projectKey].pages = store[projectKey].pages.filter(p => (p.pageName || '').trim().toLowerCase() !== page.trim().toLowerCase());
                           persistProjectStore(store);
                       }
                   } catch (e) {
                       console.error('Error removing deleted page from store:', e);
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
                   if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
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

            // --- CONFIRM CLEAR ALL REPOSITORY ACTION ---
            } else if (pendingExportAction === "confirmClearRepositoryAction") {
                pendingExportAction = null;
                if (typeof window.getRepoProjectsStore === 'function' && typeof window.setRepoProjectsStore === 'function') {
                    const store = window.getRepoProjectsStore() || {};
                    const kept = {};
                    Object.keys(store).forEach(k => {
                        const live = (typeof window.isCurrentlyOpenRepoProject === 'function')
                            ? window.isCurrentlyOpenRepoProject(k, store[k])
                            : (k === window.activeResumedProjectKey);
                        if (live) kept[k] = store[k];
                    });
                    window.setRepoProjectsStore(kept);
                    if (Object.keys(kept).length === 0 && typeof window.applyRepoChangeToHome === 'function') {
                        window.applyRepoChangeToHome({ wipeSession: true, projectKey: window.activeResumedProjectKey });
                    }
                    if (typeof window.renderRepositoryView === 'function') {
                        window.renderRepositoryView();
                    }
                }

            } else if (pendingExportAction === "confirmDeleteRepoProjects") {
                pendingExportAction = null;
                const keys = (pendingRepoDelete && Array.isArray(pendingRepoDelete.projectKeys))
                    ? pendingRepoDelete.projectKeys.slice()
                    : [];
                if (keys.length && typeof window.getRepoProjectsStore === 'function') {
                    const store = window.getRepoProjectsStore();
                    const liveKey = window.activeResumedProjectKey;
                    const actuallyDeleted = [];
                    keys.forEach(deletedKey => {
                        if (!store[deletedKey]) return;
                        const live = (typeof window.isCurrentlyOpenRepoProject === 'function')
                            ? window.isCurrentlyOpenRepoProject(deletedKey, store[deletedKey])
                            : (deletedKey === liveKey);
                        if (live) return;
                        delete store[deletedKey];
                        actuallyDeleted.push(deletedKey);
                    });
                    window.setRepoProjectsStore(store);
                    if (typeof window.applyRepoChangeToHome === 'function') {
                        actuallyDeleted.forEach(deletedKey => {
                            window.applyRepoChangeToHome({ projectKey: deletedKey, wipeSession: false });
                        });
                    }
                    pendingRepoDelete = null;
                    if (typeof window.setRepoMultiDeleteMode === 'function') {
                        window.setRepoMultiDeleteMode(false);
                    }
                    if (typeof window.renderRepositoryView === 'function') {
                        window.renderRepositoryView();
                    }
                }

            // --- CONFIRM DELETE REPOSITORY PROJECT ---
            } else if (pendingExportAction === "confirmDeleteRepoProject") {
                pendingExportAction = null;
                if (pendingRepoDelete && pendingRepoDelete.projectKey && typeof window.getRepoProjectsStore === 'function') {
                    const store = window.getRepoProjectsStore();
                    const deletedKey = pendingRepoDelete.projectKey;
                    const live = (typeof window.isCurrentlyOpenRepoProject === 'function')
                        ? window.isCurrentlyOpenRepoProject(deletedKey, store[deletedKey])
                        : (deletedKey === window.activeResumedProjectKey);
                    if (live) {
                        pendingRepoDelete = null;
                        if (typeof showCustomAlert === 'function') {
                            showCustomAlert('Active Project', 'This project is currently open and cannot be deleted.', 'warning');
                        }
                    } else {
                        delete store[deletedKey];
                        window.setRepoProjectsStore(store);
                        if (typeof window.applyRepoChangeToHome === 'function') {
                            window.applyRepoChangeToHome({
                                projectKey: deletedKey,
                                wipeSession: false
                            });
                        }
                        pendingRepoDelete = null;
                        if (typeof window.renderRepositoryView === 'function') {
                            window.renderRepositoryView();
                        }
                    }
                }

            // --- CONFIRM DELETE INDIVIDUAL REPOSITORY ITEM ---
            } else if (pendingExportAction === "confirmDeleteRepoItem") {
                pendingExportAction = null;
                if (pendingRepoDelete && pendingRepoDelete.projectKey && typeof window.getRepoProjectsStore === 'function') {
                    const { projectKey, type, id } = pendingRepoDelete;
                    const store = window.getRepoProjectsStore();
                    const proj = store[projectKey];
                    const homeChange = { projectKey, type };
                    if (proj) {
                        if (type === 'scenario') {
                            const s = (proj.scenarios || []).find(x => x.id === id);
                            homeChange.pageName = (s && (s.pageName || s.name)) || pendingRepoDelete.pageName;
                            homeChange.scenarioName = (s && s.name) || pendingRepoDelete.scenarioName;
                            proj.scenarios = (proj.scenarios || []).filter(x => x.id !== id);
                        } else if (type === 'feature') {
                            const featObj = (proj.features || []).find(f => f.id === id || f.name === id);
                            const featName = (featObj ? featObj.name : null) || pendingRepoDelete.featureName || id;
                            homeChange.featureName = featName;
                            if (typeof window.removeFeatureCompletely === 'function') {
                                window.removeFeatureCompletely(featName, projectKey);
                            } else {
                                proj.features = (proj.features || []).filter(f => f.id !== id && f.name !== id);
                            }
                        } else if (type === 'page') {
                            const p = (proj.pages || []).find(x => x.id === id);
                            homeChange.pageName = (p && p.pageName) || pendingRepoDelete.pageName;
                            proj.pages = (proj.pages || []).filter(x => x.id !== id);
                        }
                        proj.lastUpdated = Date.now();
                        window.setRepoProjectsStore(store);
                    } else {
                        homeChange.pageName = pendingRepoDelete.pageName;
                        homeChange.featureName = pendingRepoDelete.featureName;
                    }
                    if (type !== 'feature' && !pendingRepoDelete._appliedHome && typeof window.applyRepoChangeToHome === 'function') {
                        window.applyRepoChangeToHome(homeChange);
                        pendingRepoDelete._appliedHome = true;
                    }
                    pendingRepoDelete = null;
                    if (typeof window.renderRepositoryView === 'function') {
                        window.renderRepositoryView();
                    }
                }

            // --- CONFIRM EXISTING PROJECT LAUNCH (CONTINUE WITH OLD) ---
            } else if (pendingExportAction === "confirmExistingProjectLaunch" || window.pendingExportAction === "confirmExistingProjectLaunch" || (document.getElementById('okay_btn')?.innerText || '').toLowerCase().includes("continue with old") || ((document.getElementById('popup_title')?.innerText || '').toLowerCase().includes("existing project") && (document.getElementById('okay_btn')?.innerText || '').toLowerCase().includes("continue"))) {
                const launchData = pendingLaunchProjectData || window.pendingLaunchProjectData;
                const proj = launchData ? launchData.project : null;
                const projKey = launchData ? launchData.key : (proj ? `${proj.appName} (${proj.platform})` : null);
                let dataToLaunch = launchData ? launchData.initialData : null;

                const extraBtnEl = document.getElementById('extra_btn');
                if (extraBtnEl) extraBtnEl.style.display = 'none';

                if (!dataToLaunch) {
                    dataToLaunch = [
                        getSelectedPlatform(),
                        document.getElementById('devicename')?.value || '',
                        document.getElementById('platformversion')?.value || '',
                        document.getElementById('automationName')?.value || '',
                        document.getElementById('appiumurl')?.value || '',
                        document.getElementById('udid')?.value || '',
                        document.getElementById('bundleID')?.value || '',
                        document.getElementById('apppackage')?.value || '',
                        document.getElementById('appactivity')?.value || ''
                    ];
                }

                await resumeExistingProjectAndLaunch(projKey, proj, dataToLaunch);

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
        const extraBtnEl = document.getElementById('extra_btn');
        if (extraBtnEl) extraBtnEl.style.display = 'none';

        const action = pendingExportAction || window.pendingExportAction;
        const modalTitle = (document.getElementById('popup_title')?.innerText || '').trim().toLowerCase();
        if (action === "confirmExistingProjectLaunch" || modalTitle.includes("existing project")) {
            pendingLaunchProjectData = null;
            window.pendingLaunchProjectData = null;
            pendingExportAction = null;
            window.pendingExportAction = null;
            if (typeof unlockLaunchForm === 'function') {
                unlockLaunchForm();
            }
            return;
        }

        if (pendingExportAction === "confirmExistingPageAction") {
            pendingExistingPageAction = null;
            const pageNameInput = document.getElementById('pagename_searchbox');
            if (pageNameInput) {
                pageNameInput.focus();
            }
        }

        if ((pendingExportAction === "renameFeature" || pendingExportAction === "createNewFeature") && pendingFeatureRename) {
            pendingFeatureRename.cellElement.innerText = pendingFeatureRename.oldName;
            pendingFeatureRename = null;
            pendingExportAction = null;
            if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
            return;
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
                // Save current Home into Repository first, while the table still has data.
                if (typeof archiveCurrentActiveSession === 'function') {
                    archiveCurrentActiveSession();
                }

                // Home is being cleared. Do not write that empty table back to Repository.
                window._resettingHome = true;
                window._restoringProject = true;

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

                window.activeProjectSessionMode = null;
                window.activeResumedProjectKey = null;
                window.activeResumedAppName = null;
                window._resumedProjectSnapshot = null;
                if (typeof window.closeRepoWorkspaceToList === 'function') {
                    window.closeRepoWorkspaceToList();
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
            } finally {
                window._restoringProject = false;
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

    const isAppBackground = /closed or running in the background|not running|background/i.test(readableError);
    const isDeviceDisconnected = /device (offline|not found|disconnected)|connection refused|econnrefused|device '[^']+' not found|closed the connection/i.test(readableError);

    if (isDeviceDisconnected) {
        showDummyDeviceMessage({
            theme: 'error',
            title: 'Device Disconnected',
            detail: 'Please reconnect your device and click Launch Application.'
        });
    } else if (isAppBackground) {
        showDummyDeviceMessage({
            theme: 'warning',
            title: 'Application is closed or running in the background.',
            detail: 'Keep the app open, then click Launch Application to reconnect.'
        });
    } else {
        showDummyDeviceMessage({
            theme: 'error',
            title: 'Session Interrupted',
            detail: readableError || 'Communication with the application was interrupted.'
        });
    }

    // --- BUTTON LOGIC ---
    setLaunchEnabled(canEnableLaunch());

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
    if (typeof updateRowNumbers === 'function') updateRowNumbers();
    renderPaginationControls(totalPages);

    // Recalculate empty rows and toggle modern empty state if table is empty
    if (typeof updateTableEmptyState === 'function') updateTableEmptyState();
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

        const trimmedName = (name || '').trim();
        const lowerName = trimmedName.toLowerCase();
        // Sync before check to be absolutely sure
        syncRegisteredPageNames();

        // If renaming, ignore the original name
        if (isRenameMode && lowerName === renameTarget.toLowerCase()) return true;

        if (window.registeredPageNames) {
            for (let p of window.registeredPageNames) {
                if (p && p.toLowerCase() === lowerName) return false;
            }
        }

        // Check active scenarios
        if (window.pageScenarioData) {
            for (let p in window.pageScenarioData) {
                const scen = window.pageScenarioData[p];
                if (scen && scen.scenarioName && scen.scenarioName.trim().toLowerCase() === lowerName) {
                    return false;
                }
            }
        }

        // Check active features
        if (Array.isArray(registeredFeatureAreas)) {
            for (let f of registeredFeatureAreas) {
                if (f && f.name && f.name.trim().toLowerCase() === lowerName) {
                    return false;
                }
            }
        }

        if (typeof isPageNameInRepo === 'function' && isPageNameInRepo(trimmedName)) return false;

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
        if (typeof clearOverlay === 'function') {
            clearOverlay();
        }
        if (!window.registeredPageNames) window.registeredPageNames = new Set();
        if (name && name !== "All" && (typeof isGlobalPageNameValid === 'function' ? isGlobalPageNameValid(name) : true)) {
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
            if (pageNameInput) {
                pageNameInput.readOnly = true;
                pageNameInput.style.cursor = 'default';
            }
            if (confirmIcon) confirmIcon.style.display = 'none';
            if (cancelIcon) cancelIcon.style.display = 'none';
            if (addPageIcon) addPageIcon.style.display = 'inline-block';
            if (dropdownIcon) dropdownIcon.style.display = 'inline-block';

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
        if (!window._restoringProject && !window._applyingRepoToHome && typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
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
                } else {

                    // Gather all known pages, scenario names, and feature names from active memory
                    let allKnownPages = new Set(window.registeredPageNames || []);

                    // Include pages and scenario names from scenario data
                    if (window.pageScenarioData) {
                        Object.keys(window.pageScenarioData).forEach(p => {
                            allKnownPages.add(p);
                            const s = window.pageScenarioData[p];
                            if (s && s.scenarioName) allKnownPages.add(s.scenarioName);
                        });
                    }

                    // Include active features
                    if (Array.isArray(registeredFeatureAreas)) {
                        registeredFeatureAreas.forEach(a => {
                            if (a && a.name) allKnownPages.add(a.name);
                        });
                    }

                    // CRITICAL FIX: Include the page we just navigated away from via the '+' icon.
                    // If the table was empty, the sync function forgets it, causing the duplicate bug.
                    if (typeof previousPageName !== 'undefined' && previousPageName && previousPageName !== "All") {
                        allKnownPages.add(previousPageName);
                    }

                    // Include repository assets for the current app / project
                    const repoAssets = typeof getRepoAssetsForActiveApp === 'function' ? getRepoAssetsForActiveApp() : { pages: new Set(), scenarioNames: new Set(), featureNames: new Set() };
                    repoAssets.pages.forEach(rp => allKnownPages.add(rp));
                    repoAssets.scenarioNames.forEach(sn => allKnownPages.add(sn));
                    repoAssets.featureNames.forEach(fn => allKnownPages.add(fn));

                    // Check for duplicates (Case-Insensitive for better UX)
                    let isDuplicate = false;
                    let isRepoDup = false;
                    const lowerTrimmed = trimmedName.toLowerCase();
                    for (let existingPage of allKnownPages) {
                        if (existingPage.toLowerCase() === lowerTrimmed) {
                            // If we are renaming (pencil icon), it's allowed to match its own original name
                            if (!(isRenameMode && typeof renameTarget !== 'undefined' && renameTarget.toLowerCase() === lowerTrimmed)) {
                                isDuplicate = true;
                                if (repoAssets.pages.has(lowerTrimmed) || repoAssets.scenarioNames.has(lowerTrimmed) || repoAssets.featureNames.has(lowerTrimmed)) {
                                    isRepoDup = true;
                                }
                                break;
                            }
                        }
                    }

                    if (isDuplicate) {
                        errorMsg = isRepoDup ? "Page Name already exists in repository." : "Page Name already exists.";
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
                    const trimmed = pageNameInput.value.trim();
                    if (typeof isPageNameInRepo === 'function' && isPageNameInRepo(trimmed)) {
                        showCustomAlert("Page Exists in Repository", `The page "${trimmed}" already exists in the repository for this application. Please choose a different page name.`, "warning");
                    } else {
                        showCustomAlert("Invalid Format", "Please provide a valid, unique Page Name without special characters.", "warning");
                    }
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

                    // 4. Update in Repository Store
                    try {
                        const store = getProjectStore();
                        const appName = window.activeResumedAppName || resolveActiveAppName();
                        const platform = typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : 'Android';
                        const projectKey = window.activeResumedProjectKey || `${appName} (${platform})`;
                        if (store[projectKey]) {
                            if (Array.isArray(store[projectKey].pages)) {
                                store[projectKey].pages.forEach(p => {
                                    if (p && (p.pageName || '').trim().toLowerCase() === renameTarget.toLowerCase()) {
                                        p.pageName = newName;
                                    }
                                });
                            }
                            if (Array.isArray(store[projectKey].scenarios)) {
                                store[projectKey].scenarios.forEach(s => {
                                    if (s && (s.pageName || '').trim().toLowerCase() === renameTarget.toLowerCase()) {
                                        s.pageName = newName;
                                    }
                                });
                            }
                            persistProjectStore(store);
                        }
                    } catch (e) {
                        console.error('Error updating renamed page in store:', e);
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
            const currentActivePage = document.getElementById('pagename_searchbox')?.value.trim() || "";
            const val = this.value.trim();
            const lowerVal = val.toLowerCase();
            const origName = (window.pageScenarioData && window.pageScenarioData[currentActivePage]?.scenarioName || "").trim().toLowerCase();

            if (!val) {
                showEditError(this, "edit_scenario_error_icon", "edit_scenario_error_text", "Scenario Name is required");
            } else if (val.length < 3) {
                showEditError(this, "edit_scenario_error_icon", "edit_scenario_error_text", "Scenario Name must be at least 3 characters");
            } else if (!/^[A-Za-z][A-Za-z0-9_]*(\s[A-Za-z0-9_]+)*$/.test(val)) {
                showEditError(this, "edit_scenario_error_icon", "edit_scenario_error_text", "Must start with a letter and contain only alphanumeric chars or single spaces.");
            } else if (window.pageScenarioData && Object.keys(window.pageScenarioData).some(p => p.toLowerCase() !== currentActivePage.toLowerCase() && window.pageScenarioData[p]?.scenarioName?.trim().toLowerCase() === lowerVal)) {
                showEditError(this, "edit_scenario_error_icon", "edit_scenario_error_text", "Scenario Name already exists.");
            } else if (typeof isScenarioNameInRepo === 'function' && isScenarioNameInRepo(val) && lowerVal !== origName) {
                showEditError(this, "edit_scenario_error_icon", "edit_scenario_error_text", "Scenario Name already exists in repository.");
            } else {
                clearEditError(this, "edit_scenario_error_icon");
            }
        });
    }

    if (editScenarioOutlineInput) {
        editScenarioOutlineInput.addEventListener("input", function() {
            const currentActivePage = document.getElementById('pagename_searchbox')?.value.trim() || "";
            const val = this.value.trim();
            const lowerVal = val.toLowerCase();
            const origOutline = (window.pageScenarioData && window.pageScenarioData[currentActivePage]?.scenarioOutline || "").trim().toLowerCase();

            if (!val) {
                showEditError(this, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline is required");
            } else if (val.length < 3) {
                showEditError(this, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline must be at least 3 characters");
            } else if (window.pageScenarioData && Object.keys(window.pageScenarioData).some(p => p.toLowerCase() !== currentActivePage.toLowerCase() && window.pageScenarioData[p]?.scenarioOutline?.trim().toLowerCase() === lowerVal)) {
                showEditError(this, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline already exists.");
            } else if (typeof isScenarioOutlineInRepo === 'function' && isScenarioOutlineInRepo(val) && lowerVal !== origOutline) {
                showEditError(this, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline already exists in repository.");
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
            const origName = (window.pageScenarioData && window.pageScenarioData[currentActivePage]?.scenarioName || "").trim().toLowerCase();
            const origOutline = (window.pageScenarioData && window.pageScenarioData[currentActivePage]?.scenarioOutline || "").trim().toLowerCase();

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
            } else if (window.pageScenarioData && Object.keys(window.pageScenarioData).some(p => p.toLowerCase() !== currentActivePage.toLowerCase() && window.pageScenarioData[p]?.scenarioName?.trim().toLowerCase() === nameVal.toLowerCase())) {
                showEditError(editScenarioNameInput, "edit_scenario_error_icon", "edit_scenario_error_text", "Scenario Name already exists.");
                isValid = false;
            } else if (typeof isScenarioNameInRepo === 'function' && isScenarioNameInRepo(nameVal) && nameVal.toLowerCase() !== origName) {
                showEditError(editScenarioNameInput, "edit_scenario_error_icon", "edit_scenario_error_text", "Scenario Name already exists in repository.");
                isValid = false;
            }

            // Validate Outline
            if (!outlineVal) {
                showEditError(editScenarioOutlineInput, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline is required");
                isValid = false;
            } else if (outlineVal.length < 3) {
                showEditError(editScenarioOutlineInput, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline must be at least 3 characters");
                isValid = false;
            } else if (window.pageScenarioData && Object.keys(window.pageScenarioData).some(p => p.toLowerCase() !== currentActivePage.toLowerCase() && window.pageScenarioData[p]?.scenarioOutline?.trim().toLowerCase() === outlineVal.toLowerCase())) {
                showEditError(editScenarioOutlineInput, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline already exists.");
                isValid = false;
            } else if (typeof isScenarioOutlineInRepo === 'function' && isScenarioOutlineInRepo(outlineVal) && outlineVal.toLowerCase() !== origOutline) {
                showEditError(editScenarioOutlineInput, "edit_outline_error_icon", "edit_outline_error_text", "Scenario Outline already exists in repository.");
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
            if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();

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
function showCustomAlert(title, message, type, onOkay) {
    const theme = normalizeModalType(type, title);
    setModalTheme(theme);

    document.getElementById('popup_title').innerText = title;
    document.getElementById('popup_main_text').innerHTML = message;
    document.getElementById('popup_sub_text').innerText = "";

    document.getElementById('back_btn').style.display = 'none';
    document.getElementById('extra_btn').style.display = 'none';
    document.getElementById('okay_btn').innerText = 'Okay';

    pendingExportAction = "alertOnly";
    window._customAlertOnOkay = (typeof onOkay === 'function') ? onOkay : null;

    document.getElementById('confirmationPopup').style.display = 'block';
    document.getElementById('overlay').style.display = 'block';
}

/// HELPER: Confirm modal (Cancel + Confirm) for destructive / export actions
function showConfirmDialog({ title, mainText, subText, action, theme, okayBtnText, extraBtnText, onOkay, onExtra, onCancel }) {
    setModalTheme(theme || "confirm");

    const backBtn = document.getElementById('back_btn');
    backBtn.style.display = 'inline-block';

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

    if (action) {
        pendingExportAction = action;
        window.pendingExportAction = action;
    }

    if (typeof onExtra === 'function') {
        extraBtn.onclick = async (e) => {
            if (e) { e.preventDefault(); e.stopPropagation(); }
            document.getElementById('confirmationPopup').style.display = 'none';
            document.getElementById('overlay').style.display = 'none';
            extraBtn.style.display = 'none';
            extraBtn.onclick = null;
            await onExtra();
        };
    } else {
        extraBtn.onclick = null;
    }

    if (typeof onOkay === 'function') {
        okayBtn.onclick = async (e) => {
            if (e) { e.preventDefault(); e.stopPropagation(); }
            document.getElementById('confirmationPopup').style.display = 'none';
            document.getElementById('overlay').style.display = 'none';
            const extraBtnEl = document.getElementById('extra_btn');
            if (extraBtnEl) extraBtnEl.style.display = 'none';
            okayBtn.onclick = null;
            await onOkay();
        };
    } else {
        okayBtn.onclick = null;
    }

    if (typeof onCancel === 'function') {
        backBtn.onclick = (e) => {
            if (e) { e.preventDefault(); e.stopPropagation(); }
            document.getElementById('confirmationPopup').style.display = 'none';
            document.getElementById('overlay').style.display = 'none';
            const extraBtnEl = document.getElementById('extra_btn');
            if (extraBtnEl) extraBtnEl.style.display = 'none';
            backBtn.onclick = null;
            onCancel();
        };
    } else {
        backBtn.onclick = null;
    }

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

        // Check if page already exists in active memory
        const trimmedName = val.trim();
        if (window.registeredPageNames) {
            const isLocalDup = Array.from(window.registeredPageNames).some(p => p && p.toLowerCase() === trimmedName.toLowerCase());
            if (isLocalDup) {
                // If in Record Scenario mode (renaming current page), allow it.
                // But if in Add Scenario mode (new page), it must be unique.
                if (!(currentScenarioMode === "RECORD" && trimmedName.toLowerCase() === (initialModalPageName || '').toLowerCase())) {
                    return "Page Name already exists.";
                }
            }
        }

        // Check if page already exists in repository
        if (typeof isPageNameInRepo === 'function' && isPageNameInRepo(trimmedName)) {
            if (!(currentScenarioMode === "RECORD" && trimmedName.toLowerCase() === (initialModalPageName || '').toLowerCase())) {
                return "Page Name already exists in repository.";
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

        const trimmedVal = val.trim();
        const lowerVal = trimmedVal.toLowerCase();

        // Check active session scenario names
        if (window.pageScenarioData) {
            for (let p in window.pageScenarioData) {
                const scen = window.pageScenarioData[p];
                if (scen && scen.scenarioName && scen.scenarioName.trim().toLowerCase() === lowerVal) {
                    if (!(currentScenarioMode === "RECORD" && p.toLowerCase() === (initialModalPageName || '').toLowerCase())) {
                        return "Scenario Name already exists.";
                    }
                }
            }
        }

        // Check repository scenario names for this application
        if (typeof isScenarioNameInRepo === 'function' && isScenarioNameInRepo(trimmedVal)) {
            const isSelfRename = currentScenarioMode === "RECORD" && initialModalPageName && window.pageScenarioData && window.pageScenarioData[initialModalPageName] && window.pageScenarioData[initialModalPageName].scenarioName && window.pageScenarioData[initialModalPageName].scenarioName.trim().toLowerCase() === lowerVal;
            if (!isSelfRename) {
                return "Scenario Name already exists in repository.";
            }
        }

        return "";
    }

    function validateScenarioOutline(val) {
        return ""; // Scenario outline is optional and not validated
    }

    function showError(inputEl, iconId, textId, message) {
        inputEl.classList.add("input-error-border");
        const icon = document.getElementById(iconId);
        const text = document.getElementById(textId);
        if (icon) {
            icon.style.display = "flex";
            icon.setAttribute("aria-hidden", "false");
            icon.title = message || "";
        }
        if (text) text.innerText = message;
    }

    function clearError(inputEl, iconId) {
        inputEl.classList.remove("input-error-border");
        const icon = document.getElementById(iconId);
        if (icon) {
            icon.style.display = "none";
            icon.setAttribute("aria-hidden", "true");
            icon.removeAttribute("title");
        }
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
                clearError(this, "rec_outline_error_icon");
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
            if (typeof verifyPageNameSavedBeforeScraping === 'function') {
                if (!verifyPageNameSavedBeforeScraping("recording a scenario")) {
                    return;
                }
            } else {
                const pageNameEl = document.getElementById("pagename_searchbox");
                const pageVal = (pageNameEl?.value || "").trim();

                if (!pageVal || pageVal.toLowerCase() === "all" || (typeof isGlobalPageNameValid === "function" && !isGlobalPageNameValid(pageVal))) {
                    showCustomAlert(
                        "Page Name Required",
                        "Please enter a valid Page Name before recording a scenario.",
                        "warning"
                    );
                    if (pageNameEl) {
                        pageNameEl.focus();
                        pageNameEl.style.borderColor = "red";
                    }
                    return;
                }
            }

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
        addScenarioBtn.addEventListener("click", () => {
            if (typeof verifyPageNameSavedBeforeScraping === 'function') {
                if (!verifyPageNameSavedBeforeScraping("adding a scenario")) {
                    return;
                }
            }
            openScenarioModal("ADD");
        });

        const createFeatureBtn = document.getElementById("createFeatureBtn");
        if (createFeatureBtn) {
            createFeatureBtn.addEventListener("click", () => {
                const turningOn = !createFeatureMode;

                if (turningOn) {
                    if (typeof verifyPageNameSavedBeforeScraping === 'function') {
                        if (!verifyPageNameSavedBeforeScraping("creating a feature")) {
                            return;
                        }
                    } else {
                        const pageVal = (document.getElementById("pagename_searchbox")?.value || "").trim();
                        if (!pageVal || (typeof isGlobalPageNameValid === "function" && !isGlobalPageNameValid(pageVal))) {
                            showCustomAlert(
                                "Page Name Required",
                                "Please enter a valid Page Name before Create Feature mode.",
                                "warning"
                            );
                            return;
                        }
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

                    // Refresh hierarchy so features bind to the current device screen
                    (async () => {
                        try {
                            if (typeof capturePageSource === 'function') {
                                const freshSource = await capturePageSource();
                                if (freshSource) {
                                    const parser = new DOMParser();
                                    window.xmlDoc = parser.parseFromString(freshSource, "text/xml");
                                    if (typeof noteDeviceScreenChanged === 'function') noteDeviceScreenChanged();
                                    else if (typeof realignLiveFeatureScreensToCurrentDoc === 'function') realignLiveFeatureScreensToCurrentDoc();
                                }
                            }
                        } catch (e) {
                            console.warn("Create Feature mode refresh failed:", e);
                        }
                    })();

                    showCustomAlert("Feature Mode Active", "Click any section or control on the screen to create a feature.", "success");
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
            // Shared rules for Windows/Mac + Android/iOS + real/emulator/simulator (no OS fork)
            const formatErr = (typeof getFeatureNameFormatError === 'function')
                ? getFeatureNameFormatError(val)
                : "";
            if (formatErr) return formatErr;

            const trimmed = val.trim();
            const lower = trimmed.toLowerCase();

            // Conflict with Page Name (all pages)
            const nameUsedAsPage = Array.from(window.registeredPageNames || []).some(
                (p) => String(p).trim().toLowerCase() === lower
            );
            if (nameUsedAsPage) {
                return "Feature Name already used as a Page Name.";
            }

            // Conflict with Scenario Name (all pages)
            if (window.pageScenarioData) {
                for (const key of Object.keys(window.pageScenarioData)) {
                    const scen = window.pageScenarioData[key];
                    if (scen && scen.scenarioName && String(scen.scenarioName).trim().toLowerCase() === lower) {
                        return "Feature Name already used as a Scenario Name.";
                    }
                }
            }

            // Keep screen stamps fresh so already-created area checks stay accurate
            if (typeof realignLiveFeatureScreensToCurrentDoc === 'function') {
                realignLiveFeatureScreensToCurrentDoc();
            }

            // Feature names must be unique across ALL pages / screens in this session
            if (typeof isFeatureNameAlreadyUsed === 'function' && isFeatureNameAlreadyUsed(trimmed)) {
                return "Feature Name already exists. Please choose a different name.";
            }

            if (typeof isFeatureNameInRepo === 'function' && isFeatureNameInRepo(trimmed)) {
                const assets = typeof getRepoAssetsForActiveApp === 'function' ? getRepoAssetsForActiveApp() : null;
                if (assets) {
                    if (assets.featureNames && assets.featureNames.has(lower)) {
                        return "Feature Name already exists. Please choose a different name.";
                    }
                    if (assets.pages && assets.pages.has(lower)) return "Feature Name already used as a Page Name in repository.";
                    if (assets.scenarioNames && assets.scenarioNames.has(lower)) return "Feature Name already used as a Scenario Name in repository.";
                }
            }

            return "";
        }

        function showFeatureNameError(message) {
            if (!featureNameInput) return;
            featureNameInput.classList.add("input-error-border");
            const icon = document.getElementById("feature_name_error_icon");
            const text = document.getElementById("feature_name_error_text");
            if (icon) {
                icon.style.display = "flex";
                icon.setAttribute("aria-hidden", "false");
                icon.title = message || "";
            }
            if (text) text.innerText = message;
        }

        function clearFeatureNameError() {
            if (!featureNameInput) return;
            featureNameInput.classList.remove("input-error-border");
            const icon = document.getElementById("feature_name_error_icon");
            if (icon) {
                icon.style.display = "none";
                icon.setAttribute("aria-hidden", "true");
                icon.removeAttribute("title");
            }
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
                    const activePageForNewFeature = (typeof getActiveHomePageName === 'function' && getActiveHomePageName() && getActiveHomePageName().toLowerCase() !== 'all')
                        ? getActiveHomePageName()
                        : ((typeof resolveHomePageNameForScrape === 'function') ? resolveHomePageNameForScrape() : (document.getElementById('pagename_searchbox')?.value || '').trim()) || 'DefaultPage';

                    const newArea = {
                        id: 'feat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                        rect: pendingFeatureData.rect,
                        name: featureName,
                        fullPage: !!pendingFeatureData.fullPage,
                        pageName: activePageForNewFeature,
                        uniqueIdentifier: pendingFeatureData.uniqueIdentifier || "",
                        xpaths: pendingFeatureData.xpaths || [],
                        nodeFingerprint: pendingFeatureData.Fingerprint || "",
                        nodeText: pendingFeatureData.nodeText || "",
                        nodeClass: pendingFeatureData.nodeClass || "",
                        screenSignature: pendingFeatureData.screenSignature || computeScreenSignature(window.xmlDoc),
                        screenContentKeys: pendingFeatureData.screenContentKeys || computeScreenContentKeys(window.xmlDoc, pendingFeatureData.rect)
                    };
                    registeredFeatureAreas.push(newArea);
                    syncExistingRowsWithNewFeature(newArea);
                    if (typeof saveFeatureToRepo === 'function') {
                        saveFeatureToRepo(featureName, newArea.rect, newArea.fullPage, null, null, activePageForNewFeature, newArea.screenSignature, newArea.screenContentKeys, newArea.nodeText, newArea.nodeFingerprint, newArea.uniqueIdentifier, newArea.xpaths, newArea.id);
                    }
                    if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();
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

               clearError(recScenarioOutlineInput, "rec_outline_error_icon");

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

               // Persist into Repository store
               if (typeof saveScenarioToRepo === 'function') {
                   saveScenarioToRepo(newPageName, newScenarioName, newScenarioOutline);
               }
               if (typeof window.syncActiveProjectToRepo === 'function') window.syncActiveProjectToRepo();

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

function isNodeVisibleOnScreen(node) {
    if (!node || typeof node.getAttribute !== 'function') return false;

    // 1. Check XML visibility attributes (iOS & Android)
    const visibleAttr = node.getAttribute('visible');
    if (visibleAttr !== null && String(visibleAttr).toLowerCase() === 'false') {
        return false;
    }

    const displayedAttr = node.getAttribute('displayed');
    if (displayedAttr !== null && String(displayedAttr).toLowerCase() === 'false') {
        return false;
    }

    const userVisAttr = node.getAttribute('visible-to-user');
    if (userVisAttr !== null && String(userVisAttr).toLowerCase() === 'false') {
        return false;
    }

    // 2. Check bounds / coordinates against visible screenshot dimensions
    const rect = parseNodeRect(node);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        return false;
    }

    const dims = (typeof getDeviceDimensions === "function") ? getDeviceDimensions() : { width: 0, height: 0 };
    const img = document.getElementById("screenshot");
    const viewW = dims.width > 0 ? dims.width : (img && img.naturalWidth ? img.naturalWidth : 0);
    const viewH = dims.height > 0 ? dims.height : (img && img.naturalHeight ? img.naturalHeight : 0);

    if (viewW > 0 && viewH > 0) {
        // Element completely outside screen bounds
        if (rect.x >= viewW || rect.y >= viewH || (rect.x + rect.width) <= 0 || (rect.y + rect.height) <= 0) {
            return false;
        }

        // Must have at least 2px visible area inside the screen viewport
        const visibleLeft = Math.max(0, rect.x);
        const visibleTop = Math.max(0, rect.y);
        const visibleRight = Math.min(viewW, rect.x + rect.width);
        const visibleBottom = Math.min(viewH, rect.y + rect.height);
        const visibleW = visibleRight - visibleLeft;
        const visibleH = visibleBottom - visibleTop;

        if (visibleW <= 2 || visibleH <= 2) {
            return false;
        }
    }

    return true;
}

function isMeaningfulControlNode(node) {
    if (!node) return false;
    if (!isNodeVisibleOnScreen(node)) return false;
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

function mapControlType(nodeName, node) {
    const n = nodeName || (node ? ((node.getAttribute && node.getAttribute('class')) || node.nodeName) : '') || '';

    // 1. Direct standard Button types
    if (
        n === 'XCUIElementTypeButton' ||
        n === 'android.widget.Button' ||
        n === 'android.widget.ImageButton' ||
        /Button$|FloatingActionButton$|MaterialButton$/i.test(n)
    ) {
        return 'Button';
    }

    // 2. Direct standard TextBox types
    if (
        n === 'XCUIElementTypeTextField' ||
        n === 'XCUIElementTypeSecureTextField' ||
        n === 'XCUIElementTypeSearchField' ||
        n === 'XCUIElementTypeTextView' ||
        n === 'android.widget.EditText' ||
        n === 'android.widget.AutoCompleteTextView' ||
        n === 'android.widget.MultiAutoCompleteTextView' ||
        /EditText$|TextInputEditText$|SearchAutoComplete$/i.test(n)
    ) {
        return 'TextBox';
    }

    // 3. Direct standard Label types
    if (
        n === 'XCUIElementTypeStaticText' ||
        n === 'android.widget.TextView' ||
        n === 'android.widget.CheckedTextView' ||
        /TextView$|CheckedTextView$/i.test(n)
    ) {
        return 'Label';
    }

    // 4. Direct standard Image types
    if (
        n === 'XCUIElementTypeImage' ||
        n === 'android.widget.ImageView' ||
        /ImageView$|ShapeableImageView$/i.test(n)
    ) {
        return 'Image';
    }

    // 5. CheckBox / Switch / Toggle types
    if (
        n === 'XCUIElementTypeSwitch' ||
        n === 'android.widget.Switch' ||
        n === 'android.widget.ToggleButton' ||
        n === 'android.widget.CheckBox' ||
        /CheckBox$|Switch$|ToggleButton$|SwitchMaterial$/i.test(n)
    ) {
        return 'CheckBox';
    }

    // 6. RadioButton types
    if (n === 'android.widget.RadioButton' || /RadioButton$/i.test(n)) {
        return 'RadioButton';
    }

    // 7. DropDownList / Spinner
    if (n === 'android.widget.Spinner' || /Spinner$/i.test(n)) {
        return 'DropDownList';
    }

    // 8. If node is provided or for ViewGroup/View/Layout/Other: inspect attributes & child hierarchy
    if (node) {
        const getAttr = (k) => node.getAttribute ? (node.getAttribute(k) || '') : '';
        const isClickable = getAttr('clickable') === 'true' || getAttr('long-clickable') === 'true';
        const isCheckable = getAttr('checkable') === 'true';
        const isEditable = getAttr('editable') === 'true';
        const isPassword = getAttr('password') === 'true';
        const text = getAttr('text') || getAttr('label') || getAttr('value') || '';
        const resId = getAttr('resource-id') || getAttr('id') || '';
        const contentDesc = getAttr('content-desc') || '';

        if (isEditable || isPassword || /edit|input|search|query/i.test(resId)) {
            return 'TextBox';
        }

        if (isCheckable) {
            if (/radio/i.test(resId) || /radio/i.test(n)) return 'RadioButton';
            return 'CheckBox';
        }

        // Check if node contains specific child types
        if (node.getElementsByTagName) {
            if (node.getElementsByTagName('android.widget.EditText').length > 0 ||
                node.getElementsByTagName('XCUIElementTypeTextField').length > 0 ||
                node.getElementsByTagName('XCUIElementTypeSecureTextField').length > 0) {
                return 'TextBox';
            }
            if (node.getElementsByTagName('android.widget.Button').length > 0 ||
                node.getElementsByTagName('android.widget.ImageButton').length > 0 ||
                node.getElementsByTagName('XCUIElementTypeButton').length > 0) {
                return 'Button';
            }
            if (node.getElementsByTagName('android.widget.CheckBox').length > 0 ||
                node.getElementsByTagName('android.widget.Switch').length > 0) {
                return 'CheckBox';
            }
            if (node.getElementsByTagName('android.widget.RadioButton').length > 0) {
                return 'RadioButton';
            }
            if (node.getElementsByTagName('android.widget.Spinner').length > 0) {
                return 'DropDownList';
            }
            if (node.getElementsByTagName('android.widget.ImageView').length > 0) {
                return isClickable ? 'Button' : 'Image';
            }
            if (node.getElementsByTagName('android.widget.TextView').length > 0) {
                return isClickable ? 'Button' : 'Label';
            }
        }

        // Check resource-id and content-desc hints for View / ViewGroup
        if (/btn|button|fab|cta|submit|cancel|click|item|card/i.test(resId) || /btn|button/i.test(contentDesc)) {
            return 'Button';
        }
        if (/icon|img|image|avatar|logo|thumbnail|pic/i.test(resId)) {
            return isClickable ? 'Button' : 'Image';
        }
        if (/txt|text|label|title|header|lbl|tv/i.test(resId)) {
            return isClickable ? 'Button' : 'Label';
        }

        if (isClickable) {
            return 'Button';
        }

        if (text && text.trim()) {
            return 'Label';
        }
    }

    const clean = n.replace('XCUIElementType', '').replace('android.widget.', '').replace('android.view.', '').replace(/^androidx\.[a-z0-9_.]+\./i, '') || 'Other';
    if (clean === 'ViewGroup' || clean === 'View') {
        if (node && (node.getAttribute && (node.getAttribute('clickable') === 'true' || node.getAttribute('long-clickable') === 'true'))) {
            return 'Button';
        }
        return 'Other';
    }
    return clean;
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

function getInputControlValue(node, controlName) {
    if (!node) return '';
    const tag = (typeof getUiNodeName === 'function' ? getUiNodeName(node) : node.nodeName) || '';
    const isTextBox =
        tag === 'XCUIElementTypeTextField' ||
        tag === 'XCUIElementTypeSecureTextField' ||
        tag === 'XCUIElementTypeSearchField' ||
        tag === 'XCUIElementTypeTextView' ||
        tag === 'android.widget.EditText' ||
        tag === 'android.widget.AutoCompleteTextView' ||
        tag === 'android.widget.MultiAutoCompleteTextView' ||
        /EditText$|TextInputEditText$|SearchAutoComplete$/i.test(tag) ||
        (node.getAttribute && (node.getAttribute('editable') === 'true' || node.getAttribute('password') === 'true'));

    if (!isTextBox) return '';

    const text = (node.getAttribute('text') || '').trim();
    const hint = (node.getAttribute('hint') || '').trim();
    const value = (node.getAttribute('value') || '').trim();
    const label = (node.getAttribute('label') || '').trim();
    const name = (node.getAttribute('name') || '').trim();
    const contentDesc = (node.getAttribute('content-desc') || '').trim();
    const placeholder = (node.getAttribute('placeholderValue') || '').trim();
    const resId = ((node.getAttribute('resource-id') || '').split('/').pop() || '').trim();

    let val = value || text;

    // Normalize strings to compare and avoid copying Control Name / placeholder / hint into Control Value
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedVal = norm(val);
    const normalizedName = norm(controlName);
    const normalizedHint = norm(hint);
    const normalizedLabel = norm(label);
    const normalizedDesc = norm(contentDesc);
    const normalizedPlaceholder = norm(placeholder);
    const normalizedResId = norm(resId);

    if (
        !val ||
        (normalizedHint && normalizedVal === normalizedHint) ||
        (normalizedLabel && normalizedVal === normalizedLabel) ||
        (normalizedDesc && normalizedVal === normalizedDesc) ||
        (normalizedPlaceholder && normalizedVal === normalizedPlaceholder) ||
        (normalizedResId && normalizedVal === normalizedResId) ||
        (normalizedName && (normalizedVal === normalizedName || normalizedVal.includes(normalizedName) || normalizedName.includes(normalizedVal)))
    ) {
        return '';
    }

    return val;
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
        if (platformVersionInput && !platformVersionInput.dataset.userEdited) {
            if (platformVersionInput.value === '17.2' || platformVersionInput.value === '14') {
                platformVersionInput.value = '';
            }
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
        if (platformVersionInput && !platformVersionInput.dataset.userEdited) {
            if (platformVersionInput.value === '14' || platformVersionInput.value === '17.2') {
                platformVersionInput.value = '';
            }
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
    if (typeof updateDeviceFrameStyle === 'function') {
        updateDeviceFrameStyle(selectedPlatform);
    }
}

function updateConfigDashboard() {
    var isIos = false;
    var pSelect = document.getElementById("platformname");
    if (pSelect && pSelect.value === "IOS") isIos = true;
    if (typeof getSelectedPlatform === 'function' && getSelectedPlatform() === 'IOS') isIos = true;

    var platformText = isIos ? "Apple iOS" : "Android";
    var platformShort = isIos ? "iOS" : "Android";
    var engineText = isIos ? "XCUITest" : "UiAutomator2";
    var osVersion = (document.getElementById("platformversion") && document.getElementById("platformversion").value) || "";
    var udidVal = (document.getElementById("udid") && document.getElementById("udid").value) || "";
    var pkgVal = (document.getElementById("apppackage") && document.getElementById("apppackage").value) || "";
    var actVal = (document.getElementById("appactivity") && document.getElementById("appactivity").value) || "";
    var bndlVal = (document.getElementById("bundleID") && document.getElementById("bundleID").value) || "";

    if (isIos && !bndlVal) {
        try {
            bndlVal = localStorage.getItem('algo_last_selected_app_IOS') || localStorage.getItem('algo_last_selected_app_iOS') || '';
            if (bndlVal && document.getElementById("bundleID") && !document.getElementById("bundleID").value) {
                document.getElementById("bundleID").value = bndlVal;
            }
        } catch (_) {}
    } else if (!isIos && !pkgVal) {
        try {
            pkgVal = localStorage.getItem('algo_last_selected_app_Android') || '';
            if (pkgVal && document.getElementById("apppackage") && !document.getElementById("apppackage").value) {
                document.getElementById("apppackage").value = pkgVal;
            }
        } catch (_) {}
    }

    var mPlatform = document.getElementById("configMetricPlatform");
    if (mPlatform) mPlatform.textContent = platformText;

    var mEngine = document.getElementById("configMetricEngine");
    if (mEngine) mEngine.textContent = engineText;

    var mVersion = document.getElementById("configMetricVersion");
    if (mVersion) {
        mVersion.textContent = osVersion ? (isIos ? ("iOS " + osVersion) : ("Android " + osVersion)) : (platformShort + " (Auto)");
    }

    // --- Active App & Linked Project Resolution ---
    var appSelect = document.getElementById('appname');
    var rawAppName = '';
    if (appSelect && appSelect.options && appSelect.selectedIndex >= 0) {
        var opt = appSelect.options[appSelect.selectedIndex];
        rawAppName = (opt.text || opt.innerText || '').trim();
    }
    if (!rawAppName || rawAppName.toLowerCase() === 'select app' || rawAppName.toLowerCase() === 'loading apps...' || rawAppName.toLowerCase() === 'no device connected') {
        rawAppName = (appSelect ? appSelect.value : '') || '';
    }
    if (rawAppName.toLowerCase() === 'select app' || rawAppName.toLowerCase() === 'loading apps...' || rawAppName.toLowerCase() === 'no device connected') {
        rawAppName = '';
    }
    if (!rawAppName) {
        rawAppName = isIos ? (bndlVal || '') : (pkgVal || '');
    }
    if (!rawAppName) {
        try {
            var platKey = isIos ? 'IOS' : 'Android';
            rawAppName = localStorage.getItem('algo_last_selected_app_name_' + platKey)
                || localStorage.getItem('algo_last_selected_app_name_' + platformShort)
                || '';
        } catch (_) {}
    }
    var currentAppName = (typeof getCleanAppName === 'function' && rawAppName) ? getCleanAppName(rawAppName) : rawAppName;
    if (window.activeResumedAppName && (!currentAppName || currentAppName === 'Select App' || currentAppName === 'No device connected')) {
        currentAppName = window.activeResumedAppName;
    }

    var store = typeof getProjectStore === 'function' ? getProjectStore() : {};

    // Resolve Last Configured Project globally / per platform (persisted, not driven by volatile Home dropdown changes)
    var configuredInfo = (typeof getGlobalLastConfiguredProject === 'function')
        ? getGlobalLastConfiguredProject(platformShort)
        : null;
    var configuredKey = window.activeConfiguredProjectKey || (configuredInfo ? configuredInfo.key : null);
    var linkedProject = configuredKey ? store[configuredKey] : (configuredInfo ? configuredInfo.project : null);

    if (!linkedProject && configuredKey && typeof findProjectKeyInStore === 'function') {
        var foundInfo = findProjectKeyInStore(store, configuredKey);
        if (foundInfo && foundInfo.project) {
            linkedProject = foundInfo.project;
            configuredKey = foundInfo.key;
        }
    }
    if (linkedProject && configuredKey) {
        window.activeConfiguredProjectKey = configuredKey;
    }

    var mProject = document.getElementById("configMetricProject");
    var projNameEl = document.getElementById("configProjectName");
    var projIdBadgeEl = document.getElementById("configProjectIdBadge");
    var projKeyEl = document.getElementById("configProjectKey");
    var projAvatarEl = document.getElementById("configProjectAvatar");
    var projStatsRow = document.getElementById("configProjectStatsRow");
    var statScenEl = document.getElementById("configStatScen");
    var statFeatEl = document.getElementById("configStatFeat");
    var statPageEl = document.getElementById("configStatPage");
    var statUpdatedEl = document.getElementById("configStatUpdated");
    var openRepoBtn = document.getElementById("configOpenRepoBtn");
    var hintEl = document.getElementById("configProjectHint");

    if (linkedProject && configuredKey) {
        var pTitle = (typeof getProjectCardTitle === 'function') ? getProjectCardTitle(linkedProject, configuredKey) : (linkedProject.appName || 'Project');
        var pShortId = (typeof getProjectShortId === 'function') ? getProjectShortId(linkedProject, configuredKey) : (linkedProject.projectId || '');
        var pInitial = String(pTitle || 'P').charAt(0).toUpperCase();
        var pIsIos = String(linkedProject.platform || platformShort).toLowerCase().includes('ios');
        var pScens = (linkedProject.scenarios || []).length;
        var pFeats = (typeof countProjectFeatures === 'function') ? countProjectFeatures(linkedProject) : ((linkedProject.features || []).length);
        var pPages = (linkedProject.pages || []).length;
        var pUpdated = (typeof formatLaunchPickerDate === 'function') ? formatLaunchPickerDate(linkedProject.lastUpdated || linkedProject.createdAt) : 'Recently';

        if (mProject) mProject.textContent = pShortId ? `${pTitle} · ${pShortId}` : pTitle;
        if (projNameEl) projNameEl.textContent = pTitle;
        if (projIdBadgeEl) {
            projIdBadgeEl.textContent = pShortId;
            projIdBadgeEl.style.display = pShortId ? 'inline-block' : 'none';
        }
        if (projKeyEl) projKeyEl.textContent = configuredKey;
        if (projAvatarEl) {
            projAvatarEl.textContent = pInitial;
            projAvatarEl.className = 'config-project-avatar ' + (pIsIos ? 'is-ios' : 'is-android');
        }
        if (projStatsRow) projStatsRow.style.display = 'flex';
        if (statScenEl) statScenEl.textContent = `${pScens}s`;
        if (statFeatEl) statFeatEl.textContent = `${pFeats}f`;
        if (statPageEl) statPageEl.textContent = `${pPages}p`;
        if (statUpdatedEl) statUpdatedEl.textContent = `Updated ${pUpdated}`;
        if (openRepoBtn) openRepoBtn.style.display = 'inline-flex';
        if (hintEl) hintEl.textContent = `Launch Project will link and open "${pTitle}" (${pShortId || 'Saved'})`;

        var launchBtn = document.getElementById("configLaunchProjectBtn");
        if (launchBtn) {
            launchBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Launch Project</span>';
            launchBtn.title = 'Launch Application and open "' + (linkedProject.appName || pTitle) + '"';
        }
    } else {
        if (mProject) mProject.textContent = 'No Linked Project';
        if (projNameEl) projNameEl.textContent = 'No Configured Project';
        if (projIdBadgeEl) projIdBadgeEl.style.display = 'none';
        if (projKeyEl) projKeyEl.textContent = 'Launch or create a project workspace to configure';
        if (projAvatarEl) {
            projAvatarEl.textContent = '—';
            projAvatarEl.className = 'config-project-avatar ' + (isIos ? 'is-ios' : 'is-android');
        }
        if (projStatsRow) projStatsRow.style.display = 'none';
        if (openRepoBtn) openRepoBtn.style.display = 'none';
        if (hintEl) hintEl.textContent = 'Launch Application on the Home tab will create and link a new project workspace';

        var launchBtnNoProj = document.getElementById("configLaunchProjectBtn");
        if (launchBtnNoProj) {
            launchBtnNoProj.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Launch Application</span>';
            launchBtnNoProj.title = 'Launch Application session';
        }
    }

    // --- W3C Capabilities JSON Preview ---
    var jsonPreview = document.getElementById("configJsonPreview");
    if (jsonPreview) {
        var caps;
        if (!udidVal && !pkgVal && !bndlVal && !currentAppName) {
            caps = {
                "status": "No device or application connected",
                "platformName": isIos ? "iOS" : "Android",
                "appium:automationName": engineText,
                "appium:udid": "",
                "appium:platformVersion": osVersion || ""
            };
            if (isIos) {
                caps["appium:bundleId"] = "";
            } else {
                caps["appium:appPackage"] = "";
                caps["appium:appActivity"] = "";
            }
        } else {
            caps = {
                "platformName": isIos ? "iOS" : "Android",
                "appium:automationName": engineText,
                "appium:udid": udidVal,
                "appium:platformVersion": osVersion || ""
            };
            if (isIos) {
                caps["appium:bundleId"] = bndlVal;
            } else {
                caps["appium:appPackage"] = pkgVal;
                caps["appium:appActivity"] = actVal;
            }
        }
        var rawJson = JSON.stringify(caps, null, 2);
        jsonPreview.innerHTML = (typeof formatJsonToHtml === 'function') ? formatJsonToHtml(rawJson) : rawJson;

        var lineCount = rawJson.split('\n').length;
        var gutterEl = document.getElementById('configJsonGutter');
        if (gutterEl) {
            var linesHtml = '';
            for (var i = 1; i <= lineCount; i++) {
                linesHtml += '<span>' + i + '</span>';
            }
            gutterEl.innerHTML = linesHtml;
        }
    }
}
window.updateConfigDashboard = updateConfigDashboard;

// Bind live input listeners to all configuration fields so UI and JSON stay in sync
['udid', 'apppackage', 'appactivity', 'bundleID', 'platformversion', 'automationName', 'appiumurl'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
        el.addEventListener('input', function() {
            if (typeof updateConfigDashboard === 'function') updateConfigDashboard();
        });
        el.addEventListener('change', function() {
            if (typeof updateConfigDashboard === 'function') updateConfigDashboard();
        });
    }
});

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

/* =============================================================================
   PERSISTENT PROJECT-BASED REPOSITORY ENGINE (Organized by App / Project)
   ============================================================================= */
(function initRepositoryEngine() {
    let currentSelectedProjectKey = null; // null = Root Projects list; string = inside project
    let currentRepoFilter = 'all';
    let currentRepoPlatformFilter = 'all'; // 'all' | 'iOS' | 'Android'
    let repoSelectedProjectKeys = new Set();
    let repoMultiDeleteMode = false;
    let repoSearchQuery = '';
    let repoProjectSearchQuery = '';
    let activeDrawerData = null; // Currently opened page / scenario in drawer

    function setProjectStore(store) {
        try {
            localStorage.setItem(REPO_STORAGE_KEY, JSON.stringify(store));
        } catch (e) {
            console.error('Error saving repo projects store:', e);
        }
    }
    window.setRepoProjectsStore = setProjectStore;

    function beginRepoWrite() {
        if (!window._activeRepoWriteDepth) window._activeRepoWriteDepth = 0;
        if (window._activeRepoWriteDepth === 0) {
            window._activeRepoWriteStore = null;
            window._activeRepoWriteStore = getProjectStore();
        }
        window._activeRepoWriteDepth += 1;
        return window._activeRepoWriteStore;
    }

    function endRepoWrite(persist) {
        window._activeRepoWriteDepth = Math.max(0, (window._activeRepoWriteDepth || 1) - 1);
        if (window._activeRepoWriteDepth === 0) {
            const store = window._activeRepoWriteStore;
            window._activeRepoWriteStore = null;
            if (persist !== false && store) setProjectStore(store);
        }
    }

    function getOrCreateProject(store, key, fallbackAppName, fallbackPlatform) {
        const preferredKey = window.activeResumedProjectKey || key;
        const found = (typeof findProjectKeyInStore === 'function')
            ? findProjectKeyInStore(store, preferredKey)
            : { key: preferredKey, project: store[preferredKey] };
        if (found && found.project) {
            if (found.key && (window.activeProjectSessionMode === 'new' || window.activeProjectSessionMode === 'resumed')) {
                window.activeResumedProjectKey = found.key;
            }
            if (!found.project.projectId) {
                found.project.projectId = (found.key && String(found.key).includes('::'))
                    ? String(found.key).split('::').pop()
                    : createProjectId(store, found.project.appName, found.project.platform);
            }
            return found.project;
        }

        const targetKey = preferredKey;
        const platform = fallbackPlatform || (typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : (document.getElementById('platformname')?.value || 'Android'));
        const appName = window.activeResumedAppName || fallbackAppName || resolveActiveAppName();

        store[targetKey] = {
            projectId: (String(targetKey).includes('::') ? String(targetKey).split('::').pop() : createProjectId(store, appName, platform)),
            appName: appName,
            platform: platform,
            createdAt: Date.now(),
            lastUpdated: Date.now(),
            scenarios: [],
            features: [],
            pages: []
        };
        if (window.activeProjectSessionMode === 'new' || window.activeProjectSessionMode === 'resumed') {
            window.activeResumedProjectKey = targetKey;
        }
        return store[targetKey];
    }

    window.saveScenarioToRepo = function(pageName, scenarioName, scenarioOutline, platform, appName, elements) {
        if (!scenarioName && !scenarioOutline) return;
        const currentPlatform = platform || (typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : (document.getElementById('platformname')?.value || 'Android'));
        const currentApp = window.activeResumedAppName || appName || resolveActiveAppName();
        const projectKey = window.activeResumedProjectKey || `${currentApp} (${currentPlatform})`;

        const store = beginRepoWrite();
        try {
        const project = getOrCreateProject(store, projectKey, currentApp, currentPlatform);

        const pName = pageName || '';
        const sName = scenarioName || (pName ? `${pName} Scenario` : 'Scenario');

        // Upsert / deduplicate by scenario name / pageName
        const existingIdx = (project.scenarios || []).findIndex(s =>
            (s.name && s.name.toLowerCase() === sName.toLowerCase()) ||
            (pName && s.pageName && s.pageName.toLowerCase() === pName.toLowerCase())
        );

        const extractFn = (typeof window.extractAllTableData === 'function') ? window.extractAllTableData : null;
        const tableRows = extractFn ? (extractFn('myTable') || []) : [];
        const pageKey = (pName || '').trim().toLowerCase();
        const pageRows = pageKey
            ? tableRows.filter(r => (r['PAGE NAME'] || '').trim().toLowerCase() === pageKey)
            : tableRows;
        const liveRows = pageRows.length > 0 ? pageRows : tableRows;

        const existingEls = (existingIdx >= 0 && Array.isArray(project.scenarios[existingIdx].elements))
            ? project.scenarios[existingIdx].elements
            : [];
        let scenElements;
        if (Array.isArray(elements) && elements.length > 0) {
            scenElements = elements;
        } else if (liveRows.length > 0) {
            scenElements = liveRows;
        } else if (existingEls.length > 0 && tableRows.length > 0) {
            scenElements = existingEls;
        } else if (Array.isArray(elements) && elements.length === 0 && tableRows.length === 0) {
            scenElements = [];
        } else {
            scenElements = existingEls;
        }

        const item = {
            id: existingIdx >= 0 ? project.scenarios[existingIdx].id : ('scen_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
            name: sName,
            pageName: pName,
            outline: scenarioOutline || '',
            elements: scenElements,
            platform: currentPlatform,
            appName: currentApp,
            timestamp: Date.now(),
            features: mergeFeatureItems(
                (existingIdx >= 0 && project.scenarios[existingIdx].features) || [],
                collectLiveFeatureItemsForPage(pName)
            )
        };

        if (existingIdx >= 0) {
            project.scenarios[existingIdx] = item;
        } else {
            project.scenarios.unshift(item);
        }

        // Scenario page belongs ONLY to scenario, NOT to standalone pages
        if (pName && Array.isArray(project.pages)) {
            project.pages = project.pages.filter(pg => (pg.pageName || '').trim().toLowerCase() !== pName.trim().toLowerCase());
        }
        if (typeof pruneProjectAssetOwnership === 'function') pruneProjectAssetOwnership(project);

        project.lastUpdated = Date.now();
        } finally {
            endRepoWrite(true);
        }
    };

    window.saveFeatureToRepo = function(featureName, rect, fullPage, platform, appName, featurePageName, screenSignature, screenContentKeys, nodeText, nodeFingerprint, uniqueIdentifier, xpaths, featureId) {
        if (!featureName) return;
        const currentPlatform = platform || (typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : (document.getElementById('platformname')?.value || 'Android'));
        const currentApp = window.activeResumedAppName || appName || resolveActiveAppName();
        const projectKey = window.activeResumedProjectKey || `${currentApp} (${currentPlatform})`;

        const store = beginRepoWrite();
        try {
        const project = getOrCreateProject(store, projectKey, currentApp, currentPlatform);
        const currentPage = featurePageName || ((typeof window.resolveHomePageNameForScrape === 'function')
            ? window.resolveHomePageNameForScrape()
            : ((typeof getActiveHomePageName === 'function') ? getActiveHomePageName() : ''));

        if (!Array.isArray(project.features)) project.features = [];

        // Upsert: same created feature must not multiply on every Home→Repo sync
        let existingFeatIdx = -1;
        if (featureId) {
            existingFeatIdx = project.features.findIndex(f => f && f.id === featureId);
        }
        if (existingFeatIdx < 0) {
            const targetKey = featureIdentityKey(featureName, currentPage, uniqueIdentifier, null, screenSignature);
            existingFeatIdx = project.features.findIndex(f =>
                f && f.name && featureIdentityKey(f.name, f.pageName || currentPage, f.uniqueIdentifier, null, f.screenSignature) === targetKey
            );
        }

        const resolvedId = featureId
            || (existingFeatIdx >= 0 && project.features[existingFeatIdx].id)
            || ('feat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6));

        const featureItem = {
            id: resolvedId,
            name: featureName.trim(),
            rect: rect || (existingFeatIdx >= 0 ? project.features[existingFeatIdx].rect : null),
            fullPage: !!fullPage,
            pageName: currentPage,
            uniqueIdentifier: uniqueIdentifier || (existingFeatIdx >= 0 ? project.features[existingFeatIdx].uniqueIdentifier : ""),
            xpaths: (Array.isArray(xpaths) && xpaths.length) ? xpaths : (existingFeatIdx >= 0 ? project.features[existingFeatIdx].xpaths : []),
            screenSignature: screenSignature || (existingFeatIdx >= 0 ? project.features[existingFeatIdx].screenSignature : ""),
            screenContentKeys: (Array.isArray(screenContentKeys) && screenContentKeys.length) ? screenContentKeys : (existingFeatIdx >= 0 ? project.features[existingFeatIdx].screenContentKeys : []),
            nodeText: nodeText || (existingFeatIdx >= 0 ? project.features[existingFeatIdx].nodeText : ""),
            nodeFingerprint: nodeFingerprint || (existingFeatIdx >= 0 ? project.features[existingFeatIdx].nodeFingerprint : ""),
            timestamp: existingFeatIdx >= 0 ? (project.features[existingFeatIdx].timestamp || Date.now()) : Date.now()
        };

        let owner = (typeof findFeatureOwnerInProject === 'function') ? findFeatureOwnerInProject(project, currentPage) : null;
        if (!owner && typeof seedInitialProjectPage === 'function' && !(project.pages || []).length) {
            seedInitialProjectPage(project, currentApp, currentPlatform);
        }
        if (!owner && (project.pages || []).length) {
            owner = project.pages.find(pg => repoNameKey(pg.pageName) === repoNameKey(currentPage)) || null;
        }
        if (!owner && (project.scenarios || []).length) {
            owner = project.scenarios.find(sc => repoNameKey(sc.pageName) === repoNameKey(currentPage) || repoNameKey(sc.name) === repoNameKey(currentPage)) || null;
        }
        if (!owner && currentPage && repoNameKey(currentPage) && repoNameKey(currentPage) !== 'all') {
            if (!Array.isArray(project.pages)) project.pages = [];
            owner = {
                pageName: String(currentPage).trim(),
                elements: [],
                features: [],
                timestamp: Date.now()
            };
            project.pages.push(owner);
        }
        if (owner) nestFeatureOnOwner(owner, featureItem);

        const featObj = {
            ...featureItem,
            pageName: currentPage || 'Default',
            platform: currentPlatform
        };
        if (existingFeatIdx >= 0) {
            project.features[existingFeatIdx] = { ...project.features[existingFeatIdx], ...featObj };
        } else {
            project.features.unshift(featObj);
        }

        if (typeof dedupeProjectFeatureLists === 'function') dedupeProjectFeatureLists(project);
        project.lastUpdated = Date.now();
        } finally {
            endRepoWrite(true);
        }
    };

    window.renameFeatureInRepo = function(oldName, newName, pageName, screenSignature) {
        const oldLower = String(oldName || '').trim().toLowerCase();
        const trimmed = String(newName || '').trim();
        if (!oldLower || !trimmed) return;
        const currentSig = screenSignature || ((typeof computeScreenSignature === 'function') ? computeScreenSignature(window.xmlDoc) : '');

        const store = beginRepoWrite();
        try {
            const projectKey = window.activeResumedProjectKey;
            const project = projectKey ? store[projectKey] : null;
            if (!project) return;

            const matchesScreen = (f) => {
                if (!currentSig) return true;
                if (!f || !f.screenSignature) return true;
                return (typeof screenSignatureSimilarity === 'function')
                    ? screenSignatureSimilarity(f.screenSignature, currentSig) >= 0.68
                    : f.screenSignature === currentSig;
            };

            const renameInList = (list) => {
                if (!Array.isArray(list)) return;
                list.forEach(f => {
                    if (!f || !f.name) return;
                    if (String(f.name).trim().toLowerCase() !== oldLower) return;
                    if (!matchesScreen(f)) return;
                    f.name = trimmed;
                });
            };

            renameInList(project.features);
            (project.pages || []).forEach(pg => {
                renameInList(pg.features);
                (pg.elements || []).forEach(el => {
                    const cur = (el['FEATURE NAME'] || el.FeatureName || '').trim().toLowerCase();
                    if (cur !== oldLower) return;
                    // elements rarely store screenSignature — only rename when feature list on same screen was updated
                    // skip bulk element rename across screens; table rename already handled live rows
                });
            });
            (project.scenarios || []).forEach(sc => {
                renameInList(sc.features);
            });
            // Also rename nested feature refs on elements that belong to matching screen features only via live table.
            project.lastUpdated = Date.now();
        } finally {
            endRepoWrite(true);
        }
    };

    window.removeFeatureCompletely = function(featureName, projectKey, pageName) {
        if (!featureName) return;
        const cleanFeatName = featureName.trim().toLowerCase();
        const targetProjectKey = projectKey || window.activeResumedProjectKey;
        const pageKey = (typeof repoNameKey === 'function') ? repoNameKey(pageName || '') : String(pageName || '').trim().toLowerCase();
        const matchesPage = (p) => {
            if (!pageKey) return true;
            const key = (typeof repoNameKey === 'function') ? repoNameKey(p || '') : String(p || '').trim().toLowerCase();
            return key === pageKey;
        };

        // 1. Remove from registeredFeatureAreas in memory (page-scoped when pageName given)
        if (typeof registeredFeatureAreas !== 'undefined' && Array.isArray(registeredFeatureAreas)) {
            registeredFeatureAreas = registeredFeatureAreas.filter(a => {
                if (!a || !a.name || a.name.trim().toLowerCase() !== cleanFeatName) return true;
                if (pageKey && !matchesPage(a.pageName)) return true;
                return false;
            });
            window.registeredFeatureAreas = registeredFeatureAreas;
        }

        // 2. Remove canvas highlights and labels for this feature
        const overlay = document.getElementById("overlayContainer");
        if (overlay) {
            overlay.querySelectorAll('.feature-area-label').forEach(el => {
                if (el.textContent.trim().toLowerCase() === cleanFeatName) {
                    const prev = el.previousElementSibling;
                    if (prev && prev.classList.contains('feature-area-highlight')) {
                        prev.remove();
                    }
                    el.remove();
                }
            });
            overlay.querySelectorAll('.feature-area-highlight').forEach(el => {
                if (el.dataset && el.dataset.featureName && el.dataset.featureName.toLowerCase() === cleanFeatName) {
                    el.remove();
                }
            });
        }

        // 3. In live #myTable: update cells having this feature name (on this page only when scoped)
        const tableRows = document.querySelectorAll("#myTable tr:not(.empty-excel-row)");
        tableRows.forEach(tr => {
            const featCell = tr.querySelector('.featureName');
            const pageCell = tr.querySelector('.page');
            const rowPageName = (pageCell ? pageCell.innerText.trim() : '') || document.getElementById('pagename_searchbox')?.value || 'Default';
            if (pageKey && !matchesPage(rowPageName)) return;
            if (featCell && featCell.innerText.trim().toLowerCase() === cleanFeatName) {
                featCell.innerText = rowPageName;
            }
        });

        // 4. In Repository Store: remove from features array and update all page elements
        const store = (typeof getProjectStore === 'function') ? getProjectStore() : ((typeof window.getRepoProjectsStore === 'function') ? window.getRepoProjectsStore() : {});
        const pKeys = targetProjectKey && store[targetProjectKey] ? [targetProjectKey] : Object.keys(store);

        pKeys.forEach(k => {
            const proj = store[k];
            if (proj) {
                // Remove from proj.features
                if (Array.isArray(proj.features)) {
                    proj.features = proj.features.filter(f => {
                        if (!f || !f.name || f.name.trim().toLowerCase() !== cleanFeatName) return true;
                        if (pageKey && !matchesPage(f.pageName)) return true;
                        return false;
                    });
                }
                const stripOwnerFeatures = (owner, ownerPage) => {
                    if (!owner || !Array.isArray(owner.features)) return;
                    owner.features = owner.features.filter(f => {
                        if (!f || !((f.name || f) + '').trim() || ((f.name || f) + '').trim().toLowerCase() !== cleanFeatName) return true;
                        if (pageKey && !matchesPage(f.pageName || ownerPage)) return true;
                        return false;
                    });
                };
                (proj.scenarios || []).forEach(s => {
                    stripOwnerFeatures(s, s.pageName || s.name);
                    if (Array.isArray(s.elements)) {
                        s.elements.forEach(el => {
                            const curFeat = (el['FEATURE NAME'] || el.FeatureName || '').trim().toLowerCase();
                            const pName = el['PAGE NAME'] || s.pageName || 'Default';
                            if (curFeat === cleanFeatName && matchesPage(pName)) {
                                el['FEATURE NAME'] = pName;
                                el.FeatureName = pName;
                            }
                        });
                    }
                });
                // Update elements in proj.pages: replace FEATURE NAME with PAGE NAME
                if (Array.isArray(proj.pages)) {
                    proj.pages.forEach(pg => {
                        stripOwnerFeatures(pg, pg.pageName);
                        const fallbackPage = pg.pageName || 'Default';
                        if (Array.isArray(pg.elements)) {
                            pg.elements.forEach(el => {
                                const curFeat = (el['FEATURE NAME'] || el.FeatureName || '').trim().toLowerCase();
                                const pName = el['PAGE NAME'] || fallbackPage;
                                if (curFeat === cleanFeatName && matchesPage(pName)) {
                                    el['FEATURE NAME'] = pName;
                                    el.FeatureName = pName;
                                }
                            });
                        }
                    });
                }
                proj.lastUpdated = Date.now();
            }
        });

        if (typeof setProjectStore === 'function') setProjectStore(store);
        if (typeof window.setRepoProjectsStore === 'function') window.setRepoProjectsStore(store);

        // 5. Close side view inspector if it is showing this deleted feature
        if (typeof currentViewerPayload !== 'undefined' && currentViewerPayload && currentViewerPayload.data) {
            const openName = (currentViewerPayload.data.name || '').trim().toLowerCase();
            if (openName === cleanFeatName) {
                if (typeof closeRepoSideView === 'function') {
                    closeRepoSideView();
                }
            }
        }

        // 6. Re-render repository view if open
        if (typeof window.renderRepositoryView === 'function') {
            window.renderRepositoryView();
        }
    };

    window.saveScrapedPageToRepo = function(pageName, elements, platform, appName) {
        if (!pageName || typeof pageName !== 'string' || pageName.trim() === '' || pageName.trim().toLowerCase() === 'all') return;
        const currentPlatform = platform || (typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : (document.getElementById('platformname')?.value || 'Android'));
        const currentApp = window.activeResumedAppName || appName || resolveActiveAppName();
        const projectKey = window.activeResumedProjectKey || `${currentApp} (${currentPlatform})`;

        const store = beginRepoWrite();
        try {
        const project = getOrCreateProject(store, projectKey, currentApp, currentPlatform);

        const pName = pageName.trim();
        const existingIdx = (project.pages || []).findIndex(p => p.pageName && p.pageName.trim().toLowerCase() === pName.toLowerCase());
        const cleanElements = Array.isArray(elements) ? JSON.parse(JSON.stringify(elements)) : [];

        // Empty extract (e.g. all rows deleted from table)
        if (!cleanElements.length) {
            if (existingIdx >= 0) {
                const existing = project.pages[existingIdx];
                existing.elements = [];
                existing.count = 0;
                project.lastUpdated = Date.now();
            }
            return;
        }

        const item = {
            id: existingIdx >= 0 ? project.pages[existingIdx].id : ('page_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
            pageName: pName,
            appName: currentApp,
            count: cleanElements.length,
            elements: cleanElements,
            platform: currentPlatform,
            isInitialPage: existingIdx >= 0 ? !!project.pages[existingIdx].isInitialPage : false,
            timestamp: Date.now(),
            features: mergeFeatureItems(
                (existingIdx >= 0 && project.pages[existingIdx].features) || [],
                collectLiveFeatureItemsForPage(pName)
            )
        };

        if (existingIdx >= 0) {
            project.pages[existingIdx] = item;
        } else {
            project.pages.unshift(item);
        }
        project.lastUpdated = Date.now();
        } finally {
            endRepoWrite(true);
        }
    };

    window.selectActiveRepoProject = function() {
        // All Projects stays the default. A project is only Active after Launch.
    };

    window.closeRepoWorkspaceToList = function() {
        currentSelectedProjectKey = null;
        document.getElementById('tab-repository')?.classList.remove('is-workspace-open');
    };

    window.syncActiveProjectToRepo = function() {
        if (window._restoringProject || window._applyingRepoToHome || window._resettingHome) return;
        if (!window.activeResumedProjectKey || (window.activeProjectSessionMode !== 'new' && window.activeProjectSessionMode !== 'resumed')) {
            return;
        }
        if (window._syncingHomeToRepo) {
            window._homeRepoSyncQueued = true;
            return;
        }
        window._syncingHomeToRepo = true;
        const store = beginRepoWrite();
        try {
            const platform = typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : (document.getElementById('platformname')?.value || 'Android');
            const appName = window.activeResumedAppName || resolveActiveAppName();
            const projectKey = window.activeResumedProjectKey || `${appName} (${platform})`;

            const project = getOrCreateProject(store, projectKey, appName, platform);

            const scenarioPageSet = new Set();
            const extractFn = (typeof window.extractAllTableData === 'function') ? window.extractAllTableData : null;
            const allElements = extractFn ? (extractFn('myTable') || []) : [];

            // 1. Sync Scenarios from the live Home table
            if (window.pageScenarioData) {
                Object.keys(window.pageScenarioData).forEach(pName => {
                    const sData = window.pageScenarioData[pName];
                    if (sData && (sData.scenarioName || sData.scenarioOutline)) {
                        scenarioPageSet.add(pName.trim().toLowerCase());
                        const pageEls = allElements.filter(r => (r['PAGE NAME'] || '').trim().toLowerCase() === pName.trim().toLowerCase());
                        if (pageEls.length > 0) {
                            window.saveScenarioToRepo(pName, sData.scenarioName, sData.scenarioOutline, platform, appName, pageEls);
                        } else if (allElements.length === 0) {
                            window.saveScenarioToRepo(pName, sData.scenarioName, sData.scenarioOutline, platform, appName, []);
                        } else {
                            window.saveScenarioToRepo(pName, sData.scenarioName, sData.scenarioOutline, platform, appName);
                        }
                    }
                });
            }

            // 2. Sync Features (only if features exist)
            const liveFeatures = (typeof window.registeredFeatureAreas !== 'undefined' && Array.isArray(window.registeredFeatureAreas))
                ? window.registeredFeatureAreas
                : [];
            if (Array.isArray(liveFeatures)) {
                liveFeatures.forEach(area => {
                    if (area && area.name) {
                        window.saveFeatureToRepo(
                            area.name,
                            area.rect,
                            area.fullPage,
                            platform,
                            appName,
                            area.pageName,
                            area.screenSignature,
                            area.screenContentKeys,
                            area.nodeText,
                            area.nodeFingerprint,
                            area.uniqueIdentifier,
                            area.xpaths,
                            area.id
                        );
                    }
                });
            }

            // 3. Sync Standalone Pages & Scraped Elements
            const pageGroups = {};

            if (allElements.length > 0) {
                allElements.forEach(el => {
                    const p = (el['PAGE NAME'] || document.getElementById('pagename_searchbox')?.value || '').trim();
                    if (p && p.toLowerCase() !== 'all') {
                        if (!pageGroups[p]) pageGroups[p] = [];
                        pageGroups[p].push(el);
                    }
                });
            }

            // Always track active page even if 0 elements remain in myTable after deletion
            const activePage = (typeof window.resolveHomePageNameForScrape === 'function')
                ? window.resolveHomePageNameForScrape()
                : (document.getElementById('pagename_searchbox')?.value || '').trim();
            if (activePage && activePage.toLowerCase() !== 'all' && allElements.length === 0) {
                if (!pageGroups[activePage]) {
                    pageGroups[activePage] = [];
                }
            }

            Object.keys(pageGroups).forEach(p => {
                const key = p.trim().toLowerCase();
                if (scenarioPageSet.has(key)) return;
                window.saveScrapedPageToRepo(p, pageGroups[p], platform, appName);
            });

            if (typeof pruneProjectAssetOwnership === 'function') pruneProjectAssetOwnership(project);

            project.lastUpdated = Date.now();
            project.lastActivePageName = (document.getElementById('pagename_searchbox')?.value || '').trim() || project.lastActivePageName || '';

            try {
                window._resumedProjectSnapshot = JSON.parse(JSON.stringify(project));
            } catch (_) {
                window._resumedProjectSnapshot = project;
            }

            const repoTab = document.getElementById('tab-repository');
            const repoIsOpen = repoTab && repoTab.classList.contains('is-active');
            if (repoIsOpen && typeof window.renderRepositoryView === 'function') {
                window.renderRepositoryView();
            }
        } catch (e) {
            console.error('Error in syncActiveProjectToRepo:', e);
        } finally {
            endRepoWrite(true);
            window._syncingHomeToRepo = false;
            if (window._homeRepoSyncQueued) {
                window._homeRepoSyncQueued = false;
                window.syncActiveProjectToRepo();
            }
        }
    };
    window.archiveCurrentActiveSession = window.syncActiveProjectToRepo;

    function formatDate(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function downloadFile(filename, content, type = 'application/json') {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function guessAppNameFromImport(data, fileName) {
        const fromFile = String(fileName || '')
            .replace(/\.json$/i, '')
            .replace(/_\d{4}.*$/, '')
            .replace(/_project_suite$/i, '')
            .replace(/algoscraper_full_repository_export_\d+/i, '')
            .trim();
        if (fromFile && !/^imported/i.test(fromFile) && fromFile.length >= 2) {
            return fromFile.split(/[_\-]/)[0] || fromFile;
        }
        if (data && data.appName) return String(data.appName).trim();
        if (data && data.project && data.project.appName) return String(data.project.appName).trim();
        const rows = Array.isArray(data && data.dashboardControls)
            ? data.dashboardControls
            : (data && data.dashboardControls && Array.isArray(data.dashboardControls.SCENARIOS)
                ? (data.dashboardControls.SCENARIOS[0] && data.dashboardControls.SCENARIOS[0].STEPS) || []
                : (Array.isArray(data) ? data : []));
        const pageHit = (rows || []).find(r => r && (r['PAGE NAME'] || r.pageName));
        if (pageHit) return String(pageHit['PAGE NAME'] || pageHit.pageName).trim();
        return (typeof resolveActiveAppName === 'function' ? resolveActiveAppName() : '') || 'Imported App';
    }

    function buildProjectFromScrapedExport(data, meta) {
        const platform = (meta && meta.platform)
            || (typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : '')
            || (document.getElementById('platformname')?.value || 'Android');
        const appName = getCleanAppName((meta && meta.appName) || guessAppNameFromImport(data, meta && meta.fileName)) || 'Imported App';
        const pagesMap = {};
        const featuresMap = new Map();
        const scenarios = [];

        const ensurePage = (pageName) => {
            const pName = String(pageName || appName || 'DefaultPage').trim() || appName;
            if (!pagesMap[pName]) {
                pagesMap[pName] = {
                    id: 'page_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                    pageName: pName,
                    appName,
                    count: 0,
                    elements: [],
                    features: [],
                    platform,
                    timestamp: Date.now()
                };
            }
            return pagesMap[pName];
        };

        const ingestElement = (el) => {
            if (!el || typeof el !== 'object') return;
            const pageName = String(el['PAGE NAME'] || el.pageName || appName || 'DefaultPage').trim() || appName;
            const page = ensurePage(pageName);
            page.elements.push(el);
            page.count = page.elements.length;

            const featName = String(el['FEATURE NAME'] || el.FeatureName || '').trim();
            if (!featName) return;
            if (featName.toLowerCase() === 'all') return;
            if (featName.toLowerCase() === pageName.toLowerCase()) return;
            const fKey = featName.toLowerCase() + '::' + pageName.toLowerCase();
            if (featuresMap.has(fKey)) return;
            const featureItem = {
                id: 'feat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                name: featName,
                pageName,
                timestamp: Date.now(),
                rect: el.rect || null
            };
            featuresMap.set(fKey, featureItem);
            page.features.push(featureItem);
        };

        if (data && data.isRecordscenario && data.dashboardControls && Array.isArray(data.dashboardControls.SCENARIOS)) {
            data.dashboardControls.SCENARIOS.forEach((sc, idx) => {
                const steps = Array.isArray(sc.STEPS) ? sc.STEPS : [];
                const pageName = (steps[0] && (steps[0]['PAGE NAME'] || steps[0].pageName)) || appName;
                const scenario = {
                    id: 'scen_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).substr(2, 5),
                    name: String(sc.SCENARIO_NAME || sc.name || 'Scenario').trim() || 'Scenario',
                    outline: String(sc.SCENARIO_OUTLINE || sc.outline || ''),
                    pageName,
                    elements: steps.slice(),
                    features: [],
                    platform,
                    appName,
                    timestamp: Date.now()
                };
                steps.forEach(ingestElement);
                const page = pagesMap[pageName];
                if (page && Array.isArray(page.features)) {
                    scenario.features = page.features.map(f => ({ ...f }));
                }
                scenarios.push(scenario);
            });
        } else if (data && Array.isArray(data.dashboardControls)) {
            data.dashboardControls.forEach(ingestElement);
        } else if (Array.isArray(data)) {
            data.forEach(ingestElement);
        } else if (data && Array.isArray(data.elements)) {
            data.elements.forEach(ingestElement);
        } else {
            return null;
        }

        const pages = Object.values(pagesMap);
        if (!pages.length && !scenarios.length) {
            pages.push({
                id: 'page_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                pageName: appName,
                appName,
                count: 0,
                elements: [],
                features: [],
                platform,
                isInitialPage: true,
                timestamp: Date.now()
            });
        }

        return {
            appName,
            platform,
            createdAt: Date.now(),
            lastUpdated: Date.now(),
            lastActivePageName: (pages[0] && pages[0].pageName) || appName,
            scenarios,
            features: Array.from(featuresMap.values()),
            pages
        };
    }

    function importProjectsFromJsonData(data, options) {
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid JSON file.');
        }

        const fileName = (options && options.fileName) || '';
        const platformHint = (typeof getSelectedPlatform === 'function' ? getSelectedPlatform() : '')
            || (document.getElementById('platformname')?.value || 'Android');
        let incoming = {};
        let forceNewKeys = new Set();

        if (data.exportType === 'AlgoScraper_Full_Repository' && data.projects && typeof data.projects === 'object') {
            incoming = data.projects;
        } else if (data.exportType === 'AlgoScraper_Project_Suite' && data.project) {
            const key = data.projectKey
                || `${data.appName || data.project.appName || 'Imported'} (${data.platform || data.project.platform || platformHint})`;
            incoming[key] = data.project;
        } else if (
            data.isRecordscenario === true
            || data.isRecordscenario === false
            || Array.isArray(data.dashboardControls)
            || (data.dashboardControls && Array.isArray(data.dashboardControls.SCENARIOS))
            || Array.isArray(data)
            || Array.isArray(data.elements)
        ) {
            const built = buildProjectFromScrapedExport(data, {
                fileName,
                appName: guessAppNameFromImport(data, fileName),
                platform: platformHint
            });
            if (!built) {
                throw new Error('Could not read scraped controls from this JSON file.');
            }
            incoming.__algo_scraped_import__ = built;
            forceNewKeys.add('__algo_scraped_import__');
        } else {
            const keys = Object.keys(data);
            const looksLikeStore = keys.some(k => {
                const p = data[k];
                return p && typeof p === 'object' && (p.appName || p.pages || p.scenarios || p.features || p.platform);
            });
            if (!looksLikeStore) {
                throw new Error('This file is not a valid AlgoScraper JSON. Use a project export or Home download JSON.');
            }
            incoming = data;
        }

        const incomingKeys = Object.keys(incoming);
        if (!incomingKeys.length) {
            throw new Error('No projects found in this file.');
        }

        const store = beginRepoWrite();
        let added = 0;
        let updated = 0;
        let skipped = 0;
        try {
            incomingKeys.forEach(rawKey => {
                let proj = incoming[rawKey];
                if (!proj || typeof proj !== 'object') return;

                let targetKey = rawKey;
                const shouldForceNew = forceNewKeys.has(rawKey) || rawKey === '__algo_scraped_import__';
                if (shouldForceNew) {
                    const uniqueInfo = (typeof generateUniqueProjectKey === 'function')
                        ? generateUniqueProjectKey(store, proj.appName || guessAppNameFromImport(proj, fileName), proj.platform || platformHint, { forceNew: true })
                        : { key: `${proj.appName || 'Imported'} (${proj.platform || platformHint})::p_${Date.now().toString(36)}`, projectId: 'p_' + Date.now().toString(36), appName: proj.appName };
                    targetKey = uniqueInfo.key;
                    proj = {
                        ...proj,
                        projectId: uniqueInfo.projectId || proj.projectId || null,
                        appName: uniqueInfo.appName || proj.appName,
                        platform: proj.platform || platformHint,
                        createdAt: proj.createdAt || Date.now(),
                        lastUpdated: Date.now()
                    };
                    if (!Array.isArray(proj.pages)) proj.pages = [];
                    if (!Array.isArray(proj.scenarios)) proj.scenarios = [];
                    if (!Array.isArray(proj.features)) proj.features = [];
                } else if (!proj.projectId) {
                    proj.projectId = (String(targetKey).includes('::') ? String(targetKey).split('::').pop() : null)
                        || ((typeof createProjectId === 'function') ? createProjectId(store, proj.appName, proj.platform || platformHint) : ('p_' + Date.now().toString(36)));
                }

                if (typeof isProtectedLiveProject === 'function' && isProtectedLiveProject(targetKey)) {
                    skipped++;
                    return;
                }
                if (store[targetKey]) updated++;
                else added++;
                store[targetKey] = proj;
            });
        } finally {
            endRepoWrite(true);
        }

        if (typeof window.renderRepositoryView === 'function') {
            window.renderRepositoryView();
        }

        return { added, updated, skipped, total: incomingKeys.length };
    }
    window.importProjectsFromJsonData = importProjectsFromJsonData;
    window.buildProjectFromScrapedExport = buildProjectFromScrapedExport;

    // --- SIDE-BY-SIDE REPOSITORY WORKSPACE JSON ENGINE ---
    let activeViewerItem = null;
    let currentViewerPayload = null;

    function getProjectByKey(store, key) {
        if (!store || !key) return null;
        if (store[key]) return store[key];
        const targetLower = String(key).trim().toLowerCase();
        const foundKey = Object.keys(store).find(k => k.trim().toLowerCase() === targetLower);
        if (foundKey) return store[foundKey];
        const idPart = String(key).includes('::') ? String(key).split('::').pop() : '';
        if (idPart) {
            const byId = Object.keys(store).find(k =>
                (store[k] && store[k].projectId === idPart) || k.endsWith('::' + idPart)
            );
            if (byId) return store[byId];
        }
        return null;
    }

    function getItemJsonPayload(item, projectKey) {
        if (!item) return null;
        const store = getProjectStore();
        const project = getProjectByKey(store, projectKey) || {};
        const platform = item.platform || project.platform || 'Android';

        if (item.type === 'page') {
            let rawElList = Array.isArray(item.elements) && item.elements.length > 0 ? item.elements : [];
            const pageName = item.pageName || 'page';

            if (rawElList.length === 0 && Array.isArray(project.pages)) {
                const matched = project.pages.find(p => p.id === item.id || (p.pageName && repoNameKey(p.pageName) === repoNameKey(pageName)));
                if (matched && Array.isArray(matched.elements) && matched.elements.length > 0) {
                    rawElList = matched.elements;
                }
            }
            if (rawElList.length === 0 && typeof window.extractAllTableData === 'function') {
                const tableRows = window.extractAllTableData('myTable') || [];
                const matchingRows = tableRows.filter(r => repoNameKey(r['PAGE NAME']) === repoNameKey(pageName));
                if (matchingRows.length > 0) {
                    rawElList = matchingRows;
                }
            }

            const cleanElList = rawElList.map(el => {
                const loc = el['XPATH'] || el.ControlId || '';
                const inferredIdType = (typeof inferIdentificationType === 'function')
                    ? inferIdentificationType(loc)
                    : ((loc.startsWith('//') || loc.startsWith('(')) ? 'XPath' : (loc ? 'AccessibilityId' : 'Name'));
                return {
                    "CONTROL NAME": el['CONTROL NAME'] || el.ControlName || '',
                    "CONTROL TYPE": el['CONTROL TYPE'] || el.ControlType || '',
                    "XPATH": loc,
                    "PAGE NAME": el['PAGE NAME'] || el.PageName || pageName,
                    "IDENTIFICATION TYPE": el['IDENTIFICATION TYPE'] || el.IdentificationType || inferredIdType,
                    "CONTROL VALUE": el['CONTROL VALUE'] || el.ControlValue || '',
                    "FEATURE NAME": el['FEATURE NAME'] || el.FeatureName || pageName,
                    "NODE NAME": el['NODE NAME'] || el.NodeName || pageName,
                    "FINGERPRINT": el['FINGERPRINT'] || el.Fingerprint || '',
                    "APP URL": ""
                };
            });

            const downloadPayload = {
                "isRecordscenario": false,
                "dashboardControls": cleanElList
            };

            return {
                filename: `${pageName.replace(/\s+/g, '_')}_scraped_elements.json`,
                badge: 'SCRAPED PAGE JSON',
                badgeClass: 'repo-badge-page',
                title: `${pageName.replace(/\s+/g, '_')}_scraped_elements.json`,
                subtitle: `${cleanElList.length} UI ${cleanElList.length === 1 ? 'control' : 'controls'} • ${item.appName || project.appName || 'Application'} (${platform})`,
                data: downloadPayload
            };
        } else if (item.type === 'scenario') {
            // Find scraped steps for this scenario (from item.elements or fallback to project.pages)
            let rawSteps = Array.isArray(item.elements) && item.elements.length > 0 ? item.elements : [];
            if (rawSteps.length === 0 && Array.isArray(project.pages)) {
                const matchedPage = project.pages.find(p =>
                    (p.pageName && item.pageName && p.pageName.trim().toLowerCase() === item.pageName.trim().toLowerCase()) ||
                    (p.pageName && item.name && p.pageName.trim().toLowerCase() === item.name.trim().toLowerCase())
                );
                if (matchedPage && Array.isArray(matchedPage.elements)) {
                    rawSteps = matchedPage.elements;
                }
            }

            const pageName = item.pageName || item.name || 'Default';
            const cleanSteps = rawSteps.map(el => {
                const loc = el['XPATH'] || el.ControlId || '';
                const inferredIdType = (typeof inferIdentificationType === 'function')
                    ? inferIdentificationType(loc)
                    : ((loc.startsWith('//') || loc.startsWith('(')) ? 'XPath' : (loc ? 'AccessibilityId' : 'Name'));
                return {
                    "CONTROL NAME": el['CONTROL NAME'] || el.ControlName || '',
                    "CONTROL TYPE": el['CONTROL TYPE'] || el.ControlType || '',
                    "XPATH": loc,
                    "PAGE NAME": el['PAGE NAME'] || el.PageName || pageName,
                    "IDENTIFICATION TYPE": el['IDENTIFICATION TYPE'] || el.IdentificationType || inferredIdType,
                    "CONTROL VALUE": el['CONTROL VALUE'] || el.ControlValue || '',
                    "FEATURE NAME": el['FEATURE NAME'] || el.FeatureName || pageName,
                    "NODE NAME": el['NODE NAME'] || el.NodeName || pageName,
                    "FINGERPRINT": el['FINGERPRINT'] || el.Fingerprint || '',
                    "APP URL": ""
                };
            });

            const downloadPayload = {
                "isRecordscenario": true,
                "dashboardControls": {
                    "APP URL": "",
                    "SCENARIOS": [
                        {
                            "SCENARIO_NAME": item.name || pageName || "Scenario",
                            "SCENARIO_OUTLINE": item.outline || item.name || "",
                            "STEPS": cleanSteps
                        }
                    ]
                }
            };

            return {
                filename: `${(item.name || 'scenario').replace(/\s+/g, '_')}_scenario.json`,
                badge: 'SCENARIO JSON',
                badgeClass: 'repo-badge-scenario',
                title: `${(item.name || 'scenario').replace(/\s+/g, '_')}_scenario.json`,
                subtitle: `Scenario: ${item.name || 'Scenario'} • ${cleanSteps.length} scraped ${cleanSteps.length === 1 ? 'step' : 'steps'} • ${item.appName || project.appName || 'Application'} (${platform})`,
                data: downloadPayload
            };
        } else if (item.type === 'feature') {
            return {
                filename: `${(item.name || 'feature').replace(/\s+/g, '_')}_feature.json`,
                badge: 'FEATURE JSON',
                badgeClass: 'repo-badge-feature',
                title: `${(item.name || 'feature').replace(/\s+/g, '_')}_feature.json`,
                subtitle: `Feature • ${item.pageName || 'Page'} (${platform})`,
                data: {
                    "type": "Feature",
                    "project": projectKey,
                    "name": item.name || "Feature",
                    "pageName": item.pageName || "",
                    "rect": item.rect || null,
                    "fullPage": !!item.fullPage,
                    "platform": platform,
                    "timestamp": item.timestamp || Date.now(),
                    "exportedAt": new Date(item.timestamp || Date.now()).toISOString()
                }
            };
        }
        return null;
    }

    const REPO_ICON_EYE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    const REPO_ICON_DL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
    const REPO_ICON_TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';

    function repoTypeGlyph(type) {
        if (type === 'scenario') {
            return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
        }
        if (type === 'feature') {
            return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>';
        }
        return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>';
    }

    function repoAssetRowHtml(type, id, name, meta, selected) {
        const label = type === 'scenario' ? 'Scenario' : (type === 'feature' ? 'Feature' : 'Page');
        return `
        <div class="repo-card repo-card--compact repo-asset-row ${selected ? 'is-selected' : ''}" data-repo-type="${type}" data-repo-id="${id}">
            <span class="repo-asset-icon repo-asset-icon--${type}">${repoTypeGlyph(type)}</span>
            <div class="repo-asset-copy">
                <div class="repo-asset-title-row">
                    <span class="repo-chip-type repo-chip-type--${type}">${label}</span>
                    <span class="repo-chip-name" title="${escapeDummyHtml(name)}">${escapeDummyHtml(name)}</span>
                </div>
                <span class="repo-chip-meta">${escapeDummyHtml(meta)}</span>
            </div>
            <div class="repo-chip-actions">
                <button type="button" class="repo-icon-btn repo-btn-view" data-action="view-json" data-id="${id}" data-type="${type}" title="Inspect JSON">${REPO_ICON_EYE}</button>
                <button type="button" class="repo-icon-btn" data-action="download-json" data-id="${id}" data-type="${type}" title="Export JSON">${REPO_ICON_DL}</button>
                <button type="button" class="repo-icon-btn repo-btn-del" data-action="delete-item" data-id="${id}" data-type="${type}" title="Delete">${REPO_ICON_TRASH}</button>
            </div>
        </div>`;
    }

    function openRepoJsonSideView(item) {
        if (!item) return;
        try {
            const payloadInfo = getItemJsonPayload(item, currentSelectedProjectKey);
            if (!payloadInfo) return;

            activeViewerItem = { ...item };
            currentViewerPayload = payloadInfo;

            const rightCol = document.getElementById('repoRightColumn');
            const jsonBox = document.getElementById('repoJsonViewerBox');
            const tabTitleEl = document.getElementById('repoJsonViewerTitle');
            const crumbAppEl = document.getElementById('repoJsonCrumbApp');
            const crumbPageEl = document.getElementById('repoJsonCrumbPage');
            const crumbFileEl = document.getElementById('repoJsonCrumbFile');
            const sizeEl = document.getElementById('repoJsonPayloadSize');
            const statusInfoEl = document.getElementById('repoJsonStatusInfo');
            const codeEl = document.getElementById('repoJsonCodeContent');
            const gutterEl = document.getElementById('repoJsonGutter');

            if (rightCol) rightCol.style.display = 'flex';
            if (jsonBox) jsonBox.style.display = 'flex';

            const jsonStr = JSON.stringify(payloadInfo.data, null, 2);
            const lines = jsonStr.split('\n');
            const lineCount = lines.length;
            const bytes = new Blob([jsonStr]).size;
            const sizeStr = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

            const filename = payloadInfo.filename || payloadInfo.title || 'payload.json';

            if (tabTitleEl) tabTitleEl.textContent = filename;
            if (crumbAppEl) {
                const proj = getProjectByKey(getProjectStore(), currentSelectedProjectKey);
                crumbAppEl.textContent = (typeof getProjectCardTitle === 'function' && proj)
                    ? getProjectCardTitle(proj, currentSelectedProjectKey)
                    : (currentSelectedProjectKey || 'Project');
            }
            if (crumbPageEl) crumbPageEl.textContent = item.pageName || item.name || 'Workspace';
            if (crumbFileEl) crumbFileEl.textContent = filename;
            if (sizeEl) sizeEl.textContent = `${sizeStr} • ${lineCount} lines`;
            if (statusInfoEl) {
                statusInfoEl.textContent = item.type === 'scenario' ? 'Scenario JSON Standard' : (item.type === 'feature' ? 'Feature Zone JSON' : 'Page Controls JSON');
            }

            // Render line numbers in gutter as <span> elements matching line-height
            if (gutterEl) {
                let gutterHtml = '';
                for (let i = 1; i <= lineCount; i++) {
                    gutterHtml += `<span>${i}</span>`;
                }
                gutterEl.innerHTML = gutterHtml;
            }

            if (codeEl) {
                codeEl.classList.remove('is-placeholder');
                if (typeof formatJsonToHtml === 'function') {
                    codeEl.innerHTML = formatJsonToHtml(jsonStr);
                } else {
                    codeEl.textContent = jsonStr;
                }
            }

            // Reset scroll position so line 1 is immediately at the top
            const scrollEl = document.getElementById('repoJsonEditorScroll');
            if (scrollEl) {
                scrollEl.scrollTop = 0;
                scrollEl.scrollLeft = 0;
            }

            if (typeof refreshRepoJsonFind === 'function') refreshRepoJsonFind();

            // Highlight selected card in horizontal strip
            document.querySelectorAll('#repoCardsContainer .repo-card').forEach(card => {
                const cardId = card.getAttribute('data-repo-id');
                const isMatch = (cardId && item.id && cardId === item.id) ||
                                (cardId && item.name && cardId === item.name) ||
                                (cardId && item.pageName && cardId === item.pageName);
                card.classList.toggle('is-selected', !!isMatch);
            });
        } catch (err) {
            console.error('Error in openRepoJsonSideView:', err);
        }
    }

    function showRepoJsonPlaceholder(title, message) {
        const rightCol = document.getElementById('repoRightColumn');
        const jsonBox = document.getElementById('repoJsonViewerBox');
        const tabTitleEl = document.getElementById('repoJsonViewerTitle');
        const codeEl = document.getElementById('repoJsonCodeContent');
        const gutterEl = document.getElementById('repoJsonGutter');
        if (rightCol) rightCol.style.display = 'flex';
        if (jsonBox) jsonBox.style.display = 'flex';
        if (tabTitleEl) tabTitleEl.textContent = title || 'workspace.json';
        activeViewerItem = null;
        currentViewerPayload = null;
        const text = message || '// Select a scenario or scraped page to inspect JSON.';
        if (codeEl) {
            codeEl.textContent = text;
            codeEl.classList.add('is-placeholder');
        }
        if (gutterEl) gutterEl.innerHTML = '<span>1</span>';
        if (typeof refreshRepoJsonFind === 'function') refreshRepoJsonFind();
        document.querySelectorAll('#repoCardsContainer .repo-card').forEach(card => {
            card.classList.remove('is-selected');
        });
    }

    let repoJsonFindHits = [];
    let repoJsonFindIndex = -1;
    let repoJsonFindCase = false;

    function restoreRepoJsonHtml() {
        const codeEl = document.getElementById('repoJsonCodeContent');
        if (!codeEl) return;
        if (codeEl.classList.contains('is-placeholder')) return;
        if (!currentViewerPayload || !currentViewerPayload.data) return;
        const jsonStr = JSON.stringify(currentViewerPayload.data, null, 2);
        if (typeof formatJsonToHtml === 'function') {
            codeEl.innerHTML = formatJsonToHtml(jsonStr);
        } else {
            codeEl.textContent = jsonStr;
        }
    }

    function applyRepoJsonFindHighlights(query) {
        const codeEl = document.getElementById('repoJsonCodeContent');
        repoJsonFindHits = [];
        if (!codeEl || !query) return;
        const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escaped, repoJsonFindCase ? 'g' : 'gi');
        nodes.forEach(node => {
            const text = node.nodeValue;
            if (!text) return;
            re.lastIndex = 0;
            if (!re.test(text)) return;
            re.lastIndex = 0;
            const frag = document.createDocumentFragment();
            let last = 0;
            let match;
            while ((match = re.exec(text))) {
                if (!match[0]) {
                    re.lastIndex += 1;
                    continue;
                }
                if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
                const mark = document.createElement('mark');
                mark.className = 'json-find-hit';
                mark.textContent = match[0];
                frag.appendChild(mark);
                repoJsonFindHits.push(mark);
                last = match.index + match[0].length;
            }
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            if (node.parentNode) node.parentNode.replaceChild(frag, node);
        });
    }

    function setRepoJsonFindCurrent(index, scrollTo) {
        repoJsonFindHits.forEach(hit => hit.classList.remove('is-current'));
        if (!repoJsonFindHits.length) {
            repoJsonFindIndex = -1;
            return;
        }
        repoJsonFindIndex = ((index % repoJsonFindHits.length) + repoJsonFindHits.length) % repoJsonFindHits.length;
        const current = repoJsonFindHits[repoJsonFindIndex];
        if (!current) return;
        current.classList.add('is-current');
        if (scrollTo !== false) {
            current.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
    }

    function updateRepoJsonFindCount() {
        const countEl = document.getElementById('repoJsonFindCount');
        if (!countEl) return;
        const q = (document.getElementById('repoJsonFindInput')?.value || '').trim();
        if (!q) {
            countEl.textContent = 'No results';
            countEl.classList.remove('is-empty');
            return;
        }
        if (!repoJsonFindHits.length) {
            countEl.textContent = 'No results';
            countEl.classList.add('is-empty');
            return;
        }
        countEl.classList.remove('is-empty');
        countEl.textContent = `${repoJsonFindIndex + 1} of ${repoJsonFindHits.length}`;
    }

    function refreshRepoJsonFind(keepIndex) {
        const input = document.getElementById('repoJsonFindInput');
        const query = (input?.value || '').trim();
        const prevIndex = repoJsonFindIndex;
        restoreRepoJsonHtml();
        if (!query) {
            repoJsonFindHits = [];
            repoJsonFindIndex = -1;
            updateRepoJsonFindCount();
            return;
        }
        applyRepoJsonFindHighlights(query);
        if (!repoJsonFindHits.length) {
            repoJsonFindIndex = -1;
            updateRepoJsonFindCount();
            return;
        }
        const nextIndex = keepIndex && prevIndex >= 0 ? prevIndex : 0;
        setRepoJsonFindCurrent(nextIndex, true);
        updateRepoJsonFindCount();
    }
    window.refreshRepoJsonFind = refreshRepoJsonFind;

    function openRepoJsonFind() {
        const widget = document.getElementById('repoJsonFindWidget');
        const input = document.getElementById('repoJsonFindInput');
        if (!widget || !input) return;
        widget.hidden = false;
        input.focus();
        input.select();
        refreshRepoJsonFind(true);
    }
    window.openRepoJsonFind = openRepoJsonFind;

    function closeRepoJsonFind() {
        const widget = document.getElementById('repoJsonFindWidget');
        const input = document.getElementById('repoJsonFindInput');
        if (widget) widget.hidden = true;
        if (input) input.value = '';
        restoreRepoJsonHtml();
        repoJsonFindHits = [];
        repoJsonFindIndex = -1;
        updateRepoJsonFindCount();
    }

    (function bindRepoJsonFind() {
        const input = document.getElementById('repoJsonFindInput');
        const prevBtn = document.getElementById('repoJsonFindPrev');
        const nextBtn = document.getElementById('repoJsonFindNext');
        const caseBtn = document.getElementById('repoJsonFindCase');
        const closeBtn = document.getElementById('repoJsonFindClose');
        if (!input) return;

        input.addEventListener('input', () => refreshRepoJsonFind(false));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (!repoJsonFindHits.length) return;
                setRepoJsonFindCurrent(repoJsonFindIndex + (e.shiftKey ? -1 : 1), true);
                updateRepoJsonFindCount();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeRepoJsonFind();
            }
        });
        if (prevBtn) prevBtn.addEventListener('click', () => {
            if (!repoJsonFindHits.length) return;
            setRepoJsonFindCurrent(repoJsonFindIndex - 1, true);
            updateRepoJsonFindCount();
        });
        if (nextBtn) nextBtn.addEventListener('click', () => {
            if (!repoJsonFindHits.length) return;
            setRepoJsonFindCurrent(repoJsonFindIndex + 1, true);
            updateRepoJsonFindCount();
        });
        if (caseBtn) caseBtn.addEventListener('click', () => {
            repoJsonFindCase = !repoJsonFindCase;
            caseBtn.classList.toggle('is-on', repoJsonFindCase);
            caseBtn.setAttribute('aria-pressed', repoJsonFindCase ? 'true' : 'false');
            refreshRepoJsonFind(true);
        });
        if (closeBtn) closeBtn.addEventListener('click', closeRepoJsonFind);

        document.addEventListener('keydown', (e) => {
            const repoTab = document.getElementById('tab-repository');
            if (!repoTab || !repoTab.classList.contains('is-workspace-open')) return;
            const key = String(e.key || '').toLowerCase();
            if ((e.metaKey || e.ctrlKey) && key === 'f') {
                e.preventDefault();
                openRepoJsonFind();
            } else if ((e.metaKey || e.ctrlKey) && key === 'g') {
                if (document.getElementById('repoJsonFindWidget')?.hidden) return;
                e.preventDefault();
                if (!repoJsonFindHits.length) return;
                setRepoJsonFindCurrent(repoJsonFindIndex + (e.shiftKey ? -1 : 1), true);
                updateRepoJsonFindCount();
            } else if (key === 'escape' && document.getElementById('repoJsonFindWidget') && !document.getElementById('repoJsonFindWidget').hidden) {
                e.preventDefault();
                closeRepoJsonFind();
            }
        });
    })();

    function closeRepoSideView() {
        const workspace = document.getElementById('repoSplitWorkspace');
        if (workspace) workspace.classList.remove('is-split');

        document.querySelectorAll('#repoCardsContainer .repo-card').forEach(card => {
            card.classList.remove('is-selected');
        });
        activeViewerItem = null;
        currentViewerPayload = null;
    }

    function isProtectedLiveProject(key) {
        if (!key) return false;
        const store = typeof getProjectStore === 'function' ? getProjectStore() : {};
        const project = store[key] || (typeof getProjectByKey === 'function' ? getProjectByKey(store, key) : null);
        if (typeof isCurrentlyOpenRepoProject === 'function') {
            return !!isCurrentlyOpenRepoProject(key, project);
        }
        return window.activeResumedProjectKey === key;
    }

    function selectableProjectKeys(keys) {
        return (keys || []).filter(k => k && !isProtectedLiveProject(k));
    }

    function visibleRepoProjectKeys() {
        return Array.from(document.querySelectorAll('#repoProjectsGrid .repo-project-card'))
            .map(c => c.getAttribute('data-project-key'))
            .filter(Boolean);
    }

    function setRepoMultiDeleteMode(on) {
        repoMultiDeleteMode = !!on;
        if (!repoMultiDeleteMode) repoSelectedProjectKeys.clear();
        const view = document.getElementById('repoProjectsView');
        if (view) view.classList.toggle('is-multi-delete', repoMultiDeleteMode);
        const enterBtn = document.getElementById('repoMultiDeleteBtn');
        const tools = document.getElementById('repoBulkSelectTools');
        if (enterBtn) enterBtn.hidden = repoMultiDeleteMode;
        if (tools) tools.hidden = !repoMultiDeleteMode;
        if (!repoMultiDeleteMode) {
            const selectAll = document.getElementById('repoSelectAllProjects');
            if (selectAll) {
                selectAll.checked = false;
                selectAll.indeterminate = false;
            }
            const countEl = document.getElementById('repoDeleteSelectedCount');
            if (countEl) countEl.textContent = '';
            const deleteBtn = document.getElementById('repoDeleteSelectedBtn');
            if (deleteBtn) deleteBtn.disabled = true;
        }
    }
    window.setRepoMultiDeleteMode = setRepoMultiDeleteMode;

    function updateRepoBulkBar(visibleKeys) {
        const visible = Array.isArray(visibleKeys) ? visibleKeys : [];
        const store = typeof getProjectStore === 'function' ? getProjectStore() : {};
        Array.from(repoSelectedProjectKeys).forEach(k => {
            if (!store[k] || isProtectedLiveProject(k)) repoSelectedProjectKeys.delete(k);
        });
        const selectableVisible = selectableProjectKeys(visible);
        const selectedVisible = selectableVisible.filter(k => repoSelectedProjectKeys.has(k));
        const count = repoSelectedProjectKeys.size;
        const deleteBtn = document.getElementById('repoDeleteSelectedBtn');
        const countEl = document.getElementById('repoDeleteSelectedCount');
        const selectAll = document.getElementById('repoSelectAllProjects');
        const enterBtn = document.getElementById('repoMultiDeleteBtn');
        const tools = document.getElementById('repoBulkSelectTools');
        const view = document.getElementById('repoProjectsView');
        if (view) view.classList.toggle('is-multi-delete', repoMultiDeleteMode);
        if (enterBtn) enterBtn.hidden = repoMultiDeleteMode;
        if (tools) tools.hidden = !repoMultiDeleteMode;
        if (countEl) countEl.textContent = count ? `(${count})` : '';
        if (deleteBtn) deleteBtn.disabled = !repoMultiDeleteMode || count === 0;
        if (selectAll) {
            selectAll.checked = repoMultiDeleteMode && selectableVisible.length > 0 && selectedVisible.length === selectableVisible.length;
            selectAll.indeterminate = repoMultiDeleteMode && selectedVisible.length > 0 && selectedVisible.length < selectableVisible.length;
            selectAll.disabled = !repoMultiDeleteMode || selectableVisible.length === 0;
        }
        document.querySelectorAll('#repoProjectsGrid .repo-project-card').forEach(card => {
            const key = card.getAttribute('data-project-key');
            const on = repoMultiDeleteMode && repoSelectedProjectKeys.has(key);
            card.classList.toggle('is-checked', on);
            const cb = card.querySelector('.repo-project-checkbox');
            if (cb) cb.checked = on;
        });
    }

    window.renderRepositoryView = function(filter, query) {
        if (filter !== undefined) currentRepoFilter = filter;
        if (query !== undefined) {
            if (currentSelectedProjectKey) repoSearchQuery = query.toLowerCase().trim();
            else repoProjectSearchQuery = query.toLowerCase().trim();
        }

        const store = getProjectStore();
        // One-time cleanup of inflated feature duplicates from earlier sync bugs
        let cleaned = false;
        Object.keys(store).forEach(k => {
            const p = store[k];
            if (!p) return;
            if (typeof dedupeProjectFeatureLists === 'function' && dedupeProjectFeatureLists(p)) cleaned = true;
            if (typeof pruneProjectAssetOwnership === 'function' && pruneProjectAssetOwnership(p)) cleaned = true;
        });
        if (cleaned && typeof setProjectStore === 'function') setProjectStore(store);
        const projectKeys = Object.keys(store);

        // Elements
        const projectsView = document.getElementById('repoProjectsView');
        const detailsView = document.getElementById('repoDetailsView');
        const rootActions = document.getElementById('repoRootActions');
        const projectActions = document.getElementById('repoProjectActions');
        const crumbDivider = document.getElementById('repoCrumbDivider');
        const crumbProject = document.getElementById('repoCrumbProject');
        const crumbRoot = document.getElementById('repoCrumbRoot');
        const emptyState = document.getElementById('repoEmptyState');
        const emptyTitle = document.getElementById('repoEmptyTitle');
        const emptyDesc = document.getElementById('repoEmptyDesc');
        const headerDesc = document.getElementById('repoHeaderDesc');

        // Calculate global repository stats
        let globalScenarios = 0;
        let globalFeatures = 0;
        let globalPages = 0;
        let iosCount = 0;
        let androidCount = 0;

        projectKeys.forEach(k => {
            const p = store[k];
            if (p) {
                globalScenarios += (p.scenarios || []).length;
                globalFeatures += (typeof countProjectFeatures === 'function') ? countProjectFeatures(p) : ((p.features || []).length);
                globalPages += (p.pages || []).length;
                const plat = (p.platform || '').toLowerCase();
                if (plat.includes('ios')) iosCount++;
                else if (plat.includes('android')) androidCount++;
            }
        });

        const totalProjectsEl = document.getElementById('repoTotalProjectsCount');
        const heroScenariosEl = document.getElementById('repoHeroTotalScenarios');
        const heroFeaturesEl = document.getElementById('repoHeroTotalFeatures');
        const heroPagesEl = document.getElementById('repoHeroTotalPages');
        const tabPlatformAll = document.getElementById('repoTabPlatformAll');
        const tabPlatformIos = document.getElementById('repoTabPlatformIos');
        const tabPlatformAndroid = document.getElementById('repoTabPlatformAndroid');

        if (totalProjectsEl) totalProjectsEl.textContent = projectKeys.length;
        if (heroScenariosEl) heroScenariosEl.textContent = globalScenarios;
        if (heroFeaturesEl) heroFeaturesEl.textContent = globalFeatures;
        if (heroPagesEl) heroPagesEl.textContent = globalPages;
        if (tabPlatformAll) tabPlatformAll.textContent = projectKeys.length;
        if (tabPlatformIos) tabPlatformIos.textContent = iosCount;
        if (tabPlatformAndroid) tabPlatformAndroid.textContent = androidCount;

        const activeProj = currentSelectedProjectKey ? getProjectByKey(store, currentSelectedProjectKey) : null;

        // If no project selected -> Render ROOT PROJECTS VIEW
        if (!activeProj) {
            currentSelectedProjectKey = null;
            closeRepoSideView();

            if (projectsView) projectsView.style.display = 'block';
            if (detailsView) detailsView.style.display = 'none';
            document.getElementById('tab-repository')?.classList.remove('is-workspace-open');
            if (rootActions) rootActions.style.display = 'flex';
            if (projectActions) projectActions.style.display = 'none';
            if (crumbDivider) crumbDivider.style.display = 'none';
            if (crumbProject) crumbProject.style.display = 'none';
            if (crumbRoot) {
                crumbRoot.classList.add('is-active');
                crumbRoot.innerHTML = `
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <span>Application Projects</span>`;
            }
            if (headerDesc) headerDesc.textContent = "Persistent workspaces organized by application. Inspect, export, and manage your captured scenarios and scraped elements.";

            const grid = document.getElementById('repoProjectsGrid');
            if (!grid) return;

            let filteredKeys = projectKeys.slice();

            // Filter by platform
            if (currentRepoPlatformFilter !== 'all') {
                filteredKeys = filteredKeys.filter(k => {
                    const p = store[k];
                    const plat = (p.platform || '').toLowerCase();
                    return plat.includes(currentRepoPlatformFilter.toLowerCase());
                });
            }

            // Filter by search query
            if (repoProjectSearchQuery) {
                filteredKeys = filteredKeys.filter(k => {
                    const p = store[k];
                    return k.toLowerCase().includes(repoProjectSearchQuery) ||
                           (p.appName || '').toLowerCase().includes(repoProjectSearchQuery) ||
                           (p.platform || '').toLowerCase().includes(repoProjectSearchQuery);
                });
            }

            if (filteredKeys.length === 0) {
                grid.innerHTML = `
                    <div class="repo-empty-state" style="grid-column: 1 / -1;">
                        <div class="repo-empty-icon">
                            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#2F8BCC" stroke-width="2">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                            </svg>
                        </div>
                        <p class="repo-empty-title">${projectKeys.length === 0 ? 'No Saved App Projects Yet' : 'No Matching Projects'}</p>
                        <p class="repo-empty-desc">${projectKeys.length === 0
                            ? 'When you scrape UI elements, define features, or record scenarios on Home, they appear here as project workspaces.'
                            : 'Try adjusting your platform filter or search query.'}</p>
                    </div>`;
                setRepoMultiDeleteMode(false);
                const enterBtn = document.getElementById('repoMultiDeleteBtn');
                if (enterBtn) enterBtn.hidden = true;
                if (emptyState) emptyState.style.display = 'none';
                return;
            }

            if (emptyState) emptyState.style.display = 'none';
            const enterBtn = document.getElementById('repoMultiDeleteBtn');
            if (enterBtn && !repoMultiDeleteMode) enterBtn.hidden = false;

            // Opened Home session first; remaining projects by last updated
            filteredKeys.sort((a, b) => {
                const aLive = (typeof isCurrentlyOpenRepoProject === 'function') ? isCurrentlyOpenRepoProject(a, store[a]) : false;
                const bLive = (typeof isCurrentlyOpenRepoProject === 'function') ? isCurrentlyOpenRepoProject(b, store[b]) : false;
                if (aLive && !bLive) return -1;
                if (!aLive && bLive) return 1;
                return (store[b].lastUpdated || 0) - (store[a].lastUpdated || 0);
            });

            let html = '';
            filteredKeys.forEach(k => {
                const p = store[k];
                const totalScen = (p.scenarios || []).length;
                const totalFeat = (typeof countProjectFeatures === 'function') ? countProjectFeatures(p) : ((p.features || []).length);
                const totalPages = (p.pages || []).length;
                const initial = (p.appName || 'A').charAt(0).toUpperCase();
                const isIos = (p.platform || '').toLowerCase().includes('ios');
                const platformBadge = isIos ? 'iOS' : 'Android';
                const platformBadgeClass = isIos ? 'is-ios' : 'is-android';
                const avatarClass = isIos ? 'is-ios' : 'is-android';

                const assetNames = [];
                (p.pages || []).forEach(pg => { if (pg.pageName && !assetNames.includes(pg.pageName)) assetNames.push(pg.pageName); });
                (p.scenarios || []).forEach(sc => { if (sc.name && !assetNames.includes(sc.name)) assetNames.push(sc.name); });
                const visibleTags = assetNames.slice(0, 3);
                const remainingTags = assetNames.length - 3;

                const displayName = (typeof getProjectCardTitle === 'function') ? getProjectCardTitle(p, k) : (p.appName || k);
                const shortId = (typeof getProjectShortId === 'function') ? getProjectShortId(p, k) : (p.projectId || '');
                const nameTitle = shortId ? `${displayName} (${shortId})` : displayName;
                const isLive = (typeof isCurrentlyOpenRepoProject === 'function')
                    ? isCurrentlyOpenRepoProject(k, p)
                    : (window.activeResumedProjectKey === k);

                html += `
                <div class="repo-project-card${isLive ? ' is-live' : ''}${repoMultiDeleteMode && !isLive && repoSelectedProjectKeys.has(k) ? ' is-checked' : ''}" data-project-key="${escapeDummyHtml(k)}">
                    ${repoMultiDeleteMode && !isLive ? `<label class="repo-project-check" data-action="select-project" title="Select project">
                        <input type="checkbox" class="repo-project-checkbox" data-action="select-project" data-p-key="${escapeDummyHtml(k)}" ${repoSelectedProjectKeys.has(k) ? 'checked' : ''} />
                    </label>` : ''}
                    <div class="repo-project-header">
                        <div class="repo-project-identity">
                            <div class="repo-project-icon-box ${avatarClass}">${escapeDummyHtml(initial)}</div>
                            <div class="repo-project-info">
                                <div class="repo-project-name-row">
                                    <h3 class="repo-project-name" title="${escapeDummyHtml(nameTitle)}">${escapeDummyHtml(displayName)}</h3>
                                    ${isLive ? `<span class="repo-live-pill"><span class="repo-live-dot"></span>Active</span>` : ''}
                                </div>
                                <div class="repo-project-meta">
                                    ${shortId ? `<span class="repo-project-id" title="Project ID">${escapeDummyHtml(shortId)}</span>` : ''}
                                    <span class="repo-project-updated">Updated ${formatDate(p.lastUpdated || p.createdAt)}</span>
                                </div>
                            </div>
                        </div>
                        <span class="repo-project-badge-pill ${platformBadgeClass}">${escapeDummyHtml(platformBadge)}</span>
                    </div>

                    <div class="repo-project-stats-strip">
                        <div class="repo-pstat-item pstat-scenarios" title="${totalScen} Recorded Scenarios">
                            <span class="repo-pstat-num">${totalScen}</span>
                            <span class="repo-pstat-lbl">Scenarios</span>
                        </div>
                        <div class="repo-pstat-item pstat-features" title="${totalFeat} Features">
                            <span class="repo-pstat-num">${totalFeat}</span>
                            <span class="repo-pstat-lbl">Features</span>
                        </div>
                        <div class="repo-pstat-item pstat-pages" title="${totalPages} Scraped Pages">
                            <span class="repo-pstat-num">${totalPages}</span>
                            <span class="repo-pstat-lbl">Pages</span>
                        </div>
                    </div>

                    ${visibleTags.length > 0 ? `
                    <div class="repo-project-asset-tags">
                        ${visibleTags.map(t => `<span class="repo-proj-tag" title="${escapeDummyHtml(t)}">${escapeDummyHtml(t)}</span>`).join('')}
                        ${remainingTags > 0 ? `<span class="repo-proj-tag-more">+${remainingTags} more</span>` : ''}
                    </div>` : '<div class="repo-project-asset-tags"></div>'}

                    <div class="repo-project-footer">
                        <div class="repo-open-link-btn" data-action="open-workspace">
                            <span>Open Workspace</span>
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </div>
                        <div class="repo-project-actions">
                            <button type="button" class="repo-btn-sm" data-action="export-project-card" data-p-key="${escapeDummyHtml(k)}" title="Export Project as JSON">
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M9 15l6-6"></path><path d="M10 9h5v5"></path></svg>
                                <span>Export</span>
                            </button>
                            <button type="button" class="repo-btn-sm repo-btn-del${isLive ? ' is-locked' : ''}" data-action="${isLive ? 'blocked-live-delete' : 'delete-project-card'}" data-p-key="${escapeDummyHtml(k)}" ${isLive ? 'disabled' : ''} title="${isLive ? 'Active project cannot be deleted' : 'Delete Project'}">
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path></svg>
                                <span>Delete</span>
                            </button>
                        </div>
                    </div>
                </div>`;
            });

            grid.innerHTML = html;
            updateRepoBulkBar(filteredKeys);
            return;
        }

        // --- DETAILS VIEW FOR SELECTED PROJECT ---
        const project = activeProj;
        if (projectsView) projectsView.style.display = 'none';
        if (detailsView) detailsView.style.display = 'flex';
        document.getElementById('tab-repository')?.classList.add('is-workspace-open');
        if (rootActions) rootActions.style.display = 'none';
        if (projectActions) projectActions.style.display = 'flex';
        const wsDeleteBtn = document.getElementById('repoDeleteProjectBtn');
        if (wsDeleteBtn) {
            const liveOpen = isProtectedLiveProject(currentSelectedProjectKey);
            wsDeleteBtn.disabled = liveOpen;
            wsDeleteBtn.title = liveOpen
                ? 'Active project is open on Home — reset or close the session to delete it'
                : 'Delete Project';
            wsDeleteBtn.classList.toggle('is-locked', liveOpen);
            const label = wsDeleteBtn.querySelector('span');
            if (label) label.textContent = liveOpen ? 'Active Project' : 'Delete Project';
        }
        if (crumbDivider) crumbDivider.style.display = 'inline';
        if (crumbProject) {
            crumbProject.style.display = 'inline';
            crumbProject.textContent = ((typeof getProjectCardTitle === 'function') ? getProjectCardTitle(project, currentSelectedProjectKey) : (project.appName || currentSelectedProjectKey))
                + ((typeof getProjectShortId === 'function' && getProjectShortId(project, currentSelectedProjectKey)) ? ` · ${getProjectShortId(project, currentSelectedProjectKey)}` : '');
        }
        if (crumbRoot) {
            crumbRoot.classList.remove('is-active');
            crumbRoot.innerHTML = `
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="19" y1="12" x2="5" y2="12"></line>
                    <polyline points="12 19 5 12 12 5"></polyline>
                </svg>
                <span>All Projects</span>`;
        }
        if (headerDesc) headerDesc.textContent = `Viewing saved assets for ${project.appName} (${project.platform}). Preserved across resets and restarts.`;

        // Update Project-level counters
        const scCount = document.getElementById('repoScenarioCount');
        const ftCount = document.getElementById('repoFeatureCount');
        const pgCount = document.getElementById('repoPageCount');
        const allCount = document.getElementById('repoAllCount');
        const scenTabCount = document.getElementById('repoScenTabCount');
        const featTabCount = document.getElementById('repoFeatTabCount');
        const pageTabCount = document.getElementById('repoPageTabCount');

        const totalScenarios = (project.scenarios || []).length;
        const totalFeatures = (typeof countProjectFeatures === 'function') ? countProjectFeatures(project) : ((project.features || []).length);
        const totalPages = (project.pages || []).length;
        const totalAll = totalScenarios + totalFeatures + totalPages;

        if (scCount) scCount.textContent = totalScenarios;
        if (ftCount) ftCount.textContent = totalFeatures;
        if (pgCount) pgCount.textContent = totalPages;
        if (allCount) allCount.textContent = totalAll;
        if (scenTabCount) scenTabCount.textContent = totalScenarios;
        if (featTabCount) featTabCount.textContent = totalFeatures;
        if (pageTabCount) pageTabCount.textContent = totalPages;

        const container = document.getElementById('repoCardsContainer');
        if (!container) return;

        // Render items based on selected tab
        let items = [];
        if (currentRepoFilter === 'all' || currentRepoFilter === 'scenarios') {
            (project.scenarios || []).forEach(s => items.push({ type: 'scenario', ...s }));
        }
        if (currentRepoFilter === 'all' || currentRepoFilter === 'pages') {
            (project.pages || []).forEach(p => items.push({ type: 'page', ...p }));
        }
        if (currentRepoFilter === 'all' || currentRepoFilter === 'features') {
            (project.features || []).forEach(f => items.push({ type: 'feature', ...f }));
        }

        // Sort items by timestamp desc
        items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        // Filter by search query within project
        if (repoSearchQuery) {
            items = items.filter(item => {
                const nameMatch = (item.name || '').toLowerCase().includes(repoSearchQuery);
                const pageMatch = (item.pageName || '').toLowerCase().includes(repoSearchQuery);
                const outlineMatch = (item.outline || '').toLowerCase().includes(repoSearchQuery);
                const elementsMatch = item.elements && item.elements.some(el =>
                    (el['CONTROL NAME'] || '').toLowerCase().includes(repoSearchQuery) ||
                    (el['XPATH'] || '').toLowerCase().includes(repoSearchQuery)
                );
                const featuresMatch = (item.features || []).some(f => ((f && f.name) || '').toLowerCase().includes(repoSearchQuery));
                return nameMatch || pageMatch || outlineMatch || elementsMatch || featuresMatch;
            });
        }

        if (items.length === 0) {
            container.innerHTML = '<div class="repo-strip-empty">No assets match this filter.</div>';
            showRepoJsonPlaceholder('workspace.json', '// Select a scenario, feature, or scraped page to inspect JSON.');
            return;
        }

        let html = '';
        items.forEach(item => {
            const isSelected = activeViewerItem && activeViewerItem.id === item.id;
            if (item.type === 'scenario') {
                // Find scraped steps count for this scenario
                const rawSteps = item.elements || [];
                let stepsCount = Array.isArray(rawSteps) && rawSteps.length > 0 ? rawSteps.length : 0;
                if (stepsCount === 0 && Array.isArray(project.pages)) {
                    const matchedPage = project.pages.find(p =>
                        (p.pageName && item.pageName && p.pageName.trim().toLowerCase() === item.pageName.trim().toLowerCase()) ||
                        (p.pageName && item.name && p.pageName.trim().toLowerCase() === item.name.trim().toLowerCase())
                    );
                    if (matchedPage && Array.isArray(matchedPage.elements)) {
                        stepsCount = matchedPage.elements.length;
                    }
                }

                const scenFeatNames = new Set();
                const pName = item.pageName || item.name || 'Default';
                (item.features || []).forEach(f => {
                    const fn = (f && f.name) || f;
                    if (fn && isDistinctFeatureName(fn, pName)) scenFeatNames.add(String(fn).trim());
                });
                (rawSteps || []).forEach(el => {
                    const fn = el && (el['FEATURE NAME'] || el.FeatureName);
                    if (fn && isDistinctFeatureName(fn, pName)) scenFeatNames.add(String(fn).trim());
                });
                (project.features || []).forEach(f => {
                    if (f && f.name && isDistinctFeatureName(f.name, pName)) {
                        scenFeatNames.add(String(f.name).trim());
                    }
                });
                const scenFeatList = Array.from(scenFeatNames);

                const scenFeatHint = scenFeatList.length ? ` · ${scenFeatList.join(', ')}` : '';
                html += repoAssetRowHtml(
                    'scenario',
                    item.id,
                    item.name,
                    `${stepsCount} ${stepsCount === 1 ? 'step' : 'steps'} · ${item.pageName || item.name || '—'}${scenFeatHint}`,
                    isSelected
                );
            } else if (item.type === 'page') {
                let elList = Array.isArray(item.elements) && item.elements.length > 0 ? item.elements : [];
                if (elList.length === 0 && Array.isArray(project.pages)) {
                    const matched = project.pages.find(p => p.id === item.id || (p.pageName && repoNameKey(p.pageName) === repoNameKey(item.pageName)));
                    if (matched && Array.isArray(matched.elements) && matched.elements.length > 0) {
                        elList = matched.elements;
                    }
                }
                if (elList.length === 0 && typeof window.extractAllTableData === 'function') {
                    const activeRows = window.extractAllTableData('myTable') || [];
                    const matching = activeRows.filter(r => repoNameKey(r['PAGE NAME']) === repoNameKey(item.pageName));
                    if (matching.length > 0) {
                        elList = matching;
                    }
                }
                const pageFeatNames = new Set();
                (item.features || []).forEach(f => {
                    const fn = (f && f.name) || f;
                    if (fn && isDistinctFeatureName(fn, item.pageName)) pageFeatNames.add(String(fn).trim());
                });
                (elList || []).forEach(el => {
                    const fn = el && (el['FEATURE NAME'] || el.FeatureName);
                    if (fn && isDistinctFeatureName(fn, item.pageName)) pageFeatNames.add(String(fn).trim());
                });
                (project.features || []).forEach(f => {
                    if (f && f.name && (f.pageName === item.pageName || !f.pageName || f.pageName === 'Default') && isDistinctFeatureName(f.name, item.pageName)) {
                        pageFeatNames.add(String(f.name).trim());
                    }
                });
                const pageFeatList = Array.from(pageFeatNames);

                const pageFeatHint = pageFeatList.length ? ` · ${pageFeatList.join(', ')}` : '';
                html += repoAssetRowHtml(
                    'page',
                    item.id,
                    item.pageName,
                    `${elList.length} ${elList.length === 1 ? 'control' : 'controls'}${pageFeatHint}`,
                    isSelected
                );
            } else if (item.type === 'feature') {
                const featId = item.id || item.name;
                html += repoAssetRowHtml(
                    'feature',
                    featId,
                    item.name,
                    `${item.pageName || '—'} · ${item.fullPage ? 'Full Screen' : 'Bounding Box'}`,
                    isSelected
                );
            }
        });

        container.innerHTML = html;

        const foundActive = activeViewerItem && items.find(x =>
            x.type === activeViewerItem.type && (x.id === activeViewerItem.id || x.name === activeViewerItem.name)
        );
        openRepoJsonSideView(foundActive || items[0]);
    };

    // Global Click Delegation for Repository Tab
    document.addEventListener('click', function(e) {
        // 1. Breadcrumb Root / Back to Projects buttons (Top and Inline)
        if (e.target.closest('#repoCrumbRoot') || e.target.closest('#repoBackToProjectsBtn') || e.target.closest('#repoInlineBackBtn')) {
            currentSelectedProjectKey = null;
            closeRepoSideView();
            window.renderRepositoryView();
            return;
        }

        // 2. Open Project by clicking Project Card
        const projectCard = e.target.closest('.repo-project-card');

        if (e.target.closest('#repoMultiDeleteBtn')) {
            const visibleKeys = visibleRepoProjectKeys();
            const selectable = selectableProjectKeys(visibleKeys);
            if (!selectable.length) {
                showCustomAlert('Active Project', 'The opened Active project cannot be deleted. There are no other projects to select.', 'warning');
                return;
            }
            setRepoMultiDeleteMode(true);
            window.renderRepositoryView();
            return;
        }

        if (e.target.closest('#repoCancelMultiDeleteBtn')) {
            setRepoMultiDeleteMode(false);
            window.renderRepositoryView();
            return;
        }

        if (e.target.closest('[data-action="select-project"]') || e.target.classList.contains('repo-project-checkbox')) {
            if (!repoMultiDeleteMode) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const cb = e.target.closest('.repo-project-checkbox') || e.target.querySelector?.('.repo-project-checkbox');
            const box = (e.target.type === 'checkbox') ? e.target : (e.target.closest('label')?.querySelector('input[type="checkbox"]'));
            const checkbox = box || cb;
            const pKey = checkbox?.getAttribute('data-p-key') || projectCard?.getAttribute('data-project-key');
            if (pKey && isProtectedLiveProject(pKey)) {
                if (checkbox) checkbox.checked = false;
                repoSelectedProjectKeys.delete(pKey);
                updateRepoBulkBar(visibleRepoProjectKeys());
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (pKey) {
                if (checkbox && checkbox.checked) repoSelectedProjectKeys.add(pKey);
                else repoSelectedProjectKeys.delete(pKey);
                updateRepoBulkBar(visibleRepoProjectKeys());
            }
            e.stopPropagation();
            return;
        }

        if (e.target.closest('[data-action="open-workspace"]')) {
            const pKey = projectCard?.getAttribute('data-project-key');
            if (pKey) {
                currentSelectedProjectKey = pKey;
                currentRepoFilter = 'all';
                const store = typeof getProjectStore === 'function' ? getProjectStore() : {};
                const p = store[pKey];
                if (p && typeof setAppConfiguredProject === 'function') {
                    setAppConfiguredProject(p.appName, p.platform, pKey);
                }
                closeRepoSideView();
                window.renderRepositoryView();
            }
            return;
        }

        if (projectCard && !e.target.closest('[data-action]')) {
            const pKey = projectCard.getAttribute('data-project-key');
            if (repoMultiDeleteMode) {
                if (pKey && !isProtectedLiveProject(pKey)) {
                    if (repoSelectedProjectKeys.has(pKey)) repoSelectedProjectKeys.delete(pKey);
                    else repoSelectedProjectKeys.add(pKey);
                    updateRepoBulkBar(visibleRepoProjectKeys());
                }
                return;
            }
            if (pKey) {
                currentSelectedProjectKey = pKey;
                currentRepoFilter = 'all';
                const store = typeof getProjectStore === 'function' ? getProjectStore() : {};
                const p = store[pKey];
                if (p && typeof setAppConfiguredProject === 'function') {
                    setAppConfiguredProject(p.appName, p.platform, pKey);
                }
                closeRepoSideView();
                window.renderRepositoryView();
            }
            return;
        }

        if (e.target.closest('#repoSelectAllProjects') || e.target.closest('.repo-select-all')) {
            if (!repoMultiDeleteMode) return;
            const selectAll = document.getElementById('repoSelectAllProjects');
            const visibleKeys = visibleRepoProjectKeys();
            const selectable = selectableProjectKeys(visibleKeys);
            const check = selectAll ? selectAll.checked : false;
            selectable.forEach(k => {
                if (check) repoSelectedProjectKeys.add(k);
                else repoSelectedProjectKeys.delete(k);
            });
            updateRepoBulkBar(visibleKeys);
            return;
        }

        if (e.target.closest('#repoDeleteSelectedBtn')) {
            if (!repoMultiDeleteMode) return;
            const keys = selectableProjectKeys(Array.from(repoSelectedProjectKeys));
            if (!keys.length) {
                showCustomAlert('Multi Delete', 'Select one or more projects to delete. The opened Active project cannot be deleted.', 'warning');
                return;
            }
            pendingRepoDelete = { projectKeys: keys };
            showConfirmDialog({
                title: `Delete ${keys.length} project${keys.length === 1 ? '' : 's'}?`,
                mainText: `Delete the <b>${keys.length}</b> selected project workspace${keys.length === 1 ? '' : 's'}?`,
                subText: 'This cannot be undone. Saved scenarios, features, and scraped pages in these projects will be permanently removed.',
                action: 'confirmDeleteRepoProjects',
                theme: 'error',
                okayBtnText: keys.length === 1 ? 'Delete Project' : 'Delete Selected'
            });
            return;
        }

        // 3. Export Project Card action
        const exportProjCardBtn = e.target.closest('[data-action="export-project-card"]');
        if (exportProjCardBtn) {
            const pKey = exportProjCardBtn.getAttribute('data-p-key') || currentSelectedProjectKey;
            const store = getProjectStore();
            const proj = store[pKey];
            if (proj) {
                const bundle = {
                    exportType: 'AlgoScraper_Project_Suite',
                    projectKey: pKey,
                    appName: proj.appName,
                    platform: proj.platform,
                    exportedAt: new Date().toISOString(),
                    project: proj
                };
                downloadFile(`${(proj.appName || 'project').replace(/\s+/g, '_')}_project_suite.json`, JSON.stringify(bundle, null, 2));
            }
            return;
        }

        if (e.target.closest('[data-action="blocked-live-delete"]')) {
            showCustomAlert('Active Project', 'This project is currently open. Close or Reset the Home session before deleting it.', 'warning');
            return;
        }

        // 4. Delete Project Card action
        const delProjCardBtn = e.target.closest('[data-action="delete-project-card"]') || e.target.closest('#repoDeleteProjectBtn');
        if (delProjCardBtn) {
            const pKey = delProjCardBtn.getAttribute('data-p-key') || currentSelectedProjectKey;
            if (isProtectedLiveProject(pKey)) {
                showCustomAlert('Active Project', 'This project is currently open. Close or Reset the Home session before deleting it.', 'warning');
                return;
            }
            const store = getProjectStore();
            const proj = getProjectByKey(store, pKey);
            if (proj) {
                pendingRepoDelete = { projectKey: pKey };
                showConfirmDialog({
                    title: `Delete Project: ${proj.appName}?`,
                    mainText: `Are you sure you want to delete project "${proj.appName}" (${proj.platform})?`,
                    subText: `This will delete all its saved scenarios, features, and scraped pages. If deleted from here, this action cannot be undone.`,
                    action: 'confirmDeleteRepoProject',
                    theme: 'error',
                    okayBtnText: 'Delete Project'
                });
            }
            return;
        }

        // 5. Export Project from Details Header
        if (e.target.closest('#repoExportProjectBtn')) {
            const store = getProjectStore();
            const proj = getProjectByKey(store, currentSelectedProjectKey);
            if (proj) {
                const bundle = {
                    exportType: 'AlgoScraper_Project_Suite',
                    projectKey: currentSelectedProjectKey,
                    appName: proj.appName,
                    platform: proj.platform,
                    exportedAt: new Date().toISOString(),
                    project: proj
                };
                downloadFile(`${(proj.appName || 'project').replace(/\s+/g, '_')}_project_suite.json`, JSON.stringify(bundle, null, 2));
            }
            return;
        }

        // 5.5 Platform filter tabs on Root Projects page
        const platFilterBtn = e.target.closest('#repoPlatformFilterTabs .repo-filter-btn');
        if (platFilterBtn) {
            document.querySelectorAll('#repoPlatformFilterTabs .repo-filter-btn').forEach(btn => btn.classList.remove('is-active'));
            platFilterBtn.classList.add('is-active');
            currentRepoPlatformFilter = platFilterBtn.getAttribute('data-platform-filter') || 'all';
            window.renderRepositoryView();
            return;
        }

        // 6. Filter tabs inside Project Details
        const filterBtn = e.target.closest('#repoDetailsView .repo-filter-btn');
        if (filterBtn) {
            document.querySelectorAll('#repoDetailsView .repo-filter-btn').forEach(btn => btn.classList.remove('is-active'));
            filterBtn.classList.add('is-active');
            const f = filterBtn.getAttribute('data-filter') || 'all';
            window.renderRepositoryView(f);
            return;
        }

        // 7. Metric cards click to filter inside Project Details
        const metricCard = e.target.closest('#repoDetailsView .repo-metric-card');
        if (metricCard) {
            const f = metricCard.getAttribute('data-repo-filter');
            if (f) {
                document.querySelectorAll('#repoDetailsView .repo-filter-btn').forEach(btn => {
                    btn.classList.toggle('is-active', btn.getAttribute('data-filter') === f);
                });
                window.renderRepositoryView(f);
            }
            return;
        }

        // 8. Import Projects (Root)
        if (e.target.closest('#repoImportProjectsBtn')) {
            const fileInput = document.getElementById('repoImportFileInput');
            if (fileInput) {
                fileInput.value = '';
                fileInput.click();
            }
            return;
        }

        // 9. Refresh projects list (Root) — show loader, reload, then done popup
        if (e.target.closest('#repoRefreshBtn')) {
            const overlayEl = document.getElementById('overlay');
            const loaderEl = document.getElementById('AppRunningPopup');
            if (overlayEl) overlayEl.style.display = 'block';
            if (loaderEl) loaderEl.style.display = 'flex';

            const finishRefresh = () => {
                try {
                    if (!window._activeRepoWriteDepth) {
                        window._activeRepoWriteStore = null;
                    }
                    currentSelectedProjectKey = null;
                    currentRepoFilter = 'all';
                    currentRepoPlatformFilter = 'all';
                    repoProjectSearchQuery = '';
                    repoSearchQuery = '';
                    repoMultiDeleteMode = false;
                    repoSelectedProjectKeys = new Set();

                    const searchEl = document.getElementById('repoProjectSearchInput');
                    if (searchEl) searchEl.value = '';
                    document.querySelectorAll('#repoProjectsView [data-platform-filter]').forEach(btn => {
                        const isAll = (btn.getAttribute('data-platform-filter') || 'all') === 'all';
                        btn.classList.toggle('is-active', isAll);
                    });

                    const detailsView = document.getElementById('repoDetailsView');
                    const projectsView = document.getElementById('repoProjectsView');
                    if (detailsView) detailsView.style.display = 'none';
                    if (projectsView) {
                        projectsView.style.display = 'block';
                        projectsView.classList.remove('is-multi-delete');
                    }
                    document.getElementById('tab-repository')?.classList.remove('is-workspace-open');

                    if (typeof window.renderRepositoryView === 'function') {
                        window.renderRepositoryView('all', '');
                    }

                    if (loaderEl) loaderEl.style.display = 'none';
                    if (overlayEl) overlayEl.style.display = 'none';
                    showCustomAlert('Refresh Done', 'Projects list has been refreshed from persistent storage.', 'success');
                } catch (err) {
                    console.error('Repository refresh failed:', err);
                    if (loaderEl) loaderEl.style.display = 'none';
                    if (overlayEl) overlayEl.style.display = 'none';
                    showCustomAlert('Refresh Failed', (err && err.message) ? err.message : 'Could not refresh projects.', 'error');
                }
            };

            // Keep loader visible briefly so users see the loading state
            setTimeout(finishRefresh, 450);
            return;
        }

        // 10. View JSON: Clicking an asset chip or its Inspect button
        const clickedCard = e.target.closest('.repo-card');
        const viewJsonBtn = e.target.closest('[data-action="view-json"]');
        if ((clickedCard || viewJsonBtn) && !e.target.closest('[data-action="download-json"]') && !e.target.closest('[data-action="delete-item"]')) {
            const targetEl = viewJsonBtn || clickedCard;
            const cardEl = clickedCard || targetEl.closest('.repo-card');
            const id = targetEl.getAttribute('data-id') || (cardEl ? cardEl.getAttribute('data-repo-id') : null) || targetEl.getAttribute('data-repo-id');
            const type = targetEl.getAttribute('data-type') || (cardEl ? cardEl.getAttribute('data-repo-type') : null) || targetEl.getAttribute('data-repo-type');
            const store = getProjectStore();
            const project = getProjectByKey(store, currentSelectedProjectKey);
            if (project) {
                let item = null;
                if (type === 'page') {
                    item = (project.pages || []).find(p => p.id === id || (p.pageName && p.pageName === id));
                } else if (type === 'scenario') {
                    item = (project.scenarios || []).find(s => s.id === id || (s.name && s.name === id) || (s.pageName && s.pageName === id));
                } else if (type === 'feature') {
                    item = (project.features || []).find(f => f.id === id || f.name === id || (f.name && f.name.toLowerCase() === (id || '').toLowerCase()));
                }
                if (item) {
                    openRepoJsonSideView({ type, ...item });
                }
            }
            return;
        }

        if (e.target.closest('#repoJsonFindBtn')) {
            if (typeof openRepoJsonFind === 'function') openRepoJsonFind();
            return;
        }

        // 11. Copy JSON from Side View
        if (e.target.closest('#repoJsonCopyBtn')) {
            if (currentViewerPayload && currentViewerPayload.data) {
                const jsonStr = JSON.stringify(currentViewerPayload.data, null, 2);
                navigator.clipboard.writeText(jsonStr).then(() => {
                    const btn = document.getElementById('repoJsonCopyBtn');
                    if (btn) {
                        const origHtml = btn.innerHTML;
                        btn.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> <span>Copied!</span>`;
                        setTimeout(() => { btn.innerHTML = origHtml; }, 1800);
                    }
                }).catch(err => {
                    console.error('Copy JSON failed:', err);
                });
            }
            return;
        }

        // 12. Download JSON from Side View
        if (e.target.closest('#repoJsonDownloadBtn')) {
            if (currentViewerPayload && currentViewerPayload.data) {
                const jsonStr = JSON.stringify(currentViewerPayload.data, null, 2);
                downloadFile(currentViewerPayload.filename || 'download.json', jsonStr, 'application/json');
            }
            return;
        }

        // 13. Close JSON Side View
        if (e.target.closest('#repoJsonCloseBtn')) {
            closeRepoSideView();
            return;
        }

        // 14. Item Card Actions inside Project (Download JSON, Delete)
        const dlJsonBtn = e.target.closest('[data-action="download-json"]');
        if (dlJsonBtn) {
            const id = dlJsonBtn.getAttribute('data-id');
            const type = dlJsonBtn.getAttribute('data-type');
            const store = getProjectStore();
            const project = getProjectByKey(store, currentSelectedProjectKey);
            if (project) {
                let item = null;
                if (type === 'page') item = (project.pages || []).find(p => p.id === id);
                else if (type === 'scenario') item = (project.scenarios || []).find(s => s.id === id);
                else if (type === 'feature') item = (project.features || []).find(f => f.id === id || (f.name && f.name === id));
                if (item) {
                    const payloadInfo = getItemJsonPayload({ type, ...item }, currentSelectedProjectKey);
                    if (payloadInfo && payloadInfo.data) {
                        downloadFile(payloadInfo.filename, JSON.stringify(payloadInfo.data, null, 2), 'application/json');
                    }
                }
            }
            return;
        }

        const delItemBtn = e.target.closest('[data-action="delete-item"]');
        if (delItemBtn) {
            const id = delItemBtn.getAttribute('data-id');
            const type = delItemBtn.getAttribute('data-type');
            const store = getProjectStore();
            const project = getProjectByKey(store, currentSelectedProjectKey);
            if (!project) return;

            const scenItem = type === 'scenario' ? (project.scenarios || []).find(s => s.id === id) : null;
            const pageItem = type === 'page' ? (project.pages || []).find(p => p.id === id) : null;
            const featItem = type === 'feature' ? (project.features || []).find(f => f.id === id || f.name === id) : null;
            const featDisplayName = featItem ? featItem.name : 'this feature';

            pendingRepoDelete = {
                projectKey: currentSelectedProjectKey,
                type,
                id,
                pageName: (scenItem && (scenItem.pageName || scenItem.name)) || (pageItem && pageItem.pageName) || '',
                scenarioName: scenItem && scenItem.name,
                featureName: featItem && featItem.name
            };
            const label = type === 'scenario' ? 'Scenario' : (type === 'feature' ? 'Feature' : 'Page & Elements');

            showConfirmDialog({
                title: `Delete Saved ${label}?`,
                mainText: `Do you really want to delete ${type === 'feature' ? `feature "<b>${escapeDummyHtml(featDisplayName)}</b>"` : `this ${label}`}?`,
                subText: `If deleted from here, this action cannot be undone and you will not be able to recover it.${type === 'feature' ? ' The feature will be removed completely from the application, and any table rows assigned to this feature will automatically be updated to their page name.' : ' Home will update at the same time.'}`,
                action: 'confirmDeleteRepoItem',
                theme: 'error',
                okayBtnText: 'Delete',
                onOkay: () => {
                    if (type === 'feature') {
                        const featName = (featItem && featItem.name) || id;
                        if (typeof window.removeFeatureCompletely === 'function') {
                            window.removeFeatureCompletely(featName, currentSelectedProjectKey);
                        }
                    } else if (type === 'scenario') {
                        project.scenarios = (project.scenarios || []).filter(s => s.id !== id);
                        project.lastUpdated = Date.now();
                        window.setRepoProjectsStore(store);
                        if (typeof window.applyRepoChangeToHome === 'function') {
                            window.applyRepoChangeToHome({
                                projectKey: currentSelectedProjectKey,
                                type: 'scenario',
                                pageName: pendingRepoDelete.pageName,
                                scenarioName: pendingRepoDelete.scenarioName
                            });
                            pendingRepoDelete._appliedHome = true;
                        }
                    } else if (type === 'page') {
                        project.pages = (project.pages || []).filter(p => p.id !== id);
                        project.lastUpdated = Date.now();
                        window.setRepoProjectsStore(store);
                        if (typeof window.applyRepoChangeToHome === 'function') {
                            window.applyRepoChangeToHome({
                                projectKey: currentSelectedProjectKey,
                                type: 'page',
                                pageName: pendingRepoDelete.pageName
                            });
                            pendingRepoDelete._appliedHome = true;
                        }
                    }
                    if (typeof window.renderRepositoryView === 'function') {
                        window.renderRepositoryView();
                    }
                }
            });
            return;
        }
    });

    // Escape key closes side view
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            const rightCol = document.getElementById('repoRightColumn');
            if (rightCol && rightCol.style.display !== 'none') {
                closeRepoSideView();
            }
        }
    });

    // Search input listeners
    const projectSearchInput = document.getElementById('repoProjectSearchInput');
    if (projectSearchInput) {
        projectSearchInput.addEventListener('input', function() {
            window.renderRepositoryView(currentRepoFilter, this.value);
        });
    }

    const searchInput = document.getElementById('repoSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            window.renderRepositoryView(currentRepoFilter, this.value);
        });
    }

    const repoImportFileInput = document.getElementById('repoImportFileInput');
    if (repoImportFileInput) {
        repoImportFileInput.addEventListener('change', function() {
            const file = this.files && this.files[0];
            this.value = '';
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function() {
                try {
                    const parsed = JSON.parse(String(reader.result || ''));
                    const result = importProjectsFromJsonData(parsed, { fileName: file.name || '' });
                    const parts = [];
                    if (result.added) parts.push(`<b>${result.added}</b> added`);
                    if (result.updated) parts.push(`<b>${result.updated}</b> updated`);
                    if (result.skipped) parts.push(`<b>${result.skipped}</b> skipped (active project)`);
                    showCustomAlert(
                        'Import Complete',
                        parts.length
                            ? `Imported projects successfully.<br><br>${parts.join('<br>')}`
                            : 'No projects were imported.',
                        result.added || result.updated ? 'success' : 'info'
                    );
                } catch (err) {
                    showCustomAlert(
                        'Import Failed',
                        (err && err.message) ? err.message : 'Could not import this file.',
                        'error'
                    );
                }
            };
            reader.onerror = function() {
                showCustomAlert('Import Failed', 'Could not read the selected file.', 'error');
            };
            reader.readAsText(file);
        });
    }
})();