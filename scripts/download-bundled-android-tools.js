#!/usr/bin/env node
/**
 * =============================================================================
 * Download bundled Android tools → ./bundled-android-tools
 * =============================================================================
 * Ships with the installer (extraResource), same pattern as bundled-node:
 *   platform-tools/     adb
 *   build-tools/34.0.0/ apksigner, aapt, zipalign
 *   jre/                Temurin 17 JRE (JAVA_HOME)
 *
 * Usage:
 *   node scripts/download-bundled-android-tools.js
 *   node scripts/download-bundled-android-tools.js --platform win32 --arch x64
 * =============================================================================
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');

const BUILD_TOOLS_VERSION = '34.0.0';
const BUILD_TOOLS_ZIP_TAG = '34';
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, 'bundled-android-tools');

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
    const out = { platform: process.platform, arch: process.arch };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--platform' && args[i + 1]) out.platform = args[++i];
        if (args[i] === '--arch' && args[i + 1]) out.arch = args[++i];
    }
    if (out.arch === 'ia32') out.arch = 'x86';
    return out;
}

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const request = (currentUrl, redirectsLeft) => {
            const getter = String(currentUrl).startsWith('http:') ? http : https;
            const req = getter.get(currentUrl, {
                headers: { 'User-Agent': 'AlgoScraper-bundled-android-tools' }
            }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                    res.resume();
                    request(res.headers.location, redirectsLeft - 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`Download failed ${res.statusCode} for ${currentUrl}`));
                    return;
                }
                res.pipe(file);
                file.on('finish', () => file.close(() => resolve(dest)));
            });
            req.on('error', (err) => {
                try { fs.unlinkSync(dest); } catch (_) {}
                reject(err);
            });
        };
        request(url, 8);
    });
}

function rimraf(target) {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function detectArchiveKind(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        if (buf[0] === 0x1f && buf[1] === 0x8b) return 'tar.gz';
        if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
    } catch (_) {}
    const lower = String(filePath || '').toLowerCase();
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
    return 'zip';
}

function extractArchive(archivePath, destDir) {
    ensureDir(destDir);
    const kind = detectArchiveKind(archivePath);
    if (kind === 'tar.gz') {
        const tar = process.platform === 'win32'
            ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
            : 'tar';
        runNoShell(tar, ['-xzf', archivePath, '-C', destDir]);
        return;
    }
    if (process.platform === 'win32') {
        try {
            const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
            runNoShell(tar, ['-xf', archivePath, '-C', destDir]);
            return;
        } catch (_) {
            const psPath = archivePath.replace(/'/g, "''");
            const psDest = destDir.replace(/'/g, "''");
            runNoShell('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command',
                `Expand-Archive -LiteralPath '${psPath}' -DestinationPath '${psDest}' -Force`
            ]);
            return;
        }
    }
    runNoShell('unzip', ['-o', archivePath, '-d', destDir]);
}

function walkFind(root, testFn, maxDepth) {
    const stack = [{ dir: root, depth: 0 }];
    const limit = Number(maxDepth) > 0 ? Number(maxDepth) : 8;
    while (stack.length) {
        const item = stack.pop();
        if (!item || item.depth > limit) continue;
        let entries = [];
        try {
            entries = fs.readdirSync(item.dir, { withFileTypes: true });
        } catch (_) {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(item.dir, entry.name);
            if (testFn(full, entry)) return full;
            if (entry.isDirectory() && entry.name !== '.' && entry.name !== '..') {
                stack.push({ dir: full, depth: item.depth + 1 });
            }
        }
    }
    return null;
}

function javaHomeLooksValid(root, platform) {
    if (!root) return false;
    const javaName = platform === 'win32' ? 'java.exe' : 'java';
    return fs.existsSync(path.join(root, 'bin', javaName));
}

function findJavaHome(root, platform) {
    const javaName = platform === 'win32' ? 'java.exe' : 'java';
    const javaFile = walkFind(root, (full, entry) => (
        entry.isFile() && entry.name.toLowerCase() === javaName.toLowerCase()
    ), 8);
    if (!javaFile) return null;
    const binDir = path.dirname(javaFile);
    const home = path.dirname(binDir);
    if (javaHomeLooksValid(home, platform)) return home;
    return null;
}

function platformToolsUrl(platform) {
    if (platform === 'win32') return 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
    if (platform === 'darwin') return 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip';
    return 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip';
}

function buildToolsUrl(platform) {
    if (platform === 'win32') {
        return `https://dl.google.com/android/repository/build-tools_r${BUILD_TOOLS_ZIP_TAG}-windows.zip`;
    }
    if (platform === 'darwin') {
        return `https://dl.google.com/android/repository/build-tools_r${BUILD_TOOLS_ZIP_TAG}-macosx.zip`;
    }
    return `https://dl.google.com/android/repository/build-tools_r${BUILD_TOOLS_ZIP_TAG}-linux.zip`;
}

function jreUrl(platform, arch) {
    const osName = platform === 'win32' ? 'windows' : (platform === 'darwin' ? 'mac' : 'linux');
    const jreArch = arch === 'arm64' ? 'aarch64' : 'x64';
    return `https://api.adoptium.net/v3/binary/latest/17/ga/${osName}/${jreArch}/jre/hotspot/normal/eclipse?project=jdk`;
}

function isBundleComplete(outDir, platform) {
    const adb = path.join(outDir, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb');
    const java = path.join(outDir, 'jre', 'bin', platform === 'win32' ? 'java.exe' : 'java');
    const signerJar = path.join(outDir, 'build-tools', BUILD_TOOLS_VERSION, 'lib', 'apksigner.jar');
    const signerBin = path.join(
        outDir,
        'build-tools',
        BUILD_TOOLS_VERSION,
        platform === 'win32' ? 'apksigner.bat' : 'apksigner'
    );
    return fs.existsSync(adb) && fs.existsSync(java) && (fs.existsSync(signerJar) || fs.existsSync(signerBin));
}

async function stageZip(url, tmpDir, name) {
    const archivePath = path.join(tmpDir, name);
    console.log(`Downloading ${name}…`);
    console.log(`URL: ${url}`);
    await download(url, archivePath);
    const extractDir = path.join(tmpDir, `${name}-extract`);
    ensureDir(extractDir);
    console.log(`Extracting ${name}…`);
    extractArchive(archivePath, extractDir);
    return extractDir;
}

async function main() {
    const { platform, arch } = parseArgs();
    const want = `${platform}-${arch}`;
    const marker = path.join(OUT_DIR, '.platform');
    if (fs.existsSync(marker) && isBundleComplete(OUT_DIR, platform)) {
        try {
            if (fs.readFileSync(marker, 'utf8').trim() === want) {
                console.log(`bundled-android-tools already ${want} — skip download`);
                return;
            }
        } catch (_) {}
    }

    const tmpDir = path.join(ROOT, '.tmp-android-tools-download');
    rimraf(tmpDir);
    ensureDir(tmpDir);
    rimraf(OUT_DIR);
    ensureDir(OUT_DIR);

    const ptExtract = await stageZip(platformToolsUrl(platform), tmpDir, 'platform-tools.zip');
    const ptFrom = path.join(ptExtract, 'platform-tools');
    const ptSrc = fs.existsSync(ptFrom) ? ptFrom : ptExtract;
    fs.cpSync(ptSrc, path.join(OUT_DIR, 'platform-tools'), { recursive: true });

    const btExtract = await stageZip(buildToolsUrl(platform), tmpDir, 'build-tools.zip');
    const signer = walkFind(btExtract, (full, entry) => (
        entry.isFile() && /^(apksigner(\.jar|\.bat)?)$/i.test(entry.name)
    ), 6);
    if (!signer) {
        throw new Error('Downloaded build-tools, but apksigner was not found after extract.');
    }
    let toolDir = path.dirname(signer);
    if (path.basename(toolDir).toLowerCase() === 'lib') toolDir = path.dirname(toolDir);
    const btDest = path.join(OUT_DIR, 'build-tools', BUILD_TOOLS_VERSION);
    ensureDir(path.dirname(btDest));
    fs.cpSync(toolDir, btDest, { recursive: true });
    const jar = path.join(btDest, 'lib', 'apksigner.jar');
    if (fs.existsSync(jar)) {
        fs.copyFileSync(jar, path.join(OUT_DIR, 'platform-tools', 'apksigner.jar'));
    }

    const jreExtract = await stageZip(jreUrl(platform, arch), tmpDir, 'jre.bin');
    const jreHome = findJavaHome(jreExtract, platform);
    if (!jreHome) {
        throw new Error('Downloaded Java runtime, but java was not found after extract.');
    }
    fs.cpSync(jreHome, path.join(OUT_DIR, 'jre'), { recursive: true });

    const adb = path.join(OUT_DIR, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb');
    const javaBin = path.join(OUT_DIR, 'jre', 'bin', platform === 'win32' ? 'java.exe' : 'java');
    if (platform !== 'win32') {
        if (fs.existsSync(adb)) fs.chmodSync(adb, 0o755);
        if (fs.existsSync(javaBin)) fs.chmodSync(javaBin, 0o755);
        const signerUnix = path.join(btDest, 'apksigner');
        if (fs.existsSync(signerUnix)) fs.chmodSync(signerUnix, 0o755);
    }

    if (!isBundleComplete(OUT_DIR, platform)) {
        throw new Error(`bundled-android-tools incomplete after extract: ${OUT_DIR}`);
    }

    fs.writeFileSync(
        path.join(OUT_DIR, 'VERSION'),
        `build-tools=${BUILD_TOOLS_VERSION}\nplatform=${platform}\narch=${arch}\n`,
        'utf8'
    );
    fs.writeFileSync(marker, want, 'utf8');
    rimraf(tmpDir);
    console.log(`Bundled Android tools ready: ${OUT_DIR}`);
}

main().catch((err) => {
    console.error('Failed to download bundled Android tools:', err.message || err);
    process.exit(1);
});
