// src/modelManager.ts
// Main-process model management for MyDeviceAI-Desktop.
//
// Responsibilities:
// - Track installed models, active model, and per-model params in MODELS_STATE_FILE.
// - Discover default Qwen3 model installed by llamaSetup.
// - Download additional GGUF models from Hugging Face (public) into MODEL_DIR.
// - Provide helpers for IPC handlers in src/index.ts.
// - Enforce single-active-model semantics and integrate with llama-server startup.

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { MODEL_DIR, MODELS_STATE_FILE, LlamaSetupProgress } from './llamaSetup';

const LOG_PREFIX = '[ModelManager]';

function logInfo(message: string, extra?: Record<string, unknown>): void {
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
    ...(extra || {}),
  });
}

export type ModelRuntimeParams = {
  temperature: number;
  topP: number;
  topK: number;
  maxTokens: number;
  contextWindow: number;
  gpuLayers: number;
};

export type ManagedModel = {
  id: string;
  displayName: string;

  source: 'builtin' | 'huggingface';

  // For HF-sourced models
  repoId?: string;
  fileName?: string;

  // Local file
  filePath: string;
  sizeBytes?: number;

  quantization?: string;
  contextWindow?: number;
  description?: string;

  recommended?: Partial<ModelRuntimeParams>;

  currentParams: ModelRuntimeParams;

  installed: boolean;
  downloadedBytes?: number;
  checksum?: string;

  createdAt: string;
  updatedAt: string;
};

export type ModelsState = {
  version: number;
  models: ManagedModel[];
  activeModelId: string | null;
  lastUsedModelId?: string | null;
};

const STATE_VERSION = 1;

// Default runtime params; safe, conservative.
const DEFAULT_PARAMS: ModelRuntimeParams = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  maxTokens: 1024,
  contextWindow: 8192,
  gpuLayers: 0,
};

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Clamp helpers

function clamp(num: number, min: number, max: number): number {
  if (Number.isNaN(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function normalizeParams(params: Partial<ModelRuntimeParams> | undefined): ModelRuntimeParams {
  const base = DEFAULT_PARAMS;
  if (!params) return base;

  return {
    temperature: clamp(
      params.temperature ?? base.temperature,
      0,
      2,
    ),
    topP: clamp(
      params.topP ?? base.topP,
      0,
      1,
    ),
    topK: clamp(
      params.topK ?? base.topK,
      0,
      2000,
    ),
    maxTokens: clamp(
      params.maxTokens ?? base.maxTokens,
      16,
      32768,
    ),
    contextWindow: clamp(
      params.contextWindow ?? base.contextWindow,
      512,
      131072,
    ),
    gpuLayers: clamp(
      params.gpuLayers ?? base.gpuLayers,
      0,
      64,
    ),
  };
}

// Core state access

let cachedState: ModelsState | null = null;

function loadStateFromDisk(): ModelsState | null {
  const existing = readJsonFile<ModelsState>(MODELS_STATE_FILE);
  if (!existing || !Array.isArray(existing.models)) {
    return null;
  }

  // Basic normalization
  const norm: ModelsState = {
    version: existing.version || STATE_VERSION,
    models: existing.models.map((m) => ({
      ...m,
      currentParams: normalizeParams(m.currentParams),
      installed: !!m.installed && !!m.filePath && fs.existsSync(m.filePath),
    })),
    activeModelId: existing.activeModelId ?? null,
    lastUsedModelId: existing.lastUsedModelId ?? null,
  };

  return norm;
}

function persistState(state: ModelsState): void {
  const withVersion: ModelsState = {
    ...state,
    version: STATE_VERSION,
  };
  cachedState = withVersion;
  writeJsonAtomic(MODELS_STATE_FILE, withVersion);
}

function computeInitialState(): ModelsState {
  ensureDirSync(MODEL_DIR);

  const models: ManagedModel[] = [];

  // Default Qwen3-4B model that llamaSetup installs.
  const qwenPath = path.join(MODEL_DIR, 'Qwen3-4B-Q4_K_M.gguf');
  const qwenExists = fs.existsSync(qwenPath);

  const now = new Date().toISOString();

  const qwenModel: ManagedModel = {
    id: 'Qwen/Qwen3-4B-Q4_K_M',
    displayName: 'Qwen3-4B Q4_K_M (Default)',
    source: 'builtin',
    repoId: 'Qwen/Qwen3-4B-GGUF',
    fileName: 'Qwen3-4B-Q4_K_M.gguf',
    filePath: qwenPath,
    sizeBytes: qwenExists ? fs.statSync(qwenPath).size : undefined,
    quantization: 'Q4_K_M',
    contextWindow: 8192,
    description: 'Default starter model installed with MyDeviceAI Desktop.',
    recommended: {
      temperature: 0.6,
      topP: 0.9,
      maxTokens: 1024,
      contextWindow: 8192,
    },
    currentParams: normalizeParams({
      temperature: 0.6,
      topP: 0.9,
      maxTokens: 1024,
      contextWindow: 8192,
    }),
    installed: qwenExists,
    createdAt: now,
    updatedAt: now,
  };

  models.push(qwenModel);

  const activeModelId = qwenExists ? qwenModel.id : null;

  const state: ModelsState = {
    version: STATE_VERSION,
    models,
    activeModelId,
    lastUsedModelId: activeModelId,
  };

  return state;
}

function ensureState(): ModelsState {
  if (cachedState) {
    return cachedState;
  }

  const disk = loadStateFromDisk();
  if (disk) {
    // Ensure invariants and drop stale-install models
    const models = disk.models.map((m) => {
      const installed = !!m.filePath && fs.existsSync(m.filePath);
      if (!installed) {
        logInfo('Model file missing; marking as not installed', {
          id: m.id,
          filePath: m.filePath,
        });
      }
      return {
        ...m,
        installed,
        currentParams: normalizeParams(m.currentParams),
      };
    });

    let activeModelId = disk.activeModelId;
    if (activeModelId) {
      const active = models.find(
        (m) => m.id === activeModelId && m.installed,
      );
      if (!active) {
        activeModelId = null;
      }
    }

    if (!activeModelId) {
      const firstInstalled = models.find((m) => m.installed);
      activeModelId = firstInstalled ? firstInstalled.id : null;
    }

    const normalized: ModelsState = {
      version: STATE_VERSION,
      models,
      activeModelId,
      lastUsedModelId: disk.lastUsedModelId ?? activeModelId,
    };

    cachedState = normalized;
    persistState(normalized);
    return normalized;
  }

  const initial = computeInitialState();
  persistState(initial);
  return initial;
}

export function getModelsState(): ModelsState {
  return ensureState();
}

export function listModels(): { models: ManagedModel[]; activeModelId: string | null } {
  const state = ensureState();
  return {
    models: state.models,
    activeModelId: state.activeModelId,
  };
}

export function getActiveModel(): ManagedModel | null {
  const state = ensureState();
  if (!state.activeModelId) return null;
  return state.models.find((m) => m.id === state.activeModelId) || null;
}

function updateState(mutator: (state: ModelsState) => void): ModelsState {
  const state = ensureState();
  mutator(state);

  // Enforce single-active-model invariant
  if (state.activeModelId) {
    const active = state.models.find(
      (m) => m.id === state.activeModelId && m.installed,
    );
    if (!active) {
      const fallback = state.models.find((m) => m.installed) || null;
      state.activeModelId = fallback ? fallback.id : null;
    }
  }

  persistState(state);
  return state;
}

export function setActiveModel(id: string): { ok: boolean; activeModelId?: string; error?: string } {
  try {
    const state = updateState((s) => {
      const model = s.models.find((m) => m.id === id);
      if (!model) {
        throw new Error(`Model not found: ${id}`);
      }
      if (!model.installed) {
        throw new Error(`Model not installed: ${id}`);
      }
      s.activeModelId = id;
      s.lastUsedModelId = id;
    });

    logInfo('Active model updated', { activeModelId: state.activeModelId });
    return { ok: true, activeModelId: state.activeModelId || undefined };
  } catch (err: any) {
    logError('setActiveModel failed', err, { id });
    return { ok: false, error: err?.message || String(err) };
  }
}

export function updateModelParams(
  id: string,
  params: Partial<ModelRuntimeParams>,
): { ok: boolean; model?: ManagedModel; error?: string } {
  try {
    let updatedModel: ManagedModel | undefined;

    updateState((s) => {
      const model = s.models.find((m) => m.id === id);
      if (!model) {
        throw new Error(`Model not found: ${id}`);
      }
      model.currentParams = normalizeParams({
        ...model.currentParams,
        ...params,
      });
      model.updatedAt = new Date().toISOString();
      updatedModel = model;
    });

    if (!updatedModel) {
      throw new Error('Internal error: updated model missing');
    }

    logInfo('Model params updated', { id });
    return { ok: true, model: updatedModel };
  } catch (err: any) {
    logError('updateModelParams failed', err, { id });
    return { ok: false, error: err?.message || String(err) };
  }
}

// Hugging Face search integration (public, GGUF-filtered)

export type HfModelFile = {
  name: string;
  size?: number;
};

export type HfSearchResult = {
  id: string; // repoId
  downloads: number;
  likes?: number;
  tags?: string[];
  files?: HfModelFile[];
  description?: string;
};

/**
 * List GGUF files for a given Hugging Face repo.
 * Uses the main-process https client to avoid renderer/network issues.
 */
export async function listHfRepoGgufFiles(
  repoId: string,
): Promise<{ ok: true; files: HfModelFile[] } | { ok: false; error: string }> {
  try {
    const trimmed = repoId.trim();
    if (!trimmed) {
      throw new Error('repoId is required');
    }

    const url = `https://huggingface.co/api/models/${encodeURIComponent(
      trimmed,
    )}/tree/main`;

    const raw = await fetchJson<any[]>(url);

    const files: HfModelFile[] = (raw || [])
      .filter(
        (f: any) =>
          typeof f?.path === 'string' &&
          f.path.toLowerCase().endsWith('.gguf'),
      )
      .map((f: any) => ({
        name: String(f.path),
        size:
          typeof f.size === 'number'
            ? f.size
            : typeof f.lfs?.size === 'number'
            ? f.lfs.size
            : undefined,
      }));

    logInfo('listHfRepoGgufFiles success', {
      repoId: trimmed,
      url,
      fileCount: files.length,
    });

    return { ok: true, files };
  } catch (err: any) {
    logError('listHfRepoGgufFiles failed', err, { repoId });
    return { ok: false, error: err?.message || String(err) };
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'mydeviceai-desktop',
          Accept: 'application/json',
        },
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(
            `HTTP ${res.statusCode} ${res.statusMessage || ''} for ${url}`,
          );
          logError('fetchJson http error', err, {
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            url,
          });
          reject(err);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const json = JSON.parse(raw);
            resolve(json as T);
          } catch (e: any) {
            logError('fetchJson parse error', e, { url });
            reject(e);
          }
        });
      },
    );

    req.on('error', (err) => {
      logError('fetchJson network error', err, { url });
      reject(err);
    });

    req.end();
  });
}

export async function searchHfGgufModels(
  query: string,
): Promise<{ ok: true; results: HfSearchResult[] } | { ok: false; error: string }> {
  try {
    const q = query && query.trim().length > 0 ? query.trim() : 'gguf';
    const url = `https://huggingface.co/api/models?search=${encodeURIComponent(
      q,
    )}&filter=gguf&sort=downloads&direction=-1&limit=20`;

    const raw = await fetchJson<any[]>(url);

    const results: HfSearchResult[] = (raw || []).map((m) => {
      // When API only returns repo metadata (no files), still surface repo as selectable.
      // Model files will be fetched separately when user chooses a model to download.
      const id = String(m.id || m.modelId || '').trim();

      return {
        id,
        downloads: typeof m.downloads === 'number' ? m.downloads : 0,
        likes: typeof m.likes === 'number' ? m.likes : undefined,
        tags: Array.isArray(m.tags) ? m.tags.map(String) : undefined,
        // Do NOT require files here: HF /api/models search no longer returns GGUF file info.
        // We'll query /api/models/:id/tree/main later to discover .gguf candidates.
        files: [] as HfModelFile[],
        description:
          typeof m.description === 'string'
            ? m.description
            : typeof m.cardData?.summary === 'string'
            ? m.cardData.summary
            : undefined,
      };
    });

    // Count repos whose id/modelId clearly indicate GGUF content to help debug.
    const ggufLikeCount = results.filter((m) =>
      typeof m.id === 'string' && m.id.toLowerCase().includes('gguf'),
    ).length;

    logInfo('searchHfGgufModels success', {
      query: q,
      requestedUrl: url,
      rawCount: Array.isArray(raw) ? raw.length : 0,
      resultCount: results.length,
      ggufLikeCount,
    });

    return { ok: true, results };
  } catch (err: any) {
    logError('searchHfGgufModels failed', err, { query });
    return { ok: false, error: err?.message || String(err) };
  }
}

// Download GGUF model from Hugging Face and register it.

/**
 * Helper to download a file from a URL with redirect support.
 */
async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (received: number, total?: number) => void,
  maxRedirects = 5,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let redirectCount = 0;

    const doDownload = (currentUrl: string) => {
      const req = https.get(
        currentUrl,
        {
          headers: {
            'User-Agent': 'mydeviceai-desktop',
          },
        },
        (res) => {
          // Handle redirects
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            redirectCount++;
            if (redirectCount > maxRedirects) {
              reject(new Error(`Too many redirects (${maxRedirects})`));
              return;
            }

            const redirectUrl = res.headers.location;
            logInfo('Following redirect', {
              from: currentUrl,
              to: redirectUrl,
              redirectCount,
            });

            // Follow the redirect
            doDownload(redirectUrl);
            return;
          }

          // Handle non-success status codes
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const statusErr = new Error(
              `Download failed: ${res.statusCode} ${res.statusMessage || ''}`,
            );
            logError('HTTP download error', statusErr, {
              url: currentUrl,
              statusCode: res.statusCode,
            });
            reject(statusErr);
            return;
          }

          // Success - start downloading
          const file = fs.createWriteStream(destPath);
          let received = 0;
          let total: number | undefined;

          const contentLength = res.headers['content-length'];
          if (contentLength) {
            const parsed = parseInt(contentLength, 10);
            if (Number.isFinite(parsed)) total = parsed;
          }

          onProgress?.(0, total);

          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            file.write(chunk);
            onProgress?.(received, total);
          });

          res.on('end', () => {
            file.end(() => {
              resolve();
            });
          });

          res.on('error', (err) => {
            file.close();
            fs.unlink(destPath, () => {
              // ignore cleanup error
            });
            reject(err);
          });

          file.on('error', (err) => {
            file.close();
            fs.unlink(destPath, () => {
              // ignore cleanup error
            });
            reject(err);
          });
        },
      );

      req.on('error', (err) => {
        logError('Network error during download', err, { url: currentUrl });
        reject(err);
      });

      req.end();
    };

    doDownload(url);
  });
}

export async function downloadHfModel(
  options: {
    repoId: string;
    fileName: string;
    displayName?: string;
    quantization?: string;
    contextWindow?: number;
  },
  onProgress?: (p: LlamaSetupProgress & { id: string }) => void,
): Promise<{ ok: boolean; model?: ManagedModel; error?: string }> {
  const { repoId, fileName, displayName, quantization, contextWindow } = options;

  try {
    if (!repoId || !fileName) {
      throw new Error('repoId and fileName are required');
    }

    ensureDirSync(MODEL_DIR);

    const id = `${repoId}/${fileName}`;
    const url = `https://huggingface.co/${encodeURIComponent(
      repoId,
    )}/resolve/main/${encodeURIComponent(fileName)}?download=true`;

    const destPath = path.join(MODEL_DIR, fileName);
    const tmpPath = destPath + '.download';

    logInfo('Starting HF model download', { id, url, destPath });

    // Use the new download helper with progress tracking
    await downloadFile(
      url,
      tmpPath,
      (received, total) => {
        if (received === 0) {
          // Download started
          onProgress?.({
            id,
            type: 'download-start',
            url,
            totalBytes: total,
          });
        } else {
          // Download progress
          onProgress?.({
            id,
            type: 'download-progress',
            receivedBytes: received,
            totalBytes: total,
          });
        }
      },
    );

    onProgress?.({
      id,
      type: 'download-complete',
      filePath: tmpPath,
    });

    // Move into place
    fs.renameSync(tmpPath, destPath);
    const stat = fs.statSync(destPath);

    const now = new Date().toISOString();
    let createdOrUpdated: ManagedModel | undefined;

    updateState((s) => {
      const existing = s.models.find((m) => m.id === id);
      if (existing) {
        existing.displayName =
          displayName || existing.displayName || `${repoId} / ${fileName}`;
        existing.source = 'huggingface';
        existing.repoId = repoId;
        existing.fileName = fileName;
        existing.filePath = destPath;
        existing.sizeBytes = stat.size;
        existing.quantization = quantization || existing.quantization;
        existing.contextWindow =
          typeof contextWindow === 'number'
            ? contextWindow
            : existing.contextWindow;
        existing.installed = true;
        existing.downloadedBytes = stat.size;
        existing.currentParams = normalizeParams(existing.currentParams);
        existing.updatedAt = now;
        createdOrUpdated = existing;
      } else {
        const model: ManagedModel = {
          id,
          displayName:
            displayName || `${repoId} / ${fileName}`,
          source: 'huggingface',
          repoId,
          fileName,
          filePath: destPath,
          sizeBytes: stat.size,
          quantization,
          contextWindow,
          description: undefined,
          recommended: {},
          currentParams: normalizeParams(undefined),
          installed: true,
          downloadedBytes: stat.size,
          createdAt: now,
          updatedAt: now,
        };
        s.models.push(model);
        createdOrUpdated = model;

        // If no active model yet, set this as active.
        if (!s.activeModelId) {
          s.activeModelId = model.id;
          s.lastUsedModelId = model.id;
        }
      }
    });

    if (!createdOrUpdated) {
      throw new Error('Model state update failed');
    }

    logInfo('HF model downloaded and registered', {
      id: createdOrUpdated.id,
      filePath: createdOrUpdated.filePath,
    });

    return { ok: true, model: createdOrUpdated };
  } catch (err: any) {
    logError('downloadHfModel failed', err, {
      repoId,
      fileName,
    });
    onProgress?.({
      id: `${repoId}/${fileName}`,
      type: 'error',
      message: err?.message || String(err),
    });
    return { ok: false, error: err?.message || String(err) };
  }
}