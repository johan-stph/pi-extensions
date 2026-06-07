/**
 * Minimal type declarations for @earendil-works/pi-ai.
 */

declare module "@earendil-works/pi-ai" {
  export function StringEnum<T extends readonly string[]>(values: T): any;
}
