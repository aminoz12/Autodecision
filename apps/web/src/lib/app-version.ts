/**
 * Version du bundle qu'un onglet exécute vs version déployée (/api/version).
 * Logique pure, testée en node ; le hook React vit dans
 * components/ui/NewVersionNotice.tsx.
 */

/** Un déploiement plus récent que ce bundle est-il en ligne ? */
export function isNewerDeploy(running: string, deployed: string | null | undefined): boolean {
  if (!deployed || running === "dev" || deployed === "dev") return false;
  return deployed !== running;
}

/**
 * La tablette du stock reste ouverte des semaines : sur l'écran « Qui
 * pointe ? » elle se recharge toute seule pour prendre la nouvelle version.
 * Jamais deux fois pour la même version (mémorisée dans sessionStorage),
 * sinon un cache intermédiaire qui servirait encore l'ancien bundle
 * ferait boucler la tablette.
 */
export function shouldAutoReload(deployed: string, lastReloadedFor: string | null): boolean {
  return deployed !== lastReloadedFor;
}

const RELOAD_KEY = "app-version.reloaded-for";

export function readLastReload(): string | null {
  try {
    return window.sessionStorage.getItem(RELOAD_KEY);
  } catch {
    return null;
  }
}

export function rememberReload(version: string): void {
  try {
    window.sessionStorage.setItem(RELOAD_KEY, version);
  } catch {
    // stockage indisponible : on recharge quand même, au pire on l'aura fait une fois de trop
  }
}
