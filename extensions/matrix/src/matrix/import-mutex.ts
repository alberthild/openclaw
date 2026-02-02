/**
 * Import Mutex - Serializes dynamic imports to prevent race conditions
 *
 * Problem: When multiple Matrix accounts start in parallel, they all call
 * dynamic imports simultaneously. Native modules (like @matrix-org/matrix-sdk-crypto-nodejs)
 * can crash when loaded in parallel from multiple promises.
 *
 * Solution: Cache the import promise so that concurrent callers await the same promise
 * instead of triggering parallel imports.
 */

// Cache for import promises - key is module specifier
const importCache = new Map<string, Promise<unknown>>();

/**
 * Safely import a module with deduplication.
 * If an import is already in progress, returns the existing promise.
 * Once resolved, the result is cached for future calls.
 */
export async function serializedImport<T>(
  moduleSpecifier: string,
  importFn: () => Promise<T>,
): Promise<T> {
  const existing = importCache.get(moduleSpecifier);
  if (existing) {
    return existing as Promise<T>;
  }

  const importPromise = importFn().catch((err) => {
    // On failure, remove from cache to allow retry
    importCache.delete(moduleSpecifier);
    throw err;
  });

  importCache.set(moduleSpecifier, importPromise);
  return importPromise;
}

// Pre-cached imports for critical modules
let cryptoNodejsModule: typeof import("@matrix-org/matrix-sdk-crypto-nodejs") | null = null;
let credentialsModule: typeof import("./credentials.js") | null = null;

/**
 * Safely import the crypto-nodejs module (Rust native).
 * This is the most critical one - parallel imports of native modules crash.
 */
export async function importCryptoNodejs(): Promise<
  typeof import("@matrix-org/matrix-sdk-crypto-nodejs")
> {
  if (cryptoNodejsModule) {
    return cryptoNodejsModule;
  }

  const mod = await serializedImport(
    "@matrix-org/matrix-sdk-crypto-nodejs",
    () => import("@matrix-org/matrix-sdk-crypto-nodejs"),
  );
  cryptoNodejsModule = mod;
  return mod;
}

/**
 * Safely import the credentials module.
 */
export async function importCredentials(): Promise<typeof import("./credentials.js")> {
  if (credentialsModule) {
    return credentialsModule;
  }

  const mod = await serializedImport("../credentials.js", () => import("./credentials.js"));
  credentialsModule = mod;
  return mod;
}

// Pre-cached import for matrix index module
let matrixIndexModule: typeof import("./index.js") | null = null;

/**
 * Safely import the matrix/index.js module.
 * This is called from channel.ts during parallel account startup.
 */
export async function importMatrixIndex(): Promise<typeof import("./index.js")> {
  if (matrixIndexModule) {
    return matrixIndexModule;
  }

  const mod = await serializedImport("./matrix/index.js", () => import("./index.js"));
  matrixIndexModule = mod;
  return mod;
}
