import { describe, expect, it } from "vitest";
import { BUILT_IN_SIM_PHOTO, BUILT_IN_SIM_PHOTOS, listedPhotoId, listingPhotoSource, messagePhotoIds, messagePhotoSource, readSimPhotos } from "./photos";

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
    expect(listingPhotoSource("D101", "oak desk", 0, {})).toBe(BUILT_IN_SIM_PHOTO);
    expect(listingPhotoSource("D134", "oak desk", 1, {})).toBe(BUILT_IN_SIM_PHOTOS[1]);
    expect(listingPhotoSource("D266", "oak desk", 2, {})).toBe(BUILT_IN_SIM_PHOTOS[2]);
    expect(listingPhotoSource("D134", "oak desk", 1, { D134: BUILT_IN_SIM_PHOTO })).toBe(BUILT_IN_SIM_PHOTOS[1]);
    expect(listingPhotoSource("D134", "oak desk", 1, { D134: "custom-photo" })).toBe("custom-photo");
  });

  it("restores only simulation image data and handles corrupt storage", () => {
    expect(readSimPhotos(`{"D2":"${BUILT_IN_SIM_PHOTO}","D3":"https://example.com/photo","bad":"data:image/png;base64,abc"}`))
      .toEqual({ D2: BUILT_IN_SIM_PHOTO });
    for (const value of [null, "bad", "null", "[]"]) expect(readSimPhotos(value)).toEqual({});
  });
});
