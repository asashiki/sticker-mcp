import fs from 'fs/promises';
import path from 'path';

export interface Sticker {
  id: string;
  name: string;
  emotions: string[];
  filepath: string;
  mimeType: string;
}

export class StickerStorage {
  private dataFile: string;
  private imageDir: string;

  constructor(baseDir: string) {
    this.dataFile = path.join(baseDir, 'stickers.json');
    this.imageDir = path.join(baseDir, 'images');
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
    const data = await fs.readFile(this.dataFile, 'utf-8');
    return JSON.parse(data) as Sticker[];
  }

  async getStickerByEmotion(emotion: string): Promise<Sticker | null> {
    const stickers = await this.getAllStickers();
    const matches = stickers.filter(s => 
      s.emotions.some(e => e.toLowerCase().includes(emotion.toLowerCase())) ||
      s.name.toLowerCase().includes(emotion.toLowerCase())
    );
    if (matches.length === 0) return null;
    // Pick a random match if there are multiple
    return matches[Math.floor(Math.random() * matches.length)];
  }

  async addSticker(name: string, emotions: string[], base64Data: string, mimeType: string): Promise<Sticker> {
    const id = Date.now().toString();
    const ext = mimeType.split('/')[1] || 'png';
    const filename = `${id}.${ext}`;
    const filepath = path.join(this.imageDir, filename);
    
    // Remove data:image/...;base64, prefix if present
    const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, "");
    await fs.writeFile(filepath, Buffer.from(base64Image, 'base64'));

    const sticker: Sticker = {
      id,
      name,
      emotions,
      filepath,
      mimeType
    };

    const stickers = await this.getAllStickers();
    stickers.push(sticker);
    await fs.writeFile(this.dataFile, JSON.stringify(stickers, null, 2));

    return sticker;
  }

  async deleteSticker(id: string): Promise<boolean> {
    const stickers = await this.getAllStickers();
    const index = stickers.findIndex(s => s.id === id);
    if (index === -1) return false;

    const [deleted] = stickers.splice(index, 1);
    await fs.writeFile(this.dataFile, JSON.stringify(stickers, null, 2));
    
    try {
      await fs.unlink(deleted.filepath);
    } catch (e) {
      console.error(`Failed to delete file ${deleted.filepath}:`, e);
    }

    return true;
  }

  async getStickerBase64(sticker: Sticker): Promise<string> {
    const data = await fs.readFile(sticker.filepath);
    return data.toString('base64');
  }
}
