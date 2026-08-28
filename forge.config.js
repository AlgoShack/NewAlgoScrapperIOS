/**
 * Electron Forge packaging config.
 *
 * Bundles BOTH mobile automation stacks into the shipped app so end users
 * do not need system Node or system Appium:
 *   - ./appium-runtime  → Appium 2 + UiAutomator2 (Android) + XCUITest (iOS)
 *   - ./bundled-node    → Node binary used to spawn Appium (see scripts/download-bundled-node.js)
 *
 * Distributables:
 *   npm run make      → THIS machine only (Mac → iOS/Mac .app+dmg, Windows → Setup.exe)
 *   npm run make:ios  → Mac/iOS only (Mac required)
 *   npm run make:win  → Windows NSIS only
 */
const path = require('path');

module.exports = {
  packagerConfig: {
    // Force an absolute path so Electron Forge cannot fail to find it
    icon: path.resolve(__dirname, 'assets', 'algoScraper Logo'),

    executableName: 'AlgoScraper',
    appBundleId: 'com.algoshack.algoscraper',

    extendInfo: {
      CFBundleName: 'AlgoScraper',
      CFBundleDisplayName: 'AlgoScraper',
      // Required for packaged macOS builds so AlgoQA myapp:// API launches work
      CFBundleURLTypes: [
        {
          CFBundleURLName: 'AlgoScraper Protocol',
          CFBundleURLSchemes: ['myapp']
        }
      ]
    },

    asar: {
      // Keep Appium runtime (and XCUITest native bits) unpackaged for spawn/require.
      // Do NOT unpack src/*.js — renderer require() must resolve into app.asar node_modules.
      // Unpacking popup.js alone breaks all UI JS on Windows.
      unpackDir: '{appium-runtime,node_modules/appium-xcuitest-driver}'
    },

    // Copied next to the app as process.resourcesPath/{appium-runtime,bundled-node}
    extraResource: [
      "./appium-runtime",
      "./bundled-node"
    ],

    // Don't ship junk into the package (Xcode caches cause ENOSPC during copy)
    ignore: [
      /^\/appium-runtime\/\.appium-home($|\/)/,
      /^\/\.tmp-node-download($|\/)/,
      /^\/\.tmp-win-prune($|\/)/,
      /^\/out($|\/)/,
      /^\/algoScraper-builds($|\/)/,
      /^\/\.git($|\/)/,
      // Root Appium/XCUITest duplicates appium-runtime — huge + unused at runtime
      /^\/node_modules\/appium($|\/)/,
      /^\/node_modules\/appium-xcuitest-driver($|\/)/,
      // Xcode / Appium compile caches (any depth)
      /CompilationCache\.noindex($|\/)/i,
      /ModuleCache\.noindex($|\/)/i,
      /SDKStatCaches\.noindex($|\/)/i,
      /Intermediates\.noindex($|\/)/i,
      /DerivedData($|\/)/i,
      /\/\.cache($|\/)/
    ]
  },
  rebuildConfig: {},
  makers: [
    // macOS shareable disk image
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'AlgoScraper',
        title: 'AlgoScraper',
        icon: path.resolve(__dirname, 'assets', 'algoScraper Logo.icns'),
        format: 'ULFO'
      }
    },
    // Mac .zip is built in scripts/make-all.js (follows symlinks so Windows
    // Explorer can open/transfer the archive). Forge maker-zip stores Unix
    // symlinks → Windows reports "zip is invalid".
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
};
