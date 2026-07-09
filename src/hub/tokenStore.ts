import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface IssuedToken {
  token: string;
  name: string;
  issuedAt: string;
}

const DEFAULT_STORE_PATH = join(homedir(), ".cctag-hub", "tokens.json");

/**
 * The Hub's registry of tokens it will accept from connecting Spokes. The
 * token itself is the authorization boundary — whoever holds a valid token
 * can register as any `ownerUserId` (supplied by the Spoke at connect time),
 * so tokens should only be handed to people you trust with your Slack
 * workspace's cctag access.
 */
export class TokenStore {
  private tokens = new Map<string, IssuedToken>();

  constructor(private readonly path: string = DEFAULT_STORE_PATH) {
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, "utf8");
      const list = JSON.parse(raw) as IssuedToken[];
      for (const t of list) this.tokens.set(t.token, t);
    } catch {
      // no store yet
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.tokens.values()], null, 2));
    renameSync(tmp, this.path);
  }

  issue(name: string): IssuedToken {
    const token = randomBytes(24).toString("base64url");
    const entry: IssuedToken = { token, name, issuedAt: new Date().toISOString() };
    this.tokens.set(token, entry);
    this.save();
    return entry;
  }

  revoke(name: string): boolean {
    let removed = false;
    for (const [token, entry] of this.tokens) {
      if (entry.name === name) {
        this.tokens.delete(token);
        removed = true;
      }
    }
    if (removed) this.save();
    return removed;
  }

  validate(token: string): IssuedToken | undefined {
    return this.tokens.get(token);
  }

  list(): IssuedToken[] {
    return [...this.tokens.values()];
  }
}
