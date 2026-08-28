#!/usr/bin/env node
/**
 * =============================================================================
 * AlgoScraper setup (scripts/setup.js) — run once: `npm run setup`
 * =============================================================================
 * What it does:
 *   1) Resolves system npm-cli.js (never broken local node_modules/.bin/npm@3)
 *   2) npm install at repo root (Electron app)
 *   3) Downloads bundled Node → ./bundled-node (Appium runner)
 *   4) npm install inside appium-runtime/ (Appium + drivers)
 *   5) Ensures drivers: uiautomator2 (Android), xcuitest (iOS)
 *
 * Windows note: all child processes use spawnSync WITHOUT shell:true and run
 * npm via `node <npm-cli.js> ...` so paths with spaces (Program Files, project
 * folder names) never hang on cmd.exe quoting.
 * =============================================================================
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const APPIUM_RUNTIME = path.resolve(ROOT, 'appium-runtime');

function cleanPathEnv() {
    const parts = String(process.env.PATH || '')
        .split(path.delimiter)
        .filter(Boolean)
        // Never prefer project-local npm shims (can be ancient npm@3)
        .filter((p) => !p.includes(`${path.sep}node_modules${path.sep}.bin`));
    return parts.join(path.delimiter);
}

/** Env for child npm/node: clean PATH + drop invalid/sandbox npm overrides. */
function childEnv(extraEnv = {}) {
    const env = {
        ...process.env,
        PATH: cleanPathEnv(),
        ...extraEnv
    };
    // Cursor agent injects npm_config_devdir (invalid) and a sandbox npm cache
    // that can break arborist rollback on Windows (ERR_INVALID_ARG_TYPE).
    for (const key of Object.keys(env)) {
        const lower = key.toLowerCase();
        if (lower === 'npm_config_devdir') {
            delete env[key];
            continue;
        }
        if (lower === 'npm_config_cache') {
            const val = String(env[key] || '');
            if (/cursor-sandbox-cache/i.test(val)) {
                delete env[key];
            }
        }
    }
    // Keep npm cache under the user profile (absolute, no relative path surprises)
    if (!env.npm_config_cache && !env.NPM_CONFIG_CACHE) {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        if (home) {
            env.npm_config_cache = path.join(home, '.npm');
        }
    }
    return env;
}

/** Turn a discovered npm.cmd / npm shim into npm-cli.js next to Node. */
function npmCliJsFromHint(hintPath) {
    if (!hintPath) return null;
    const resolved = path.resolve(hintPath);
    // Direct hit
    if (/npm-cli\.js$/i.test(resolved) && fs.existsSync(resolved)) {
        return resolved;
    }
    // npm.cmd / npm beside nodejs → node_modules/npm/bin/npm-cli.js
    const dir = path.dirname(resolved);
    const beside = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(beside)) return beside;

    // Some installs put npm in APPDATA\npm — walk up from there is unreliable;
    // try dirname(node) via process.execPath instead (handled by candidates).
    return null;
}

/**
 * Resolve the real npm CLI entry (JS file), not npm.cmd.
 * Running `node npm-cli.js` avoids Windows shell/.cmd path quoting issues.
 */
function resolveNpmCliJs() {
    const candidates = [];

    // 1) npm bundled next to the Node that is running this script
    candidates.push(
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    );

    // 2) Discover via `where` / `command -v`, then map to npm-cli.js
    try {
        const cmd = process.platform === 'win32' ? 'where.exe npm' : 'command -v npm';
        const found = spawnSync(cmd, {
            encoding: 'utf8',
            shell: process.platform !== 'win32', // where.exe needs no shell; unix needs shell for command -v
            env: childEnv(),
            windowsHide: true
        });
        const lines = String(found.stdout || '')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        for (const line of lines) {
            const mapped = npmCliJsFromHint(line);
            if (mapped) candidates.push(mapped);
            if (process.platform === 'win32' && !/\.cmd$/i.test(line)) {
                const asCmd = `${line}.cmd`;
                const mappedCmd = npmCliJsFromHint(asCmd);
                if (mappedCmd) candidates.push(mappedCmd);
            }
        }
    } catch (_) {}

    // 3) Well-known install locations (path.join — no hardcoded slash style)
    if (process.platform === 'win32') {
        const programFiles = process.env.ProgramFiles || path.join('C:', 'Program Files');
        const programFilesX86 = process.env['ProgramFiles(x86)'] || path.join('C:', 'Program Files (x86)');
        const localAppData = process.env.LOCALAPPDATA || '';
        const appData = process.env.APPDATA || '';
        candidates.push(
            path.join(programFiles, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
            path.join(programFilesX86, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
            localAppData ? path.join(localAppData, 'Programs', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js') : '',
            appData ? path.join(appData, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js') : ''
        );
    } else {
        candidates.push(
            '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
            '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
            path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
        );
    }

    for (const c of candidates) {
        if (c && fs.existsSync(c)) {
            return path.resolve(c);
        }
    }

    throw new Error(
        'Could not find npm-cli.js. Install Node.js from https://nodejs.org and retry.'
    );
}

/**
 * Spawn without shell — argv paths with spaces are safe on Windows & macOS.
 */
function run(command, args, cwd, extraEnv = {}) {
    const absCwd = path.resolve(cwd);
    console.log(`\n> ${command} ${args.join(' ')}`);
    console.log(`  cwd: ${absCwd}`);
    const result = spawnSync(command, args, {
        cwd: absCwd,
        stdio: 'inherit',
        env: childEnv(extraEnv),
        shell: false,
        windowsHide: true
    });
    if (result.error) {
        console.error('Spawn failed:', result.error.message || result.error);
        process.exit(1);
    }
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

function runNpm(npmCliJs, args, cwd, extraEnv = {}) {
    // node <absolute-npm-cli.js> install ...
    run(process.execPath, [npmCliJs, ...args], cwd, extraEnv);
}

function removeBrokenLocalNpm() {
    const localNpm = path.join(ROOT, 'node_modules', 'npm');
    const binDir = path.join(ROOT, 'node_modules', '.bin');
    if (fs.existsSync(localNpm)) {
        console.log('Removing broken local npm package from node_modules (npm@3 shadow)...');
        fs.rmSync(localNpm, { recursive: true, force: true });
    }
    for (const name of ['npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1']) {
        try {
            const p = path.join(binDir, name);
            if (fs.existsSync(p)) fs.rmSync(p, { force: true });
        } catch (_) {}
    }
}

function installAppiumDriver(npmCliJs, driverName) {
    console.log(`\n> ensure appium driver: ${driverName}`);
    const result = spawnSync(
        process.execPath,
        [npmCliJs, 'exec', '--', 'appium', 'driver', 'install', driverName],
        {
            cwd: APPIUM_RUNTIME,
            encoding: 'utf8',
            env: childEnv({ APPIUM_HOME: APPIUM_RUNTIME }),
            shell: false,
            windowsHide: true
        }
    );

    if (result.error) {
        console.error('Spawn failed:', result.error.message || result.error);
        process.exit(1);
    }

    const out = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status === 0) {
        process.stdout.write(out);
        return;
    }

    if (/already installed/i.test(out)) {
        console.log(`Driver "${driverName}" already installed — OK`);
        return;
    }

    process.stdout.write(out);
    console.error(`Failed to install Appium driver: ${driverName}`);
    process.exit(result.status || 1);
}

function main() {
    const npmCliJs = resolveNpmCliJs();
    console.log('Using Node:', process.execPath);
    console.log('Using npm-cli.js:', npmCliJs);
    console.log('Project root:', ROOT);

    // Show versions for debugging
    run(process.execPath, ['-v'], ROOT);
    runNpm(npmCliJs, ['-v'], ROOT);

    removeBrokenLocalNpm();

    // 1) Root install
    runNpm(npmCliJs, ['install'], ROOT);

    // Local npm@3 may have been reinstalled by a transitive dep — remove again
    removeBrokenLocalNpm();

    // 2) Bundled Node for Appium (no user Node install needed at runtime)
    run(process.execPath, [path.join(ROOT, 'scripts', 'download-bundled-node.js')], ROOT);

    // 3) Appium runtime install + drivers
    if (!fs.existsSync(APPIUM_RUNTIME)) {
        throw new Error(`Missing appium-runtime folder at ${APPIUM_RUNTIME}`);
    }

    runNpm(npmCliJs, ['install'], APPIUM_RUNTIME, {
        APPIUM_HOME: APPIUM_RUNTIME,
        // Chromedriver CDN often fails / is unnecessary for native UI scraping
        APPIUM_SKIP_CHROMEDRIVER_INSTALL: '1'
    });

    // Install drivers into the bundled runtime home (ok if already installed)
    installAppiumDriver(npmCliJs, 'uiautomator2');
    installAppiumDriver(npmCliJs, 'xcuitest');

    console.log('\nSetup complete.');
    console.log('- Bundled Node: bundled-node/');
    console.log('- Bundled Appium: appium-runtime/');
    console.log('Next: npm start');
}

try {
    main();
} catch (err) {
    console.error('\nSetup failed:', err.message || err);
    process.exit(1);
}
