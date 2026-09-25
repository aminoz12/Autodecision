import type { ReturnItem, Tour } from "@/types/dashboard";

export const initialTours: Tour[] = [
  {
    id: "tour-10",
    number: 1,
    time: "10H00",
    color: "violet",
    suppliers: [
      {
        id: "acr",
        name: "ACR",
        shortName: "ACR",
        pieces: [
          { id: "acr-901026", reference: "901026", label: "Projecteur SPILU", detail: "Réassort", kind: "stock", status: "pending", canDefer: true },
          { id: "acr-110372", reference: "11-0372", detail: "Reçue magasin", status: "received" },
          { id: "acr-tc1367", reference: "TC1367", detail: "Reçue magasin", status: "received" },
          { id: "acr-725497-g", reference: "72-5497", detail: "Garage Meca 92 · Nanterre", kind: "garage", status: "pending" },
          { id: "acr-725496", reference: "72-5496", detail: "Garage Auto Service · Colombes", kind: "garage", status: "pending" },
          { id: "acr-725497-c", reference: "72-5497", detail: "Commande client comptoir", kind: "counter", status: "pending" },
          { id: "acr-725498", reference: "72-5498", detail: "Commande atelier", kind: "garage", status: "picked" }
        ]
      },
      {
        id: "cal",
        name: "CAL",
        shortName: "CAL",
        pieces: [
          { id: "cal-r1551", reference: "R1551", detail: "Commande garage", kind: "garage", status: "pending" },
          { id: "cal-tc1362-c", reference: "TC1362", detail: "Commande comptoir", kind: "counter", status: "pending" },
          { id: "cal-tc1362-g", reference: "TC1362", detail: "Commande garage", kind: "garage", status: "pending" }
        ]
      },
      {
        id: "dca",
        name: "DCA",
        shortName: "DCA",
        pieces: [
          { id: "dca-elg5390", reference: "ELG5390", kind: "garage", status: "pending" },
          { id: "dca-ra22400", reference: "RA22400", kind: "stock", status: "pending" }
        ]
      },
      {
        id: "drop",
        name: "DROP",
        shortName: "DROP",
        pieces: [{ id: "drop-r1551", reference: "R1551", kind: "garage", status: "pending" }]
      },
      {
        id: "mapco",
        name: "MAPCO",
        shortName: "MAPCO",
        pieces: [{ id: "mapco-tc1367", reference: "TC1367", kind: "counter", status: "pending" }]
      },
      {
        id: "ned",
        name: "NED",
        shortName: "NED",
        pieces: [{ id: "ned-elg5390", reference: "ELG5390", kind: "stock", status: "pending" }]
      },
      {
        id: "pap",
        name: "PAP",
        shortName: "PAP",
        pieces: [
          { id: "pap-p001", reference: "PAP-001", kind: "garage", status: "pending" },
          { id: "pap-p002", reference: "PAP-002", kind: "counter", status: "pending" }
        ]
      },
      {
        id: "ottogo",
        name: "OTTOGO",
        shortName: "OTTO",
        pieces: [
          { id: "otto-ra22353-g", reference: "RA22353", kind: "garage", status: "pending" },
          { id: "otto-ra22353-c", reference: "RA22353", kind: "counter", status: "pending" },
          { id: "otto-04i-1", reference: "04I253725F", status: "pending" },
          { id: "otto-969-1", reference: "969-875", status: "pending" },
          { id: "otto-tc2684-1", reference: "TC2684", quantity: 2, status: "pending" },
          { id: "otto-04i-2", reference: "04I253725F", status: "pending" },
          { id: "otto-969-2", reference: "969-875", status: "pending" },
          { id: "otto-tc2684-2", reference: "TC2684", quantity: 2, status: "pending" }
        ]
      }
    ]
  },
  {
    id: "tour-13",
    number: 2,
    time: "13H00",
    color: "pink",
    suppliers: [
      { id: "acr-13", name: "ACR", shortName: "ACR", pieces: [
        { id: "acr13-1", reference: "ACR-1301", status: "pending" },
        { id: "acr13-2", reference: "ACR-1302", status: "pending" }
      ] },
      { id: "cal-13", name: "CAL", shortName: "CAL", pieces: [1,2,3,4].map((n) => ({ id: `cal13-${n}`, reference: `CAL-13${n}`, status: "pending" as const })) },
      { id: "dca-13", name: "DCA", shortName: "DCA", pieces: [{ id: "dca13-1", reference: "DCA-1301", status: "pending" }] },
      { id: "mapco-13", name: "MAPCO", shortName: "MAPCO", pieces: [1,2,3].map((n) => ({ id: `mapco13-${n}`, reference: `MAP-13${n}`, status: "pending" as const })) },
      { id: "otto-13", name: "OTTOGO", shortName: "OTTO", pieces: [1,2].map((n) => ({ id: `otto13-${n}`, reference: `OTT-13${n}`, status: "pending" as const })) },
      { id: "pap-13", name: "PAP", shortName: "PAP", pieces: [1,2].map((n) => ({ id: `pap13-${n}`, reference: `PAP-13${n}`, status: "pending" as const })) }
    ]
  },
  {
    id: "tour-15",
    number: 3,
    time: "15H00",
    color: "green",
    suppliers: [
      { id: "acr-15", name: "ACR", shortName: "ACR", pieces: [{ id: "acr15-1", reference: "ACR-1501", status: "pending" }] },
      { id: "cal-15", name: "CAL", shortName: "CAL", pieces: [1,2].map((n) => ({ id: `cal15-${n}`, reference: `CAL-15${n}`, status: "pending" as const })) },
      { id: "drop-15", name: "DROP", shortName: "DROP", pieces: [1,2].map((n) => ({ id: `drop15-${n}`, reference: `DROP-15${n}`, status: "pending" as const })) },
      { id: "ned-15", name: "NED", shortName: "NED", pieces: [{ id: "ned15-1", reference: "NED-1501", status: "pending" }] },
      { id: "otto-15", name: "OTTOGO", shortName: "OTTO", pieces: [1,2,3].map((n) => ({ id: `otto15-${n}`, reference: `OTT-15${n}`, status: "pending" as const })) }
    ]
  },
  {
    id: "tour-1730",
    number: 4,
    time: "17H30",
    color: "orange",
    suppliers: [
      { id: "cal-1730", name: "CAL", shortName: "CAL", pieces: [{ id: "cal1730-1", reference: "CAL-1731", status: "pending" }] },
      { id: "dca-1730", name: "DCA", shortName: "DCA", pieces: [1,2].map((n) => ({ id: `dca1730-${n}`, reference: `DCA-173${n}`, status: "pending" as const })) },
      { id: "otto-1730", name: "OTTOGO", shortName: "OTTO", pieces: [1,2].map((n) => ({ id: `otto1730-${n}`, reference: `OTT-173${n}`, status: "pending" as const })) },
      { id: "pap-1730", name: "PAP", shortName: "PAP", pieces: [{ id: "pap1730-1", reference: "PAP-1731", status: "pending" }] }
    ]
  }
];

export const initialReturns: ReturnItem[] = [
  { id: "return-g-1", reference: "REF 123", label: "Étrier de frein", direction: "garage-to-store", destination: "Garage Meca 92 · Nanterre" },
  { id: "return-g-2", reference: "TC1362", label: "Biellette", direction: "garage-to-store", destination: "Garage des Champs · Rueil" },
  { id: "return-g-3", reference: "72-5497", label: "Fusée", direction: "garage-to-store", destination: "Auto Tech · Courbevoie" },
  { id: "return-f-1", reference: "REF 123458", label: "Alternateur", direction: "store-to-supplier", destination: "ACR", slip: "BR-1842" },
  { id: "return-f-2", reference: "K015685", label: "Kit embrayage", direction: "store-to-supplier", destination: "CAL", slip: "BR-1847" }
];
