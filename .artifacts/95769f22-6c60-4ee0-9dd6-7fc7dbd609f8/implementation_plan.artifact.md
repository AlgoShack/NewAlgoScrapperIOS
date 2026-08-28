# Implementation Plan - Include Fingerprint in Export and Send Data

This plan ensures that the newly generated JSON fingerprint and the App URL are correctly included when downloading the table as JSON or sending data to the API.

## Proposed Changes

### UI Template

#### [MODIFY] [index.html](file:///Users/divum/Downloads/Algoscrapper%20android%20/algoScraper%20Android/src/index.html)
- Fix the `fingerprint` header in `mainTable` to be a `th` instead of a `td`.
- Clean up the incorrect template-like string `${dtControls[i].Fingerprint || ""}`.

### UI Scraper Logic

#### [MODIFY] [popup.js](file:///Users/divum/Downloads/Algoscrapper%20android%20/algoScraper%20Android/src/popup.js)
- **`downloadTableAsJSON`**: Update the row extraction logic to pull the actual values for `FINGERPRINT` and `APP URL` from the table cells instead of hardcoding them to empty strings.
- **`sendTableDataToAPI`**: Update the row extraction logic similarly to include `FINGERPRINT` and `APP URL`.

## Verification Plan

### Manual Verification
1. **Scrape Test**: Perform a scrape.
2. **Download Test**: Click the "Download" button (if available) or trigger `downloadTableAsJSON`. Verify the downloaded JSON file contains the detailed fingerprint.
3. **Send Data Test**: Click the "algoQA" button to send data. Intercept or check logs to verify the payload includes the fingerprint and App URL.
