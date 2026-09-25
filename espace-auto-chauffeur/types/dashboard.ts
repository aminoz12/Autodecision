export type PieceKind = "garage" | "counter" | "stock";
export type PieceStatus = "pending" | "picked" | "unavailable" | "received";
export type TourColor = "violet" | "pink" | "green" | "orange";

export interface Piece {
  id: string;
  reference: string;
  label?: string;
  detail?: string;
  quantity?: number;
  kind?: PieceKind;
  status: PieceStatus;
  canDefer?: boolean;
}

export interface Supplier {
  id: string;
  name: string;
  shortName: string;
  pieces: Piece[];
}

export interface Tour {
  id: string;
  number: number;
  time: string;
  color: TourColor;
  suppliers: Supplier[];
}

export type ReturnDirection = "garage-to-store" | "store-to-supplier";

export interface ReturnItem {
  id: string;
  reference: string;
  label: string;
  direction: ReturnDirection;
  destination: string;
  slip?: string;
  completedAt?: string;
}
