declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: Element, urlOrChannel: string | unknown, options?: {
      credentials?: { password?: string };
      shared?: boolean;
      wsProtocols?: string[];
    });

    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;

    disconnect(): void;
    sendCredentials(credentials: { password?: string }): void;
  }
}
