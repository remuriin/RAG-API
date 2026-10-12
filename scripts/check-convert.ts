// Checks the file-conversion rules without a model or a database: npx tsx scripts/check-convert.ts
import assert from "node:assert/strict";
import { DocumentTooLongError, kindOf, toMarkdown, withFallback, type ConvertCall } from "../src/ingest/convert.js";

// the time budget uses a timer that does not keep the process alive by itself; a server is always alive, this script is not
const alive = setInterval(() => {}, 1000);

// which kind a name is
assert.equal(kindOf("guide.md"), "markdown");
assert.equal(kindOf("notes.TXT"), "text");
assert.equal(kindOf("policy.pdf"), "pdf");
assert.equal(kindOf("page.html"), "html");
assert.equal(kindOf("page.htm"), "html");
assert.equal(kindOf("feed.xml"), "xml");
assert.equal(kindOf("report.docx"), null);
assert.equal(kindOf("archive.pdf.exe"), null, "only the last ending counts");
assert.equal(kindOf("noending"), null);

// a pretend model: the replies it gives in order, each one cut short or not
const model = (...replies: [text: string, truncated: boolean][]) => {
  const seen: { system: string; turns: number; last: string }[] = [];
  const generate: ConvertCall = async (system, contents) => {
    const parts = contents.at(-1)?.parts ?? [];
    seen.push({ system, turns: contents.length, last: parts.map((p) => p.text ?? "[file]").join(" ") });
    const [text, truncated] = replies[seen.length - 1] ?? ["", false];
    return { text, truncated };
  };
  return { generate, seen };
};
const pdf = Buffer.from("%PDF-1.7 pretend");

// markdown and plain text never reach the model
const unused = model(["never", false]);
assert.equal(await toMarkdown("markdown", "# Title\ntext", unused.generate), "# Title\ntext");
assert.equal(await toMarkdown("text", "just words", unused.generate), "just words");
assert.equal(unused.seen.length, 0);

// one reply that fits
const one = model(["# Refunds\n5 to 7 days", false]);
assert.equal(await toMarkdown("pdf", pdf, one.generate), "# Refunds\n5 to 7 days");
assert.equal(one.seen.length, 1);
assert.match(one.seen[0].system, /Never summarise/);

// a reply cut short is carried on, and the pieces are joined with nothing between them
const two = model(["# Refunds\n5 to 7 busin", true], ["ess days", false]);
assert.equal(await toMarkdown("pdf", pdf, two.generate), "# Refunds\n5 to 7 business days");
assert.equal(two.seen.length, 2);
assert.equal(two.seen[1].turns, 3, "the second call carries the file, the first reply and the request to carry on");
assert.match(two.seen[1].last, /Carry on exactly where you stopped/);

// a file that never finishes is refused after 4 replies, not stored with its end missing
const endless = model(["a", true], ["b", true], ["c", true], ["d", true], ["e", true]);
await assert.rejects(toMarkdown("pdf", pdf, endless.generate), DocumentTooLongError);
assert.equal(endless.seen.length, 4);

// a file that runs out of time is refused the same way, whether the model is still writing or just returned
const slow: ConvertCall = (_system, _contents, deadline) =>
  new Promise((_resolve, reject) => deadline.addEventListener("abort", () => reject(new Error("aborted"))));
await assert.rejects(toMarkdown("pdf", pdf, slow, 30), DocumentTooLongError);
const late: ConvertCall = async () => {
  await new Promise((r) => setTimeout(r, 60));
  return { text: "half a docu", truncated: true };
};
await assert.rejects(toMarkdown("pdf", pdf, late, 30), DocumentTooLongError);

// a busy model is tried again and the file still converts; another failure is passed on as it is
let attempts = 0;
const busyOnce: ConvertCall = async () => {
  if (attempts++ === 0) throw Object.assign(new Error("busy"), { status: 503 });
  return { text: "# ok", truncated: false };
};
const quiet = console.warn;
console.warn = () => {};
assert.equal(await toMarkdown("pdf", pdf, busyOnce), "# ok");
await assert.rejects(toMarkdown("pdf", pdf, async () => Promise.reject(new Error("bad request"))), /bad request/);

// two models: the second takes over when the first is busy, and only then
const busy = () => Object.assign(new Error("busy"), { status: 503 });
const tried: string[] = [];
const use = (works: string[]) => (m: string, isLast: boolean) => {
  tried.push(m + (isLast ? ":last" : ""));
  return works.includes(m) ? Promise.resolve(m) : Promise.reject(busy());
};
assert.equal(await withFallback(["strong", "lite"], use(["strong", "lite"])), "strong");
assert.deepEqual(tried.splice(0), ["strong"], "the first model answered: the second is never called");
assert.equal(await withFallback(["strong", "lite"], use(["lite"])), "lite");
assert.deepEqual(tried.splice(0), ["strong", "lite:last"]);
await assert.rejects(withFallback(["strong", "lite"], use([])), { status: 503 });
await assert.rejects(
  withFallback(["strong", "lite"], () => Promise.reject(new Error("bad request"))),
  /bad request/,
  "a failure that is not busy does not move on to the next model",
);
console.warn = quiet;

// nothing came back: empty, which the pipeline refuses as a file with no content
assert.equal(await toMarkdown("pdf", pdf, model(["  ", false]).generate), "");

// a reply wrapped in a code fence is unwrapped
assert.equal(await toMarkdown("html", "<h1>x</h1>", model(["```markdown\n# x\n```", false]).generate), "# x");

// a web page and XML get their own extra rule
const html = model(["# x", false]);
await toMarkdown("html", "<h1>x</h1>", html.generate);
assert.match(html.seen[0].system, /web page's HTML/);
const xml = model(["# x", false]);
await toMarkdown("xml", "<a>x</a>", xml.generate);
assert.match(xml.seen[0].system, /document is XML/);

clearInterval(alive);
console.log("file conversion: all checks passed");
