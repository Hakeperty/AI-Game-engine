import type { AigeBridge } from '../shared/protocol.ts';

declare global {
  interface Window {
    aige: AigeBridge;
    /** The @aige/runtime scripting API, read by compiled user scripts (virtual module 'aige'). */
    __aigeRuntime?: unknown;
  }
}
