import type { DocChunk } from "../types/index.js";

const MAX_CHARS = 1800; // ~ 400-500 tokens, rough char-to-token ratio

// A section shorter than this is folded into the chunk before it instead of becoming its own chunk.
// Without it, a file of thousands of one-line headings would become thousands of chunks, each one
// an embedding call against the shared Gemini quota.
const MIN_SECTION_CHARS = 120;

// The backstop: a real document of 500 KB in 1800-char pieces is under 300 chunks.
export const MAX_CHUNKS = 1000;

export class DocumentTooFragmentedError extends Error {
  constructor(chunks: number) {
    super(`The document would be split into ${chunks} pieces; the limit is ${MAX_CHUNKS}. Use fewer, longer sections.`);
  }
}

export function chunkMarkdown(raw: string): DocChunk[] {
  const sections = splitByHeading(raw.replace(/^﻿/, "").replace(/\r\n/g, "\n"));

  const chunks: DocChunk[] = [];
  let idx = 0;

  for (const section of sections) {
    const pieces = splitIfTooLong(section.content, MAX_CHARS);
    for (const piece of pieces) {
      const trimmed = piece.trim();
      if (!trimmed) continue; // skip empty/whitespace-only chunks

      const previous = chunks[chunks.length - 1];
      // A small section joins the previous chunk when the two fit together. Its heading is kept
      // as a line of text, so the words are still there for retrieval.
      if (
        previous &&
        trimmed.length < MIN_SECTION_CHARS &&
        previous.content.length + trimmed.length + section.heading.length + 4 <= MAX_CHARS
      ) {
        previous.content += section.heading ? `\n\n${section.heading}\n${trimmed}` : `\n\n${trimmed}`;
        // the chunk now spans two headings; cite what they have in common
        previous.headingPath = commonPath(previous.headingPath, section.headingPath);
        continue;
      }

      chunks.push({
        chunkIndex: idx++,
        headingPath: section.headingPath,
        content: trimmed,
      });
      if (chunks.length > MAX_CHUNKS) throw new DocumentTooFragmentedError(chunks.length);
    }
  }
  return chunks;
}

// "Returns > Refunds" and "Returns > Exchanges" share "Returns"; with nothing in common, the first one stands
function commonPath(a: string, b: string): string {
  const left = a.split(" > ");
  const right = b.split(" > ");
  const shared: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length) && left[i] === right[i]; i++) shared.push(left[i]);
  return shared.length ? shared.join(" > ") : a;
}

interface Section {
  headingPath: string;
  heading: string; // the heading line itself ("## Refunds"), empty for text above the first heading
  content: string;
}

function splitByHeading(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  const path: string[] = []; // path[0] = current #, path[1] = current ##, path[2] = current ###
  let heading = "";
  let buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    const headingPath = path.filter(Boolean).join(" > ") || "Introduction";
    sections.push({ headingPath, heading, content: buffer.join("\n") });
    buffer = [];
  };

  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.*)/);
    if (match) {
      flush();
      const level = match[1].length;
      path.length = level - 1; // drop deeper headings from the previous section
      path[level - 1] = match[2].trim();
      heading = line.trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function splitIfTooLong(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];
  const parts: string[] = [];
  let remaining = content;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n\n", maxChars);
    if (cut <= 0) cut = maxChars;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.trim()) parts.push(remaining);
  return parts;
}
