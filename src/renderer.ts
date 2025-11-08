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

console.log(
  '👋 This message is being logged by "renderer.js", included via webpack',
);

// Import the p2pcf module
// @ts-ignore
import P2PCF from 'p2pcf';

const client_id = 'client';
const room_id = '1234';

const p2pcf = new P2PCF(client_id, room_id);

// Start polling
p2pcf.start();

p2pcf.on('peerconnect', (peer: any) => {
  // New peer connected
  
  // Peer is an instance of simple-peer (https://github.com/feross/simple-peer)
  //
  // The peer has two custom fields:
  // - id (a per session unique id)
  // - client_id (which was passed to their P2PCF constructor)
  
  console.log("New peer:", peer.id, peer.client_id);
  
  peer.on('track', (track: any, stream: any) => {
    // New media track + stream from peer
      console.log("track");

  });
  
  // Add a media stream to the peer to start sending it
  // Note: This is commented out as it requires actual media tracks
  // peer.addStream(new MediaStream());
});

p2pcf.on('peerclose', (peer: any) => {
  // Peer has disconnected
  console.log("peer disconnected")
});

p2pcf.on('msg', (peer: any, data: any) => {
  // Received data from peer (data is an ArrayBuffer)
  console.log(`message peer ${peer} data ${data}`)
});

// Broadcast a message via data channel to all peers
// Note: This is commented out as it requires actual data
// p2pcf.broadcast(new ArrayBuffer(8));

// To send a message via data channel to just one peer:
// Note: This is commented out as it requires actual data and peer reference
// p2pcf.send(peer, new ArrayBuffer(8));

// To stop polling + shut down (not necessary to call this typically, page transition suffices.)
// p2pcf.destroy();