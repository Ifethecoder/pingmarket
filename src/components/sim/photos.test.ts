import { describe, expect, it } from "vitest";
import { BUILT_IN_SIM_PHOTO, BUILT_IN_SIM_PHOTOS, listedPhotoId, listingPhotoSource, messagePhotoIds, messagePhotoSource, readSimPhotos, threadPhotoSources } from "./photos";

describe("simulation photos", () => {
  it("attaches only after a successful listing reply, including a clarification flow", () => {
    expect(listedPhotoId(["What is the price? (or CANCEL)"])).toBeUndefined();
    expect(listedPhotoId(["Couldn't list that: invalid price"])).toBeUndefined();
    expect(listedPhotoId(["Listed D12 · oak desk. Reply DETAILS D12."])).toBe("D12");
  });

  it("matches exact listing IDs once in search and details replies", () => {
    const photos = { D2: "photo2", D20: "photo20" };
    expect(messagePhotoIds('1) D2 oak desk — $120.00 · Berkeley\nReply OFFER D2 96', photos)).toEqual(["D2"]);
    expect(messagePhotoIds("D20 · Desk. DETAILS D20", photos)).toEqual(["D20"]);
    expect(messagePhotoIds("D2 · Desk\nD20 · Table\nD3 · Lamp", photos)).toEqual(["D2", "D20"]);
    expect(messagePhotoIds("No results", photos)).toEqual([]);
    const search = "1) D101 oak desk — $120.00 · Berkeley\n2) D134 oak desk — $120.00 · Berkeley\n3) D266 oak desk — $120.00 · Berkeley";
    expect(messagePhotoSource("D101", search, {})).toBe(BUILT_IN_SIM_PHOTO);
    expect(messagePhotoSource("D134", search, {})).toBe(BUILT_IN_SIM_PHOTOS[1]);
    expect(messagePhotoSource("D266", search, {})).toBe(BUILT_IN_SIM_PHOTOS[2]);
    expect(messagePhotoSource("D2", "D2 oak desk · $120.00. Pay with Stripe: https://stripe.test/1", {}))
      .toBe(BUILT_IN_SIM_PHOTOS[2]);
    expect(messagePhotoSource("D4", "D4 oak desk · $120.00. Pay with Stripe: https://stripe.test/2", {}))
      .toBe(BUILT_IN_SIM_PHOTOS[1]);
    expect(listingPhotoSource("D101", "oak desk", 0, {})).toBe(BUILT_IN_SIM_PHOTO);
    expect(listingPhotoSource("D134", "oak desk", 1, {})).toBe(BUILT_IN_SIM_PHOTOS[1]);
    expect(listingPhotoSource("D266", "oak desk", 2, {})).toBe(BUILT_IN_SIM_PHOTOS[2]);
    expect(listingPhotoSource("D134", "oak desk", 1, { D134: BUILT_IN_SIM_PHOTO })).toBe(BUILT_IN_SIM_PHOTO);
    // Seller-attached desk keeps its photo; the other desks in the list get the remaining built-ins.
    const attached = { D101: BUILT_IN_SIM_PHOTO, D134: BUILT_IN_SIM_PHOTO, D266: BUILT_IN_SIM_PHOTO };
    expect(messagePhotoSource("D134", search, { D134: BUILT_IN_SIM_PHOTO })).toBe(BUILT_IN_SIM_PHOTO);
    expect(messagePhotoSource("D101", search, { D134: BUILT_IN_SIM_PHOTO })).toBe(BUILT_IN_SIM_PHOTOS[1]);
    expect(messagePhotoSource("D266", search, { D134: BUILT_IN_SIM_PHOTO })).toBe(BUILT_IN_SIM_PHOTOS[2]);
    expect(new Set(["D101", "D134", "D266"].map((id) => messagePhotoSource(id, search, attached))).size).toBe(3);
    expect(messagePhotoSource("D134", "Listed D134 · oak desk", { D134: BUILT_IN_SIM_PHOTO })).toBe(BUILT_IN_SIM_PHOTO);
    expect(listingPhotoSource("D134", "oak desk", 1, { D134: "custom-photo" })).toBe("custom-photo");
  });

  it("keeps each SEARCH result's photo in the later BUY replies", () => {
    const attached = { D7: BUILT_IN_SIM_PHOTO, D8: BUILT_IN_SIM_PHOTO, D9: BUILT_IN_SIM_PHOTO };
    const [search, ...buys] = threadPhotoSources([
      "3 listings:\n1) D9 oak desk — $120.00\n2) D8 oak desk — $96.00\n3) D7 oak desk — $102.00",
      "D9 oak desk · $120.00. Pay with Stripe: https://stripe.test/1",
      "D8 oak desk · $96.00. Pay with Stripe: https://stripe.test/2",
      "D7 oak desk · $102.00. Pay with Stripe: https://stripe.test/3",
    ], attached);
    expect([...search.values()]).toEqual([...BUILT_IN_SIM_PHOTOS]);
    expect(buys.map((m) => [...m.values()][0])).toEqual([...BUILT_IN_SIM_PHOTOS]);
  });

  it("restores only simulation image data and handles corrupt storage", () => {
    expect(readSimPhotos(`{"D2":"${BUILT_IN_SIM_PHOTO}","D3":"https://example.com/photo","bad":"data:image/png;base64,abc"}`))
      .toEqual({ D2: BUILT_IN_SIM_PHOTO });
    for (const value of [null, "bad", "null", "[]"]) expect(readSimPhotos(value)).toEqual({});
  });
});
