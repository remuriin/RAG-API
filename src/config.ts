import { isUuid } from "./util/uuid.js";

function requireInstanceId(): string {
  const id = process.env.INSTANCE_ID?.trim() ?? "";
  if (!isUuid(id)) {
    throw new Error("INSTANCE_ID must be set to this instance's UUID");
  }
  return id.toLowerCase();
}

// Every query this process runs is scoped to this instance.
export const INSTANCE_ID = requireInstanceId();

export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = process.env.HOST ?? "127.0.0.1"; // nginx is the public entry
