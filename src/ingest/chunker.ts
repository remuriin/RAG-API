import type { DocChunk } from "../types/index.js";

const MAX_CHARS = 1800; // ~ 400-500 tokens, rough char-to-token ratio

export function chunkMarkdown(raw: string): DocChunk[] {
  const sections = splitByHeading(raw.replace(/^﻿/, "").replace(/\r\n/g, "\n"));

  const chunks: DocChunk[] = [];
  let idx = 0;

  for (const section of sections) {
    const pieces = splitIfTooLong(section.content, MAX_CHARS);
    for (const piece of pieces) {
      const trimmed = piece.trim();
      if (!trimmed) continue; // skip empty/whitespace-only chunks

      chunks.push({
        chunkIndex: idx++,
        headingPath: section.headingPath,
        content: trimmed,
      });
    }
  }
  return chunks;
}

function splitByHeading(markdown: string): { headingPath: string; content: string }[] {
  const lines = markdown.split("\n");
  const sections: { headingPath: string; content: string }[] = [];
  const path: string[] = []; // path[0] = current #, path[1] = current ##, path[2] = current ###
  let buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    const headingPath = path.filter(Boolean).join(" > ") || "Introduction";
    sections.push({ headingPath, content: buffer.join("\n") });
    buffer = [];
  };

  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.*)/);
    if (match) {
      flush();
      const level = match[1].length;
      path.length = level - 1; // drop deeper headings from the previous section
      path[level - 1] = match[2].trim();
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
