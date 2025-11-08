declare module 'unzipper' {
  import { Writable } from 'stream';

  interface ExtractOptions {
    path: string;
    concurrency?: number;
    strict?: boolean;
  }

  interface ParseOptions {
    forceStream?: boolean;
  }

  // The Extract function returns a writable stream that can be piped into.
  interface ExtractStream extends Writable {
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }

  export function Extract(options: ExtractOptions): ExtractStream;
  export function Parse(options?: ParseOptions): Writable;
}