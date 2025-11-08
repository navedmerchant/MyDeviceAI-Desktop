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

function generateRandomRoomId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `room-${random}`;
}

function getOrCreateRoomId(): string {
  let roomId = window.localStorage.getItem(ROOM_ID_STORAGE_KEY);
  if (!roomId) {
    roomId = generateRandomRoomId();
    window.localStorage.setItem(ROOM_ID_STORAGE_KEY, roomId);
  }
  return roomId;
}

function setRoomId(roomId: string): void {
  window.localStorage.setItem(ROOM_ID_STORAGE_KEY, roomId);
}

function updateRoomIdDisplay(roomId: string): void {
  const el = document.getElementById('room-id');
  if (el) {
    el.textContent = roomId;
  }
}

function createP2PCFClient(roomId: string): any {
  const clientId = 'client';
  const p2pcf = new P2PCF(clientId, roomId);

  p2pcf.on('peerconnect', (peer: any) => {
    console.log('New peer:', peer.id, peer.client_id);

    peer.on('track', (track: any, stream: any) => {
      console.log('track', { track, stream });
    });

    // Example hook: we could expose llama here later, e.g.:
    // window.llama?.query(`Peer ${peer.client_id} connected`);
  });

  p2pcf.on('peerclose', (peer: any) => {
    console.log('peer disconnected', peer?.id, peer?.client_id);
  });

  p2pcf.on('msg', (peer: any, data: any) => {
    console.log('message from peer', peer?.id, 'data', data);
    // Later: integrate with llama API, e.g. forward prompts/results
  });

  // Start polling after listeners are attached
  p2pcf.start();

  return p2pcf;
}

declare global {
  interface Window {
    llama?: {
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
    };
  }
}

let p2pcf: any | null = null;

function initP2PCFWithCurrentRoom(): void {
  const roomId = getOrCreateRoomId();
  updateRoomIdDisplay(roomId);

  if (p2pcf) {
    try {
      p2pcf.destroy();
    } catch (e) {
      console.warn('Error destroying previous P2PCF instance', e);
    }
    p2pcf = null;
  }

  p2pcf = createP2PCFClient(roomId);
}

function setupRoomControls(): void {
  const newRoomButton = document.getElementById('new-room-btn');
  if (!newRoomButton) {
    return;
  }

  newRoomButton.addEventListener('click', () => {
    const newRoomId = generateRandomRoomId();
    setRoomId(newRoomId);
    updateRoomIdDisplay(newRoomId);

    // Re-init P2PCF with new room id
    initP2PCFWithCurrentRoom();
  });
}

function parseStartupParams(): URLSearchParams {
  try {
    const url = new URL(window.location.href);
    return url.searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function renderSetupScreen() {
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
    runInstall();
  };
  retryButton.onclick = () => {
    runInstall();
  };
}

function renderMainUI() {
  // Keep existing HTML-driven structure: assume index.html has the room controls.
  // We only ensure that on successful setup we restore original DOM-based UI.
  document.location.href = document.location.origin + document.location.pathname;
}

window.addEventListener('DOMContentLoaded', async () => {
  const params = parseStartupParams();
  const llamaInstalledFlag = params.get('llamaInstalled') === '1';

  if (!llamaInstalledFlag && window.llama?.getInstallStatus) {
    const status = await window.llama.getInstallStatus().catch(() => ({
      installed: false,
    }));

    if (!status.installed) {
      renderSetupScreen();
      return;
    }
  }

  // If we reach here, llama is installed (or we fall back to existing behavior).
  initP2PCFWithCurrentRoom();
  setupRoomControls();
});