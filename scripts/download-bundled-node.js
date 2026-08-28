#!/usr/bin/env node
/**
 * =============================================================================
 * Download bundled Node.js → ./bundled-node
 * =============================================================================
 * WHY: AlgoScraper spawns Appium with this Node binary so users do not need
 *      a system Node install. Used by main.js resolveAppiumNodeBinary().
 *
 * BOTH platforms share the same Node process; mobile drivers differ:
 *   Android → UiAutomator2 (in appium-runtime)
 *   iOS     → XCUITest      (in appium-runtime)
 *
 * Usage:
 *   node scripts/download-bundled-node.js
 *   node scripts/download-bundled-node.js --platform darwin --arch arm64
 * =============================================================================
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');

const NODE_VERSION = process.env.BUNDLED_NODE_VERSION || '20.18.1';
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, 'bundled-node');

/** Spawn without shell so paths with spaces never hang on Windows. */
function runNoShell(command, args, opts = {}) {
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        shell: false,
        windowsHide: true,
        ...opts
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} exited with code ${result.status || 1}`);
    }
    return result;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const out = {
        platform: process.platform,
        arch: process.arch
    };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--platform' && args[i + 1]) out.platform = args[++i];
        if (args[i] === '--arch' && args[i + 1]) out.arch = args[++i];
    }
    // Normalize electron-packager / forge arch names
    if (out.arch === 'ia32') out.arch = 'x86';
    if (out.arch === 'x64') out.arch = 'x64';
    if (out.arch === 'arm64') out.arch = 'arm64';
    return out;
}

function distSlug(platform, arch) {
    if (platform === 'darwin') {
        if (arch === 'arm64') return `node-v${NODE_VERSION}-darwin-arm64`;
        return `node-v${NODE_VERSION}-darwin-x64`;
    }
    if (platform === 'win32') {
        if (arch === 'x86' || arch === 'ia32') return `node-v${NODE_VERSION}-win-x86`;
        return `node-v${NODE_VERSION}-win-x64`;
    }
    // linux
    if (arch === 'arm64') return `node-v${NODE_VERSION}-linux-arm64`;
    return `node-v${NODE_VERSION}-linux-x64`;
}

function archiveName(platform, slug) {
    if (platform === 'win32') return `${slug}.zip`;
    return `${slug}.tar.gz`;
}

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const getter = url.startsWith('https') ? https : http;

        const request = (currentUrl, redirectsLeft) => {
            getter.get(currentUrl, (res) => {
                if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                    res.resume();
                    request(res.headers.location, redirectsLeft - 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`Download failed ${res.statusCode} for ${currentUrl}`));
                    res.resume();
                    return;
                }
                res.pipe(file);
                file.on('finish', () => file.close(() => resolve(dest)));
            }).on('error', (err) => {
                try { fs.unlinkSync(dest); } catch (_) {}
                reject(err);
            });
        };

        request(url, 5);
    });
}

function rimraf(target) {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

async function main() {
    const { platform, arch } = parseArgs();
    const slug = distSlug(platform, arch);
    const archive = archiveName(platform, slug);
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archive}`;
    const tmpDir = path.join(ROOT, '.tmp-node-download');
    const archivePath = path.join(tmpDir, archive);

    console.log(`Downloading Node.js v${NODE_VERSION} for ${platform}/${arch}`);
    console.log(`URL: ${url}`);

    rimraf(tmpDir);
    ensureDir(tmpDir);
    ensureDir(OUT_DIR);

    await download(url, archivePath);
    console.log('Extracting...');

    const extractDir = path.join(tmpDir, 'extract');
    ensureDir(extractDir);

    if (platform === 'win32') {
        // Extract Windows Node zip on any host (needed when packaging win32 from macOS)
        if (process.platform === 'win32') {
            try {
                // Single -Command string; -LiteralPath handles spaces (no cmd.exe shell)
                const psPath = archivePath.replace(/'/g, "''");
                const psDest = extractDir.replace(/'/g, "''");
                runNoShell('powershell.exe', [
                    '-NoProfile',
                    '-Command',
                    `Expand-Archive -LiteralPath '${psPath}' -DestinationPath '${psDest}' -Force`
                ]);
            } catch (_) {
                runNoShell('tar', ['-xf', archivePath, '-C', extractDir]);
            }
        } else {
            runNoShell('unzip', ['-o', archivePath, '-d', extractDir]);
        }
    } else {
        runNoShell('tar', ['-xzf', archivePath, '-C', extractDir]);
    }

    const extractedRoot = path.join(extractDir, slug);
    const binaryName = platform === 'win32' ? 'node.exe' : 'node';
    const srcBinary = platform === 'win32'
        ? path.join(extractedRoot, binaryName)
        : path.join(extractedRoot, 'bin', binaryName);

    if (!fs.existsSync(srcBinary)) {
        throw new Error(`Extracted Node binary not found at ${srcBinary}`);
    }

    // Clear previous binary but keep folder
    for (const name of ['node', 'node.exe', 'VERSION', 'LICENSE']) {
        const p = path.join(OUT_DIR, name);
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }

    const destBinary = path.join(OUT_DIR, binaryName);
    fs.copyFileSync(srcBinary, destBinary);
    if (platform !== 'win32') {
        fs.chmodSync(destBinary, 0o755);
    }

    // Optional license copy
    const licenseSrc = path.join(extractedRoot, 'LICENSE');
    if (fs.existsSync(licenseSrc)) {
        fs.copyFileSync(licenseSrc, path.join(OUT_DIR, 'LICENSE'));
    }
    fs.writeFileSync(
        path.join(OUT_DIR, 'VERSION'),
        `v${NODE_VERSION}\nplatform=${platform}\narch=${arch}\nslug=${slug}\n`,
        'utf8'
    );
    fs.writeFileSync(path.join(OUT_DIR, '.platform'), `${platform}-${arch}`, 'utf8');

    rimraf(tmpDir);
    console.log(`Bundled Node ready: ${destBinary}`);
    // Only execute binary when it matches this host (cross-downloads for packaging are OK)
    if (platform === process.platform) {
        const ver = spawnSync(destBinary, ['-v'], {
            encoding: 'utf8',
            shell: false,
            windowsHide: true
        });
        if (ver.status === 0) {
            console.log(String(ver.stdout || '').trim());
        }
    } else {
        console.log(`(skipped -v: binary is for ${platform}, host is ${process.platform})`);
    }
}

main().catch((err) => {
    console.error('Failed to download bundled Node.js:', err.message || err);
    process.exit(1);
});
