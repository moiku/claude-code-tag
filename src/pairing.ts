import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Pairing {
  key: string; // `${channel}:${threadTs}` for thread pairings, `${channel}` for channel pairings
  channel: string;
  threadTs?: string;
  terminalId: string;
  cwd: string; // display only, snapshotted at pairing time
  pairedBy: string; // Slack user id of the owner who paired it
  pairedAt: string; // ISO 8601
}

const DEFAULT_STORE_PATH = join(homedir(), ".cctag", "pairings.json");

export class PairingStore {
  private pairings = new Map<string, Pairing>();

  constructor(private readonly path: string = DEFAULT_STORE_PATH) {
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, "utf8");
      const list = JSON.parse(raw) as Pairing[];
      for (const p of list) this.pairings.set(p.key, p);
    } catch {
      // no store yet — start empty
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.pairings.values()], null, 2));
    renameSync(tmp, this.path);
  }

  static threadKey(channel: string, threadTs: string): string {
    return `${channel}:${threadTs}`;
  }

  static channelKey(channel: string): string {
    return channel;
  }

  /** Looks up a pairing for a thread, falling back to a channel-level pairing. */
  get(channel: string, threadTs?: string): Pairing | undefined {
    if (threadTs) {
      const exact = this.pairings.get(PairingStore.threadKey(channel, threadTs));
      if (exact) return exact;
    }
    return this.pairings.get(PairingStore.channelKey(channel));
  }

  byTerminal(terminalId: string): Pairing | undefined {
    for (const p of this.pairings.values()) {
      if (p.terminalId === terminalId) return p;
    }
    return undefined;
  }

  add(p: Pairing): void {
    this.pairings.set(p.key, p);
    this.save();
  }

  remove(key: string): boolean {
    const existed = this.pairings.delete(key);
    if (existed) this.save();
    return existed;
  }

  list(): Pairing[] {
    return [...this.pairings.values()];
  }
}
