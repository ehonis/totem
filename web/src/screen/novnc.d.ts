// The slice of noVNC's RFB class the Screen view uses. noVNC ships no types;
// see node_modules/@novnc/novnc/docs/API.md.
declare module '@novnc/novnc' {
  export interface RfbCredentials { username?: string; password?: string; target?: string }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { credentials?: RfbCredentials; wsProtocols?: string[]; shared?: boolean })
    viewOnly: boolean
    scaleViewport: boolean
    clipViewport: boolean
    resizeSession: boolean
    focusOnClick: boolean
    qualityLevel: number
    compressionLevel: number
    background: string
    disconnect(): void
    sendCredentials(credentials: RfbCredentials): void
    clipboardPasteFrom(text: string): void
    focus(): void
    blur(): void
  }
}
