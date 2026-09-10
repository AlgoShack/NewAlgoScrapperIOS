// Extracted from https://github.com/AlgoShack/NewAlgoScrapperIOS/blob/main/src/popup.js
// and src/index.html (main). Reference only.

// ----- popup.js handleFeatureClick + sync -----
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
            showStructuredAlert(
                "Feature Already Created",
                {
                    lead: `“<b>${escapePopupPlain(existingName)}</b>” is already created for this area.`,
                    hint: "Select a different area on the screen."
                },
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

// ----- popup.js drawFeatureHoverAt + highlight -----
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

        // Keep dashed hover above screenshot on Windows + Mac
        try {
            overlay.style.zIndex = '2000';
            overlay.style.pointerEvents = 'none';
        } catch (_) {}

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

        // Dashed border highlight
        const box =
            document.createElement("div");

        box.className = "show-element-hover-box";
        box.style.position = "absolute";
        box.style.left = left + "px";
        box.style.top = top + "px";
        box.style.width = Math.max(2, width) + "px";
        box.style.height = Math.max(2, height) + "px";
        box.style.border = "2px dashed #2F8BCC";
        box.style.boxSizing = "border-box";
        box.style.pointerEvents = "none";
        box.style.zIndex = "2001";

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

// ----- popup.js createFeatureBtn + validate + save -----
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

// ----- popup.js preview createFeatureMode -----
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

// ----- popup.js screenshot click -----
        // Create Feature only while in Tap (scrape) mode
        if (createFeatureMode) {
            const { scaleX, scaleY, rect } = getScreenshotScale(img);
            const clickX = (e.clientX - rect.left) * scaleX;
            const clickY = (e.clientY - rect.top) * scaleY;
            handleFeatureClick(clickX, clickY);
            return;
        }

// ----- index.html createFeatureModal -----
<div class="custom-modal form-modal" id="createFeatureModal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="createFeatureTitle">
    <div class="modal-header header-info">
        <span style="display: flex;" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="warning-icon">
                <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                <rect x="3" y="14" width="7" height="7" rx="1"></rect>
                <rect x="14" y="14" width="7" height="7" rx="1"></rect>
            </svg>
        </span>
        <span class="modal-title" id="createFeatureTitle">Create Feature</span>
    </div>
    <div class="modal-body form-modal-body">
        <p class="modal-sub-text form-modal-lead">Name the selected area on the device screen.</p>
        <div class="floating-group">
            <input type="text" id="feature_name_input" class="floating-input" placeholder=" " maxlength="60" autocomplete="off">
            <label class="floating-label">Feature Name *</label>
            <div id="feature_name_error_icon" class="rec-error-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
                    <circle cx="12" cy="12" r="9"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                <div class="rec-error-tooltip" id="feature_name_error_text"></div>
            </div>
        </div>
        <p class="form-field-hint">At least 3 characters, max 3 words. Start with a letter; letters, numbers, underscore, and single spaces only.</p>
        <div class="modal-actions">
            <button type="button" class="btn-cancel" id="feature_cancel_btn">Cancel</button>
            <button type="button" class="btn-confirm" id="feature_save_btn">Save Feature</button>
        </div>
    </div>
</div>
