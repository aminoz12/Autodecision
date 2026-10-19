/**
 * Feature switches for screens that exist in the code but are not shown yet.
 * Flip a value to true to launch the feature; nothing else to change.
 */
export const FEATURES = {
  /**
   * « Mon espace » for caissiers (/dashboard/mon-espace: stats & congés) and
   * the « Mon espace » tab of the livreur app. Hidden until the launch planned
   * for November 2026 (user, 2026-10-19); the administrator's « Stats équipe »
   * and « Congés » tabs stay available in the meantime.
   */
  monEspace: false,
} as const;
