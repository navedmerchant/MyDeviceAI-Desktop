/**
 * This file will automatically be loaded by webpack and run in the "renderer" context.
 * To learn more about the differences between the "main" and the "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/latest/tutorial/process-model
 *
 * By default, Node.js integration in this file is disabled. When enabling Node.js integration
 * in a renderer process, please be aware of potential security implications. You can read
 * more about security risks here:
 *
 * https://electronjs.org/docs/tutorial/security
 *
 * To enable Node.js integration in this file, open up `main.js` and enable the `nodeIntegration`
 * flag:
 *
 * ```
 *  // Create the browser window.
 *  mainWindow = new BrowserWindow({
 *    width: 800,
 *    height: 600,
 *    webPreferences: {
 *      nodeIntegration: true
 *    }
 *  });
 * ```
 */

import './index.css';

// @ts-ignore
import P2PCF from 'p2pcf';

const ROOM_ID_STORAGE_KEY = 'p2pcf_room_id';
const LOG_PREFIX_RENDERER = '[Renderer]';

function logRenderer(message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX_RENDERER} ${message}`, extra);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX_RENDERER} ${message}`);
  }
}

function logRendererError(
  message: string,
  error?: unknown,
  extra?: Record<string, unknown>,
): void {
  // eslint-disable-next-line no-console
  console.error(`${LOG_PREFIX_RENDERER} ${message}`, {
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error,
    ...extra,
  });
}

function generateRandomRoomId(): string {
  // Generate a 9-character upper-case alphanumeric ID for easier reading/input.
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 9; i += 1) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const roomId = id;
  logRenderer('Generated new random room id', { roomId });
  return roomId;
}

function getOrCreateRoomId(): string {
  let roomId = window.localStorage.getItem(ROOM_ID_STORAGE_KEY);
  if (!roomId) {
    logRenderer('No room id in storage, generating one');
    roomId = generateRandomRoomId();
    window.localStorage.setItem(ROOM_ID_STORAGE_KEY, roomId);
  } else {
    logRenderer('Using existing room id from storage', { roomId });
  }
  return roomId;
}

function setRoomId(roomId: string): void {
  logRenderer('Persisting room id', { roomId });
  window.localStorage.setItem(ROOM_ID_STORAGE_KEY, roomId);
}

function updateRoomIdDisplay(roomId: string): void {
  const el = document.getElementById('room-id');
  if (el) {
    el.textContent = roomId;
    logRenderer('Updated room id display', { roomId });
  } else {
    logRendererError('room-id element not found in DOM');
  }
}

function createP2PCFClient(roomId: string): any {
  const clientId = 'client';
  uiLog.info('Creating P2PCF client', { clientId, roomId });
  const p2pcf = new P2PCF(clientId, roomId);

  p2pcf.on('peerconnect', (peer: any) => {
    uiLog.info('Peer connected', {
      id: peer?.id,
      client_id: peer?.client_id,
    });

    addPeerToList(peer);

    peer.on('track', (track: any, stream: any) => {
      uiLog.info('Received media track from peer', {
        peerId: peer?.id,
        clientId: peer?.client_id,
        kind: track?.kind,
      });
    });

    updateP2PStatus('P2P: connected', 'ok');
  });

  p2pcf.on('peerclose', (peer: any) => {
    uiLog.info('Peer disconnected', {
      id: peer?.id,
      client_id: peer?.client_id,
    });
    removePeerFromList(peer);
  });

  // Minimal binary-safe JSON protocol over P2PCF:
  // All control/messages are UTF-8 JSON strings with field "t" (type).
  //
  // Types:
  // - "hello": sent by both sides on connect.
  //     { "t": "hello", "clientId": string, "impl": "mydeviceai-desktop", "version": string }
  //
  // - "prompt": remote peer -> this app
  //     { "t": "prompt", "id": string, "prompt": string, "max_tokens"?: number }
  //
  // Streaming response from this app -> remote peer:
  // - "start": once per prompt before any tokens
  //     { "t": "start", "id": string }
  // - "token": many per prompt
  //     { "t": "token", "id": string, "tok": string }
  // - "end": final success
  //     { "t": "end", "id": string }
  // - "error": final failure
  //     { "t": "error", "id": string, "message": string }
  //
  // Unknown or malformed messages are ignored but logged.
  //
  // NOTE: Actual llama integration is delegated to window.llama.ensureServer()
  // and HTTP calls; if unavailable, we respond with an error.

  type P2PMessage =
    | { t: 'hello'; clientId: string; impl: string; version: string }
    | { t: 'prompt'; id: string; prompt: string; max_tokens?: number }
    | { t: 'start'; id: string }
    | { t: 'token'; id: string; tok: string }
    | { t: 'reasoning_token'; id: string; tok: string }
    | { t: 'end'; id: string }
    | { t: 'error'; id: string; message: string }
    | { t: string; [k: string]: any };

  async function sendJsonSafe(peer: any, msg: P2PMessage): Promise<void> {
    try {
      const raw = JSON.stringify(msg);
      peer.send(raw);
    } catch (err) {
      logRendererError('Failed to send P2PCF JSON message', err as Error, {
        msg,
      });
    }
  }

  async function handlePromptRequest(peer: any, msg: any): Promise<void> {
    const id = typeof msg.id === 'string' ? msg.id : '';
    const prompt = typeof msg.prompt === 'string' ? msg.prompt : '';
    const maxTokens =
      typeof msg.max_tokens === 'number' && msg.max_tokens > 0
        ? msg.max_tokens
        : 512;

    if (!id || !prompt) {
      logRendererError('Invalid prompt message; missing id or prompt', undefined, {
        msg,
      });
      if (id) {
        await sendJsonSafe(peer, {
          t: 'error',
          id,
          message: 'Invalid prompt: missing prompt text',
        });
      }
      return;
    }

    if (!window.llama?.ensureServer) {
      await sendJsonSafe(peer, {
        t: 'error',
        id,
        message: 'Llama server control API not available in preload bridge',
      });
      return;
    }

    await sendJsonSafe(peer, { t: 'start', id });

    try {
      logRenderer('Ensuring llama-server before HTTP streaming', {
        id,
        maxTokens,
      });

      const ensure = await window.llama.ensureServer();
      if (!ensure.ok || !ensure.endpoint) {
        throw new Error(
          ensure.error || 'Failed to start or discover llama-server endpoint',
        );
      }

      const endpoint = `${ensure.endpoint}/v1/chat/completions`;
      logRenderer('Resolved llama-server HTTP endpoint for streaming', {
        endpoint,
      });

      const body: any = {
        model: 'local-model',
        temperature: 0.7,
        max_tokens: maxTokens,
        messages: [
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
        logRendererError('llama HTTP stream error', undefined, {
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

      while (true) {
        const { value, done: doneReading } = await reader.read();
        if (doneReading) {
          if (buffer.trim().length > 0) {
            const line = buffer.trim();
            let contentTok: string | undefined;
            let reasoningTok: string | undefined;
            try {
              const json = JSON.parse(line);
              contentTok =
                json.choices?.[0]?.delta?.content ??
                json.choices?.[0]?.message?.content ??
                undefined;
              reasoningTok =
                json.choices?.[0]?.delta?.reasoning_content ?? undefined;
            } catch {
              contentTok = line;
            }
            if (reasoningTok) {
              await sendJsonSafe(peer, {
                t: 'reasoning_token',
                id,
                tok: String(reasoningTok),
              });
            }
            if (contentTok) {
              await sendJsonSafe(peer, {
                t: 'token',
                id,
                tok: String(contentTok),
              });
            }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (!line) {
            continue;
          }

          // Handle SSE format: lines start with "data: "
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6); // Remove "data: " prefix
            
            // SSE streams often end with "data: [DONE]"
            if (jsonStr === '[DONE]') {
              await sendJsonSafe(peer, { t: 'end', id });
              return;
            }

            let contentTok: string | undefined;
            let reasoningTok: string | undefined;

            try {
              const json = JSON.parse(jsonStr);
              contentTok =
                json.choices?.[0]?.delta?.content ??
                json.choices?.[0]?.message?.content ??
                undefined;
              reasoningTok =
                json.choices?.[0]?.delta?.reasoning_content ?? undefined;

              const done =
                json.done === true || !!json.choices?.[0]?.finish_reason;

              if (reasoningTok) {
                await sendJsonSafe(peer, {
                  t: 'reasoning_token',
                  id,
                  tok: String(reasoningTok),
                });
              }

              if (contentTok) {
                await sendJsonSafe(peer, {
                  t: 'token',
                  id,
                  tok: String(contentTok),
                });
              }

              if (done) {
                await sendJsonSafe(peer, { t: 'end', id });
                return;
              }
            } catch (parseErr) {
              // If JSON parsing fails, treat the data as raw text
              logRendererError('Failed to parse SSE data as JSON', parseErr as Error, {
                line: jsonStr.slice(0, 256),
              });
            }
          } else if (line.startsWith(':')) {
            // SSE comment, ignore
            continue;
          } else if (line) {
            // Try parsing non-SSE format as fallback
            let contentTok: string | undefined;
            let reasoningTok: string | undefined;
            try {
              const json = JSON.parse(line);
              contentTok =
                json.choices?.[0]?.delta?.content ??
                json.choices?.[0]?.message?.content ??
                undefined;
              reasoningTok =
                json.choices?.[0]?.delta?.reasoning_content ?? undefined;

              const done =
                json.done === true || !!json.choices?.[0]?.finish_reason;

              if (reasoningTok) {
                await sendJsonSafe(peer, {
                  t: 'reasoning_token',
                  id,
                  tok: String(reasoningTok),
                });
              }

              if (contentTok) {
                await sendJsonSafe(peer, {
                  t: 'token',
                  id,
                  tok: String(contentTok),
                });
              }

              if (done) {
                await sendJsonSafe(peer, { t: 'end', id });
                return;
              }
            } catch {
              // Not JSON, skip
            }
          }
        }
      }

      await sendJsonSafe(peer, { t: 'end', id });
    } catch (err) {
      logRendererError(
        'Error while streaming llama completion via HTTP in renderer',
        err as Error,
        {
          id,
        },
      );
      await sendJsonSafe(peer, {
        t: 'error',
        id,
        message:
          (err as Error)?.message ||
          'Unknown error during completion via llama HTTP',
      });
      return;
    }

    return;
  }

  p2pcf.on('msg', (peer: any, data: any) => {
    const meta = {
      id: peer?.id,
      client_id: peer?.client_id,
    };

    try {
      const asString =
        typeof data === 'string'
          ? data
          : data instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(data))
          : ArrayBuffer.isView(data)
          ? new TextDecoder().decode(
              data.buffer instanceof ArrayBuffer
                ? new Uint8Array(data.buffer)
                : new Uint8Array(data as any),
            )
          : null;

      if (!asString) {
        logRendererError('Received unsupported P2PCF msg payload', undefined, {
          ...meta,
          dataType: typeof data,
        });
        return;
      }

      let msg: P2PMessage;
      try {
        msg = JSON.parse(asString);
      } catch (parseErr) {
        logRendererError('Failed to parse P2PCF msg as JSON', parseErr as Error, {
          ...meta,
          raw: asString.slice(0, 256),
        });
        return;
      }

      if (!msg || typeof msg.t !== 'string') {
        logRendererError('Received JSON without type field "t"', undefined, {
          ...meta,
          msg,
        });
        return;
      }

      switch (msg.t) {
        case 'hello':
          logRenderer('Received hello from peer', {
            ...meta,
            clientId: msg.clientId,
            impl: msg.impl,
            version: msg.version,
          });
          break;

        case 'prompt':
          logRenderer('Received prompt over P2PCF', {
            ...meta,
            id: msg.id,
            promptLen:
              typeof msg.prompt === 'string' ? msg.prompt.length : undefined,
          });
          void handlePromptRequest(peer, msg);
          break;

        default:
          logRenderer('Ignoring unknown P2PCF msg type', {
            ...meta,
            t: msg.t,
          });
      }
    } catch (err) {
      logRendererError('Unhandled error in P2PCF msg handler', err as Error, meta);
    }
  });

  // Start polling after listeners are attached
  uiLog.info('Starting P2PCF client');
  p2pcf.start();

  return p2pcf;
}

declare global {
  interface Window {
    llama?: {
      // Setup / IPC helpers still bridged via preload
      getStatus?: () => Promise<{
        ok: boolean;
        endpoint: string;
        error?: string;
      }>;

      getInstallStatus?: () => Promise<{
        installed: boolean;
        version?: string;
        binaryPath?: string;
        error?: string;
      }>;

      installLatest?: (
        onProgress?: (p: {
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
          version?: string;
          binaryPath?: string;
        }) => void,
      ) => Promise<{
        installed: boolean;
        version?: string;
        binaryPath?: string;
        error?: string;
      }>;

      ensureServer?: () => Promise<{
        ok: boolean;
        endpoint?: string;
        error?: string;
      }>;
    };
  }
}

let p2pcf: any | null = null;

/**
 * DOM helpers and UI wiring
 */

function q(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function setText(id: string, text: string): void {
  const node = q(id);
  if (node) node.textContent = text;
}

function ensureLogContainer(): HTMLElement | null {
  let c = q('log-output');
  if (!c) {
    logRendererError('log-output element missing in DOM');
    return null;
  }
  return c;
}

function appendLog(
  msg: string,
  level: 'info' | 'error' = 'info',
  tag = 'app',
): void {
  const root = ensureLogContainer();
  if (!root) return;

  const line = document.createElement('div');
  line.className =
    'md-log-line' + (level === 'error' ? ' md-log-line-error' : '');

  const tagEl = document.createElement('div');
  tagEl.className = 'md-log-tag';
  tagEl.textContent = tag.toUpperCase();

  const msgEl = document.createElement('div');
  msgEl.className = 'md-log-msg';
  msgEl.textContent = msg;

  line.appendChild(tagEl);
  line.appendChild(msgEl);

  root.appendChild(line);
  root.scrollTop = root.scrollHeight;
}

// Wrap logger helpers to also feed the UI log stream.
const uiLog = {
  info(message: string, extra?: Record<string, unknown>) {
    logRenderer(message, extra);
    const suffix =
      extra && Object.keys(extra).length
        ? ' ' + JSON.stringify(extra)
        : '';
    appendLog(message + suffix, 'info', 'p2p');
  },
  error(message: string, error?: unknown, extra?: Record<string, unknown>) {
    logRendererError(message, error, extra);
    const payload: any = {
      ...(extra || {}),
    };
    if (error instanceof Error) {
      payload.error = {
        name: error.name,
        message: error.message,
      };
    } else if (error) {
      payload.error = error;
    }
    const suffix =
      Object.keys(payload).length > 0
        ? ' ' + JSON.stringify(payload)
        : '';
    appendLog(message + suffix, 'error', 'err');
  },
};

function updateLlamaStatus(text: string, variant: 'muted' | 'ok' | 'warn') {
  const el = q('llama-status');
  if (!el) return;
  el.textContent = text;
  el.className = `md-pill ${
    variant === 'ok'
      ? 'md-pill-ok'
      : variant === 'warn'
      ? 'md-pill-warn'
      : 'md-pill-muted'
  }`;
}

function updateP2PStatus(_text: string, _variant: 'muted' | 'ok' | 'warn') {
  // P2P status indicator removed from UI; this is a no-op to keep callers safe.
}

function addPeerToList(peer: any) {
  const list = q('peer-list');
  if (!list) return;
  if (list.dataset.empty === '1') {
    list.textContent = '';
    delete list.dataset.empty;
  }

  const id =
    peer?.client_id || peer?.id || 'peer-' + Math.random().toString(36).slice(2);
  const safeId = String(id);

  let row = list.querySelector<HTMLElement>(
    `[data-peer-id="${CSS.escape(safeId)}"]`,
  );
  if (!row) {
    row = document.createElement('div');
    row.className = 'md-peer-item';
    row.dataset.peerId = safeId;

    const label = document.createElement('div');
    label.textContent = safeId;
    label.className = 'md-peer-id';

    const badge = document.createElement('div');
    badge.className = 'md-pill md-pill-ok';
    badge.textContent = 'connected';

    row.appendChild(label);
    row.appendChild(badge);
    list.appendChild(row);
  } else {
    const badge =
      row.querySelector<HTMLElement>('.md-pill') ||
      (() => {
        const b = document.createElement('div');
        b.className = 'md-pill';
        row!.appendChild(b);
        return b;
      })();
    badge.className = 'md-pill md-pill-ok';
    badge.textContent = 'connected';
  }
}

function removePeerFromList(peer: any) {
  const list = q('peer-list');
  if (!list) return;
  const safeId = String(peer?.client_id || peer?.id || '');
  if (!safeId) return;

  const row = list.querySelector<HTMLElement>(
    `[data-peer-id="${CSS.escape(safeId)}"]`,
  );
  if (row) {
    row.remove();
  }

  if (!list.children.length) {
    list.textContent = '';
    list.classList.remove('md-text-muted');
    (list as any).dataset.empty = '1';
  }
}

function initP2PCFWithCurrentRoom(): void {
  const roomId = getOrCreateRoomId();
  updateRoomIdDisplay(roomId);

  if (p2pcf) {
    try {
      uiLog.info('Destroying previous P2PCF instance before re-init');
      p2pcf.destroy();
    } catch (e) {
      uiLog.error('Error destroying previous P2PCF instance', e as Error);
    }
    p2pcf = null;
  }

  p2pcf = createP2PCFClient(roomId);
}

function setupRoomControls(): void {
  const newRoomButton = q('new-room-btn');
  const copyRoomButton = q('copy-room-btn');

  if (!newRoomButton) {
    uiLog.error('new-room-btn element not found; room controls disabled');
  } else {
    newRoomButton.addEventListener('click', () => {
      const newRoomId = generateRandomRoomId();
      uiLog.info('User requested new room id', { newRoomId });
      setRoomId(newRoomId);
      updateRoomIdDisplay(newRoomId);

      // Re-init P2PCF with new room id
      initP2PCFWithCurrentRoom();
    });
  }

  if (copyRoomButton) {
    copyRoomButton.addEventListener('click', async () => {
      const roomIdEl = q('room-id');
      const value = roomIdEl?.textContent || '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        uiLog.info('Room ID copied to clipboard');
      } catch (err) {
        uiLog.error('Failed to copy Room ID to clipboard', err as Error);
      }
    });
  }
}

function parseStartupParams(): URLSearchParams {
  try {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    logRenderer('Parsed startup params from URL', {
      llamaInstalled: params.get('llamaInstalled'),
      llamaVersion: params.get('llamaVersion'),
    });
    return params;
  } catch (error) {
    logRendererError('Failed to parse startup params; using empty params', error);
    return new URLSearchParams();
  }
}

function renderSetupScreen() {
  logRenderer('Rendering llama setup screen');
  const root = document.body;
  root.innerHTML = '';

  const container = document.createElement('div');
  container.id = 'llama-setup';
  container.style.padding = '24px';
  container.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif';

  const title = document.createElement('h1');
  title.textContent = 'Welcome to MyDeviceAI Desktop';
  title.style.marginBottom = '8px';

  const subtitle = document.createElement('p');
  subtitle.textContent =
    'The button below will download the right llama.cpp runtime for your platform, a LLM Qwnen3-4b to get you started. This will take about 2.5 gb of space';

  const statusLine = document.createElement('div');
  statusLine.id = 'llama-setup-status';
  statusLine.style.margin = '12px 0';
  statusLine.textContent = 'Ready to download.';

  const progressBarWrapper = document.createElement('div');
  progressBarWrapper.style.width = '100%';
  progressBarWrapper.style.height = '8px';
  progressBarWrapper.style.background = '#eee';
  progressBarWrapper.style.borderRadius = '4px';
  progressBarWrapper.style.overflow = 'hidden';
  progressBarWrapper.style.margin = '8px 0 4px 0';

  const progressBar = document.createElement('div');
  progressBar.id = 'llama-setup-progress';
  progressBar.style.width = '0%';
  progressBar.style.height = '100%';
  progressBar.style.background = '#2563eb';
  progressBar.style.transition = 'width 0.15s linear';

  progressBarWrapper.appendChild(progressBar);

  const progressDetail = document.createElement('div');
  progressDetail.id = 'llama-setup-progress-detail';
  progressDetail.style.fontSize = '11px';
  progressDetail.style.color = '#666';

  const errorLine = document.createElement('div');
  errorLine.id = 'llama-setup-error';
  errorLine.style.color = '#b91c1c';
  errorLine.style.marginTop = '6px';
  errorLine.style.fontSize = '12px';

  const buttonRow = document.createElement('div');
  buttonRow.style.marginTop = '16px';
  buttonRow.style.display = 'flex';
  buttonRow.style.gap = '8px';

  const installButton = document.createElement('button');
  installButton.textContent = 'Download & Install llama.cpp';
  installButton.style.padding = '8px 14px';
  installButton.style.border = 'none';
  installButton.style.borderRadius = '4px';
  installButton.style.background = '#2563eb';
  installButton.style.color = '#fff';
  installButton.style.cursor = 'pointer';

  const retryButton = document.createElement('button');
  retryButton.textContent = 'Retry';
  retryButton.style.padding = '8px 12px';
  retryButton.style.borderRadius = '4px';
  retryButton.style.border = '1px solid #d1d5db';
  retryButton.style.background = '#fff';
  retryButton.style.cursor = 'pointer';
  retryButton.style.display = 'none';

  buttonRow.appendChild(installButton);
  buttonRow.appendChild(retryButton);

  container.appendChild(title);
  container.appendChild(subtitle);
  container.appendChild(statusLine);
  container.appendChild(progressBarWrapper);
  container.appendChild(progressDetail);
  container.appendChild(errorLine);
  container.appendChild(buttonRow);

  root.appendChild(container);

  const runInstall = async () => {
    if (!window.llama?.installLatest) {
      errorLine.textContent =
        'Setup API not available. Ensure preload and main are configured correctly.';
      return;
    }

    installButton.disabled = true;
    retryButton.style.display = 'none';
    errorLine.textContent = '';
    statusLine.textContent = 'Starting download...';
    progressBar.style.width = '0%';
    progressDetail.textContent = '';

    const updateFromProgress = (p: any) => {
      switch (p.type) {
        case 'status':
          statusLine.textContent = p.message || '';
          break;
        case 'download-start':
          statusLine.textContent = 'Downloading llama.cpp...';
          if (p.totalBytes) {
            progressDetail.textContent = `Total size: ${(
              p.totalBytes /
              (1024 * 1024)
            ).toFixed(2)} MB`;
          }
          break;
        case 'download-progress':
          if (p.totalBytes) {
            const pct = Math.max(
              1,
              Math.min(99, (p.receivedBytes / p.totalBytes) * 100),
            );
            progressBar.style.width = `${pct.toFixed(1)}%`;
            progressDetail.textContent = `Downloaded ${(
              p.receivedBytes /
              (1024 * 1024)
            ).toFixed(2)} MB of ${(p.totalBytes / (1024 * 1024)).toFixed(
              2,
            )} MB`;
          } else {
            statusLine.textContent = 'Downloading llama.cpp...';
          }
          break;
        case 'download-complete':
          statusLine.textContent = 'Download complete. Finalizing installation...';
          progressBar.style.width = '100%';
          break;
        case 'install-complete':
          statusLine.textContent = `Installed llama.cpp ${p.version || ''}`;
          progressDetail.textContent = p.binaryPath
            ? `Binary: ${p.binaryPath}`
            : '';
          break;
        case 'error':
          errorLine.textContent = p.message || 'Unknown error during setup.';
          retryButton.style.display = 'inline-block';
          installButton.disabled = false;
          break;
      }
    };

    const result = (await window.llama
      .installLatest(updateFromProgress)
      .catch((err: any) => {
        updateFromProgress({
          type: 'error',
          message: err?.message || String(err),
        });
        const fallback: {
          installed: boolean;
          version?: string;
          binaryPath?: string;
          error?: string;
        } = { installed: false, error: err?.message || String(err) };
        return fallback;
      })) as {
      installed: boolean;
      version?: string;
      binaryPath?: string;
      error?: string;
    };

    if (result.installed) {
      statusLine.textContent = `Setup complete. llama.cpp ${
        result.version || ''
      } is ready. Launching app...`;
      progressBar.style.width = '100%';
      setTimeout(() => {
        renderMainUI();
      }, 800);
    }
  };

  installButton.onclick = () => {
    logRenderer('Install button clicked');
    runInstall();
  };
  retryButton.onclick = () => {
    logRenderer('Retry button clicked');
    runInstall();
  };
}

function renderMainUI() {
  // Keep existing HTML-driven structure: assume index.html has the room controls.
  // We only ensure that on successful setup we restore original DOM-based UI.
  const target = document.location.origin + document.location.pathname;
  logRenderer('Navigating to main UI', { target });
  document.location.href = target;
}

window.addEventListener('DOMContentLoaded', async () => {
  logRenderer('DOMContentLoaded');
  const params = parseStartupParams();
  const llamaInstalledFlag = params.get('llamaInstalled') === '1';

  if (!llamaInstalledFlag && window.llama?.getInstallStatus) {
    logRenderer('Checking llama install status via preload API');
    const status = await window.llama
      .getInstallStatus()
      .catch((err: any) => {
        logRendererError('llama.getInstallStatus failed in renderer', err);
        return {
          installed: false,
          error: err?.message || String(err),
        };
      });
    logRenderer('Renderer llama install status result', status as any);

    if (!status.installed) {
      logRenderer('Llama not installed; showing setup screen');
      renderSetupScreen();
      return;
    }
    logRenderer('Llama already installed; proceeding with main UI');
  }

  // If we reach here, llama is installed (or we fall back to existing behavior).
  uiLog.info('Ensuring managed llama-server is running via preload bridge');
  if (window.llama?.ensureServer) {
    try {
      const status = await window.llama.ensureServer();
      if (status.ok) {
        uiLog.info('Managed llama-server is running', {
          endpoint: status.endpoint,
        });
        updateLlamaStatus('Llama: ready', 'ok');
      } else {
        uiLog.error('Failed to ensure llama-server', undefined, {
          error: status.error,
        });
        updateLlamaStatus('Llama: unavailable', 'warn');
      }
    } catch (err: any) {
      uiLog.error('Error while ensuring llama-server', err);
      updateLlamaStatus('Llama: error', 'warn');
    }
  } else {
    uiLog.info(
      'llama.ensureServer bridge not available; skipping server ensure',
    );
    updateLlamaStatus('Llama: bridge missing', 'warn');
  }

  uiLog.info('Initializing main P2PCF UI');
  initP2PCFWithCurrentRoom();
  setupRoomControls();
});