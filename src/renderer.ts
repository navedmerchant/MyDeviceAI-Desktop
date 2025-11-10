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

// Logger helpers for console output only (activity log UI removed)
const uiLog = {
  info(message: string, extra?: Record<string, unknown>) {
    logRenderer(message, extra);
  },
  error(message: string, error?: unknown, extra?: Record<string, unknown>) {
    logRendererError(message, error, extra);
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

declare global {
  interface Window {
    modelManager?: {
      list: () => Promise<{
        models: {
          id: string;
          displayName: string;
          filePath: string;
          installed: boolean;
          currentParams: {
            temperature: number;
            topP: number;
            topK: number;
            maxTokens: number;
            contextWindow: number;
            gpuLayers: number;
          };
        }[];
        activeModelId: string | null;
      }>;
      getActive: () => Promise<{
        model: {
          id: string;
          displayName: string;
          filePath: string;
          installed: boolean;
          currentParams: {
            temperature: number;
            topP: number;
            topK: number;
            maxTokens: number;
            contextWindow: number;
            gpuLayers: number;
          };
        } | null;
      }>;
      setActive: (
        id: string,
      ) => Promise<{ ok: boolean; activeModelId?: string; error?: string }>;
      updateParams: (
        id: string,
        params: {
          temperature?: number;
          topP?: number;
          topK?: number;
          maxTokens?: number;
          contextWindow?: number;
          gpuLayers?: number;
        },
      ) => Promise<{ ok: boolean; error?: string }>;
      searchHfGguf: (
        query: string,
      ) => Promise<{ ok: true; results: any[] } | { ok: false; error: string }>;
      listHfFiles: (
        repoId: string,
      ) => Promise<
        | { ok: true; files: { name: string; size?: number }[] }
        | { ok: false; error: string }
      >;
      downloadHf: (options: {
        repoId: string;
        fileName: string;
        displayName?: string;
        quantization?: string;
        contextWindow?: number;
      }) => Promise<{ ok: boolean; error?: string }>;
      cancelDownload: (id: string) => Promise<{ ok: boolean; error?: string }>;
      deleteModel: (id: string) => Promise<{ ok: boolean; error?: string }>;
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
      ) => () => void;
    };
  }
}

/**
 * Simple in-renderer Model Management screen implementation.
 * - Separate UIs for Model Management and Model Downloading
 * - Model Management: select active model, edit params
 * - Download Models: HF search and download
 */

function renderMainP2PUI() {
  const target = document.location.origin + document.location.pathname;
  logRenderer('Navigating to main UI', { target });
  document.location.href = target;
}

/**
 * Build the Model Management UI (selection and parameters only)
 */
function buildModelManagementUI() {
  const root = document.body;
  root.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'md-root md-stack';

  const header = document.createElement('header');
  header.className = 'md-topbar md-stack-section';
  header.style.justifyContent = 'space-between';

  const headerLeft = document.createElement('div');
  headerLeft.className = 'md-topbar-left';

  const title = document.createElement('div');
  title.className = 'md-app-title';
  title.textContent = 'Model Management';

  const subtitle = document.createElement('div');
  subtitle.className = 'md-app-subtitle';
  subtitle.textContent = 'Manage installed models and parameters';

  headerLeft.appendChild(title);
  headerLeft.appendChild(subtitle);

  const headerRight = document.createElement('div');
  headerRight.className = 'md-topbar-right';

  const backBtn = document.createElement('button');
  backBtn.textContent = 'Back to Main';
  backBtn.className = 'md-btn md-btn-ghost';
  backBtn.onclick = () => {
    renderMainP2PUI();
  };

  headerRight.appendChild(backBtn);
  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  const layout = document.createElement('div');
  layout.className = 'md-stack-section';
  layout.style.display = 'grid';
  layout.style.gridTemplateColumns = '280px 1fr';
  layout.style.gap = '14px';
  layout.style.flex = '1 1 auto';
  layout.style.minHeight = '0';

  // Left: Installed models list
  const leftPanel = document.createElement('section');
  leftPanel.className = 'md-card';
  leftPanel.style.display = 'flex';
  leftPanel.style.flexDirection = 'column';
  leftPanel.style.gap = '8px';
  leftPanel.style.overflowY = 'auto';

  const leftTitle = document.createElement('div');
  leftTitle.className = 'md-section-label';
  leftTitle.textContent = 'Installed Models';
  leftPanel.appendChild(leftTitle);

  const modelListEl = document.createElement('div');
  modelListEl.id = 'md-model-list';
  modelListEl.style.display = 'flex';
  modelListEl.style.flexDirection = 'column';
  modelListEl.style.gap = '4px';
  leftPanel.appendChild(modelListEl);

  // Right: Details
  const rightPanel = document.createElement('section');
  rightPanel.className = 'md-card';
  rightPanel.style.display = 'flex';
  rightPanel.style.flexDirection = 'column';
  rightPanel.style.gap = '8px';
  rightPanel.style.flex = '1';
  rightPanel.style.minHeight = '0';
  rightPanel.style.overflowY = 'auto';

  const detailsTitle = document.createElement('div');
  detailsTitle.className = 'md-section-label';
  detailsTitle.textContent = 'Model Details & Parameters';
  rightPanel.appendChild(detailsTitle);

  const detailsBody = document.createElement('div');
  detailsBody.id = 'md-model-details-body';
  detailsBody.textContent = 'Select a model from the left to view and edit its parameters.';
  detailsBody.style.fontSize = '12px';
  detailsBody.style.color = 'var(--md-text-muted)';
  rightPanel.appendChild(detailsBody);

  layout.appendChild(leftPanel);
  layout.appendChild(rightPanel);

  container.appendChild(header);
  container.appendChild(layout);

  root.appendChild(container);

  let currentSelectedId: string | null = null;

  const refreshList = async () => {
    if (!window.modelManager?.list) return;
    const { models, activeModelId } = await window.modelManager.list();
    modelListEl.innerHTML = '';

    if (!models.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No models registered yet.';
      empty.style.fontSize = '12px';
      empty.style.color = '#6b7280';
      modelListEl.appendChild(empty);
      return;
    }

    models.forEach((m) => {
      const row = document.createElement('div');
      row.style.padding = '8px 10px';
      row.style.marginBottom = '4px';
      row.style.borderRadius = '8px';
      row.style.cursor = 'pointer';
      row.style.display = 'flex';
      row.style.flexDirection = 'column';
      row.style.gap = '4px';
      row.style.transition = 'all var(--md-transition-fast)';
      row.dataset.id = m.id;

      const name = document.createElement('div');
      name.textContent = m.displayName || m.id;
      name.style.fontSize = '12px';
      name.style.fontWeight = '500';
      name.style.color = 'var(--md-text)';

      const meta = document.createElement('div');
      meta.style.fontSize = '10px';
      meta.style.color = 'var(--md-text-muted)';
      meta.textContent = `${
        m.installed ? 'installed' : 'not installed'
      }${activeModelId === m.id ? ' • active' : ''}`;

      row.appendChild(name);
      row.appendChild(meta);

      // Highlight active model with distinct styling
      const isActive = activeModelId === m.id;
      const isSelected = m.id === currentSelectedId;
      
      if (isActive && isSelected) {
        // Active AND selected - show both highlights
        row.style.background = 'linear-gradient(135deg, var(--md-accent-soft), rgba(168, 85, 247, 0.14))';
        row.style.border = '2px solid var(--md-accent)';
        row.style.boxShadow = '0 0 12px rgba(56, 189, 248, 0.3)';
      } else if (isActive) {
        // Active but not selected - subtler green/blue glow
        row.style.background = 'linear-gradient(135deg, rgba(56, 189, 248, 0.12), rgba(34, 197, 94, 0.08))';
        row.style.border = '1px solid rgba(56, 189, 248, 0.5)';
        row.style.boxShadow = '0 0 8px rgba(56, 189, 248, 0.2)';
      } else if (isSelected) {
        // Selected but not active
        row.style.background = 'var(--md-accent-soft)';
        row.style.border = '1px solid var(--md-accent)';
      } else {
        row.style.background = 'rgba(15, 23, 42, 0.6)';
        row.style.border = '1px solid var(--md-border-subtle)';
      }

      row.onmouseenter = () => {
        const isActive = activeModelId === m.id;
        const isSelected = m.id === currentSelectedId;
        
        if (!isSelected && !isActive) {
          row.style.background = 'rgba(15, 23, 42, 0.9)';
          row.style.borderColor = 'var(--md-border-strong)';
        }
      };

      row.onmouseleave = () => {
        const isActive = activeModelId === m.id;
        const isSelected = m.id === currentSelectedId;
        
        if (isActive && isSelected) {
          row.style.background = 'linear-gradient(135deg, var(--md-accent-soft), rgba(168, 85, 247, 0.14))';
          row.style.border = '2px solid var(--md-accent)';
          row.style.boxShadow = '0 0 12px rgba(56, 189, 248, 0.3)';
        } else if (isActive) {
          row.style.background = 'linear-gradient(135deg, rgba(56, 189, 248, 0.12), rgba(34, 197, 94, 0.08))';
          row.style.border = '1px solid rgba(56, 189, 248, 0.5)';
          row.style.boxShadow = '0 0 8px rgba(56, 189, 248, 0.2)';
        } else if (isSelected) {
          row.style.background = 'var(--md-accent-soft)';
          row.style.border = '1px solid var(--md-accent)';
        } else {
          row.style.background = 'rgba(15, 23, 42, 0.6)';
          row.style.borderColor = 'var(--md-border-subtle)';
        }
      };

      row.onclick = () => {
        currentSelectedId = m.id;
        renderDetails(m, activeModelId);
        refreshList();
      };

      modelListEl.appendChild(row);
    });
  };

  const renderDetails = (
    model: {
      id: string;
      displayName: string;
      installed: boolean;
      currentParams: {
        temperature: number;
        topP: number;
        topK: number;
        maxTokens: number;
        contextWindow: number;
        gpuLayers: number;
      };
    },
    activeModelId: string | null,
  ) => {
    detailsBody.innerHTML = '';

    const titleEl = document.createElement('div');
    titleEl.textContent = model.displayName || model.id;
    titleEl.style.fontSize = '13px';
    titleEl.style.fontWeight = '600';
    titleEl.style.marginBottom = '6px';
    titleEl.style.color = 'var(--md-text)';

    const statusEl = document.createElement('div');
    statusEl.style.fontSize = '11px';
    statusEl.style.marginBottom = '8px';
    statusEl.style.color = 'var(--md-text-muted)';
    statusEl.textContent = `${
      model.installed ? 'Installed' : 'Not installed'
    }${activeModelId === model.id ? ' • Active model' : ''}`;

    const paramsForm = document.createElement('div');
    paramsForm.style.display = 'grid';
    paramsForm.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
    paramsForm.style.gap = '6px';
    paramsForm.style.fontSize = '11px';

    type ParamKey = keyof typeof model.currentParams;
    const paramLabels: Record<ParamKey, string> = {
      temperature: 'Temp',
      topP: 'top_p',
      topK: 'top_k',
      maxTokens: 'Max tokens',
      contextWindow: 'Ctx window',
      gpuLayers: 'GPU layers',
    };

    const inputs: Partial<Record<ParamKey, HTMLInputElement>> = {};

    (Object.keys(model.currentParams) as ParamKey[]).forEach((key) => {
      const wrap = document.createElement('label');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '1px';

      const lab = document.createElement('div');
      lab.textContent = paramLabels[key];
      lab.style.color = 'var(--md-text-muted)';
      lab.style.fontSize = '10px';

      const input = document.createElement('input');
      input.type = 'number';
      input.value = String(model.currentParams[key]);
      input.style.fontSize = '11px';
      input.style.padding = '5px 7px';
      input.style.borderRadius = '5px';
      input.style.border = '1px solid var(--md-border-subtle)';
      input.style.background = 'rgba(2, 6, 23, 0.8)';
      input.style.color = 'var(--md-text)';

      inputs[key] = input;

      wrap.appendChild(lab);
      wrap.appendChild(input);
      paramsForm.appendChild(wrap);
    });

    const actionsRow = document.createElement('div');
    actionsRow.style.marginTop = '4px';
    actionsRow.style.display = 'flex';
    actionsRow.style.gap = '6px';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save Params';
    saveBtn.className = 'md-btn md-btn-ghost';
    saveBtn.style.fontSize = '11px';

    saveBtn.onclick = async () => {
      if (!window.modelManager?.updateParams) return;
      const params: any = {};
      (Object.keys(inputs) as ParamKey[]).forEach((k) => {
        const v = inputs[k]?.value;
        if (v !== undefined) {
          const num = Number(v);
          if (!Number.isNaN(num)) params[k] = num;
        }
      });
      const res = await window.modelManager.updateParams(model.id, params);
      if (!res.ok) {
        detailsBody.appendChild(
          document.createTextNode(
            ` Failed to update params: ${res.error || 'unknown error'}`,
          ),
        );
      } else {
        uiLog.info('Updated model params', { id: model.id });
        refreshList();
      }
    };

    const setActiveBtn = document.createElement('button');
    setActiveBtn.textContent =
      activeModelId === model.id ? 'Active' : 'Set Active';
    setActiveBtn.disabled = activeModelId === model.id || !model.installed;
    setActiveBtn.className = activeModelId === model.id ? 'md-btn md-btn-ghost' : 'md-btn';
    setActiveBtn.style.fontSize = '11px';
    if (setActiveBtn.disabled) {
      setActiveBtn.style.opacity = '0.5';
      setActiveBtn.style.cursor = 'default';
    }

    setActiveBtn.onclick = async () => {
      if (!window.modelManager?.setActive) return;
      if (setActiveBtn.disabled) return;
      
      uiLog.info('Setting active model', { id: model.id });
      const res = await window.modelManager.setActive(model.id);
      if (!res.ok) {
        const errorMsg = document.createElement('div');
        errorMsg.style.color = '#b91c1c';
        errorMsg.style.fontSize = '12px';
        errorMsg.style.marginTop = '4px';
        errorMsg.textContent = `Failed to set active: ${res.error || 'unknown error'}`;
        detailsBody.appendChild(errorMsg);
      } else {
        uiLog.info('Active model changed', { id: model.id });
        // Refresh the list to show updated active state
        await refreshList();
        // Re-render details for the now-active model
        const { models, activeModelId } = await window.modelManager.list();
        const updatedModel = models.find((m) => m.id === model.id);
        if (updatedModel) {
          renderDetails(updatedModel, activeModelId);
        }
      }
    };

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete Model';
    deleteBtn.className = 'md-btn md-btn-ghost';
    deleteBtn.style.fontSize = '11px';
    deleteBtn.style.color = 'var(--md-danger)';
    deleteBtn.disabled = activeModelId === model.id || !model.installed;
    if (deleteBtn.disabled) {
      deleteBtn.style.opacity = '0.5';
      deleteBtn.style.cursor = 'default';
    }

    deleteBtn.onclick = async () => {
      if (!window.modelManager?.deleteModel) return;
      if (deleteBtn.disabled) return;

      // Confirm deletion
      const confirmed = confirm(
        `Are you sure you want to delete "${model.displayName || model.id}"?\n\nThis will permanently remove the model file from your system.`
      );
      
      if (!confirmed) return;

      uiLog.info('Deleting model', { id: model.id });
      const res = await window.modelManager.deleteModel(model.id);
      
      if (!res.ok) {
        const errorMsg = document.createElement('div');
        errorMsg.style.color = '#b91c1c';
        errorMsg.style.fontSize = '12px';
        errorMsg.style.marginTop = '4px';
        errorMsg.textContent = `Failed to delete: ${res.error || 'unknown error'}`;
        detailsBody.appendChild(errorMsg);
      } else {
        uiLog.info('Model deleted successfully', { id: model.id });
        // Clear details and refresh list
        currentSelectedId = null;
        detailsBody.innerHTML = '';
        detailsBody.textContent = 'Select a model from the left to view and edit its parameters.';
        detailsBody.style.fontSize = '12px';
        detailsBody.style.color = 'var(--md-text-muted)';
        await refreshList();
      }
    };

    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(setActiveBtn);
    actionsRow.appendChild(deleteBtn);

    detailsBody.appendChild(titleEl);
    detailsBody.appendChild(statusEl);
    detailsBody.appendChild(paramsForm);
    detailsBody.appendChild(actionsRow);
  };

  void refreshList();
}

/**
 * Build the Download Models UI (HuggingFace search and download)
 */
function buildDownloadModelsUI() {
  const root = document.body;
  root.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'md-root md-stack';

  const header = document.createElement('header');
  header.className = 'md-topbar md-stack-section';
  header.style.justifyContent = 'space-between';

  const headerLeft = document.createElement('div');
  headerLeft.className = 'md-topbar-left';

  const title = document.createElement('div');
  title.className = 'md-app-title';
  title.textContent = 'Download Models';

  const subtitle = document.createElement('div');
  subtitle.className = 'md-app-subtitle';
  subtitle.textContent = 'Search and download GGUF models from Hugging Face';

  headerLeft.appendChild(title);
  headerLeft.appendChild(subtitle);

  const headerRight = document.createElement('div');
  headerRight.className = 'md-topbar-right';

  const backBtn = document.createElement('button');
  backBtn.textContent = 'Back to Main';
  backBtn.className = 'md-btn md-btn-ghost';
  backBtn.onclick = () => {
    renderMainP2PUI();
  };

  headerRight.appendChild(backBtn);
  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  const mainContent = document.createElement('div');
  mainContent.className = 'md-stack-section';
  mainContent.style.flex = '1';
  mainContent.style.display = 'flex';
  mainContent.style.flexDirection = 'column';
  mainContent.style.gap = '14px';
  mainContent.style.minHeight = '0';

  const hfCard = document.createElement('section');
  hfCard.className = 'md-card';
  hfCard.style.display = 'flex';
  hfCard.style.flexDirection = 'column';
  hfCard.style.gap = '8px';

  const hfTitle = document.createElement('div');
  hfTitle.className = 'md-section-label';
  hfTitle.textContent = 'Search GGUF Models';

  const hfSearchRow = document.createElement('div');
  hfSearchRow.style.display = 'flex';
  hfSearchRow.style.gap = '8px';

  const hfSearchInput = document.createElement('input');
  hfSearchInput.type = 'text';
  hfSearchInput.placeholder = 'Search GGUF models (e.g. "Qwen 7B", "Llama")';
  hfSearchInput.style.flex = '1';
  hfSearchInput.style.fontSize = '12px';
  hfSearchInput.style.padding = '8px 10px';
  hfSearchInput.style.borderRadius = '7px';
  hfSearchInput.style.border = '1px solid var(--md-border-subtle)';
  hfSearchInput.style.background = 'rgba(2, 6, 23, 0.8)';
  hfSearchInput.style.color = 'var(--md-text)';

  const hfSearchButton = document.createElement('button');
  hfSearchButton.textContent = 'Search';
  hfSearchButton.className = 'md-btn';
  hfSearchButton.style.fontSize = '12px';

  hfSearchRow.appendChild(hfSearchInput);
  hfSearchRow.appendChild(hfSearchButton);

  const resultsCard = document.createElement('section');
  resultsCard.className = 'md-card';
  resultsCard.style.flex = '1';
  resultsCard.style.display = 'flex';
  resultsCard.style.flexDirection = 'column';
  resultsCard.style.gap = '8px';
  resultsCard.style.minHeight = '0';

  const resultsTitle = document.createElement('div');
  resultsTitle.className = 'md-section-label';
  resultsTitle.textContent = 'Search Results';

  const hfResults = document.createElement('div');
  hfResults.id = 'md-hf-results';
  hfResults.style.flex = '1';
  hfResults.style.overflowY = 'auto';
  hfResults.style.fontSize = '12px';
  hfResults.textContent = 'Enter a search term and click Search to find GGUF models.';
  hfResults.style.color = 'var(--md-text-muted)';

  const hfStatus = document.createElement('div');
  hfStatus.id = 'md-hf-status';
  hfStatus.style.fontSize = '11px';
  hfStatus.style.color = 'var(--md-text-muted)';
  hfStatus.style.minHeight = '18px';
  
  const progressBarContainer = document.createElement('div');
  progressBarContainer.id = 'md-download-progress-container';
  progressBarContainer.style.width = '100%';
  progressBarContainer.style.height = '6px';
  progressBarContainer.style.background = 'rgba(15, 23, 42, 0.8)';
  progressBarContainer.style.borderRadius = '3px';
  progressBarContainer.style.overflow = 'hidden';
  progressBarContainer.style.marginTop = '4px';
  progressBarContainer.style.display = 'none';

  const progressBarFill = document.createElement('div');
  progressBarFill.id = 'md-download-progress-fill';
  progressBarFill.style.width = '0%';
  progressBarFill.style.height = '100%';
  progressBarFill.style.background = 'var(--md-accent)';
  progressBarFill.style.boxShadow = '0 0 8px var(--md-accent)';
  progressBarFill.style.transition = 'width 0.2s ease';
  
  progressBarContainer.appendChild(progressBarFill);

  hfCard.appendChild(hfTitle);
  hfCard.appendChild(hfSearchRow);

  resultsCard.appendChild(resultsTitle);
  resultsCard.appendChild(hfResults);
  resultsCard.appendChild(progressBarContainer);
  resultsCard.appendChild(hfStatus);

  mainContent.appendChild(hfCard);
  mainContent.appendChild(resultsCard);

  container.appendChild(header);
  container.appendChild(mainContent);

  root.appendChild(container);

  // Track current download ID for cancel functionality
  let currentDownloadId: string | null = null;

  // Download progress tracking
  const unsubscribeProgress =
    window.modelManager?.onDownloadProgress?.((p) => {
      if (p.type === 'download-start') {
        currentDownloadId = p.id;
        progressBarContainer.style.display = 'block';
        progressBarFill.style.width = '0%';
        hfStatus.textContent = `Downloading ${p.id}...`;
        hfStatus.style.color = 'var(--md-accent)';
        
        // Add cancel button
        const existingCancelBtn = document.getElementById('md-cancel-download-btn');
        if (!existingCancelBtn) {
          const cancelBtn = document.createElement('button');
          cancelBtn.id = 'md-cancel-download-btn';
          cancelBtn.textContent = 'Cancel Download';
          cancelBtn.className = 'md-btn md-btn-ghost';
          cancelBtn.style.fontSize = '11px';
          cancelBtn.style.color = 'var(--md-danger)';
          cancelBtn.style.marginTop = '4px';
          
          cancelBtn.onclick = async () => {
            if (!window.modelManager?.cancelDownload || !currentDownloadId) return;
            
            const confirmed = confirm('Are you sure you want to cancel this download?');
            if (!confirmed) return;
            
            cancelBtn.disabled = true;
            cancelBtn.textContent = 'Cancelling...';
            
            const result = await window.modelManager.cancelDownload(currentDownloadId);
            
            if (result.ok) {
              hfStatus.textContent = 'Download cancelled';
              hfStatus.style.color = 'var(--md-text-muted)';
              progressBarContainer.style.display = 'none';
              cancelBtn.remove();
              currentDownloadId = null;
            } else {
              cancelBtn.disabled = false;
              cancelBtn.textContent = 'Cancel Download';
              hfStatus.textContent = `Failed to cancel: ${result.error || 'unknown error'}`;
              hfStatus.style.color = 'var(--md-danger)';
            }
          };
          
          hfStatus.parentElement?.insertBefore(cancelBtn, hfStatus.nextSibling);
        }
      } else if (p.type === 'download-progress' && p.totalBytes) {
        const percent = ((p.receivedBytes || 0) / p.totalBytes) * 100;
        progressBarFill.style.width = `${Math.min(99, percent).toFixed(1)}%`;
        const mbReceived = ((p.receivedBytes || 0) / (1024 * 1024)).toFixed(1);
        const mbTotal = (p.totalBytes / (1024 * 1024)).toFixed(1);
        hfStatus.textContent = `Downloading ${p.id}: ${mbReceived}MB / ${mbTotal}MB`;
      } else if (p.type === 'download-complete') {
        progressBarFill.style.width = '100%';
        hfStatus.textContent = `Download complete for ${p.id}. Model is now available!`;
        hfStatus.style.color = 'var(--md-accent)';
        currentDownloadId = null;
        
        // Remove cancel button
        const cancelBtn = document.getElementById('md-cancel-download-btn');
        if (cancelBtn) cancelBtn.remove();
        
        setTimeout(() => {
          progressBarContainer.style.display = 'none';
        }, 3000);
      } else if (p.type === 'error') {
        progressBarContainer.style.display = 'none';
        hfStatus.textContent = `Error downloading ${p.id}: ${p.message || ''}`;
        hfStatus.style.color = 'var(--md-danger)';
        currentDownloadId = null;
        
        // Remove cancel button
        const cancelBtn = document.getElementById('md-cancel-download-btn');
        if (cancelBtn) cancelBtn.remove();
      } else if (p.message) {
        hfStatus.textContent = p.message;
      }
    }) || null;

  // Search functionality
  hfSearchButton.onclick = async () => {
    if (!window.modelManager?.searchHfGguf) return;
    const q = hfSearchInput.value || '';
    hfResults.innerHTML = '<div style="color: var(--md-text-muted);">Searching...</div>';
    hfStatus.textContent = '';
    
    const res = await window.modelManager.searchHfGguf(q);
    if (!res.ok) {
      hfResults.innerHTML = `<div style="color: var(--md-danger);">Search error: ${(res as { ok: false; error: string }).error}</div>`;
      return;
    }
    
    const results = res.results || [];
    hfResults.innerHTML = '';
    
    if (!results.length) {
      hfResults.innerHTML = '<div style="color: var(--md-text-muted);">No GGUF models found. Try a different search term.</div>';
      return;
    }
    
    results.forEach((m: any) => {
      const row = document.createElement('div');
      row.style.padding = '8px 10px';
      row.style.marginBottom = '4px';
      row.style.borderRadius = '8px';
      row.style.border = '1px solid var(--md-border-subtle)';
      row.style.cursor = 'pointer';
      row.style.transition = 'all var(--md-transition-fast)';
      row.style.background = 'rgba(15, 23, 42, 0.6)';

      row.onmouseenter = () => {
        row.style.background = 'rgba(15, 23, 42, 0.9)';
        row.style.borderColor = 'var(--md-accent)';
      };
      row.onmouseleave = () => {
        row.style.background = 'rgba(15, 23, 42, 0.6)';
        row.style.borderColor = 'var(--md-border-subtle)';
      };

      const titleRow = document.createElement('div');
      titleRow.style.display = 'flex';
      titleRow.style.justifyContent = 'space-between';
      titleRow.style.alignItems = 'center';
      titleRow.style.marginBottom = '2px';

      const modelTitle = document.createElement('div');
      modelTitle.textContent = m.id;
      modelTitle.style.fontSize = '12px';
      modelTitle.style.fontWeight = '500';
      modelTitle.style.color = 'var(--md-text)';

      const meta = document.createElement('div');
      meta.style.fontSize = '10px';
      meta.style.color = 'var(--md-text-muted)';
      meta.textContent = `${m.downloads || 0} downloads`;

      titleRow.appendChild(modelTitle);
      titleRow.appendChild(meta);

      row.appendChild(titleRow);

      row.onclick = async () => {
        if (!window.modelManager?.listHfFiles || !window.modelManager?.downloadHf) {
          hfStatus.textContent =
            'Model file listing or download bridge not available in preload.';
          hfStatus.style.color = 'var(--md-danger)';
          return;
        }

        hfStatus.textContent = `Loading GGUF files for ${m.id}...`;
        hfStatus.style.color = 'var(--md-text-muted)';

        try {
          const res = await window.modelManager.listHfFiles(m.id);

          if (!res || !res.ok) {
            const errMsg =
              res && !res.ok
                ? (res as { ok: false; error: string }).error
                : 'Unknown error while listing GGUF files';
            console.error('[ModelManager] listHfFiles failed', {
              repoId: m.id,
              error: errMsg,
            });
            hfStatus.textContent = `Failed to load files for ${m.id}: ${errMsg}`;
            hfStatus.style.color = 'var(--md-danger)';
            return;
          }

          const ggufFiles = Array.isArray(res.files) ? res.files : [];

          hfResults.innerHTML = '';

          if (!ggufFiles.length) {
            hfStatus.textContent = `No GGUF files found in ${m.id}`;
            hfStatus.style.color = 'var(--md-danger)';
            return;
          }

          hfStatus.textContent = `Select a GGUF file from ${m.id} to download:`;
          hfStatus.style.color = 'var(--md-text-muted)';

          // Back button to return to search results
          const backToResults = document.createElement('button');
          backToResults.textContent = '← Back to Search Results';
          backToResults.className = 'md-btn md-btn-ghost';
          backToResults.style.marginBottom = '8px';
          backToResults.style.fontSize = '11px';
          backToResults.onclick = () => {
            hfSearchButton.click();
          };
          hfResults.appendChild(backToResults);

          ggufFiles.forEach((file: any) => {
            const fileName = String(file.name || file.path || '');

            const fileRow = document.createElement('div');
            fileRow.style.padding = '8px 10px';
            fileRow.style.marginBottom = '4px';
            fileRow.style.borderRadius = '7px';
            fileRow.style.border = '1px solid var(--md-border-subtle)';
            fileRow.style.background = 'rgba(15, 23, 42, 0.6)';
            fileRow.style.display = 'flex';
            fileRow.style.justifyContent = 'space-between';
            fileRow.style.alignItems = 'center';
            fileRow.style.gap = '8px';
            fileRow.dataset.file = fileName;

            const leftWrap = document.createElement('div');
            leftWrap.style.display = 'flex';
            leftWrap.style.flexDirection = 'column';
            leftWrap.style.flex = '1';
            leftWrap.style.minWidth = '0';

            const nameEl = document.createElement('div');
            nameEl.textContent = fileName;
            nameEl.style.fontSize = '11px';
            nameEl.style.fontWeight = '500';
            nameEl.style.color = 'var(--md-text)';
            nameEl.style.whiteSpace = 'nowrap';
            nameEl.style.overflow = 'hidden';
            nameEl.style.textOverflow = 'ellipsis';

            const sizeEl = document.createElement('div');
            sizeEl.style.fontSize = '10px';
            sizeEl.style.color = 'var(--md-text-muted)';
            if (typeof file.size === 'number') {
              const mb = file.size / (1024 * 1024);
              const gb = mb / 1024;
              sizeEl.textContent = gb >= 1
                ? `${gb.toFixed(2)} GB`
                : `${mb.toFixed(2)} MB`;
            }

            leftWrap.appendChild(nameEl);
            if (sizeEl.textContent) {
              leftWrap.appendChild(sizeEl);
            }

            const actionEl = document.createElement('button');
            actionEl.textContent = 'Download';
            actionEl.className = 'md-btn';
            actionEl.style.fontSize = '11px';
            actionEl.style.whiteSpace = 'nowrap';

            actionEl.onclick = async (ev) => {
              ev.stopPropagation();
              actionEl.disabled = true;
              actionEl.textContent = 'Downloading...';
              actionEl.style.opacity = '0.6';
              
              hfStatus.textContent = `Starting download for ${m.id} / ${fileName}...`;
              hfStatus.style.color = 'var(--md-accent)';
              
              const result = await window.modelManager!.downloadHf({
                repoId: m.id,
                fileName,
              });

              if (!result.ok) {
                hfStatus.textContent = `Download failed: ${
                  result.error || 'unknown error'
                }`;
                hfStatus.style.color = 'var(--md-danger)';
                actionEl.disabled = false;
                actionEl.textContent = 'Retry';
                actionEl.style.opacity = '1';
              } else {
                actionEl.textContent = '✓ Downloaded';
                actionEl.disabled = true;
                actionEl.style.opacity = '0.7';
              }
            };

            fileRow.appendChild(leftWrap);
            fileRow.appendChild(actionEl);
            hfResults.appendChild(fileRow);
          });
        } catch (err: any) {
          console.error('[ModelManager] Error loading HF GGUF files via IPC', err);
          hfStatus.textContent = `Error loading files for ${m.id}: ${
            err?.message || String(err)
          }`;
          hfStatus.style.color = 'var(--md-danger)';
        }
      };

      hfResults.appendChild(row);
    });
  };

  // Clean up progress listener when leaving screen
  if (unsubscribeProgress) {
    window.addEventListener(
      'beforeunload',
      () => {
        unsubscribeProgress();
      },
      { once: true },
    );
  }

  // Allow Enter key to trigger search
  hfSearchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      hfSearchButton.click();
    }
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  logRenderer('DOMContentLoaded');
  const params = parseStartupParams();
  const llamaInstalledFlag = params.get('llamaInstalled') === '1';

  // If not installed, show setup.
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

  // If installed, expose two separate controls in the top-right:
  // 1. "Models" - for managing/selecting installed models
  // 2. "Download Models" - for searching and downloading from HuggingFace
  // Update active model display in room section
  const updateActiveModelDisplay = async () => {
    const activeModelNameEl = document.getElementById('active-model-name');
    if (!activeModelNameEl || !window.modelManager?.getActive) return;
    
    try {
      const { model } = await window.modelManager.getActive();
      if (model) {
        activeModelNameEl.textContent = model.displayName || model.id;
        activeModelNameEl.title = `Active model: ${model.displayName || model.id}`;
      } else {
        activeModelNameEl.textContent = 'none selected';
        activeModelNameEl.style.color = 'var(--md-danger)';
      }
    } catch (err) {
      activeModelNameEl.textContent = 'error loading model';
      activeModelNameEl.style.color = 'var(--md-danger)';
    }
  };

  // Initial update
  void updateActiveModelDisplay();

  const header = document.querySelector('.md-topbar-right');
  if (header) {
    const modelsBtn = document.createElement('button');
    modelsBtn.textContent = 'Manage Models';
    modelsBtn.className = 'md-btn';
    modelsBtn.style.marginLeft = '8px';
    modelsBtn.onclick = () => {
      buildModelManagementUI();
    };
    modelsBtn.title = 'Manage installed models and parameters';
    header.appendChild(modelsBtn);

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'Download Models';
    downloadBtn.className = 'md-btn';
    downloadBtn.style.marginLeft = '8px';
    downloadBtn.onclick = () => {
      buildDownloadModelsUI();
    };
    downloadBtn.title = 'Download new models from Hugging Face';
    header.appendChild(downloadBtn);
  }

  // Ensure llama-server is running so there is an active engine.
  uiLog.info('Ensuring managed llama-server is running via preload bridge');
  if (window.llama?.ensureServer) {
    try {
      const status = await window.llama.ensureServer();
      if (status.ok) {
        uiLog.info('Managed llama-server is running', {
          endpoint: status.endpoint,
        });
        updateLlamaStatus('Runtime: ready', 'ok');
      } else {
        uiLog.error('Failed to ensure llama-server', undefined, {
          error: status.error,
        });
        updateLlamaStatus('Runtime: unavailable', 'warn');
      }
    } catch (err: any) {
      uiLog.error('Error while ensuring llama-server', err);
      updateLlamaStatus('Runtime: error', 'warn');
    }
  } else {
    uiLog.info(
      'llama.ensureServer bridge not available; skipping server ensure',
    );
    updateLlamaStatus('Runtime: bridge missing', 'warn');
  }

  uiLog.info('Initializing main P2PCF UI');
  initP2PCFWithCurrentRoom();
  setupRoomControls();
});