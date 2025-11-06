declare module 'p2pcf' {
  class P2PCF {
    constructor(clientId: string, roomId: string);
    start(): void;
    on(event: string, callback: (...args: any[]) => void): void;
    broadcast(data: ArrayBuffer): void;
    send(peer: any, data: ArrayBuffer): void;
    destroy(): void;
  }
  export = P2PCF;
}