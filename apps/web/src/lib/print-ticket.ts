/*
 * Printing tickets (bon de commande, bon de livraison, reçu) on an 80 mm
 * thermal roll: each ticket on ONE page, as long as the ticket, nothing else
 * printed. Several tickets (the « CLIENT » and « CAISSIER » copies) go out in
 * the same job, one page each, so the printer cuts between them.
 *
 * The tickets on screen are copied alone into #tk-print-root (a child of
 * <body>, so everything else can be removed from the printout with
 * display:none — hidden content would otherwise still take room and add blank
 * pages), measured, and the page is sized to the longest: @page 80 mm × that
 * height, no margin. Removed again once the print dialog closes.
 */

const MM_PER_PX = 25.4 / 96;
/** Paper fed after the last line, so the cut never touches the footer. */
const TAIL_MM = 6;

/**
 * `source`: a ticket (.tk-doc) or an element holding several; by default every
 * ticket of the page.
 */
export function printTicket(title: string, source?: HTMLElement | null) {
  const scope: ParentNode = source ?? document;
  const tickets =
    source && source.matches(".tk-doc") ? [source] : Array.from(scope.querySelectorAll<HTMLElement>(".tk-doc"));
  if (tickets.length === 0) {
    window.print();
    return;
  }

  // A previous print that was never closed properly.
  document.getElementById("tk-print-root")?.remove();
  document.getElementById("tk-page-size")?.remove();

  const root = document.createElement("div");
  root.id = "tk-print-root";
  root.innerHTML = tickets.map((t) => t.outerHTML).join("");
  document.body.appendChild(root);

  const tallest = Math.max(...Array.from(root.children, (c) => c.getBoundingClientRect().height));
  const heightMm = Math.ceil(tallest * MM_PER_PX) + TAIL_MM;

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
