declare module "virtual:page-script" {
  /** The core page script, inlined at build time: (max) => RawElement[] */
  export const listElements: (max: number) => unknown[];
}
