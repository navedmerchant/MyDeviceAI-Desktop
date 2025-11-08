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

const DEFAULT_LLAMA_ENDPOINT = 'http://localhost:8080';

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
 * Call a LlamaCPP-compatible chat endpoint (non-streaming).
 *
 * By default targets `${DEFAULT_LLAMA_ENDPOINT}/v1/chat/completions`.
 * Adjust once your server implementation is finalized.
 */
async function llamaQuery(
  prompt: string,
  opts: Partial<LlamaChatCompletionRequest> = {},
): Promise<LlamaChatCompletionResponse> {
  logPreload('llama.query invoked', {
    hasCustomEndpoint: Boolean((opts as any).endpoint),
    model: opts.model,
    temperature: opts.temperature,
    max_tokens: opts.max_tokens,
    extraMessages: opts.messages?.length ?? 0,
  });
  const endpoint =
    (opts as any).endpoint || `${DEFAULT_LLAMA_ENDPOINT}/v1/chat/completions`;

  const body: LlamaChatCompletionRequest = {
    model: opts.model || 'local-model',
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 256,
    messages: [
      ...(opts.messages || []),
      {
        role: 'user',
        content: prompt,
      },
    ],
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logPreloadError('llama.query HTTP error', undefined, {
      endpoint,
      status: res.status,
      statusText: res.statusText,
      bodySnippet: text.slice(0, 512),
    });
    throw new Error(
      `Llama query failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  // Allow loosely-typed response to accommodate different LlamaCPP frontends.
  const data = (await res.json()) as any;
  logPreload('llama.query response received', {
    hasChoices: Array.isArray(data?.choices),
    model: data?.model,
  });

  // Normalize into LlamaChatCompletionResponse-like shape.
  if (!data.choices && data.content) {
    return {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: String(data.content) },
          finish_reason: 'stop',
        },
      ],
    };
  }

  return data as LlamaChatCompletionResponse;
}

/**
 * Streaming chat completion.
 *
 * Assumes the future LlamaCPP server supports a streaming mode:
 * - Either OpenAI-style `stream: true` with SSE / chunked JSON.
 * - Or JSONL / plain text tokens per line.
 *
 * This returns an async generator so the renderer can:
 *
 *   for await (const chunk of window.llama.stream(prompt, opts)) {
 *     // append chunk.token to UI
 *   }
 *
 * Implementation is intentionally generic; you can refine once the server
 * protocol is finalized.
 */
async function* llamaStream(
  prompt: string,
  opts: Partial<LlamaChatCompletionRequest & { endpoint?: string }> = {},
): AsyncGenerator<LlamaStreamChunk, void, unknown> {
  const endpoint =
    opts.endpoint || `${DEFAULT_LLAMA_ENDPOINT}/v1/chat/completions`;

  const body: any = {
    model: opts.model || 'local-model',
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 256,
    messages: [
      ...(opts.messages || []),
      {
        role: 'user',
        content: prompt,
      },
    ],
    stream: true,
  };

  logPreload('llama.stream invoked', {
    endpoint,
    model: opts.model,
    temperature: opts.temperature,
    max_tokens: opts.max_tokens,
  });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.body || !res.ok) {
    const text = await res.text().catch(() => '');
    logPreloadError('llama.stream HTTP error', undefined, {
      endpoint,
      status: res.status,
      statusText: res.statusText,
      bodySnippet: text.slice(0, 512),
    });
    throw new Error(
      `Llama stream failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  let yieldedTokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (buffer.trim().length > 0) {
        const raw = buffer;
        let json: any | null = null;
        let token: string | undefined;
        try {
          json = JSON.parse(raw);
          token =
            json.choices?.[0]?.delta?.content ??
            json.choices?.[0]?.message?.content ??
            undefined;
        } catch {
          token = raw;
        }
        yield { raw, json, token, done: true };
      }
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    // Split on newlines to support JSONL and SSE-like outputs.
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      const raw = line;
      let json: any | null = null;
      let token: string | undefined;
      let isDone = false;

      try {
        json = JSON.parse(line);

        // OpenAI-style "done" flag or finish_reason
        if (json.done === true || json.choices?.[0]?.finish_reason) {
          isDone = true;
        }

        // Attempt to extract token / delta text
        token =
          json.choices?.[0]?.delta?.content ??
          json.choices?.[0]?.message?.content ??
          undefined;
      } catch {
        // If not JSON, treat line as raw token/text.
        token = line;
      }

      yield { raw, json, token, done: isDone };
      if (token) {
        yieldedTokens += 1;
      }

      if (isDone) {
        return;
      }
    
      logPreload('llama.stream completed', {
        yieldedTokens,
      });
    }
  }
}

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
  // Existing HTTP helpers (for when a local llama.cpp HTTP server is running)
  query: llamaQuery,
  stream: llamaStream,
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

// Keep the original docs as comments for reference:
// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
