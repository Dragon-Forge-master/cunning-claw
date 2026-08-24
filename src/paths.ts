import os from "node:os";
import path from "node:path";

/** Paths the model must not read or write, even via dedicated file tools. */
const SENSITIVE_PATH = /\/etc\/(shadow|sudoers)|\.ssh\/.*(id_|authorized_keys)|\/root\//i;

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATH.test(expandHome(p));
}
