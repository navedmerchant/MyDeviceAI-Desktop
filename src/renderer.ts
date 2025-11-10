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
  const random = Math.random().toString(36).slice(2, 10);
  const roomId = `room-${random}`;
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
  logRenderer('Creating P2PCF client', { clientId, roomId });
  const p2pcf = new P2PCF(clientId, roomId);

  p2pcf.on('peerconnect', (peer: any) => {
    logRenderer('Peer connected', {
      id: peer?.id,
      client_id: peer?.client_id,
    });

    peer.on('track', (track: any, stream: any) => {
      logRenderer('Received media track from peer', {
        peerId: peer?.id,
        clientId: peer?.client_id,
        kind: track?.kind,
      });
    });

    // Example hook: we could expose llama here later, e.g.:
    // window.llama?.query(`Peer ${peer.client_id} connected`);
  });

  p2pcf.on('peerclose', (peer: any) => {
    logRenderer('Peer disconnected', {
      id: peer?.id,
      client_id: peer?.client_id,
    });
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
  logRenderer('Starting P2PCF client');
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

function initP2PCFWithCurrentRoom(): void {
  const roomId = getOrCreateRoomId();
  updateRoomIdDisplay(roomId);

  if (p2pcf) {
    try {
      logRenderer('Destroying previous P2PCF instance before re-init');
      p2pcf.destroy();
    } catch (e) {
      logRendererError('Error destroying previous P2PCF instance', e as Error);
    }
    p2pcf = null;
  }

  p2pcf = createP2PCFClient(roomId);
}

function setupRoomControls(): void {
  const newRoomButton = document.getElementById('new-room-btn');
  if (!newRoomButton) {
    logRendererError('new-room-btn element not found; room controls disabled');
    return;
  }

  newRoomButton.addEventListener('click', () => {
    const newRoomId = generateRandomRoomId();
    logRenderer('User requested new room id', { newRoomId });
    setRoomId(newRoomId);
    updateRoomIdDisplay(newRoomId);

    // Re-init P2PCF with new room id
    initP2PCFWithCurrentRoom();
  });
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
  title.textContent = 'mydeviceai-desktop setup';
  title.style.marginBottom = '8px';

  const subtitle = document.createElement('p');
  subtitle.textContent =
    'We need to download the latest llama.cpp binary for your platform to run models locally.';

  const statusLine = document.createElement('div');
  statusLine.id = 'llama-setup-status';
  statusLine.style.margin = '12px 0';
  statusLine.textContent = 'Ready to download the recommended build.';

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
  logRenderer('Ensuring managed llama-server is running via preload bridge');
  if (window.llama?.ensureServer) {
    try {
      const status = await window.llama.ensureServer();
      if (status.ok) {
        logRenderer('Managed llama-server is running', {
          endpoint: status.endpoint,
        });
      } else {
        logRendererError('Failed to ensure llama-server', undefined, {
          error: status.error,
        });
      }
    } catch (err: any) {
      logRendererError('Error while ensuring llama-server', err);
    }
  } else {
    logRenderer('llama.ensureServer bridge not available; skipping server ensure');
  }

  logRenderer('Initializing main P2PCF UI');
  initP2PCFWithCurrentRoom();
  setupRoomControls();
});