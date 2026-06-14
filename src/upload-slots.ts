import crypto from "node:crypto";

export interface StickerUploadSlot {
  token: string;
  name: string;
  emotions: string[];
  expiresAt: number;
}

const SLOT_TTL_MS = 10 * 60 * 1000;
const slots = new Map<string, StickerUploadSlot>();

function pruneExpired(now = Date.now()) {
  for (const [token, slot] of slots) {
    if (slot.expiresAt <= now) slots.delete(token);
  }
}

export function createStickerUploadSlot(name: string, emotions: string[]): StickerUploadSlot {
  pruneExpired();
  const token = crypto.randomBytes(18).toString("base64url");
  const slot = {
    token,
    name: name.trim(),
    emotions: emotions.map((e) => e.trim()).filter(Boolean),
    expiresAt: Date.now() + SLOT_TTL_MS
  };
  slots.set(token, slot);
  return slot;
}

export function getStickerUploadSlot(token: string): StickerUploadSlot | null {
  pruneExpired();
  return slots.get(token) ?? null;
}

export function consumeStickerUploadSlot(token: string) {
  slots.delete(token);
}

