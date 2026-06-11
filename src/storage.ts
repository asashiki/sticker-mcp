import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

export interface Sticker {
  id: string;
  name: string;
  emotions: string[];
  filepath: string;
  mimeType: string;
  addedAt?: string;
}

export interface StickerWithThumb extends Sticker {
  /** Small base64 webp thumbnail (data URI) for gallery rendering. */
  thumb: string | null;
}

const THUMB_SIZE = 96;
/** Stickers larger than this get recompressed before being inlined as base64. */
const INLINE_SIZE_LIMIT = 700 * 1024;

export class StickerStorage {
  private dataFile: string;
  private imageDir: string;
  private thumbCache = new Map<string, string>();

  constructor(baseDir: string) {
    this.dataFile = path.join(baseDir, "stickers.json");
    this.imageDir = path.join(baseDir, "images");
  }

  async init() {
    await fs.mkdir(this.imageDir, { recursive: true });
    try {
      await fs.access(this.dataFile);
    } catch {
      await fs.writeFile(this.dataFile, JSON.stringify([]));
    }
  }

  async getAllStickers(): Promise<Sticker[]> {
    const data = await fs.readFile(this.dataFile, "utf-8");
    return JSON.parse(data) as Sticker[];
  }

  async getById(id: string): Promise<Sticker | null> {
    const stickers = await this.getAllStickers();
    return stickers.find((s) => s.id === id) ?? null;
  }

  /**
   * Fuzzy search: matches if any emotion tag or the name contains the query
   * (or the query contains the tag — so "开心到飞起" matches tag "开心").
   * Returns a random sticker among the matches, plus the full match list.
   */
  async findByQuery(query: string): Promise<{ picked: Sticker | null; matches: Sticker[] }> {
    const stickers = await this.getAllStickers();
    const q = query.trim().toLowerCase();
    const matches = stickers.filter((s) => {
      const tags = [...s.emotions, s.name].map((e) => e.toLowerCase());
      return tags.some((t) => t.includes(q) || (t.length >= 2 && q.includes(t)));
    });
    if (matches.length === 0) return { picked: null, matches: [] };
    const picked = matches[crypto.randomInt(matches.length)] ?? null;
    return { picked, matches };
  }

  async addSticker(name: string, emotions: string[], imageBuffer: Buffer, mimeType: string): Promise<Sticker> {
    const id = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const ext = (mimeType.split("/")[1] || "png").replace("+xml", "");
    const filename = `${id}.${ext}`;
    const filepath = path.join(this.imageDir, filename);
    await fs.writeFile(filepath, imageBuffer);

    const sticker: Sticker = {
      id,
      name,
      emotions: emotions.map((e) => e.trim()).filter(Boolean),
      filepath,
      mimeType,
      addedAt: new Date().toISOString()
    };

    const stickers = await this.getAllStickers();
    stickers.push(sticker);
    await fs.writeFile(this.dataFile, JSON.stringify(stickers, null, 2));
    return sticker;
  }

  async addStickerFromBase64(name: string, emotions: string[], base64Data: string, mimeType: string): Promise<Sticker> {
    const cleaned = base64Data.replace(/^data:image\/[\w.+-]+;base64,/, "");
    return this.addSticker(name, emotions, Buffer.from(cleaned, "base64"), mimeType);
  }

  async updateSticker(id: string, patch: { name?: string; emotions?: string[] }): Promise<Sticker | null> {
    const stickers = await this.getAllStickers();
    const sticker = stickers.find((s) => s.id === id);
    if (!sticker) return null;
    if (patch.name !== undefined) sticker.name = patch.name;
    if (patch.emotions !== undefined) sticker.emotions = patch.emotions.map((e) => e.trim()).filter(Boolean);
    await fs.writeFile(this.dataFile, JSON.stringify(stickers, null, 2));
    return sticker;
  }

  async deleteSticker(id: string): Promise<boolean> {
    const stickers = await this.getAllStickers();
    const index = stickers.findIndex((s) => s.id === id);
    if (index === -1) return false;

    const [deleted] = stickers.splice(index, 1);
    await fs.writeFile(this.dataFile, JSON.stringify(stickers, null, 2));
    this.thumbCache.delete(id);
    if (deleted) {
      try {
        await fs.unlink(deleted.filepath);
      } catch {
        // file already gone — index removal is what matters
      }
    }
    return true;
  }

  /** Image filename (basename of filepath) used by the /images/:filename HTTP route. */
  publicFilename(sticker: Sticker): string {
    return path.basename(sticker.filepath);
  }

  /** Read the sticker image, recompressing to webp if it exceeds the inline size limit. */
  async readForInline(sticker: Sticker): Promise<{ buffer: Buffer; mimeType: string }> {
    let buffer: Buffer = await fs.readFile(sticker.filepath);
    let mimeType = sticker.mimeType;
    if (buffer.length > INLINE_SIZE_LIMIT) {
      try {
        const isGif = mimeType === "image/gif";
        buffer = await sharp(buffer, { animated: isGif })
          .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 75 })
          .toBuffer();
        mimeType = "image/webp";
      } catch {
        // serve original if compression fails
      }
    }
    return { buffer, mimeType };
  }

  /** Small data-URI thumbnail for gallery views; cached in memory. */
  async getThumb(sticker: Sticker): Promise<string | null> {
    const cached = this.thumbCache.get(sticker.id);
    if (cached) return cached;
    try {
      const buffer = await sharp(sticker.filepath)
        .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 70 })
        .toBuffer();
      const thumb = `data:image/webp;base64,${buffer.toString("base64")}`;
      this.thumbCache.set(sticker.id, thumb);
      return thumb;
    } catch {
      return null;
    }
  }

  async withThumbs(stickers: Sticker[]): Promise<StickerWithThumb[]> {
    return Promise.all(
      stickers.map(async (s) => ({ ...s, thumb: await this.getThumb(s) }))
    );
  }
}
