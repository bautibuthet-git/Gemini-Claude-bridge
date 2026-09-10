declare const __BRIDGE_VERSION__: string | undefined;

/** Injected by scripts/build.mjs from package.json; "dev" when running from source (tests). */
export const VERSION: string = typeof __BRIDGE_VERSION__ === "string" ? __BRIDGE_VERSION__ : "dev";
