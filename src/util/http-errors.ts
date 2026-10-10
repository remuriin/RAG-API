// Turns the errors Express and body-parser throw into a status and a message meant for people.
// Returns null for anything that is the server's own fault, which the caller logs and answers with 500.
export function clientError(err: any): { status: number; message: string } | null {
  const status = typeof err?.status === "number" ? err.status : typeof err?.statusCode === "number" ? err.statusCode : 0;
  if (status < 400 || status >= 500) return null;

  switch (err?.type) {
    case "entity.too.large":
      return { status: 413, message: "The request is too large. Files can be up to 500 KB." };
    case "entity.parse.failed":
      return { status: 400, message: "The request body is not valid JSON." };
    case "charset.unsupported":
    case "encoding.unsupported":
      return { status: 415, message: "Send the request as UTF-8 text." };
  }
  // Express's own 400 for a badly percent-encoded path, and anything else that knows it is the caller's mistake
  if (err?.expose) return { status, message: err.message };
  return { status, message: status === 400 ? "The request is malformed." : "The request was refused." };
}
