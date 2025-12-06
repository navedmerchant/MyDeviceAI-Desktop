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
import { getActiveModel } from './modelManager';

const LOG_PREFIX = '[LlamaSetup]';

function logDebug(message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} ${message}`, extra);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} ${message}`);
  }
}

function logError(message: string, error?: unknown, extra?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.error(`${LOG_PREFIX} ${message}`, {
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error,
    ...extra,
  });
}

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
const LLAMA_VERSION = 'b7306'; // Pin to specific version
const RELEASES_API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${LLAMA_VERSION}`;

// Qwen3-4B GGUF (default model)
const QWEN3_MODEL_URL =
  'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=1';

const INSTALL_ROOT = path.join(app.getPath('userData'), 'llama');
const INSTALL_DIR = path.join(INSTALL_ROOT, 'bin');
const METADATA_FILE = path.join(INSTALL_ROOT, 'install.json');
export const MODEL_DIR = path.join(INSTALL_ROOT, 'models');
export const MODELS_STATE_FILE = path.join(INSTALL_ROOT, 'models.json');
const QWEN3_MODEL_PATH = path.join(MODEL_DIR, 'Qwen3-4B-Q4_K_M.gguf');

// Log buffer for status bar
const LOG_BUFFER_SIZE = 1000;
const llamaLogBuffer: Array<{
  timestamp: number;
  level: 'info' | 'error';
  message: string;
}> = [];

function addToLogBuffer(level: 'info' | 'error', message: string): void {
  llamaLogBuffer.push({
    timestamp: Date.now(),
    level,
    message: message.trim(),
  });

  if (llamaLogBuffer.length > LOG_BUFFER_SIZE) {
    llamaLogBuffer.shift();
  }

  // Broadcast to all windows
  const { BrowserWindow } = require('electron');
  BrowserWindow.getAllWindows().forEach((window: any) => {
    window.webContents.send('llama-log-entry', {
      timestamp: Date.now(),
      level,
      message: message.trim(),
    });
  });
}

export function getLlamaLogs(): Array<{
  timestamp: number;
  level: 'info' | 'error';
  message: string;
}> {
  return [...llamaLogBuffer];
}

let llamaServerProcess: import('child_process').ChildProcessWithoutNullStreams | null = null;
let llamaServerPort: number | null = null;
let llamaServerCurrentModelPath: string | null = null;
let llamaServerStartTime: number | null = null;

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
    logDebug('Creating directory', { dir });
    fs.mkdirSync(dir, { recursive: true });
  } else {
    logDebug('Directory already exists', { dir });
  }
}

function readInstallMetadata(): LlamaInstallStatus {
  try {
    logDebug('Reading install metadata', { METADATA_FILE });
    const raw = fs.readFileSync(METADATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.binaryPath && fs.existsSync(data.binaryPath)) {
      logDebug('Found valid existing llama.cpp install', {
        version: data.version,
        binaryPath: data.binaryPath,
      });
      return {
        installed: true,
        version: data.version,
        binaryPath: data.binaryPath,
      };
    }
    logDebug('No valid llama.cpp install metadata found or binary missing');
    return { installed: false };
  } catch (error) {
    logDebug('Install metadata not present or unreadable, treating as not installed', {
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : String(error),
    });
    return { installed: false };
  }
}

function writeInstallMetadata(status: { version: string; binaryPath: string }) {
  ensureDirSync(path.dirname(METADATA_FILE));
  logDebug('Writing install metadata', status);
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
  logDebug('HTTP GET JSON', { url });
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
          logError('GitHub API request failed', undefined, {
            url,
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
          });
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const json = JSON.parse(raw);
            logDebug('HTTP GET JSON success', { url });
            resolve(json as T);
          } catch (e) {
            logError('Failed to parse JSON response', e as Error, { url });
            reject(e);
          }
        });
      },
    );

    req.on('error', (err) => {
      logError('HTTP GET JSON network error', err, { url });
      reject(err);
    });
    req.end();
  });
}

async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (p: LlamaSetupProgress) => void,
): Promise<void> {
  ensureDirSync(path.dirname(destPath));

  logDebug('Starting download', { url, destPath });
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
          logDebug('Download complete', {
            url,
            destPath,
            totalBytes: received,
          });
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
      logError('Download failed', err, { url, destPath });
      reject(err);
    });
  });
}

/**
* Extract a zip archive into targetDir and resolve when complete.
* Uses native unzip on macOS to preserve file permissions and attributes.
* Uses "unzipper" package on Linux and Windows.
*/
async function extractZip(assetPath: string, targetDir: string): Promise<void> {
 ensureDirSync(targetDir);
 logDebug('Extracting llama.cpp zip archive', { assetPath, targetDir });

 // On macOS, use native unzip to preserve permissions, extended attributes,
 // and code signing that are critical for dylib files
 if (process.platform === 'darwin') {
   // eslint-disable-next-line @typescript-eslint/no-var-requires
   const { execFile } = require('child_process');
   // eslint-disable-next-line @typescript-eslint/no-var-requires
   const { promisify } = require('util');
   const execFileAsync = promisify(execFile);

   try {
     // -o: overwrite files without prompting
     // -q: quiet mode
     // -d: extract to directory
     await execFileAsync('unzip', ['-o', '-q', assetPath, '-d', targetDir]);
     logDebug('Zip extraction completed (native unzip)', { assetPath, targetDir });
     return;
   } catch (err) {
     logError('Native unzip failed, falling back to unzipper', err);
     // Continue to fallback below
   }
 }

 // Use unzipper for Linux/Windows or if native unzip fails on macOS
 // eslint-disable-next-line @typescript-eslint/no-var-requires
 const unzipper = require('unzipper') as typeof import('unzipper');

 return new Promise<void>((resolve, reject) => {
   const directory = unzipper.Extract({ path: targetDir });

   directory.on('close', () => {
     logDebug('Zip extraction completed (unzipper)', { assetPath, targetDir });
     resolve();
   });

   directory.on('error', (err: Error) => {
     logError('Zip extraction failed', err, { assetPath, targetDir });
     reject(err);
   });

   fs.createReadStream(assetPath).pipe(directory);
 });
}

/**
* Given the downloaded asset and platform, locate the llama-server binary.
*
* For the Ubuntu Vulkan x64 asset layout:
*   llama-{version}-bin-ubuntu-vulkan-x64/build/bin/llama-server
*
* Behavior:
* - If asset is a Windows .exe, return as-is.
* - If asset is a .zip, extract into INSTALL_DIR and search for llama-server.
* - Ensure the found binary is marked executable.
* - Otherwise, fall back to assetPath to match previous behavior.
*/
async function inferBinaryPathFromAsset(
 assetPath: string,
 platform: Platform,
): Promise<string> {
 const lower = assetPath.toLowerCase();

 // Raw Windows executable
 if (platform === 'windows' && lower.endsWith('.exe')) {
   return assetPath;
 }

 // Zip archives: extract then search for llama-server
 if (lower.endsWith('.zip')) {
   const extractRoot = INSTALL_DIR;
   await extractZip(assetPath, extractRoot);

   // Expected: llama-{version}-bin-ubuntu-vulkan-x64/build/bin/llama-server
   const entries = fs.readdirSync(extractRoot);
   for (const entry of entries) {
     const full = path.join(extractRoot, entry);
     if (!fs.statSync(full).isDirectory()) continue;

     const buildBin = path.join(full, 'build', 'bin');
     if (fs.existsSync(buildBin) && fs.statSync(buildBin).isDirectory()) {
       const binEntries = fs.readdirSync(buildBin);
       for (const be of binEntries) {
         const candidate = path.join(buildBin, be);
         const name = be.toLowerCase();
         if (
           fs.statSync(candidate).isFile() &&
           (name === 'llama-server' || name === 'llama-server.exe')
         ) {
           try {
             fs.chmodSync(candidate, 0o755);
           } catch {
             // best-effort; ignore chmod failures on non-POSIX
           }
           logDebug('Resolved llama-server binary inside archive', {
             assetPath,
             candidate,
           });
           return candidate;
         }
       }
     }
   }

   // Fallback: recursive search under extractRoot
   const stack: string[] = [extractRoot];
   while (stack.length) {
     const dir = stack.pop() as string;
     const children = fs.readdirSync(dir);
     for (const child of children) {
       const full = path.join(dir, child);
       const stat = fs.statSync(full);
       if (stat.isDirectory()) {
         stack.push(full);
       } else if (stat.isFile()) {
         const name = child.toLowerCase();
         if (name === 'llama-server' || name === 'llama-server.exe') {
           try {
             fs.chmodSync(full, 0o755);
           } catch {
             // ignore chmod errors
           }
           logDebug('Resolved llama-server binary via recursive search', {
             assetPath,
             candidate: full,
           });
           return full;
         }
       }
     }
   }

   throw new Error(`llama-server binary not found in extracted archive: ${assetPath}`);
 }

 // Non-zip assets: preserve previous behavior.
 return assetPath;
}

export async function getLlamaInstallStatus(): Promise<LlamaInstallStatus> {
  const status = readInstallMetadata();
  if (status.installed && status.binaryPath && fs.existsSync(status.binaryPath)) {
    return status;
  }
  return { installed: false };
}

/**
 * Internal helper: ensure llama.cpp binary is installed and usable.
 * - Only downloads once; subsequent calls reuse existing metadata/binary.
 */
async function ensureLlamaBinary(
  onProgress?: (p: LlamaSetupProgress) => void,
): Promise<LlamaInstallStatus> {
  const existing = await getLlamaInstallStatus();
  if (existing.installed && existing.binaryPath && fs.existsSync(existing.binaryPath)) {
    logDebug('ensureLlamaBinary: using existing llama.cpp binary', {
      version: existing.version,
      binaryPath: existing.binaryPath,
    });
    return existing;
  }

  logDebug('ensureLlamaBinary: no valid install found, invoking installLatestLlama');
  const installed = await installLatestLlama(onProgress);
  if (installed.installed && installed.binaryPath && fs.existsSync(installed.binaryPath)) {
    logDebug('ensureLlamaBinary: installLatestLlama succeeded', {
      version: installed.version,
      binaryPath: installed.binaryPath,
    });
    return installed;
  }

  const error = installed.error || 'Failed to install llama.cpp';
  logError('ensureLlamaBinary: installLatestLlama failed', undefined, { error });
  return { installed: false, error };
}

/**
 * Ensure Qwen3-4B-Q4_K_M.gguf exists under MODEL_DIR.
 */
async function downloadModelIfNeeded(
  onProgress?: (p: LlamaSetupProgress) => void,
): Promise<string> {
  ensureDirSync(MODEL_DIR);

  if (fs.existsSync(QWEN3_MODEL_PATH)) {
    logDebug('Model already present, skipping download', {
      modelPath: QWEN3_MODEL_PATH,
    });
    return QWEN3_MODEL_PATH;
  }

  const tmpPath = QWEN3_MODEL_PATH + '.download';
  logDebug('Downloading Qwen3 model', {
    url: QWEN3_MODEL_URL,
    tmpPath,
    finalPath: QWEN3_MODEL_PATH,
  });
  await downloadFile(QWEN3_MODEL_URL, tmpPath, onProgress);
  fs.renameSync(tmpPath, QWEN3_MODEL_PATH);
  logDebug('Qwen3 model download complete and moved into place', {
    modelPath: QWEN3_MODEL_PATH,
  });

  return QWEN3_MODEL_PATH;
}

function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const net = require('net');
    logDebug('Checking port availability', { port });
    const server = net.createServer();

    server.once('error', (err: Error) => {
      logDebug('Port not available', {
        port,
        error: err.message,
      });
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => {
        logDebug('Port is available', { port });
        resolve(true);
      });
    });

    server.listen(port, 'localhost');
  });
}

async function pickAvailablePort(): Promise<number> {
  // Choose a random high port and ensure it is available.
  // If the first choice is not available, retry a few times.
  for (let i = 0; i < 10; i++) {
    const candidate = 10000 + Math.floor(Math.random() * 50000);
    // eslint-disable-next-line no-await-in-loop
    const available = await checkPortAvailable(candidate);
    if (available) {
      logDebug('Selected port for llama server', { port: candidate });
      return candidate;
    }
  }
  const msg = 'No available port found for llama server after multiple attempts';
  logError(msg);
  throw new Error(msg);
}

async function spawnLlamaServer(
  binaryPath: string,
  modelPath: string,
  contextWindow: number = 8192
): Promise<{ port: number }> {
  if (llamaServerProcess) {
    // If already running, reuse existing port if known.
    if (llamaServerPort) {
      logDebug('llama-server already running, reusing existing port', {
        port: llamaServerPort,
      });
      return { port: llamaServerPort };
    }
    // Otherwise kill and restart cleanly.
    logDebug('Existing llama-server process found without known port, restarting');
    try {
      llamaServerProcess.kill();
    } catch (error) {
      logError('Failed to kill existing llama-server process', error);
    }
    llamaServerProcess = null;
    llamaServerPort = null;
  }

  const port = await pickAvailablePort();

  const args = [
    '--host',
    'localhost',
    '--port',
    String(port),
    '--model',
    modelPath,
    '--ctx-size',
    String(contextWindow),
    '--parallel',
    '4',
  ];

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const spawn = require('child_process').spawn;
  logDebug('Spawning llama-server process', {
    binaryPath,
    args,
  });
  const proc = spawn(binaryPath, args, {
    cwd: INSTALL_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  llamaServerProcess = proc;
  llamaServerPort = port;
  llamaServerStartTime = Date.now();

  proc.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    logDebug('llama-server stdout', { line: text.trim() });
    addToLogBuffer('info', text);
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().toLowerCase();
    logError('llama-server stderr', undefined, { line: text.trim() });
    addToLogBuffer('error', text);
    if (text.includes('address already in use') || text.includes('eaddrinuse')) {
      // Port conflict: attempt to restart on a new port.
      (async () => {
        try {
          await restartLlamaServerOnNewPort(binaryPath, modelPath);
        } catch {
          // If restart fails, leave process cleanup to exit handler.
        }
      })();
    }
  });

  proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    logDebug('llama-server process exited', { code, signal });
    llamaServerProcess = null;
    llamaServerPort = null;
  });

  return { port };
}

async function restartLlamaServerOnNewPort(
  binaryPath: string,
  modelPath: string,
  contextWindow: number = 8192
): Promise<{ port: number }> {
  if (llamaServerProcess) {
    try {
      llamaServerProcess.kill();
    } catch {
      // ignore
    }
    llamaServerProcess = null;
    llamaServerPort = null;
  }

  return spawnLlamaServer(binaryPath, modelPath, contextWindow);
}

/**
 * Ensure llama.cpp is installed (installLatestLlama) AND
 * Qwen3-4B GGUF is present, then start llama-server with Qwen3
 * on an available port.
 *
 * Returns the base HTTP endpoint for use by preload.ts.
 */
/**
 * Ensure a managed llama-server is running.
 *
 * Behavior:
 * - Does NOT re-download or re-install on every call.
 * - If a managed server is already running, reuses its known port.
 * - Otherwise:
 *    - Ensures llama.cpp binary is installed (once).
 *    - Ensures default model is present.
 *    - Spawns llama-server and caches its port.
 */
export async function ensureLlamaServer(
  onProgress?: (p: LlamaSetupProgress) => void,
): Promise<{ ok: true; endpoint: string } | { ok: false; error: string }> {
  logDebug('ensureLlamaServer invoked');

  // Determine which model should be running
  let modelPath: string;
  let contextWindow: number = 8192; // default
  const activeModel = getActiveModel();
  if (activeModel && activeModel.installed && activeModel.filePath) {
    modelPath = activeModel.filePath;
    contextWindow = activeModel.currentParams.contextWindow || 8192;
    logDebug('ensureLlamaServer: active model from model manager', {
      modelId: activeModel.id,
      modelPath,
      contextWindow,
    });
  } else {
    // Fall back to default Qwen3 model
    modelPath = await downloadModelIfNeeded(onProgress);
    logDebug('ensureLlamaServer: no active model found, using default Qwen3', {
      modelPath,
      contextWindow,
    });
  }

  // Check if server is running with the correct model
  if (llamaServerProcess && llamaServerPort && llamaServerCurrentModelPath === modelPath) {
    const endpoint = `http://localhost:${llamaServerPort}`;
    logDebug('ensureLlamaServer: reusing existing managed llama-server with correct model', {
      endpoint,
      modelPath,
    });
    return { ok: true, endpoint };
  }

  // If server is running but with wrong model, stop it
  if (llamaServerProcess && llamaServerCurrentModelPath !== modelPath) {
    logDebug('ensureLlamaServer: active model changed, restarting server', {
      oldModel: llamaServerCurrentModelPath,
      newModel: modelPath,
    });
    stopLlamaServer();
    // Clear log buffer so status bar doesn't show stale "ready" status
    llamaLogBuffer.length = 0;
  }

  // Ensure llama binary exists (install once if needed).
  const install = await ensureLlamaBinary(onProgress);
  if (!install.installed || !install.binaryPath) {
    const error = install.error || 'llama.cpp not installed';
    logError('ensureLlamaServer: cannot start server, llama.cpp not installed', error);
    return { ok: false, error };
  }

  // Spawn llama-server with the active model
  try {
    const { port } = await spawnLlamaServer(install.binaryPath, modelPath, contextWindow);
    llamaServerCurrentModelPath = modelPath;
    const endpoint = `http://localhost:${port}`;
    const modelName = activeModel?.displayName || 'Qwen3-4B-Q4_K_M.gguf';
    logDebug('ensureLlamaServer: started new managed llama-server', {
      endpoint,
      modelPath,
      modelName,
      contextWindow,
    });
    onProgress?.({
      type: 'status',
      message: `llama-server running at ${endpoint} with ${modelName}`,
    });
    return { ok: true, endpoint };
  } catch (err: any) {
    const msg = err?.message || String(err);
    logError('ensureLlamaServer: failed to start llama-server', err, {
      modelPath,
      contextWindow,
    });
    onProgress?.({
      type: 'error',
      message: `Failed to start llama-server: ${msg}`,
    });
    return { ok: false, error: msg };
  }
}

/**
 * Stop the managed llama-server process if it is running.
 * This is idempotent and safe to call multiple times.
 */
export function stopLlamaServer(): void {
  if (!llamaServerProcess) {
    logDebug('stopLlamaServer called but no managed llama-server is running');
    return;
  }

  try {
    logDebug('Stopping managed llama-server process');
    llamaServerProcess.kill();
  } catch (error) {
    logError('Error while stopping llama-server process', error);
  } finally {
    llamaServerProcess = null;
    llamaServerPort = null;
    llamaServerCurrentModelPath = null;
    llamaServerStartTime = null;
  }
}

/**
 * Get the current status of the llama-server for display in status bar
 */
export function getLlamaServerStatus(): {
  running: boolean;
  port: number | null;
  modelPath: string | null;
  modelName: string | null;
  uptime: number | null;
} {
  const activeModel = getActiveModel();
  return {
    running: llamaServerProcess !== null,
    port: llamaServerPort,
    modelPath: llamaServerCurrentModelPath,
    modelName: activeModel?.displayName || null,
    uptime: llamaServerStartTime ? Date.now() - llamaServerStartTime : null,
  };
}

export async function installLatestLlama(
  onProgress?: (p: LlamaSetupProgress) => void,
): Promise<LlamaInstallStatus> {
  logDebug('Starting installLatestLlama');
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
    logDebug('Fetched latest llama.cpp release metadata', {
      tag: release.tag_name,
      assetCount: (release.assets || []).length,
    });
    const matcher = pickAssetNamePattern(platform, arch);
    const candidateAssets = (release.assets || []).filter((a) =>
      matcher(a.name),
    );
    logDebug('Filtered candidate assets for platform/arch', {
      platform,
      arch,
      candidateCount: candidateAssets.length,
    });

    if (!candidateAssets.length) {
      const msg = `No suitable llama.cpp asset found for ${platform}/${arch} in latest release ${release.tag_name}`;
      logError('No matching llama.cpp assets', undefined, {
        platform,
        arch,
        tag: release.tag_name,
      });
      onProgress?.({ type: 'error', message: msg });
      return { installed: false, error: msg };
    }

    // Prefer smaller / likely binary assets first
    const asset = candidateAssets[0];
    logDebug('Selected llama.cpp asset', {
      name: asset.name,
      url: asset.browser_download_url,
    });

    ensureDirSync(INSTALL_DIR);
    const destPath = path.join(INSTALL_DIR, asset.name);

    await downloadFile(asset.browser_download_url, destPath, onProgress);

    const binaryPath = await inferBinaryPathFromAsset(destPath, platform);
    logDebug('Inferred llama.cpp binary path from asset', {
      assetPath: destPath,
      binaryPath,
      platform,
    });

    // Persist llama.cpp binary metadata
    writeInstallMetadata({
      version: release.tag_name,
      binaryPath,
    });

    // After llama.cpp binary is available, ensure the default model is downloaded.
    // This aligns with the requirement: "download the model as a part of downloading llama cpp."
    const modelPath = await downloadModelIfNeeded(onProgress);
    logDebug('Verified/Downloaded default Qwen3 model for llama.cpp', {
      modelPath,
    });

    onProgress?.({
      type: 'install-complete',
      version: release.tag_name,
      binaryPath,
    });

    // Note: modelPath is not part of LlamaInstallStatus today; llama-server startup
    // uses downloadModelIfNeeded/ensureLlamaServer, so we keep the return type stable.
    const result: LlamaInstallStatus = {
      installed: true,
      version: release.tag_name,
      binaryPath,
    };
    logDebug('installLatestLlama completed successfully', result);
    return result;
  } catch (error: any) {
    const msg = `Failed to install llama.cpp: ${error?.message || String(
      error,
    )}`;
    logError('installLatestLlama failed', error);
    onProgress?.({ type: 'error', message: msg });
    return { installed: false, error: msg };
  }
}