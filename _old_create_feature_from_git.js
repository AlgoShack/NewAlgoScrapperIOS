// =============================================================================
// OLD CREATE FEATURE CODE — fetched from git
// Commit: b01e3b7  (Initial commit)
// Source files: src/popup.js, src/index.html
// This is a reference extract only — not loaded by the app.
// =============================================================================


// ----- src/popup.js:92-125  Feature state + full-page helpers -----
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

// ----- src/popup.js:2748-2827  Table FEATURE NAME edit / uniqueness (pre-rename-all) -----
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


// ----- src/popup.js:3582-3610  Screenshot click → handleFeatureClick -----
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

// ----- src/popup.js:3909-4005  Hover preview while Create Feature mode is on -----
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

// ----- src/popup.js:4607-4965  resolveFeatureTargetAt, drawFeatureHoverAt, drawFullPageFeatureFrame, drawFeatureAreaHighlight -----
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

// ----- src/popup.js:6446-6576  handleFeatureClick + syncExistingRowsWithNewFeature -----
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


// ----- src/popup.js:9449-9620  Create Feature button toggle + modal validate/save/cancel -----
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

// ----- src/index.html:375-382  Create Feature toolbar button -----
            <button id="createFeatureBtn" class="pill-btn" style="background-color: #B6B6B4;" disabled>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="7" height="16" stroke-dasharray="4 4"></rect>
                    <rect x="14" y="4" width="7" height="5"></rect>
                    <path d="M21 14a2.121 2.121 0 0 0-3-3L11 18v3h3l7-7z"></path>
                </svg>
                <span>Create Feature</span>
            </button>

// ----- src/index.html:928-948  createFeatureModal HTML -----
<div class="custom-modal" id="createFeatureModal" style="display: none; width: 380px; background: #ffffff; border: 2px solid #2F8BCC; border-radius: 8px; overflow: visible; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 100000 !important; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
    <div style="background: #000000; border-bottom: 2px solid #2F8BCC; padding: 10px 16px; display: flex; align-items: center; border-radius: 6px 6px 0 0;">
        <span style="color: #ffffff; font-size: 14px; font-weight: 600;">Create Feature</span>
    </div>
    <div style="padding: 24px 20px 16px 20px; display: flex; flex-direction: column; gap: 20px; background: #ffffff; color: #333333; border-radius: 0 0 6px 6px;">
        <div class="floating-group">
            <input type="text" id="feature_name_input" class="floating-input" placeholder=" ">
            <label class="floating-label">Feature Name *</label>
            <div id="feature_name_error_icon" class="rec-error-icon">
                <svg viewBox="0 0 24 24" fill="#d9534f" style="width: 18px; height: 18px;">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                </svg>
                <div class="rec-error-tooltip" id="feature_name_error_text"></div>
            </div>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 12px; margin-top: 4px;">
            <button id="feature_cancel_btn" class="pill-btn" style="flex: 1; background-color: #555555; color: #fff; height: 30px !important; font-size: 12px;">Cancel</button>
            <button id="feature_save_btn" class="pill-btn" style="flex: 1; background-color: #2F8BCC; color: #fff; height: 30px !important; font-size: 12px;">Save Feature</button>
        </div>
    </div>
</div>
