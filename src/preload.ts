import { contextBridge, ipcRenderer } from 'electron';

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
    throw new Error(
      `Llama query failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  // Allow loosely-typed response to accommodate different LlamaCPP frontends.
  const data = (await res.json()) as any;

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

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.body || !res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Llama stream failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

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

      if (isDone) {
        return;
      }
    }
  }
}

/**
* Lightweight status check.
* For now, just attempts a HEAD/GET on the base endpoint.
*/
async function llamaGetStatus(): Promise<LlamaStatus> {
 try {
   const res: Response | null = await fetch(DEFAULT_LLAMA_ENDPOINT, {
     method: 'GET',
   }).catch((): null => null);

   if (!res) {
     return {
       ok: false,
       endpoint: DEFAULT_LLAMA_ENDPOINT,
       error: 'No response from LlamaCPP server',
     };
   }

   return {
     ok: res.ok,
     endpoint: DEFAULT_LLAMA_ENDPOINT,
     error: res.ok
       ? undefined
       : `HTTP ${res.status} ${res.statusText}`,
   };
 } catch (error: any) {
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
    const status = await ipcRenderer.invoke('llama-get-status');
    return status as LlamaInstallStatus;
  },

  installLatest: async (
    onProgress?: (p: LlamaSetupProgress) => void,
  ): Promise<LlamaInstallStatus> => {
    // Listen for progress events for this install call.
    const listener = (_event: any, progress: LlamaSetupProgress) => {
      onProgress?.(progress);
    };
    ipcRenderer.on('llama-install-progress', listener);

    try {
      const result = await ipcRenderer.invoke('llama-install-latest');
      return result as LlamaInstallStatus;
    } finally {
      ipcRenderer.removeListener('llama-install-progress', listener);
    }
  },
});

// Keep the original docs as comments for reference:
// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
