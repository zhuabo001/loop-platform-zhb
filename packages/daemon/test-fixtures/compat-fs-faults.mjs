/** Test-only preload: fail filesystem boundaries of the real compat CLI. */
import { appendFileSync, promises as fs } from "node:fs";
import path from "node:path";

const fault = process.env.COMPAT_TEST_FAULT;
const mintedLog = process.env.COMPAT_TEST_MINTED_LOG;
const mkdtemp = fs.mkdtemp.bind(fs);
fs.mkdtemp = async (...args) => {
  const created = await mkdtemp(...args);
  if (!path.basename(created).startsWith("work-")) appendFileSync(mintedLog, `${created}\n`);
  return created;
};
const open = fs.open.bind(fs);
let locks = 0;
fs.open = async (file, ...args) => {
  if (String(file).endsWith(".lock") && ++locks === 2 && fault === "reservation-lock") {
    throw Object.assign(new Error("injected reservation lock conflict"), { code: "EEXIST" });
  }
  return open(file, ...args);
};
const rename = fs.rename.bind(fs);
fs.rename = async (from, to) => {
  if (String(to).endsWith("spend-ledger.json") && fault === "reservation-write") {
    throw Object.assign(new Error("injected ledger write failure"), { code: "EIO" });
  }
  return rename(from, to);
};
const symlink = fs.symlink.bind(fs);
fs.symlink = async (...args) => {
  if (fault === "refusal-setup") throw new Error("injected refusal setup failure");
  return symlink(...args);
};
