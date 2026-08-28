# Walkthrough - Fingerprint Included in Export and API Send

I have updated the application to ensure that the detailed JSON fingerprint is correctly included when exporting data or sending it to the algoQA API. Previously, these fields were explicitly hardcoded to be empty strings during the extraction process.

## Changes

### UI Template Fix

#### [index.html](file:///Users/divum/Downloads/Algoscrapper%20android%20/algoScraper%20Android/src/index.html)

- Corrected the table header for the `fingerprint` column. It was incorrectly using a `td` tag inside the `thead`, which interfered with header discovery logic. It is now a proper `th` tag.
- Removed a leftover template string in the static HTML.

### Export and Send Logic Updates

#### [popup.js](file:///Users/divum/Downloads/Algoscrapper%20android%20/algoScraper%20Android/src/popup.js)

- **`downloadTableAsJSON`**: Updated to extract the actual Fingerprint and App URL from the table rows. It now searches for cells with the `.fingerprint` and `.appUrl` classes to populate the `FINGERPRINT` and `APP URL` fields in the JSON export.
- **`sendTableDataToAPI`**: Applied the same extraction logic update to ensure that when data is sent to the algoQA API, it includes the full node fingerprint and application identity.

## Verification

- The changes were applied surgically to the extraction loops of both functions.
- The default values for `FINGERPRINT` and `APP URL` in the initial `rowObj` are still present as fallbacks, but are now correctly overwritten by the actual data from the table.
- This fix applies to both normal scrapes and Record Scenario mode, as scenarios use the same extracted row data.
