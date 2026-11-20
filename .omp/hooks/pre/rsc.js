// rsc-omp:managed
// OMP loads every .omp/hooks/pre/*.js as an extension factory. The harness itself lives under
// .rsc/ (machine-local): a clone that has not run rsc yet has nothing to load, and this loader
// must stay silent instead of printing a module-not-found stack trace on every session.
export default async function rscOmp(pi) {
  try {
    const bridge = await import('../../../.rsc/omp-bridge.mjs');
    // Resolve OMP's package from its discovered extension entry, not from a detached .rsc import.
    const registry = await import('@oh-my-pi/pi-coding-agent/config/registry').catch(() => null);
    return await bridge.default(pi, registry);
  } catch {
    // No harness here, or it was purged: nothing to enforce and nothing to say.
  }
}
