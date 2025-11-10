import { contextBridge, ipcRenderer } from 'electron';

const LOG_PREFIX_PRELOAD = '[Preload]';

function logPreload(message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX_PRELOAD} ${message}`, extra);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX_PRELOAD} ${message}`);
  }
}

function logPreloadError(
  message: string,
  error?: unknown,
  extra?: Record<string, unknown>,
): void {
  // eslint-disable-next-line no-console
  console.error(`${LOG_PREFIX_PRELOAD} ${message}`, {
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error,
    ...extra,
  });
}

/**
* Preload script:
* - Exposes a minimal, typed surface for LlamaCPP HTTP interactions.
* - Keeps renderer sandboxed (no direct Node/Electron APIs).
*
* NOTE:
* - This assumes a local LlamaCPP server will be available later.
* - For now, these functions are safe no-ops / HTTP calls and can be
*   wired up once the server is running.
*/

type LlamaChatMessage = {
 role: 'system' | 'user' | 'assistant';
 content: string;
};

type LlamaChatCompletionRequest = {
 messages: LlamaChatMessage[];
 model?: string;
 temperature?: number;
 max_tokens?: number;
};

type LlamaChatChoice = {
 index: number;
 message: LlamaChatMessage;
 finish_reason: string | null;
};

type LlamaChatCompletionResponse = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: LlamaChatChoice[];
};

type LlamaStatus = {
  ok: boolean;
  endpoint: string;
  error?: string;
};

type LlamaStreamChunk = {
  /**
   * Raw chunk data from the server (already decoded as text).
   */
  raw: string;
  /**
   * Parsed JSON line if the server streams JSONL, otherwise null.
   */
  json: any | null;
  /**
   * Extracted token / delta text for convenience if present.
   */
  token?: string;
  done?: boolean;
};

const DEFAULT_LLAMA_ENDPOINT = 'http:/localhost:8080';

type LlamaInstallStatus = {
  installed: boolean;
  version?: string;
  binaryPath?: string;
  error?: string;
};

type LlamaSetupProgress =
  | { type: 'status'; message: string }
  | { type: 'download-start'; url: string; totalBytes?: number }
  | { type: 'download-progress'; receivedBytes: number; totalBytes?: number }
  | { type: 'download-complete'; filePath: string }
  | { type: 'install-complete'; version: string; binaryPath: string }
  | { type: 'error'; message: string };

type LlamaServerStatus =
  | { ok: true; endpoint: string }
  | { ok: false; error: string };


/**
 * NOTE: Llama HTTP helpers were moved into the renderer process.
 * Preload no longer performs direct HTTP calls to the llama server.
 * This keeps the preload surface focused on safe, minimal IPC bridges.
 */


/**
 * Lightweight status check.
 * If a managed llama-server is running, main will expose its endpoint via IPC;
 * otherwise we fall back to DEFAULT_LLAMA_ENDPOINT.
 */
async function llamaGetStatus(): Promise<LlamaStatus> {
  // Ask main if it has a managed llama-server endpoint (Qwen3/llama-server).
  try {
    logPreload('llama.getStatus invoked');
    const managed: LlamaServerStatus | undefined =
      (await (ipcRenderer.invoke('llama-server-get-endpoint') as Promise<LlamaServerStatus>)) ??
      undefined;
    const endpoint =
      managed && managed.ok ? managed.endpoint : DEFAULT_LLAMA_ENDPOINT;
    logPreload('llama.getStatus managed endpoint check', {
      managedOk: managed?.ok,
      managedEndpoint: managed?.ok ? managed.endpoint : null,
      effectiveEndpoint: endpoint,
    });

    const res: Response | null = await fetch(endpoint, {
      method: 'GET',
    }).catch((err: any): null => {
      logPreloadError('llama.getStatus fetch failed', err, { endpoint });
      return null;
    });

   if (!res) {
     logPreloadError('llama.getStatus: no HTTP response from server', undefined, {
       endpoint,
     });
     return {
       ok: false,
       endpoint,
       error: 'No response from LlamaCPP server',
     };
   }

   const status: LlamaStatus = {
     ok: res.ok,
     endpoint,
     error: res.ok
       ? undefined
       : `HTTP ${res.status} ${res.statusText}`,
   };
   logPreload('llama.getStatus HTTP probe result', status);
   return status;
 } catch (error: any) {
   logPreloadError('llama.getStatus threw', error);
   return {
     ok: false,
     endpoint: DEFAULT_LLAMA_ENDPOINT,
     error: error?.message || 'Unknown error',
   };
 }
}

// Expose a minimal API surface to the renderer.
contextBridge.exposeInMainWorld('llama', {
  // Only expose IPC and setup helpers; HTTP calls live in the renderer.
  getStatus: llamaGetStatus,

  // Setup helpers for native llama.cpp binary management
  getInstallStatus: async (): Promise<LlamaInstallStatus> => {
    logPreload('llama.getInstallStatus bridge invoke');
    const status = await ipcRenderer
      .invoke('llama-get-status')
      .catch((err: any) => {
        logPreloadError('llama-get-status IPC failed', err);
        const fallback: LlamaInstallStatus = {
          installed: false,
          error: err?.message || 'IPC llama-get-status failed',
        };
        return fallback;
      });

    logPreload('llama.getInstallStatus bridge result', status as any);
    return status as LlamaInstallStatus;
  },

  installLatest: async (
    onProgress?: (p: LlamaSetupProgress) => void,
  ): Promise<LlamaInstallStatus> => {
    logPreload('llama.installLatest bridge invoked');
    // Listen for progress events for this install call.
    const listener = (_event: any, progress: LlamaSetupProgress) => {
      logPreload('llama.installLatest progress event', progress as any);
      onProgress?.(progress);
    };
    ipcRenderer.on('llama-install-progress', listener);

    try {
      const result = await ipcRenderer
        .invoke('llama-install-latest')
        .catch((err: any) => {
          logPreloadError('llama-install-latest IPC failed', err);
          const fallback: LlamaInstallStatus = {
            installed: false,
            error: err?.message || 'IPC llama-install-latest failed',
          };
          return fallback;
        });

      logPreload('llama.installLatest bridge completed', result as any);
      return result as LlamaInstallStatus;
    } finally {
      ipcRenderer.removeListener('llama-install-progress', listener);
      logPreload('llama.installLatest progress listener removed');
    }
  },

  /**
   * Ensure the managed llama-server is running.
   * This simply forwards to the main-process IPC that wraps ensureLlamaServer()
   * in src/llamaSetup.ts, and returns its { ok, endpoint, error? } result.
   */
  ensureServer: async (): Promise<LlamaServerStatus> => {
    logPreload('llama.ensureServer bridge invoked');
    try {
      const result = await ipcRenderer.invoke(
        'llama-ensure-server',
      ) as LlamaServerStatus;
      logPreload('llama.ensureServer bridge result', result as any);
      return result;
    } catch (err: any) {
      logPreloadError('llama.ensureServer IPC failed', err);
      return {
        ok: false,
        error: err?.message || 'IPC llama-ensure-server failed',
      };
    }
  },
});

/**
 * Model management bridge
 * - Wraps the IPC handlers from src/index.ts.
 */
contextBridge.exposeInMainWorld('modelManager', {
  list: async () => {
    logPreload('modelManager.list invoke');
    return ipcRenderer.invoke('models-list');
  },

  getActive: async () => {
    logPreload('modelManager.getActive invoke');
    return ipcRenderer.invoke('models-get-active');
  },

  setActive: async (id: string) => {
    logPreload('modelManager.setActive invoke', { id });
    return ipcRenderer.invoke('models-set-active', { id });
  },

  updateParams: async (
    id: string,
    params: {
      temperature?: number;
      topP?: number;
      topK?: number;
      maxTokens?: number;
      contextWindow?: number;
      gpuLayers?: number;
    },
  ) => {
    logPreload('modelManager.updateParams invoke', { id, params });
    return ipcRenderer.invoke('models-update-params', { id, params });
  },

  searchHfGguf: async (query: string) => {
    logPreload('modelManager.searchHfGguf invoke', { query });
    return ipcRenderer.invoke('models-search-hf-gguf', { query });
  },

  listHfFiles: async (repoId: string) => {
    logPreload('modelManager.listHfFiles invoke', { repoId });
    return ipcRenderer.invoke('models-list-hf-gguf-files', { repoId });
  },

  downloadHf: async (options: {
    repoId: string;
    fileName: string;
    displayName?: string;
    quantization?: string;
    contextWindow?: number;
  }) => {
    logPreload('modelManager.downloadHf invoke', {
      repoId: options?.repoId,
      fileName: options?.fileName,
    });
    return ipcRenderer.invoke('models-download-hf', options);
  },

  onDownloadProgress: (
    handler: (p: {
      id: string;
      type:
        | 'status'
        | 'download-start'
        | 'download-progress'
        | 'download-complete'
        | 'install-complete'
        | 'error';
      message?: string;
      url?: string;
      totalBytes?: number;
      receivedBytes?: number;
      filePath?: string;
    }) => void,
  ) => {
    const listener = (_event: any, payload: any) => {
      handler(payload);
    };
    ipcRenderer.on('models-download-progress', listener);
    return () => {
      ipcRenderer.removeListener('models-download-progress', listener);
    };
  },
});

// Keep the original docs as comments for reference:
// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
