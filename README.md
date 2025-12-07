# MyDeviceAI Desktop

Transform your computer into an AI inference hub. Connect from any device via peer-to-peer networking to run AI models locally on your desktop.

## Overview

MyDeviceAI Desktop is a cross-platform Electron application that enables remote devices (ios & android via the MyDeviceAI app) to leverage your desktop's computing power for AI inference. Using WebRTC peer-to-peer connections, devices can send prompts and receive AI-generated responses without relying on cloud services.

### Key Features

- **Local AI Inference**: Run GGUF format models locally using llama.cpp
- **Peer-to-Peer Networking**: Direct WebRTC connections with devices via Cloudflare Workers signaling
- **Model Management**: Search, download, and switch between AI models from Hugging Face
- **Cross-Platform**: Supports macOS, Linux, and Windows
- **Privacy-Focused**: All inference happens locally on your machine
- **Streaming Responses**: Real-time token streaming for responsive AI interactions
- **Modern UI**: Clean, dark-themed interface with live connection monitoring

## Quick Start

### Prerequisites

- Node.js v20 or higher
- 10+ GB free disk space (for AI models)
- Stable internet connection (for initial model download)

### Installation

#### From Release

Download the latest installer for your platform:
- **macOS**: `.zip` archive
- **Linux**: `.deb` package (Ubuntu/Debian)
- **Windows**: `.exe` installer

#### From Source

```bash
# Clone the repository
git clone https://github.com/navedmerchant/MyDeviceAI-Desktop.git
cd MyDeviceAI-Desktop

# Install dependencies
npm install

# Create environment configuration
cp src/Env.example.ts src/Env.ts
# Edit src/Env.ts with your P2P signaling server URL

# Start development server
npm start
```

### First Run

1. Launch the application
2. The app will automatically download llama.cpp for your platform
3. Default AI model (Qwen3-4B, ~7GB) will be downloaded
4. Once setup completes, you'll see your Room ID
5. Use this Room ID to connect from other devices

## Usage

### Connecting Devices

1. Note your **Room ID** displayed in the app
2. On your mobile device or other computer, use the companion app
3. Enter the Room ID to establish a peer-to-peer connection
4. Send prompts and receive AI-generated responses

### Managing Models

- **Active Model**: Displayed in the status bar
- **Download Models**: Search and download from Hugging Face
- **Configure Parameters**: Adjust temperature, top-p, max tokens, etc.
- **Switch Models**: Stop current model and load a different one

### Room Management

- **Current Room ID**: Shown at the top of the interface
- **Regenerate Room**: Click to create a new Room ID (disconnects current peers)

## Architecture

### Tech Stack

- **Frontend**: TypeScript, Electron, HTML/CSS
- **Backend**: Node.js, Electron main process
- **AI Runtime**: llama.cpp (bundled)
- **Networking**: WebRTC, Cloudflare Workers (signaling)
- **Build System**: Webpack, Electron Forge

### Project Structure

```
src/
├── index.ts           # Main process entry point
├── renderer.ts        # UI logic and P2P client
├── preload.ts        # IPC bridge (security layer)
├── llamaSetup.ts     # llama.cpp management
├── modelManager.ts   # Model download and lifecycle
├── p2pcf/            # P2P networking library
├── index.html        # Main window template
└── index.css         # Application styling
```

### P2P Protocol

Communication uses WebRTC data channels with JSON messages:

- `hello`: Initial peer handshake
- `version_negotiate`: Protocol version exchange
- `prompt`: AI completion request
- `tokens`: Streaming response chunks
- `model_info`: Current model metadata

## Development

### Build Commands

```bash
# Development mode with hot reload
npm start

# Run linter
npm run lint

# Package application
npm run package

# Create platform installers
npm run make

# Publish release
npm run publish
```

### Platform-Specific Builds

The CI/CD pipeline automatically builds for:
- **Linux**: DEB package (Ubuntu/Debian) - uses Ubuntu-compiled llama.cpp
- **macOS**: ZIP distribution
- **Windows**: Squirrel installer

Builds are triggered on git tags matching `v*` pattern.

### Configuration

**Environment Configuration**:

The application requires a P2P signaling server URL to be configured in `src/Env.ts`.

To set up your own signaling server:
1. Follow the instructions at [p2pcf-signalling](https://github.com/navedmerchant/p2pcf-signalling)
2. Deploy to Railway (one-click deployment available)
3. Update `src/Env.ts` with your Railway deployment URL

**Model Parameters** (configurable per model):
- Temperature
- Top-p, Top-k
- Maximum tokens
- Context window size
- GPU layers (for acceleration)

## Security

The application implements several security measures:

- **Electron Fuses**: Code integrity validation
- **Preload Sandboxing**: Minimal IPC surface
- **Content Security Policy**: Restricted resource loading
- **No Remote Code**: All code loaded from ASAR bundle
- **Local Inference**: No data sent to external servers

## Troubleshooting

### llama.cpp fails to start

- Check logs in the collapsible "Logs" panel
- Ensure no other process is using the assigned port
- Verify model file integrity in the models directory

### Peers cannot connect

- Verify Room ID is correct
- Check firewall settings (WebRTC requires UDP)
- Ensure STUN/TURN servers are accessible

### Model download fails

- Check available disk space (models are 2-10GB)
- Verify internet connection
- Try a different Hugging Face model

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Author

Naved Merchant (naved.merchant@gmail.com)

## Acknowledgments

- [llama.cpp](https://github.com/ggerganov/llama.cpp) - High-performance LLM inference
- [Electron](https://www.electronjs.org/) - Cross-platform desktop framework
- [P2PCF](https://github.com/gofodor/p2pcf) - Peer-to-peer communication library
- [Hugging Face](https://huggingface.co/) - Model hosting and distribution

---

**Note**: This is an early-stage project. Features and APIs may change in future releases.