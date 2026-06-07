/**
 * Minimal type declarations for @earendil-works/pi-tui.
 */

declare module "@earendil-works/pi-tui" {
  export class Text {
    constructor(text: string, x?: number, y?: number);
  }

  export function truncateToWidth(text: string, width: number): string;

  export function matchesKey(data: string, key: string): boolean;
}
