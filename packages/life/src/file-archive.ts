import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LifeArchive, LifeEvent } from "./events.js";

/**
 * A life kept in a JSON Lines file, one event per line. It is the simplest archive that can be
 * read by a person, diffed, backed up and carried to another machine — the life is the file.
 */
export class FileArchive implements LifeArchive {
  constructor(private readonly path: string) {}

  async load(): Promise<LifeEvent[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: LifeEvent[] = [];
    const lines = text.split("\n");
    let torn = false;
    lines.forEach((line, index) => {
      if (torn || !line.trim()) return;
      try {
        events.push(JSON.parse(line) as LifeEvent);
      } catch (error: unknown) {
        // A torn last line means the process died mid-write; anything earlier is corruption.
        if (lines.slice(index + 1).every((rest) => !rest.trim())) {
          torn = true;
          return;
        }
        throw new Error(`life archive ${this.path} is corrupt at line ${index + 1}`, { cause: error });
      }
    });
    if (torn) {
      // Cut the fragment off now; otherwise the next append would be glued onto it.
      await writeFile(this.path, events.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
    }
    return events;
  }

  async append(events: LifeEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, events.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
  }
}
