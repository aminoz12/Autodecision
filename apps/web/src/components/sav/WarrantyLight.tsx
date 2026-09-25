import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { fmtDate } from "@/lib/data/saas";
import { warrantyText, type LineWarranty } from "@/lib/sav";

/**
 * Le voyant de garantie : vert / orange / rouge, lisible en trois secondes au
 * comptoir. `compact` = the dot + the end date (tables); otherwise the two
 * counters (légale, commerciale) are spelled out.
 */
export function WarrantyLight({ warranty, compact = false }: { warranty: LineWarranty | null; compact?: boolean }) {
  if (!warranty) return <span className="sav-light sav-light--none">—</span>;
  const Icon = warranty.light === "green" ? ShieldCheck : warranty.light === "orange" ? ShieldAlert : ShieldX;
  if (compact) {
    return (
      <span className={`sav-light sav-light--${warranty.light}`} title={warrantyText(warranty)}>
        <Icon className="h-4 w-4" />
        {warranty.daysLeft < 0 ? "Expirée" : fmtDate(warranty.end)}
      </span>
    );
  }
  return (
    <div className={`sav-warranty sav-warranty--${warranty.light}`}>
      <span className="sav-warranty-icon">
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="sav-warranty-title">{warrantyText(warranty)}</p>
        <p className="sav-warranty-sub">
          Délivrée le {fmtDate(warranty.start)} · légale jusqu&apos;au {fmtDate(warranty.legalEnd)}
          {warranty.commercialEnd ? ` · équipementier jusqu'au ${fmtDate(warranty.commercialEnd)}` : " · pas de garantie équipementier connue"}
        </p>
      </div>
    </div>
  );
}
