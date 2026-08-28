#!/usr/bin/env node
/**
 * =============================================================================
 * AlgoScraper make (scripts/make-all.js) — ONE host target per `npm run make`
 * =============================================================================
 *   npm run make          → THIS machine only
 *                           Mac     → AlgoScraper.app + .dmg + .zip  (iOS + Android scrape)
 *                           Windows → AlgoScraper-Setup-*.exe         (Android only)
 *   npm run make:ios      → Mac/iOS only (must run on a Mac)
 *   npm run make:win      → Windows Setup.exe only
 *
 * AUTOMATIC (no manual cleanup needed):
 *   • Clears electron-packager leftovers (common ENOSPC cause)
 *   • Removes Xcode *.noindex / Intermediates caches from node_modules
 *   • Clears old out/ artifacts for the target being built
 *   • Checks free disk and retries once if forge hits ENOSPC
 *
 * Never builds Mac + Windows together.
 * =============================================================================
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const SHARE_DIR = path.join(ROOT, 'out', 'share');
const WIN_INSTALLER_DIR = path.join(ROOT, 'out', 'windows-installer');

/** Quote an argv token for cmd.exe when shell:true (paths with spaces). */
function quoteForWinShell(arg) {
    const s = String(arg);
    if (!/[ \t"]/.test(s)) return s;
    return `"${s.replace(/"/g, '""')}"`;
}

function run(cmd, args, opts = {}) {
    console.log(`\n════════════════════════════════════════`);
    console.log(`>>> ${cmd} ${args.join(' ')}`);
    console.log(`════════════════════════════════════════\n`);
    // Prefer shell:false so paths with spaces never hang (same approach as setup.js).
    // On Windows, npx/npm may be .cmd — fall back to shell only for those shims.
    // When shell:true, Node joins args with spaces; quote tokens so paths like
    // "...\algoScraper Android\..." are not split (electron-builder --prepackaged).
    const needsShell = process.platform === 'win32' && !path.isAbsolute(cmd)
        && !cmd.endsWith('.exe') && !cmd.endsWith('.cmd');
    const spawnArgs = needsShell ? args.map(quoteForWinShell) : args;
    const result = spawnSync(cmd, spawnArgs, {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, ...opts.env },
        shell: needsShell,
        windowsHide: true
    });
    if (result.error) {
        throw new Error(`Spawn failed: ${result.error.message || result.error}`);
    }
    if (result.status !== 0) {
        throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(' ')}`);
    }
}

function runNode(scriptArgs) {
    run(process.execPath, scriptArgs);
}

function downloadBundledNode(platform, arch) {
    const marker = path.join(ROOT, 'bundled-node', '.platform');
    const want = `${platform}-${arch}`;
    const binName = platform === 'win32' ? 'node.exe' : 'node';
    const binPath = path.join(ROOT, 'bundled-node', binName);
    if (fs.existsSync(binPath) && fs.existsSync(marker)) {
        try {
            if (fs.readFileSync(marker, 'utf8').trim() === want) {
                console.log(`   bundled-node already ${want} — skip download`);
                return;
            }
        } catch (_) {}
    }
    runNode([
        path.join('scripts', 'download-bundled-node.js'),
        '--platform', platform,
        '--arch', arch
    ]);
    try {
        fs.writeFileSync(marker, want, 'utf8');
    } catch (_) {}
}

function ensureShareDir() {
    fs.mkdirSync(SHARE_DIR, { recursive: true });
}

function copyFilesToShare(files, label) {
    ensureShareDir();
    const copied = [];
    for (const full of files) {
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
        const dest = path.join(SHARE_DIR, path.basename(full));
        fs.copyFileSync(full, dest);
        const st = fs.statSync(dest);
        copied.push({
            label,
            file: dest,
            sizeMB: (st.size / (1024 * 1024)).toFixed(1)
        });
    }
    return copied;
}

function folderSizeMB(dir) {
    let bytes = 0;
    const walk = (p) => {
        let st;
        try { st = fs.lstatSync(p); } catch (_) { return; }
        if (st.isSymbolicLink() || st.isFile()) {
            bytes += st.size;
            return;
        }
        if (!st.isDirectory()) return;
        let names = [];
        try { names = fs.readdirSync(p); } catch (_) { return; }
        for (const name of names) walk(path.join(p, name));
    };
    walk(dir);
    return (bytes / (1024 * 1024)).toFixed(1);
}

function copyDirToShare(srcDir, destName, label) {
    ensureShareDir();
    const dest = path.join(SHARE_DIR, destName);
    if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.cpSync(srcDir, dest, { recursive: true });
    return [{
        label,
        file: dest,
        sizeMB: folderSizeMB(dest)
    }];
}

function findPackagedMacApp(arch) {
    const outDir = path.join(ROOT, 'out');
    const preferred = [
        path.join(outDir, `AlgoScraper-darwin-${arch}`, 'AlgoScraper.app'),
        path.join(outDir, `algoscraper-darwin-${arch}`, 'AlgoScraper.app')
    ];
    for (const p of preferred) {
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    }
    if (!fs.existsSync(outDir)) return null;
    for (const name of fs.readdirSync(outDir)) {
        const appPath = path.join(outDir, name, 'AlgoScraper.app');
        if (!name.toLowerCase().includes('darwin')) continue;
        if (fs.existsSync(appPath) && fs.statSync(appPath).isDirectory()) return appPath;
    }
    return null;
}

function collectByExt(rootDir, exts) {
    if (!fs.existsSync(rootDir)) return [];
    const out = [];
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const st = fs.statSync(full);
            if (st.isDirectory()) {
                walk(full);
                continue;
            }
            if (exts.some((ext) => name.toLowerCase().endsWith(ext))) {
                out.push(full);
            }
        }
    };
    walk(rootDir);
    return out;
}

/**
 * Run every disk / cache cleanup automatically before packaging.
 * Called by `npm run make` / `make:win` — user should not need manual rm.
 */
function cleanOldWindowsOut() {
    const outDir = path.join(ROOT, 'out');
    if (!fs.existsSync(outDir)) return;
    for (const name of fs.readdirSync(outDir)) {
        const lower = name.toLowerCase();
        // Only wipe previous Windows package / installer outputs (keep Mac artifacts)
        if (!(lower.includes('win32') || lower.includes('windows-installer') || lower.includes('win-'))) {
            continue;
        }
        const full = path.join(outDir, name);
        if (forceRemovePath(full)) {
            console.log(`  removed old Windows out: ${name}`);
        }
    }
}

function autoPrepareDiskForMake(kind) {
    console.log('\n🧹 Auto-preparing disk for packaging…');
    cleanPackagerTemp();
    cleanIosRuntimeJunk();
    if (kind === 'ios') {
        cleanOldDarwinOut();
    } else if (kind === 'win') {
        cleanOldWindowsOut();
    }
    cleanPackagerTemp();
    assertDiskSpace(kind === 'ios' ? 6 : 5);
    console.log('🧹 Prep done.\n');
}

/**
 * Run forge make/package. If it fails (often ENOSPC with inherited stdio),
 * wipe temps/caches once and retry automatically — no manual cleanup needed.
 */
function runForgeWithEnospcRetry(kind, forgeFn) {
    try {
        forgeFn();
        return;
    } catch (firstErr) {
        const msg = String((firstErr && firstErr.message) || firstErr || '');
        console.warn('\n⚠️  Packaging failed — auto-cleaning disk caches/temp and retrying once…');
        console.warn(`   (${msg.split('\n')[0]})\n`);
        cleanPackagerTemp();
        cleanIosRuntimeJunk();
        if (kind === 'ios') cleanOldDarwinOut();
        cleanPackagerTemp();
        try {
            assertDiskSpace(4);
        } catch (spaceErr) {
            throw spaceErr;
        }
        forgeFn();
    }
}

function forgeMake(platform, arch) {
    run('npx', [
        'electron-forge', 'make',
        '--platform', platform,
        '--arch', arch
    ]);
}

function forgePackage(platform, arch) {
    run('npx', [
        'electron-forge', 'package',
        '--platform', platform,
        '--arch', arch
    ]);
}

/** Best-effort recursive delete (chmod + rm -rf on macOS when Node rm fails). */
function forceRemovePath(full) {
    if (!fs.existsSync(full)) return false;
    try {
        fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 });
        return !fs.existsSync(full);
    } catch (_) {}
    if (process.platform === 'darwin' || process.platform === 'linux') {
        try {
            spawnSync('chmod', ['-R', 'u+w', full], { stdio: 'ignore' });
            const r = spawnSync('rm', ['-rf', full], { stdio: 'ignore' });
            return r.status === 0 && !fs.existsSync(full);
        } catch (_) {}
    }
    return false;
}

/** Remove leftover electron-packager temp dirs that cause ENOSPC on Mac builds. */
function cleanPackagerTemp() {
    const tmpRoot = os.tmpdir();
    let removed = 0;
    const targets = [];
    try {
        // Common layout: <tmpdir>/electron-packager/tmp-XXXX
        targets.push(path.join(tmpRoot, 'electron-packager'));
        for (const name of fs.readdirSync(tmpRoot)) {
            if (name.startsWith('electron-packager')) {
                targets.push(path.join(tmpRoot, name));
            }
        }
    } catch (_) {}

    for (const full of [...new Set(targets)]) {
        if (!fs.existsSync(full)) continue;
        if (forceRemovePath(full)) {
            removed += 1;
            console.log(`  cleared packager temp: ${full}`);
        } else {
            console.warn(`  could not clear packager temp: ${full}`);
        }
    }
    if (!removed) {
        console.log('  no electron-packager temp folders to clear');
    }
}

/**
 * Drop Xcode / Appium compile caches from BOTH root node_modules and appium-runtime.
 * These *.noindex folders are what trigger ENOSPC during electron-packager copy.
 * Keeps Build/Products (needed for WDA).
 */
function cleanIosRuntimeJunk() {
    const roots = [
        path.join(ROOT, 'node_modules'),
        path.join(ROOT, 'appium-runtime', 'node_modules')
    ];
    const junkNames = new Set([
        'CompilationCache.noindex',
        'ModuleCache.noindex',
        'SDKStatCaches.noindex',
        'Intermediates.noindex',
        'DerivedData',
        '.cache'
    ]);

    let freedHint = 0;
    const walk = (dir, depth) => {
        if (!fs.existsSync(dir) || depth > 8) return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            return;
        }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (!ent.isDirectory()) continue;
            if (junkNames.has(ent.name)) {
                if (forceRemovePath(full)) {
                    freedHint += 1;
                    console.log(`  removed package junk: ${path.relative(ROOT, full)}`);
                } else {
                    console.warn(`  could not remove ${full}`);
                }
                continue;
            }
            walk(full, depth + 1);
        }
    };

    for (const root of roots) walk(root, 0);
    if (!freedHint) {
        console.log('  no Xcode/Appium cache junk found to remove');
    }
}

/** Fail early with a clear message instead of cryptic ENOSPC mid-copy. */
function assertDiskSpace(minGB = 6) {
    let freeBytes = null;
    try {
        if (typeof fs.statfsSync === 'function') {
            const s = fs.statfsSync(ROOT);
            freeBytes = Number(s.bavail) * Number(s.bsize);
        }
    } catch (_) {}
    if (freeBytes == null && process.platform === 'darwin') {
        try {
            const df = spawnSync('df', ['-k', ROOT], { encoding: 'utf8' });
            const line = String(df.stdout || '').trim().split('\n').pop() || '';
            const parts = line.split(/\s+/);
            // df -k: Filesystem 1024-blocks Used Available Capacity ...
            if (parts.length >= 4) freeBytes = parseInt(parts[3], 10) * 1024;
        } catch (_) {}
    }
    if (freeBytes == null || Number.isNaN(freeBytes)) {
        console.warn('  could not measure free disk space — continuing');
        return;
    }
    const freeGB = freeBytes / (1024 ** 3);
    console.log(`  free disk space: ${freeGB.toFixed(1)} GB`);
    if (freeBytes < minGB * 1024 ** 3) {
        throw new Error(
            `Not enough free disk space for packaging (${freeGB.toFixed(1)} GB free, need ~${minGB}+ GB).\n`
            + `Free space then retry. Tip: delete leftover packager temp:\n`
            + `  rm -rf "$TMPDIR/electron-packager"\n`
            + `  rm -rf out/make out/*darwin* out/*mac*`
        );
    }
}

/**
 * Free space before iOS make: old darwin package dirs under out/.
 * Windows folders (AlgoScraper-win32-*, windows-installer) are left alone.
 */
function cleanOldDarwinOut() {
    const outDir = path.join(ROOT, 'out');
    if (!fs.existsSync(outDir)) return;
    for (const name of fs.readdirSync(outDir)) {
        const lower = name.toLowerCase();
        if (lower.includes('win')) continue;
        if (!(lower.includes('darwin') || lower.includes('mac') || lower.endsWith('.app'))) continue;
        const full = path.join(outDir, name);
        try {
            fs.rmSync(full, { recursive: true, force: true });
            console.log(`  removed old darwin out: ${name}`);
        } catch (err) {
            console.warn(`  could not remove ${full}: ${err.message || err}`);
        }
    }
    const makeDir = path.join(outDir, 'make');
    if (fs.existsSync(makeDir)) {
        try {
            fs.rmSync(makeDir, { recursive: true, force: true });
            console.log('  cleared out/make (will be recreated)');
        } catch (err) {
            console.warn(`  could not clear out/make: ${err.message || err}`);
        }
    }
}

function findPackagedWinApp(arch) {
    const outDir = path.join(ROOT, 'out');
    if (!fs.existsSync(outDir)) {
        throw new Error('out/ missing after electron-forge package');
    }

    const preferred = [
        path.join(outDir, `AlgoScraper-win32-${arch}`),
        path.join(outDir, `algoscraper-win32-${arch}`)
    ];
    for (const p of preferred) {
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    }

    const match = fs.readdirSync(outDir)
        .map((n) => path.join(outDir, n))
        .filter((p) => fs.statSync(p).isDirectory())
        .find((p) => {
            const base = path.basename(p).toLowerCase();
            return base.includes('win32') && base.includes(arch) && !base.includes('make') && !base.includes('share') && !base.includes('installer');
        });

    if (!match) {
        throw new Error(`Could not find packaged Windows app under out/ (expected AlgoScraper-win32-${arch})`);
    }
    return match;
}

/**
 * Windows does not need XCUITest (~300MB) or TypeScript tooling.
 * Park them outside appium-runtime during forge package, then restore.
 */
function pruneAppiumRuntimeForWindows() {
    const nm = path.join(ROOT, 'appium-runtime', 'node_modules');
    const parkRoot = path.join(ROOT, '.tmp-win-prune');
    const moves = [
        'appium-xcuitest-driver',
        'typescript',
        'ts-node'
    ];

    if (fs.existsSync(parkRoot)) {
        fs.rmSync(parkRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(parkRoot, { recursive: true });

    const parked = [];
    for (const name of moves) {
        const from = path.join(nm, name);
        if (!fs.existsSync(from)) continue;
        const to = path.join(parkRoot, name);
        // Prefer rename; fall back to copy+remove so a failed restore never loses XCUITest
        try {
            fs.renameSync(from, to);
        } catch (_) {
            fs.cpSync(from, to, { recursive: true });
            fs.rmSync(from, { recursive: true, force: true });
        }
        parked.push(name);
        console.log(`  pruned for Windows package: ${name}`);
    }

    // Drop caches that bloat the installer
    const cacheDir = path.join(nm, '.cache');
    if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        console.log('  cleared appium-runtime node_modules/.cache');
    }

    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        for (const name of parked) {
            const from = path.join(parkRoot, name);
            const to = path.join(nm, name);
            if (!fs.existsSync(from)) continue;
            try {
                if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
                try {
                    fs.renameSync(from, to);
                } catch (_) {
                    fs.cpSync(from, to, { recursive: true });
                    fs.rmSync(from, { recursive: true, force: true });
                }
                console.log(`  restored after Windows package: ${name}`);
            } catch (err) {
                console.error(`  FAILED to restore ${name}:`, err.message || err);
                console.error(`  Manual fix: move ${from} → ${to}`);
            }
        }
        try {
            fs.rmSync(parkRoot, { recursive: true, force: true });
        } catch (_) {}
    };

    // Also restore if the process is interrupted mid-build
    process.once('exit', restore);
    process.once('SIGINT', () => { restore(); process.exit(130); });
    process.once('SIGTERM', () => { restore(); process.exit(143); });

    return restore;
}

/**
 * Build a real Windows NSIS Setup installer (installs into Program Files, Start Menu, etc.)
 * Works from macOS and Windows via electron-builder --prepackaged.
 */
function buildWindowsNsisInstaller(packagedDir) {
    if (fs.existsSync(WIN_INSTALLER_DIR)) {
        fs.rmSync(WIN_INSTALLER_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(WIN_INSTALLER_DIR, { recursive: true });

    console.log(`\n📦 Creating Windows NSIS installer from:\n   ${packagedDir}\n`);
    console.log('   (This can take several minutes for a large Appium payload — not stuck.)\n');

    // Run via node + local cli.js (shell:false) so --prepackaged paths with spaces work on Windows.
    const ebCli = require.resolve('electron-builder/cli.js');
    run(process.execPath, [
        ebCli,
        '--prepackaged', packagedDir,
        '--win', 'nsis',
        '--x64',
        '--config', 'electron-builder.yml'
    ]);

    // Prefer Setup installer artifacts; ignore blockmap / yml helpers for sharing
    const installers = collectByExt(WIN_INSTALLER_DIR, ['.exe']).filter((f) => {
        const name = path.basename(f).toLowerCase();
        // NSIS output is typically AlgoScraper-Setup-1.0.0.exe
        return name.includes('setup') || name.includes('installer') || name.endsWith('.exe');
    });

    if (!installers.length) {
        throw new Error(`NSIS installer not found in ${WIN_INSTALLER_DIR}`);
    }

    return copyFilesToShare(installers, 'windows-nsis-installer');
}

/**
 * iOS / macOS distributable only (mirror of make:win).
 * Keeps XCUITest + UiAutomator2 so the Mac app can scrape iOS simulators/devices
 * and Android. Must run on a Mac.
 */
/**
 * Zip AlgoScraper.app by *following* symlinks (no `zip -y`).
 * Electron's Forge zip stores Unix symlink entries; Windows Explorer then says
 * the archive is invalid. This zip opens on Windows for transfer/copy; the app
 * still only runs on macOS (install/run on a Mac).
 */
function createWindowsOpenableMacZip(appPath, arch) {
    const version = (() => {
        try {
            return require(path.join(ROOT, 'package.json')).version || '1.0.0';
        } catch (_) {
            return '1.0.0';
        }
    })();
    const zipName = `AlgoScraper-darwin-${arch}-${version}.zip`;
    const outDir = path.join(ROOT, 'out', 'make', 'zip', 'darwin', arch);
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, zipName);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    const appParent = path.dirname(appPath);
    const appName = path.basename(appPath);
    console.log(`\n📦 Creating Windows-openable Mac zip (follows symlinks): ${zipName}`);
    // Do NOT pass -y — that stores symlink entries Windows cannot open.
    const result = spawnSync('zip', ['-r', '-q', zipPath, appName], {
        cwd: appParent,
        stdio: 'inherit'
    });
    if (result.error) {
        throw new Error(`zip failed: ${result.error.message || result.error}`);
    }
    if (result.status !== 0) {
        throw new Error(`zip exited ${result.status} while creating ${zipName}`);
    }
    if (!fs.existsSync(zipPath)) {
        throw new Error(`Expected zip missing: ${zipPath}`);
    }
    return zipPath;
}

function buildIOS() {
    if (process.platform !== 'darwin') {
        throw new Error(
            'Mac/iOS build must run on a Mac.\n'
            + 'On Windows use:  npm run make'
        );
    }

    const arch = process.arch === 'x64' ? 'x64' : 'arm64';
    console.log(`\n🍎 Building iOS / macOS distributable (${arch})…`);
    console.log('   Keeping XCUITest + UiAutomator2 in appium-runtime (full dual-platform).');

    autoPrepareDiskForMake('ios');

    // Ensure iOS driver is present (Windows prune may have left a park folder)
    const xcuitest = path.join(ROOT, 'appium-runtime', 'node_modules', 'appium-xcuitest-driver');
    if (!fs.existsSync(xcuitest)) {
        console.warn('   Warning: appium-xcuitest-driver missing — run npm run setup first.');
    }

    downloadBundledNode('darwin', arch);
    // Last wipe right before forge (failed runs leave multi‑GB tmp trees)
    cleanPackagerTemp();
    assertDiskSpace(5);
    runForgeWithEnospcRetry('ios', () => forgeMake('darwin', arch));
    cleanPackagerTemp();

    const artifacts = [];
    const appPath = findPackagedMacApp(arch);
    if (appPath) {
        artifacts.push(...copyDirToShare(appPath, 'AlgoScraper.app', `macos-app-${arch}`));
        try {
            const zipPath = createWindowsOpenableMacZip(appPath, arch);
            artifacts.push(...copyFilesToShare([zipPath], `ios-macOS-zip-${arch}`));
        } catch (err) {
            console.warn('   Warning: could not create Windows-openable zip:', err.message || err);
        }
    }

    const macFiles = collectByExt(path.join(ROOT, 'out', 'make'), ['.dmg'])
        .filter((f) => !path.basename(f).toLowerCase().includes('win'));
    artifacts.push(...copyFilesToShare(macFiles, `ios-macOS-${arch}`));

    if (!artifacts.length) {
        throw new Error('No .app / .dmg / .zip found after iOS/macOS build');
    }

    return artifacts;
}

function buildWindows() {
    const arch = 'x64';
    console.log(`\n🪟 Building Windows NSIS installer (${arch})…`);
    console.log('   1) Prune XCUITest  2) forge package  3) electron-builder NSIS');
    console.log('   (Windows Android installer only — not combined with Mac make.)');

    autoPrepareDiskForMake('win');
    downloadBundledNode('win32', arch);

    const restoreRuntime = pruneAppiumRuntimeForWindows();
    try {
        // 1) Package the Windows app (Android Appium only → much smaller Setup)
        runForgeWithEnospcRetry('win', () => forgePackage('win32', arch));
        const packagedDir = findPackagedWinApp(arch);

        // 2) Wrap packaged app into an NSIS Setup installer (not a portable exe zip)
        return buildWindowsNsisInstaller(packagedDir);
    } finally {
        restoreRuntime();
        cleanPackagerTemp();
    }
}

function restoreHostNode() {
    try {
        downloadBundledNode(process.platform, process.arch === 'ia32' ? 'x86' : process.arch);
    } catch (err) {
        console.warn('Could not restore host bundled-node:', err.message || err);
    }
}

function parseTargets() {
    // No arg → build for THIS OS only (Mac = iOS/Mac, Windows = Android Setup.exe)
    const raw = process.argv[2];
    const arg = (raw == null || raw === '' ? 'host' : String(raw)).toLowerCase();

    if (arg === 'host' || arg === 'default' || arg === 'auto') {
        if (process.platform === 'win32') return ['win'];
        if (process.platform === 'darwin') return ['ios'];
        throw new Error(`Unsupported host platform for make: ${process.platform}`);
    }
    if (arg === 'win' || arg === 'win32' || arg === 'windows') return ['win'];
    if (arg === 'ios' || arg === 'mac' || arg === 'darwin' || arg === 'macos') return ['ios'];
    if (arg === 'all' || arg === 'both') {
        throw new Error(
            'Do not build Mac + Windows together.\n'
            + '  Mac:      npm run make          → iOS / macOS .app\n'
            + '  Windows:  npm run make          → Android Setup.exe\n'
            + '  Overrides: npm run make:ios  |  npm run make:win'
        );
    }
    throw new Error(`Unknown target "${arg}". Use: npm run make   (this machine only)`);
}

function main() {
    const targets = parseTargets();
    const all = [];
    const isWinOnly = targets.length === 1 && targets[0] === 'win';
    const isIosOnly = targets.length === 1 && targets[0] === 'ios';

    console.log('AlgoScraper distributable build (this machine only)');
    console.log(`Host: ${process.platform}-${process.arch}`);
    console.log(`Target: ${targets[0]}${!process.argv[2] ? '  ← npm run make' : ''}`);

    try {
        if (isIosOnly) {
            all.push(...buildIOS());
        } else if (isWinOnly) {
            all.push(...buildWindows());
        }
    } finally {
        if (isWinOnly && process.platform === 'darwin') {
            restoreHostNode();
        }
    }

    console.log('\n════════════════════════════════════════');
    console.log('✅ Build complete — share these files:');
    console.log(`   Folder: ${SHARE_DIR}`);
    console.log('════════════════════════════════════════');
    if (!all.length) {
        console.log('(No artifacts collected — check out/share/)');
    } else {
        const seen = new Set();
        for (const a of all) {
            if (seen.has(a.file)) continue;
            seen.add(a.file);
            console.log(`  • ${path.basename(a.file)}  (${a.sizeMB} MB)`);
        }
    }
    if (isIosOnly) {
        console.log(`
Mac / iOS: send AlgoScraper.app, the .dmg, or the .zip.
  The .zip opens on Windows for transfer; the app still only runs on a Mac.
  Includes XCUITest (iOS) + UiAutomator2 (Android).
`);
    } else {
        console.log(`
Windows Android: send AlgoScraper-Setup-*.exe.
  Install can take several minutes. SmartScreen "not safe" is expected until signed
  (More info → Run anyway).
`);
    }
}

main();
