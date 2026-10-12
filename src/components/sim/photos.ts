/** Browser-session photos used only by the simulated handsets. */
export type SimPhotos = Record<string, string>;
export const SIM_PHOTOS_STORAGE_KEY = "pingmarket.sim.photos";
export const BUILT_IN_SIM_PHOTO = "/photos/oakdesk.jpeg";
export const BUILT_IN_SIM_PHOTOS = [
  BUILT_IN_SIM_PHOTO,
  "/photos/oakdesk2.jpeg",
  "/photos/oakdesk3.jpeg",
] as const;

export function listedPhotoId(replies: string[]): string | undefined {
  for (const reply of replies) {
    const match = /^Listed (D\d+)\b/.exec(reply);
    if (match) return match[1];
  }
}

export function messagePhotoIds(body: string, photos: SimPhotos): string[] {
  return [...new Set(body.match(/\bD\d+\b/g) ?? [])].filter((id) => photos[id]);
}

export function messagePhotoSource(id: string, body: string, photos: SimPhotos): string | undefined {
  const oakDeskIds = [...new Set(
    body.split(/\r?\n/)
      .filter((line) => /\boak desk\b/i.test(line))
      .flatMap((line) => line.match(/\bD\d+\b/g) ?? []),
  )];
  if (oakDeskIds.length > 1 && oakDeskIds.includes(id)) {
    // A list of desks stands in for different sellers' products: the seller-attached photo keeps
    // its listing, and every other desk gets a built-in photo not already shown in this message.
    const used = new Set(oakDeskIds.map((deskId) => photos[deskId]).filter(Boolean));
    const spare = BUILT_IN_SIM_PHOTOS.filter((photo) => !used.has(photo));
    const assigned = new Map<string, string>();
    for (const deskId of oakDeskIds) {
      if (photos[deskId] && ![...assigned.values()].includes(photos[deskId])) assigned.set(deskId, photos[deskId]);
    }
    let next = 0;
    for (const deskId of oakDeskIds) {
      if (assigned.has(deskId)) continue;
      const pool = spare.length ? spare : BUILT_IN_SIM_PHOTOS;
      assigned.set(deskId, pool[next++ % pool.length]);
    }
    return assigned.get(id);
  }
  // A photo the seller attached always wins on a single-listing message.
  if (photos[id]) return photos[id];
  const index = oakDeskIds.indexOf(id);
  if (index === -1) return undefined;
  const numericId = Number(/^D(\d+)$/i.exec(id)?.[1]);
  const fallbackIndex = Number.isSafeInteger(numericId) ? numericId % BUILT_IN_SIM_PHOTOS.length : 0;
  return BUILT_IN_SIM_PHOTOS[fallbackIndex];
}

/**
 * Photo per listing for every message of a thread, in order. A desk listed in a multi-desk reply
 * (a SEARCH result) keeps that photo in later single-desk replies (BUY checkout links), so each
 * product shows the same, distinct photo throughout.
 */
export function threadPhotoSources(bodies: string[], photos: SimPhotos): Map<string, string>[] {
  const seen = new Map<string, string>();
  return bodies.map((body) => {
    const ids = [...new Set(body.match(/\bD\d+\b/g) ?? [])];
    const multi = body.split(/\r?\n/).filter((line) => /\boak desk\b/i.test(line)).length > 1;
    const sources = new Map<string, string>();
    for (const id of ids) {
      const source = (!multi && seen.get(id)) || messagePhotoSource(id, body, photos);
      if (!source) continue;
      sources.set(id, source);
      if (multi) seen.set(id, source);
    }
    return sources;
  });
}

export function listingPhotoSource(
  id: string,
  title: string,
  oakDeskIndex: number,
  photos: SimPhotos,
): string | undefined {
  if (photos[id]) return photos[id];
  return /\boak desk\b/i.test(title) ? BUILT_IN_SIM_PHOTOS[oakDeskIndex % BUILT_IN_SIM_PHOTOS.length] : undefined;
}

export function readSimPhotos(value: string | null): SimPhotos {
  try {
    const parsed: unknown = JSON.parse(value ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, src]) =>
      /^D\d+$/.test(id) && typeof src === "string" && BUILT_IN_SIM_PHOTOS.includes(src as (typeof BUILT_IN_SIM_PHOTOS)[number]),
    ));
  } catch {
    return {};
  }
}
