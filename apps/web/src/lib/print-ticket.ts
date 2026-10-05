/*
 * Printing a ticket (bon de commande, bon de livraison, reçu) on an 80 mm
 * thermal roll: ONE long page, as long as the ticket, nothing else on it.
 *
 * The ticket on screen is copied alone into #tk-print-root (a child of <body>,
 * so everything else can be removed from the printout with display:none —
 * hidden content would otherwise still take room and add blank pages), its
 * height is measured, and the page is sized to it: @page 80 mm × that height,
 * no margin. Removed again once the print dialog closes.
 */

const MM_PER_PX = 25.4 / 96;
/** Paper fed after the last line, so the cut never touches the footer. */
const TAIL_MM = 6;

export function printTicket(title: string, source?: HTMLElement | null) {
  const ticket = source ?? document.querySelector<HTMLElement>(".tk-doc");
  if (!ticket) {
    window.print();
    return;
  }

  // A previous print that was never closed properly.
  document.getElementById("tk-print-root")?.remove();
  document.getElementById("tk-page-size")?.remove();

  const root = document.createElement("div");
  root.id = "tk-print-root";
  root.innerHTML = ticket.outerHTML;
  document.body.appendChild(root);

  const copy = root.firstElementChild as HTMLElement | null;
  const heightMm = Math.ceil((copy?.getBoundingClientRect().height ?? 0) * MM_PER_PX) + TAIL_MM;

  const page = document.createElement("style");
  page.id = "tk-page-size";
  page.textContent = `@page { size: 80mm ${Math.max(heightMm, 60)}mm; margin: 0; }`;
  document.head.appendChild(page);
  document.documentElement.classList.add("tk-printing");

  const previousTitle = document.title;
  // The tab title becomes the suggested PDF name (REQ-….pdf).
  document.title = title;

  const cleanup = () => {
    window.removeEventListener("afterprint", cleanup);
    document.documentElement.classList.remove("tk-printing");
    root.remove();
    page.remove();
    document.title = previousTitle;
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
}
