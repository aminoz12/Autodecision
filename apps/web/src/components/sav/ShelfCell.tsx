"use client";

import { MapPin } from "lucide-react";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fmtDate } from "@/lib/data/saas";
import { setOrderSavFields } from "@/lib/data/sav";
import { parisToday, parseDay } from "@/lib/sav";

/**
 * Casier de retrait + date promise, in a table cell of « Commande à préparer ».
 * The shelf number is typed once by whoever stores the part; any vendeur then
 * finds it without calling the colleague who put it away.
 */
export type Shelf = { casier: string | null; promisedDate: string | null; promiseRevisedDate: string | null; readyAt: string | null };

export function ShelfCell({ orderId, shelf, onSaved }: { orderId: string; shelf: Shelf; onSaved: (casier: string | null) => void }) {
  const [value, setValue] = useState(shelf.casier ?? "");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async () => {
    const next = value.trim().toUpperCase();
    if (next === (shelf.casier ?? "")) return;
    setSaving(true);
    setFailed(false);
    try {
      await setOrderSavFields(createClient(), orderId, { casier: next || null });
      onSaved(next || null);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const promise = shelf.promiseRevisedDate ?? shelf.promisedDate;
  const promiseDay = parseDay(promise);
  const late = promiseDay != null && !shelf.readyAt && promiseDay < parisToday();

  return (
    <div className="sav-shelf">
      <label className="sav-casier" title="Emplacement sur l'étagère des commandes">
        <MapPin className="h-3.5 w-3.5" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value.toUpperCase())}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="Casier"
          maxLength={8}
          disabled={saving}
          aria-label="Casier de retrait"
          aria-invalid={failed}
        />
      </label>
      {promise && (
        <span className={`sav-promise${late ? " sav-promise--late" : ""}`}>
          Promis le {fmtDate(promise)}
          {shelf.promiseRevisedDate && shelf.promiseRevisedDate !== shelf.promisedDate ? " (décalé)" : ""}
        </span>
      )}
    </div>
  );
}
