// @ts-check
// PreToolUse hook (Bash | PowerShell): denies `git commit` commands whose -m message breaks the
// commit format, or that skip hooks / add trailers. Commands it cannot parse are allowed; the
// git commit-msg hook (.githooks/commit-msg) is the backstop.
import { text } from "node:stream/consumers";
import { describeErrors, validateCommitMessage } from "../../scripts/commit-format.mjs";

// Bash: git commit -m "$(cat <<'EOF'\n...\nEOF\n)"
const HEREDOC = /"\$\(cat\s*<<-?\s*(['"]?)(\w+)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?[ \t]*\)"/g;
// Private-use characters mark extracted heredoc bodies while the rest is tokenized.
const PLACEHOLDER = /(\d+)/g;
const BASH_DQUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

// Options whose value is the next word when not written as --opt=value.
const LONG_WITH_VALUE = new Set([
  "--author",
  "--cleanup",
  "--date",
  "--file",
  "--fixup",
  "--pathspec-from-file",
  "--reedit-message",
  "--reuse-message",
  "--squash",
  "--template",
]);
const SHORT_WITH_VALUE = new Set(["m", "F", "C", "c", "t"]);
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/**
 * Splits a shell command line (Bash or PowerShell) into simple commands of unquoted words.
 * @param {string} input
 * @returns {string[][] | null} null when the command uses constructs this parser does not handle.
 */
export function splitCommands(input) {
  /** @type {string[]} */
  const bodies = [];
  const src = input.replace(/\r\n/g, "\n").replace(HEREDOC, (_match, _quote, _tag, body) => {
    bodies.push(body);
    return `${bodies.length - 1}`;
  });

  /** @type {string[][]} */
  const commands = [];
  /** @type {string[]} */
  let current = [];
  /** @type {string | null} */
  let word = null;

  const endWord = () => {
    if (word !== null) {
      current.push(word.replace(PLACEHOLDER, (_m, index) => bodies[Number(index)] ?? ""));
      word = null;
    }
  };
  const endCommand = () => {
    endWord();
    if (current.length > 0) commands.push(current);
    current = [];
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // PowerShell here-string: @'\n...\n'@ or @"\n...\n"@
    if (c === "@" && (next === "'" || next === '"') && src[i + 2] === "\n" && word === null) {
      const close = src.indexOf(`\n${next}@`, i + 3);
      if (close === -1) return null;
      word = src.slice(i + 3, close);
      i = close + 3;
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) return null;
      word = (word ?? "") + src.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== '"') {
        const d = src[j];
        const e = src[j + 1];
        if (d === "\\" && e !== undefined && BASH_DQUOTE_ESCAPABLE.has(e)) {
          value += e;
          j += 2;
          continue;
        }
        if ((d === "$" && e === "(") || d === "`") return null;
        value += d;
        j++;
      }
      if (j >= src.length) return null;
      word = (word ?? "") + value;
      i = j + 1;
      continue;
    }
    if ((c === "$" && next === "(") || c === "`") return null;
    if (c === "\\" && next !== undefined) {
      word = (word ?? "") + next;
      i += 2;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      endCommand();
      i++;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    word = (word ?? "") + c;
    i++;
  }
  endCommand();
  return commands;
}

/**
 * @param {string[]} words One simple command.
 * @returns {{ messages: string[], errors: string[] } | null} null when it is not `git commit`.
 */
export function parseGitCommit(words) {
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
  if (words[i] !== "git" && words[i] !== "git.exe") return null;
  i++;
  for (let w = words[i]; w?.startsWith("-"); w = words[i]) {
    i += GIT_GLOBAL_WITH_VALUE.has(w) ? 2 : 1;
  }
  if (words[i] !== "commit") return null;

  /** @type {string[]} */
  const messages = [];
  /** @type {Set<string>} */
  const errors = new Set();
  const noVerify = "must not use --no-verify / -n (it skips the commit-msg hook)";
  const trailers = "must not add trailers (--trailer, --signoff)";

  for (let j = i + 1; j < words.length; j++) {
    const w = words[j] ?? "";
    if (w === "--") break;
    if (w === "-m" || w === "--message") {
      const value = words[++j];
      if (value !== undefined) messages.push(value);
    } else if (w.startsWith("--message=")) {
      messages.push(w.slice("--message=".length));
    } else if (w === "--no-verify") {
      errors.add(noVerify);
    } else if (w === "--signoff" || w === "--trailer" || w.startsWith("--trailer=")) {
      errors.add(trailers);
      if (w === "--trailer") j++;
    } else if (LONG_WITH_VALUE.has(w)) {
      j++;
    } else if (/^-[^-]/.test(w)) {
      // Short-option cluster such as -am, -nm, -mfix or -m"fix bug".
      for (let k = 1; k < w.length; k++) {
        const flag = w.charAt(k);
        if (flag === "n") errors.add(noVerify);
        if (flag === "s") errors.add(trailers);
        if (SHORT_WITH_VALUE.has(flag)) {
          const value = k + 1 < w.length ? w.slice(k + 1) : words[++j];
          if (flag === "m" && value !== undefined) messages.push(value);
          break;
        }
      }
    }
  }

  if (messages.length > 0) {
    for (const error of validateCommitMessage(messages.join("\n\n"))) errors.add(error);
  }
  return { messages, errors: [...errors] };
}

/**
 * @param {string} command Full command line from the tool call.
 * @returns {string[]} Violations across every `git commit` in the command.
 */
export function checkCommand(command) {
  const commands = splitCommands(command);
  if (commands === null) return [];
  return [...new Set(commands.flatMap((words) => parseGitCommit(words)?.errors ?? []))];
}

if (import.meta.main) {
  const input = JSON.parse(await text(process.stdin));
  const command = input?.tool_input?.command;
  const errors = typeof command === "string" ? checkCommand(command) : [];
  if (errors.length > 0) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: describeErrors(errors),
        },
      }),
    );
  }
}
