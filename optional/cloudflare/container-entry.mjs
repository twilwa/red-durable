// Intentionally fail closed: ephemeral local storage cannot safely own refresh tokens.
// Future implementation injects a trusted DO-backed store into exported runBridge().
// Never fall back to bridge/store.mjs or tokens copied into the image/environment.
console.error('Cloud host scaffold: protected onboarding and durable store transport are not connected. Inference is disabled.');
process.exitCode = 78;
