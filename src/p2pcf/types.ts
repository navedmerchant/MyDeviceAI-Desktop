/**
 * P2PCF Types
 * TypeScript interfaces and types for P2PCF library
 */

/**
 * Configuration options for P2PCF
 */
export interface P2PCFOptions {
  /**
   * Identifies if this peer is the desktop hub
   * Desktop: waits for connections (passive)
   * Mobile: initiates connections (active)
   */
  isDesktop: boolean;

  /**
   * Cloudflare Worker URL for signaling
   */
  workerUrl: string;

  /**
   * WebRTC configuration (STUN/TURN servers)
   */
  rtcConfig?: any; // RTCConfiguration from WebRTC

  /**
   * Polling interval in milliseconds
   * @default 3000
   */
  pollingInterval?: number;
}

/**
 * Represents a peer in the P2P network
 */
export interface Peer {
  /**
   * Unique session ID
   */
  id: string;

  /**
   * Client identifier (user-provided)
   */
  clientId: string;

  /**
   * Whether this peer is a desktop hub
   */
  isDesktop: boolean;
}

/**
 * Event types emitted by P2PCF
 */
export type P2PCFEventType = 'peerconnect' | 'peerclose' | 'msg' | 'error';

/**
 * Event handlers for P2PCF events
 */
export interface P2PCFEvents {
  peerconnect: (peer: Peer) => void;
  peerclose: (peer: Peer) => void;
  msg: (peer: Peer, data: ArrayBuffer) => void;
  error: (error: Error) => void;
}

/**
 * Worker registration payload
 */
export interface WorkerPayload {
  r: string; // room ID
  k: string; // context ID
  d: [string, string, boolean, string, number, string[]]; // peer data
  t: number; // timestamp
  x: number; // expiration
  p: WorkerPackage[]; // packages
}

/**
 * Package sent/received from worker
 */
export interface WorkerPackage {
  to: string; // destination session ID
  type: 'offer' | 'answer' | 'ice';
  data: any;
}

/**
 * Worker response
 */
export interface WorkerResponse {
  ps: PeerData[]; // discovered peers
  pk: IncomingPackage[]; // packages for this peer
  dk: string; // delete key
}

/**
 * Peer data from worker
 */
export interface PeerData {
  0: string; // sessionId
  1: string; // clientId
  2: boolean; // isDesktop
  3: string; // dtls fingerprint
  4: number; // timestamp
  5: string[]; // reflexive IPs
}

/**
 * Incoming package from worker
 */
export interface IncomingPackage {
  from: string; // source session ID
  type: 'offer' | 'answer' | 'ice';
  data: any;
}
