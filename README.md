# AlgoScraper

Desktop app to scrape UI controls/locators for **Android** (UiAutomator2) and **iOS** (XCUITest) using bundled Appium.

| Host | What you can scrape |
|------|---------------------|
| **macOS** | Android + iOS |
| **Windows** | Android only (same UI/features as macOS Android) |

---

## 1. Get the code

```bash
git clone https://github.com/AlgoShack/AlgoScrapperIOS.git
cd AlgoScrapperIOS
git checkout main
git pull origin main
```

Already cloned? Update with:

```bash
git fetch origin
git pull origin main
```

---

## 2. Prerequisites

AlgoScraper ships Appium + Node, and **auto-installs Android platform-tools** (`adb`) on first run if they are missing. It sets `ANDROID_HOME` / `ANDROID_SDK_ROOT` itself — you do not need to configure those env vars.

It cannot ship an emulator image, USB drivers, or Xcode.

### Windows (dev + installed Setup.exe)

- First launch downloads Google **platform-tools** (~10–15 MB) if Android Studio is not already installed. Needs internet once.
- You still need a **running emulator** or a **phone with USB debugging**.
- If Android Studio is installed, AlgoScraper uses that SDK instead.

Dev-only extra: [Node.js LTS](https://nodejs.org) (not needed for the installed `.exe`).

### macOS (dev + installed .dmg)

Required to scrape **iOS**:
- Xcode + Command Line Tools (`xcode-select --install`)
- Optional helpers: CocoaPods, libimobiledevice, ios-deploy

**Android** on Mac: same auto-download of platform-tools as Windows. You still need an emulator or a USB device. iOS scrape does not need the Android SDK.

Dev-only extra: Node.js (`brew install node`).

---

## 3. Setup & run (dev)

One-time after clone or big pulls:

```bash
npm run setup
npm start
```

`npm run setup` installs root deps, `appium-runtime`, bundled Node, and drivers (UiAutomator2 + XCUITest on Mac).

---

## 4. Build distributable — one command

```bash
npm run make
```

Builds **only for the machine you are on**:

| Where you run it | Output (in `out/share/`) |
|------------------|--------------------------|
| **Mac** | iOS / macOS app: `AlgoScraper.app` + `.dmg` + `.zip` |
| **Windows** | Android installer: `AlgoScraper-Setup-*.exe` |

The Mac `.zip` is openable on Windows for **transfer only** (copy/share). The app inside still only runs on macOS — unzip and open `.app` on a Mac. Windows users who need to *run* AlgoScraper need `AlgoScraper-Setup-*.exe` from a Windows `npm run make`.

```bash
npm run make:ios   # Mac/iOS only (Mac required)
npm run make:win   # Windows Setup.exe only
```

---

## 5. Commands

| Command | What it does |
|---------|----------------|
| `git pull origin main` | Get latest code |
| `npm run setup` | Install deps + Appium runtime + drivers + bundled Node |
| `npm start` | Run app in development |
| `npm run make` | **This OS only** — Mac → iOS `.app`, Windows → Android `Setup.exe` |

---

## 6. Notes

- End users do **not** need a global Appium install — the app ships its own runtime + Node.
- End users do **not** need to set `ANDROID_HOME`. First launch downloads platform-tools if needed. A running emulator/phone is still required. Mac iOS scrape still needs Xcode.
- Windows Setup can take several minutes (large Appium payload) — wait if progress looks paused.
- Windows SmartScreen may warn on unsigned Setup → **More info → Run anyway** until code-signed.
- Spaces in the project path are OK.
