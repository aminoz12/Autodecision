"use client";

import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/providers/AuthProvider";

/**
 * Wraps an ADMIN-only page: caissiers (and garagistes) get a clear
 * "reserved" message instead of the content. Rendering is client-side —
 * the real enforcement lives in RLS and the server-only API routes.
 */
export function AdminGate({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();

  if (!profile) return null;
  if (profile.role !== "ADMIN" || profile.client_id) {
    return (
      <div className="od-page">
        <div className="od-card admin-locked">
          <span className="admin-locked-icon">
            <ShieldAlert className="h-7 w-7" />
          </span>
          <h1>Accès réservé à l&apos;administrateur</h1>
          <p>
            Cette page est réservée à l&apos;administrateur du magasin.
            Demandez-lui de faire la modification, ou de vous donner le rôle
            Administrateur.
          </p>
          <Link href="/dashboard" className="od-btn od-btn--primary">
            Retour au tableau de bord
          </Link>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
