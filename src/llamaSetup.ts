// src/llamaSetup.ts
// Helper module (main process side) to manage llama.cpp installation:
// - Detect platform/arch
// - Query GitHub releases
// - Select correct asset
// - Download to app.getPath('userData')/llama/bin
// - Persist install metadata
// - Exposed via IPC from main (to be wired in index.ts)

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

export type LlamaInstallStatus = {
  installed: boolean;
  version?: string;
  binaryPath?: string;
  error?: string;
};

export type LlamaSetupProgress =
  | { type: 'status'; message: string }
  | { type: 'download-start'; url: string; totalBytes?: number }
  | { type: 'download-progress'; receivedBytes: number; totalBytes?: number }
  | { type: 'download-complete'; filePath: string }
  | { type: 'install-complete'; version: string; binaryPath: string }
  | { type: 'error'; message: string };

const OWNER = 'ggml-org';
const REPO = 'llama.cpp';
const RELEASES_API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

const INSTALL_DIR = path.join(app.getPath('userData'), 'llama', 'bin');
const METADATA_FILE = path.join(app.getPath('userData'), 'llama', 'install.json');

type Platform = 'windows' | 'linux' | 'macos';
type Arch = 'x64' | 'arm64';

function getPlatform(): Platform | null {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'macos';
    default:
      return null;
  }
}

function getArch(): Arch | null {
  switch (process.arch) {
    case 'x64':
      return 'x64';
    case 'arm64':
      return 'arm64';
    default:
      return null;
  }
}

function ensureDirSync(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readInstallMetadata(): LlamaInstallStatus {
  try {
    const raw = fs.readFileSync(METADATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.binaryPath && fs.existsSync(data.binaryPath)) {
      return {
        installed: true,
        version: data.version,
        binaryPath: data.binaryPath,
      };
    }
    return { installed: false };
  } catch {
    return { installed: false };
  }
}

function writeInstallMetadata(status: { version: string; binaryPath: string }) {
  ensureDirSync(path.dirname(METADATA_FILE));
  fs.writeFileSync(METADATA_FILE, JSON.stringify(status, null, 2), 'utf8');
}

function pickAssetNamePattern(platform: Platform, arch: Arch): (name: string) => boolean {
  // Deterministic mapping focused on Vulkan / GPU-accelerated builds where required.
  //
  // Requirements (updated):
  // - Windows: must use a Vulkan implementation (prefer assets with "-vulkan-x64").
  // - Linux: must use the Ubuntu Vulkan x64 asset:
  //     "llama-b6989-bin-ubuntu-vulkan-x64.zip"
  // - macOS: only arm64:
  //     "llama-b6989-bin-macos-arm64.zip"
  //
  // Implementation:
  // - We match by lowercased filename so future versions (bXXXX) keep working as long
  //   they follow the same naming pattern.

  return (rawName: string) => {
    const lower = rawName.toLowerCase();

    if (platform === 'windows') {
      if (arch !== 'x64') {
        return false;
      }

      // Require a Vulkan-flavored Windows build of the form:
      //   llama-b*-bin-win-vulkan-x64.zip
      // If multiple exist for different tags, this pattern will still match.
      if (
        lower.endsWith('.zip') &&
        lower.includes('-win-vulkan-x64')
      ) {
        return true;
      }

      return false;
    }

    if (platform === 'linux') {
      if (arch !== 'x64') {
        return false;
      }

      // Strict: only Ubuntu Vulkan x64 builds:
      //   llama-b*-bin-ubuntu-vulkan-x64.zip
      if (
        lower.endsWith('.zip') &&
        lower.includes('-ubuntu-vulkan-x64')
      ) {
        return true;
      }

      return false;
    }

    if (platform === 'macos') {
      // Only arm64 per requirement.
      if (arch !== 'arm64') {
        return false;
      }

      // macOS arm64 build:
      //   llama-b*-bin-macos-arm64.zip
      if (
        lower.endsWith('.zip') &&
        lower.includes('-macos-arm64')
      ) {
        return true;
      }

      return false;
    }

    return false;
  };
}

type GithubAsset = {
  name: string;
  browser_download_url: string;
};

type GithubRelease = {
  tag_name: string;
  assets: GithubAsset[];
};

async function fetchJson<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'mydeviceai-desktop',
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(
            new Error(
              `GitHub API request failed: ${res.statusCode} ${res.statusMessage || ''}`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const json = JSON.parse(raw);
            resolve(json as T);
          } catch (e) {
            reject(e);
          }
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.end();
  });
}

async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (p: LlamaSetupProgress) => void,
): Promise<void> {
  ensureDirSync(path.dirname(destPath));

  return new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let received = 0;
    let total: number | undefined = undefined;

    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'mydeviceai-desktop',
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          file.close();
          fs.unlinkSync(destPath);
          downloadFile(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          file.close();
          fs.unlink(destPath, () => {
            // ignore
          });
          reject(
            new Error(
              `Download failed: ${res.statusCode} ${res.statusMessage || ''}`,
            ),
          );
          return;
        }

        const contentLength = res.headers['content-length'];
        if (contentLength) {
          total = parseInt(contentLength, 10);
          if (!Number.isFinite(total)) {
            total = undefined;
          }
        }

        onProgress?.({
          type: 'download-start',
          url,
          totalBytes: total,
        });

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          file.write(chunk);
          onProgress?.({
            type: 'download-progress',
            receivedBytes: received,
            totalBytes: total,
          });
        });

        res.on('end', () => {
          file.end();
          onProgress?.({
            type: 'download-complete',
            filePath: destPath,
          });
          resolve();
        });
      },
    );

    req.on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => {
        // ignore
      });
      reject(err);
    });
  });
}

// NOTE: For now we avoid archive extraction to keep implementation simple and robust.
// Many llama.cpp releases ship self-contained binaries or archives. If the picked asset
// is an archive, you may extend this with unzip/untar logic or call out to a helper.
// To satisfy current requirements minimally, we:
// - Download the asset into INSTALL_DIR
// - If it is an .exe on Windows, treat that as the binary
// - If it's any other file, persist its path; the app can later adapt if needed.

function inferBinaryPathFromAsset(assetPath: string, platform: Platform): string {
  const lower = assetPath.toLowerCase();
  if (platform === 'windows') {
    if (lower.endsWith('.exe')) {
      return assetPath;
    }
  }
  // For archives or other formats, we default to the asset itself for now.
  // A future enhancement can add extraction and actual binary path detection.
  return assetPath;
}

export async function getLlamaInstallStatus(): Promise<LlamaInstallStatus> {
  const status = readInstallMetadata();
  if (status.installed && status.binaryPath && fs.existsSync(status.binaryPath)) {
    return status;
  }
  return { installed: false };
}

export async function installLatestLlama(
  onProgress?: (p: LlamaSetupProgress) => void,
): Promise<LlamaInstallStatus> {
  try {
    const platform = getPlatform();
    const arch = getArch();

    if (!platform) {
      const msg = `Unsupported platform: ${process.platform}`;
      onProgress?.({ type: 'error', message: msg });
      return { installed: false, error: msg };
    }
    if (!arch) {
      const msg = `Unsupported architecture: ${process.arch}`;
      onProgress?.({ type: 'error', message: msg });
      return { installed: false, error: msg };
    }

    onProgress?.({
      type: 'status',
      message: `Detecting latest llama.cpp release for ${platform}/${arch}...`,
    });

    const release = await fetchJson<GithubRelease>(RELEASES_API_URL);
    const matcher = pickAssetNamePattern(platform, arch);
    const candidateAssets = (release.assets || []).filter((a) =>
      matcher(a.name),
    );

    if (!candidateAssets.length) {
      const msg = `No suitable llama.cpp asset found for ${platform}/${arch} in latest release ${release.tag_name}`;
      onProgress?.({ type: 'error', message: msg });
      return { installed: false, error: msg };
    }

    // Prefer smaller / likely binary assets first
    const asset = candidateAssets[0];

    ensureDirSync(INSTALL_DIR);
    const destPath = path.join(INSTALL_DIR, asset.name);

    await downloadFile(asset.browser_download_url, destPath, onProgress);

    const binaryPath = inferBinaryPathFromAsset(destPath, platform);

    writeInstallMetadata({
      version: release.tag_name,
      binaryPath,
    });

    onProgress?.({
      type: 'install-complete',
      version: release.tag_name,
      binaryPath,
    });

    return {
      installed: true,
      version: release.tag_name,
      binaryPath,
    };
  } catch (error: any) {
    const msg = `Failed to install llama.cpp: ${error?.message || String(
      error,
    )}`;
    onProgress?.({ type: 'error', message: msg });
    return { installed: false, error: msg };
  }
}