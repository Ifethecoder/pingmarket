/** Browser-session photos used only by the simulated handsets. */
export type SimPhotos = Record<string, string>;
export const SIM_PHOTOS_STORAGE_KEY = "pingmarket.sim.photos";
export const BUILT_IN_SIM_PHOTO = "/photos/oakdesk.jpeg";
export const BUILT_IN_SIM_PHOTOS = [
  BUILT_IN_SIM_PHOTO,
  "/photos/oakdesk2.jpeg",
  "/photos/oakdesk3.jpeg",
] as const;

function isBuiltInPhoto(source: string): boolean {
  return BUILT_IN_SIM_PHOTOS.includes(source as (typeof BUILT_IN_SIM_PHOTOS)[number]);
}

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
  if (photos[id] && !isBuiltInPhoto(photos[id])) return photos[id];
  const oakDeskIds = [...new Set(
    body.split(/\r?\n/)
      .filter((line) => /\boak desk\b/i.test(line))
      .flatMap((line) => line.match(/\bD\d+\b/g) ?? []),
  )];
  const index = oakDeskIds.indexOf(id);
  return index === -1 ? undefined : BUILT_IN_SIM_PHOTOS[index % BUILT_IN_SIM_PHOTOS.length];
}

export function listingPhotoSource(
  id: string,
  title: string,
  oakDeskIndex: number,
  photos: SimPhotos,
): string | undefined {
  if (photos[id] && !isBuiltInPhoto(photos[id])) return photos[id];
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
