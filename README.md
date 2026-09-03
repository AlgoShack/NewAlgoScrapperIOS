# AlgoScraper

[![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Appium](https://img.shields.io/badge/Appium-Bundled-EA5906?logo=appium&logoColor=white)](https://appium.io/)
[![Platform - macOS](https://img.shields.io/badge/Platform-macOS%20(iOS%20%2B%20Android)-000000?logo=apple&logoColor=white)](#platform-support)
[![Platform - Windows](https://img.shields.io/badge/Platform-Windows%20(Android)-0078D6?logo=windows&logoColor=white)](#platform-support)

**AlgoScraper** is a high-performance cross-platform desktop application engineered to inspect, scrape, and record UI elements and automation locators for **Android** (UiAutomator2) and **iOS** (XCUITest). 

It comes with a fully self-contained, bundled Appium runtime and bundled Node environment, automatically discovering connected devices and managing Android platform-tools (`adb`) without requiring global Appium installations or manual environment variable configuration.

---

## Table of Contents
1. [Platform Support](#platform-support)
2. [Key Features](#key-features)
3. [Prerequisites](#prerequisites)
4. [Getting the Code](#getting-the-code)
   - [Command Line (macOS / Windows)](#command-line-macos--windows)
   - [Android Studio (GUI)](#android-studio-gui)
5. [Setup & Running in Development](#setup--running-in-development)
6. [Building Distributable Packages](#building-distributable-packages)
7. [Architecture & Workflow Overview](#architecture--workflow-overview)
   - [Smart Swipe & Scroll Tracking](#smart-swipe--scroll-tracking)
   - [Customizable Auto-Adjusting Table](#customizable-auto-adjusting-table)
   - [Centralized Repository & Real-Time Sync](#centralized-repository--real-time-sync)
8. [Troubleshooting & FAQs](#troubleshooting--faqs)

---

## Platform Support

| Operating System | Supported Target Platforms | Driver Engine | Notes |
| :--- | :--- | :--- | :--- |
| **macOS** | **iOS** & **Android** | XCUITest + UiAutomator2 | Scrapes physical iPhones/iPads, iOS Simulators, physical Android devices, and Android Emulators. |
| **Windows** | **Android** | UiAutomator2 | Scrapes physical Android devices (via USB debugging) and Android Emulators. |

---

## Key Features

- **Zero-Config Appium Architecture**: Bundles its own Appium runtime and Node binary. No global Appium CLI installation needed.
- **Interactive Device Preview**: Real-time mirrored screen feed with precision touch, swipe, click, and inspect capabilities.
- **Automated Locator Generation**: Automatically generates resilient, testable XPaths, accessibility IDs, resource IDs, and control types.
- **Smart Scroll Detection**: Proprietary multi-node delta engine (`hasScreenContentScrolled`) accurately distinguishes true scrolling from rubber-band overscroll bounces. Eliminates false-positive captures on static screens and alerts when the end of the page is reached.
- **Dynamic Customizable Table**:
  - Toggle columns on/off on demand via the Customize Columns menu.
  - **Auto-Adjust Layout**: Dynamically measures text dimensions on both Windows and macOS, guaranteeing **zero `...` text truncation** across all column headers and cells.
  - Clean borderless horizontal scrolling without visible scrollbar chrome.
- **Scenario Recording**: Live user journey recorder that captures sequential user flows, taps, text entries, and swipes.
- **Centralized Repository**: Organize elements, pages, and scenarios into projects with real-time bidirectional synchronization between Home, Scenarios, and the Repository.
- **Root-Cause Launch Diagnostics**: Context-aware launch failure hints provide actionable troubleshooting steps for port conflicts, offline devices, or permission issues.

---

## Prerequisites

AlgoScraper ships with Appium + Node and automatically downloads Google Android platform-tools (`adb`) on first launch if not already installed.

### Windows (Android Scraping)
- **USB Debugging**: Enabled on your physical Android device, or a running Android Emulator (AVD) from Android Studio.
- **Node.js**: [Node.js LTS](https://nodejs.org) (required only for running from source; not required for the packaged `.exe`).
- **Android Studio** *(Optional)*: If installed, AlgoScraper will automatically detect and use your existing Android SDK.

### macOS (iOS & Android Scraping)
- **For iOS**:
  - Xcode with Command Line Tools: `xcode-select --install`
  - Active iOS Simulator or a physically connected iPhone with Developer Mode enabled.
- **For Android**:
  - A running Android Emulator or a physical device with USB debugging enabled.
- **Node.js**: `brew install node` (for running from source).

---

## Getting the Code

### Command Line (macOS / Windows)

Clone the repository:
```bash
git clone https://github.com/AlgoShack/NewAlgoScrapperIOS.git
cd NewAlgoScrapperIOS
git checkout main
git pull origin main
```

If you already have the repository cloned, pull the latest changes:
```bash
git fetch origin
git pull origin main
```

### Android Studio (GUI)

If you are working inside Android Studio on Windows or macOS:
1. **Fetch**: From the top menu bar, click **`Git`** > **`Fetch`**.
2. **Pull**: Click **`Git`** > **`Pull...`**, verify branch is `origin/main`, and click **`Pull`** (or click the blue **⬇ Update Project** button in the top-right toolbar).

---

## Setup & Running in Development

Run this once after cloning or after pulling major updates:

```bash
# 1. Install root dependencies and setup Appium runtime
npm run setup

# 2. Launch the Electron application
npm start
```

> **What `npm run setup` does:**
> Installs root npm dependencies, configures the `appium-runtime` directory, downloads the bundled Node binary, and verifies drivers (UiAutomator2 on Windows/Mac, XCUITest on Mac).

---

## Building Distributable Packages

Build production-ready installers with a single command for your current host OS:

```bash
npm run make
```

### Output Locations:
Artifacts are generated in the `out/share/` directory:

| Host OS | Command | Generated Artifacts |
| :--- | :--- | :--- |
| **macOS** | `npm run make` or `npm run make:ios` | `AlgoScraper.app`, `AlgoScraper-*.dmg`, `AlgoScraper-*.zip` |
| **Windows** | `npm run make` or `npm run make:win` | `AlgoScraper-Setup-*.exe` (Standalone Windows Installer) |

> **Note for Windows Users**: On Windows, Windows SmartScreen may present an *"Unrecognized app"* prompt on initial launch. Click **More info** → **Run anyway**.

---

## Architecture & Workflow Overview

### Smart Swipe & Scroll Tracking
- Distinguishes genuine scroll travel from unscrollable pages or elastic rubber-band bounce effects.
- Elements entering or exiting the viewport are verified alongside a 28px vertical delta floor.
- If content did not actually scroll, no row is created and no XPath is stored in the table.
- A clean **"Scroll Complete"** dialog alerts you when the page boundary is reached.

### Customizable Auto-Adjusting Table
- **Default View**: Starts with 7 core columns visible (`#`, `Control Name`, `Control Type`, `Control ID`, `Page Name`, `Feature Name`, `Delete`).
- **Optional Columns**: `Identification Type`, `Control Value`, and `Node Name` can be toggled on via the Customize Columns dropdown.
- **Dynamic Sizing**: Automatically measures column header text and prevents CSS truncation. When many columns are checked, the table expands smoothly and enables horizontal scrolling without squashing text into `.....`.

### Centralized Repository & Real-Time Sync
- Scraped elements, pages, scenarios, and features are stored in a unified JSON format.
- Deletions, renames, and additions in the Repository automatically reflect on the Home workspace and vice versa.
- Export payloads follow the standardized AlgoQA automation schema.

---

## Troubleshooting & FAQs

#### Q: Appium says "port 4723 is in use" or fails to start.
> **Fix**: AlgoScraper automatically attempts to release hung Appium instances. If an external Appium server was started manually, stop it or run `npx kill-port 4723` in your terminal.

#### Q: Android device is plugged in but doesn't appear in the dropdown.
> **Fix**: Verify USB Debugging is turned on in Developer Options. Run `adb devices` in your terminal to ensure the device is listed as `device` (not `unauthorized`).

#### Q: iOS Simulator or device launch fails with WebDriverAgent error.
> **Fix**: Ensure Xcode Command Line Tools are active (`sudo xcode-select -s /Applications/Xcode.app`). For physical iOS devices, verify that the device is paired and trusted on your Mac.

---

## License & Support
Developed and maintained by **[algoShack](https://algoshack.com)**. For questions, feature requests, or support, reach out to your algoShack representative.
