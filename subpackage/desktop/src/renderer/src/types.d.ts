import type { PiDesktopApi } from "../../preload";

declare global {
  interface Window {
    piDesktop: PiDesktopApi;
  }
}

export {};
