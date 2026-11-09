/**
 * Sets the operator password for self-hosted mode (AW.5).
 *
 * Run on the machine itself: `npm run operator:password`. Prompts twice
 * without echo and needs a real terminal (it refuses piped input, so a
 * password never lands in shell history or a log). Setting a new password
 * also rotates the session key, which signs everyone out.
 */
import {
  createOperatorRecord,
  resolveOperatorFile,
  validateNewPassword,
  writeOperatorFile,
} from "../src/core/selfhost/operator-store";

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (error?: Error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(new Error("Cancelled."));
        if (ch === "\u0004" && value.length === 0)
          return finish(new Error("Cancelled."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "This command needs an interactive terminal. Run it directly on the machine, not piped.",
    );
    process.exit(1);
  }
  const first = await readHidden("New operator password: ");
  const problem = validateNewPassword(first);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const second = await readHidden("Repeat password: ");
  if (first !== second) {
    console.error("Passwords do not match. Nothing was changed.");
    process.exit(1);
  }
  const record = await createOperatorRecord(first);
  const file = resolveOperatorFile();
  writeOperatorFile(file, record);
  console.log(`Operator password saved to ${file}.`);
  console.log("All existing sign-ins were ended. Restart is not needed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Failed.");
  process.exit(1);
});
