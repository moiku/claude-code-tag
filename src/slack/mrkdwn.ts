/** Converts common Markdown constructs (as Claude Code emits them) into Slack mrkdwn. */
export function markdownToMrkdwn(input: string): string {
  const fenceSplit = input.split(/(```[\s\S]*?```)/g);
  return fenceSplit
    .map((part, i) => {
      if (i % 2 === 1) return part; // inside a fenced code block — leave verbatim
      let s = part;
      s = s.replace(/\*\*(.+?)\*\*/g, "*$1*"); // bold
      s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_"); // italic *x* -> _x_
      s = s.replace(/^(#{1,6})\s+(.+)$/gm, "*$2*"); // headings -> bold line
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>"); // links
      s = s.replace(/^(\s*)[-*]\s+/gm, "$1• "); // bullet lists
      return s;
    })
    .join("");
}

const CHUNK_LIMIT = 3900;

/**
 * Splits text into chunks under CHUNK_LIMIT, preferring paragraph boundaries
 * and never splitting inside a fenced code block (re-opens the fence if a
 * block has to be split across chunks).
 */
export function chunkForSlack(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openFence = false;

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;

    let piece = remaining.slice(0, cut);
    const fenceCount = (piece.match(/```/g) ?? []).length;
    const pieceOpensFence: boolean = openFence ? fenceCount % 2 === 0 : fenceCount % 2 === 1;

    if (openFence) piece = "```\n" + piece; // continuation marker for readability
    if (pieceOpensFence) piece += "\n```"; // close the fence for this chunk

    chunks.push(piece);
    openFence = pieceOpensFence;
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining.length > 0) {
    chunks.push(openFence ? "```\n" + remaining : remaining);
  }
  return chunks;
}
