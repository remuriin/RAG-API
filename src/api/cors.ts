import type { NextFunction, Request, Response } from "express";

// Lets a web page call POST /query straight from the browser, from any site or from a file opened
// on disk (its Origin is "null"). The key still travels in the Authorization header and is still
// checked by requireApiKey; "*" only lets the browser show the reply to a page that already holds
// a key. No cookies are involved, so "*" grants nothing a server-side caller could not already do.
// Only /query is opened: uploads, deletes and the document list stay server-to-server.
export function allowBrowserQueries(req: Request, res: Response, next: NextFunction): void {
  if (req.path.replace(/\/+$/, "") !== "/query") {
    next();
    return;
  }
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST");
  res.set("Access-Control-Max-Age", "600");
  // the browser's preflight carries no key, so it is answered here, before requireApiKey
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}
