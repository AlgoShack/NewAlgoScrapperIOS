# Implementation Plan - Retroactive Feature Tagging

Automatically update existing table rows with a newly created Feature Name if those elements fall within the boundaries of the new feature area.

## Proposed Changes

### `src/popup.js`

#### [MODIFY] [popup.js](file:///Users/divum/Downloads/Algoscrapper%20android%20/algoScraper%20Android/src/popup.js)

- **New Helper Function `syncExistingRowsWithNewFeature(area)`**:
    - **Logic**:
        1. Select all data rows in `#myTable`.
        2. For each row, parse the element boundary data from `tr.dataset.rect`.
        3. If the row has no valid `rect` (e.g., coordinate-only rows), skip it.
        4. Calculate the center point of the element.
        5. Check if this center point falls within the boundaries of the newly registered `area.rect`.
        6. If it does, find the `.featureName` cell in that row and update its `innerText` to `area.name`.
- **Integrate Sync Logic**:
    - Call `syncExistingRowsWithNewFeature(newArea)` whenever a new feature is pushed to `registeredFeatureAreas`:
        - **`featureSaveBtn` click listener**: For features created via selection mode.
        - **`newExtraBtn` click listener**: For sub-features created via table edit.
        - **`newOkayBtn` click listener (createNewFeature action)**: For initial feature assignments from table edit.

## Verification Plan

### Manual Verification
1.  **Retroactive Creation (Selection Mode)**:
    - Scrape elements in a specific UI region (e.g., a "Settings" list). They will show the default Page Name.
    - Click **Create Feature** and map the entire Settings list area as "Settings Category".
    - Click **Save Feature**.
    - **Verify**: All previously scraped rows for the settings items now show "Settings Category" in the table.
2.  **Retroactive Creation (Table Flow)**:
    - Scrape elements.
    - Edit one row to "ActionSection" and click **Create**.
    - **Verify**: If other elements are within that same area, they should also update to "ActionSection".
3.  **Sub-feature Precision**:
    - Edit one specific row within a feature to a more specific name (e.g., "Settings -> Notification Toggle") and click **Sub-feature**.
    - **Verify**: Only that row is updated.
