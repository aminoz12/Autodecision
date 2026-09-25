# Espace Auto 92 — Espace Chauffeur

Interface mobile Next.js pour le suivi des tournées fournisseurs et des retours.

## Installation

```bash
npm install
npm run dev
```

Ouvrez ensuite `http://localhost:3000`.

## Fonctions incluses

- Vue mobile de la tournée en cours.
- Progression globale et compteurs par fournisseur.
- Accordéons fournisseurs et références.
- Cycle de statut : à récupérer → récupérée → indisponible.
- Pièces déjà reçues au magasin.
- Report d’une pièce vers la tournée de 13 h.
- Retours garage → magasin et magasin → fournisseur.
- Horodatage lors de la validation d’un retour.
- Sauvegarde automatique dans `localStorage`.
- Bouton de remise à zéro des données de démonstration.

## Structure

- `app/page.tsx` : page principale.
- `components/driver-dashboard.tsx` : interface et logique interactive.
- `data/dashboard.ts` : données de démonstration à remplacer par votre API.
- `types/dashboard.ts` : types TypeScript.
- `app/globals.css` : styles globaux et variables visuelles.

## Connexion à une API

Les données sont actuellement locales. Pour passer en production, remplacez `initialTours` et `initialReturns` par des appels à votre API, puis envoyez les changements de statut depuis `cyclePiece`, `deferPiece` et `completeReturn`.
