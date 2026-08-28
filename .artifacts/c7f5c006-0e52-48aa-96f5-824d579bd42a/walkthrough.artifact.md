# Walkthrough - Simplified Feature Creation & Retroactive Tagging

I have refined the feature renaming logic and implemented retroactive tagging to ensure existing data stays in sync with your feature mappings.

## Changes Made

### `src/popup.js`

- **Retroactive Tagging Logic**:
    - Added `syncExistingRowsWithNewFeature(area)` to automatically update existing table rows when a new feature is defined.
    - If an element's center point falls within the new feature area, its "FEATURE NAME" is updated instantly.
    - Integrated this sync into both the screen selection mode and the table editing flow.
- **Smart Selection Logic**: The app now checks if the element you are editing already belongs to a registered feature.
- **"Create New Feature" Popup**:
    - If you edit a row with no feature assigned, you will see a simplified popup with just **"Create"** and **"Cancel"** buttons.
- **"Update Feature Name" Popup**:
    - If you edit an existing feature, you still get the full **"Rename All"** and **"Sub-feature"** options.
- **Cancellation Fix**: Clicking **Cancel** now correctly reverts the cell text for both creation and rename flows.
- **Reset Logic Fix**: Clicking the **Reset** button now properly resets the "Create Feature" button text and state, even if the user was in "Exit Feature" mode.
- **Gesture Conflict Fix**: Enhanced interaction handling to prevent swipes from triggering clicks. The app now tracks mouse movement distance regardless of the current mode and explicitly blocks the "click" event if a swipe was detected. This prevents accidental feature popups or element selections while navigating the screen.

## Verification

### Manual Verification Steps
1.  **Retroactive Sync**:
    - Scrape elements in a region (e.g., a Navbar).
    - Use "Create Feature" to map the Navbar.
    - **Verify**: The existing Navbar rows in the table automatically update their "FEATURE NAME".
2.  **Initial Creation**:
    - Edit a row with no feature to "HeaderIcon" and press Enter.
    - **Verify**: The popup says **"Create New Feature"** with a **"Create"** button.
    - Click **Create**. Verify the cell updates and the hover label is visible.
3.  **Existing Rename**:
    - Edit an existing feature name.
    - **Verify**: The popup says **"Update Feature Name"** with the choices: **"Rename All"** and **"Sub-feature"**.
4.  **Cancel Check**:
    - Edit a name and click **Cancel**.
    - **Verify**: The cell reverts to its original value immediately.
