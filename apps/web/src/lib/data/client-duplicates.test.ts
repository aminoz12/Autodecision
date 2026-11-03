import { describe, expect, it } from "vitest";
import { duplicateInsertError, duplicateMessage, findDuplicate, normName, type DuplicateCandidate } from "./client-duplicates";

const files: DuplicateCandidate[] = [
  { id: "flix", name: "FLIX AUTO", phone: "07 83 02 85 84", kind: "GARAGE" },
  { id: "tlr", name: "TLR TRANSPORTS", phone: "+33 6 27 08 55 05", kind: "PRO" },
  { id: "labed", name: "Mohammed LABED", phone: "06 06 06 01 06", kind: "PARTICULIER" },
  { id: "dupont", name: "Jean Dupont", phone: null, kind: "PARTICULIER" },
];

describe("normName", () => {
  it("ignores case, accents, spaces and punctuation", () => {
    expect(normName(" Soins Auto  Acacia ")).toBe("soinsautoacacia");
    expect(normName("Garage Élysée-Nord")).toBe("garageelyseenord");
    expect(normName(null)).toBe("");
  });
});

describe("findDuplicate", () => {
  it("matches the phone number first, whatever the kind and the formatting", () => {
    // +33 6… and 06… are the same number (TLR TRANSPORTS existed twice that way).
    expect(findDuplicate(files, { name: "BR TRANSPORT", phone: "06 27 08 55 05", kind: "PRO" })?.record.id).toBe("tlr");
    const m = findDuplicate(files, { name: "FELIX AUTO", phone: "0783028584", kind: "PARTICULIER" });
    expect(m).toMatchObject({ record: { id: "flix" }, by: "phone" });
    expect(duplicateMessage(m!)).toBe("Ce numéro est déjà celui de « FLIX AUTO » (garage).");
  });

  it("matches a professional account by name, even typed as another kind", () => {
    const m = findDuplicate(files, { name: "tlr transports", phone: "", kind: "GARAGE" });
    expect(m).toMatchObject({ record: { id: "tlr" }, by: "name" });
    expect(duplicateMessage(m!)).toBe("Une fiche « TLR TRANSPORTS » (client PRO) existe déjà sous ce nom.");
    expect(findDuplicate(files, { name: "Flix Auto", phone: "0611111111", kind: "PARTICULIER" })?.record.id).toBe("flix");
  });

  it("lets two particuliers share a name when a phone tells them apart", () => {
    expect(findDuplicate(files, { name: "Mohammed Labed", phone: "0699999999", kind: "PARTICULIER" })).toBeNull();
    expect(findDuplicate(files, { name: "Mohammed Labed", phone: "", kind: "PARTICULIER" })?.record.id).toBe("labed");
    expect(findDuplicate(files, { name: "jean dupont", phone: "", kind: "PARTICULIER" })?.record.id).toBe("dupont");
  });

  it("ignores short phones, short names and the file being edited", () => {
    expect(findDuplicate(files, { name: "AB", phone: "06", kind: "PRO" })).toBeNull();
    expect(findDuplicate(files, { name: "FLIX AUTO", phone: "0783028584", kind: "GARAGE" }, { excludeId: "flix" })).toBeNull();
  });
});

describe("duplicateInsertError", () => {
  it("translates the unique index violation and leaves other errors alone", () => {
    expect(duplicateInsertError('duplicate key value violates unique constraint "clients_no_duplicate"')).toMatch(/existe déjà/);
    expect(duplicateInsertError("permission denied for table clients")).toBeNull();
  });
});
