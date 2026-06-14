// Mint an AUTH_PASS value (PBKDF2-HMAC-SHA256, salted) for the login secret.
// Keep PBKDF2_ITERS in sync with worker/index.ts.
//
// The password is read from stdin so it never lands in shell history or `ps`.
// The hidden prompt is written to stderr and the hash to stdout, so you can pipe
// the hash to the clipboard and never show it on screen:
//   node scripts/hash-password.mjs | pbcopy   # type password at hidden prompt → hash to clipboard
//   npx wrangler secret put AUTH_PASS          # paste at wrangler's masked prompt
//
// Other forms:
//   node scripts/hash-password.mjs                       # print the hash (interactive)
//   printf '%s' 'pw' | node scripts/hash-password.mjs    # piped (non-interactive / CI)
// For local dev, put the printed hash into AUTH_PASS in .dev.vars.

const PBKDF2_ITERS = 210_000;

// Read the password without echoing it to the terminal. Falls back to reading a
// piped stream when stdin isn't a TTY (CI, `printf ... | node ...`).
function readPassword() {
  const { stdin, stderr } = process;

  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const chunks = [];
      stdin.on("data", (c) => chunks.push(c));
      stdin.on("end", () =>
        resolve(Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, ""))
      );
    });
  }

  return new Promise((resolve) => {
    stderr.write("New password (input hidden): "); // prompt on stderr, hash on stdout
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      resolve(buf);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") return finish(); // Enter / EOT
        if (ch === "\u0003") {
          // Ctrl-C
          stdin.setRawMode(false);
          stderr.write("\n");
          process.exit(130);
        } else if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
        } else if (ch >= " ") {
          buf += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

const password = await readPassword();
if (!password) {
  process.stderr.write("error: empty password\n");
  process.exit(1);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(password),
  "PBKDF2",
  false,
  ["deriveBits"]
);
const bits = new Uint8Array(
  await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    key,
    256
  )
);
const b64 = (b) => Buffer.from(b).toString("base64");
// `:`-delimited (not the PHC `$`) so it survives dotenv expansion in .dev.vars.
console.log(`pbkdf2:${PBKDF2_ITERS}:${b64(salt)}:${b64(bits)}`);
