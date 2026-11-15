import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { linkOrCopy } from './index.js';
import { ensureShadowClaudeMd } from './agents-md-shadow.js';

// Shared adapter for every assistant whose "always-on" surface is a plain
// markdown instructions/rules file (AGENTS.md, copilot-instructions.md, a
// .windsurf/.roo/.continue rule, …). Skills are symlinked to the shared base;
// the suggest block is injected between idempotent markers so re-installs and
// multiple assistants sharing one file never duplicate it.
const MARK_START = '<!-- rsc-suggest:start -->';
const MARK_END = '<!-- rsc-suggest:end -->';
// The exact separator wireHook writes before an appended block, so unwireHook can take
// back precisely what it gave and leave the rest of the file untouched.
const SEAM = '\n\n';
// Most assistants that read a rules file have no session-start hook, so nothing checks for a new rsc
// on its own. The agent does it instead. Here and not in suggest's body: the body is paid on every
// turn by every assistant, Claude Code included, which already checks from its hook.
export const UPDATE_NOTE = '**rsc updates.** Claude Code, Codex, Gemini CLI, Cursor, OpenCode and Oh My Pi check for a new rsc on their '
  + 'own. In any other assistant, run `node .rsc/auto-update.mjs` once on the first turn of a session and relay any '
  + 'notice it prints in one line; "up to date" needs no mention.\n';

// OMP is the only target here with a native todo panel. The skills keep owning the method and the
// durable Markdown artifact; this section only tells the main session how to mirror that artifact
// into the client's live view. It lives in AGENTS.md, not RULES.md, because task subagents cannot
// call `todo` and should not pay for the instruction.
export const OMP_TODO_SECTION = `## Native todo panel (Oh My Pi)

This client has a live todo panel. On the FTD lane and the ASDD chain, create the list with the
native \`todo\` tool before the first edit: one phase per stage, one task per checklist row or
\`## Tasks\` row, keeping the row's ID when it has one. Mark \`start\` and \`done\` as the work happens.
The markdown artifact is the durable record; the panel is how the person sees where the run is. Do
not create a list for the Answer lane.`;

// The compass already ends in 1–3 concrete options. OMP renders those natively through `ask`;
// without this section the model turns the menu into prose because the skills never name a tool.
// It is main-session guidance only: task subagents cannot prompt the person.
export const OMP_ASK_SECTION = `## Native question form (Oh My Pi)

When the compass's ➡️ line offers 1–3 real options and the session is interactive — and the lane is
not autopilot and no skill sent the decision to the queue — use the native \`ask\` tool instead
of a prose menu: one short \`<form>\` with one radio group, the recommended option preselected, and
the same options in the same order. Keep the 📍/✅/🧭 lines and let the ➡️ line name the decision;
the form carries its options. Use prose only in print/RPC/headless sessions, where \`ask\` has no UI,
or when the question is genuinely open-ended. Never add an "Other" option: OMP supplies it.

\`\`\`html
<form>
  <p>¿Cómo seguimos?</p>
  <label><input type="radio" name="next" value="merge" checked> Mergear #2 y seguir (recomendado)</label>
  <label><input type="radio" name="next" value="review"> Revisar #3 y #4 antes</label>
  <label><input type="radio" name="next" value="stop"> Cerrar aquí</label>
</form>
\`\`\``;

export function writeSkill(id, fromDir, toPath) {
  return linkOrCopy(fromDir, toPath);
}

export function wireHook(paths, sourceMd, policy = {}, target = null) {
  const full = stripFrontmatter(readFileSync(sourceMd, 'utf8'));
  const body = policy.codeHooks === false
    ? `# rsc-suggest — always-on operations layer\n\nRead \`02-DOCS/wiki/harness/user-profile.md\` before acting. Use \`orient\` to keep the user situated and \`suggest\` to offer a missing skill only when the current task needs it. Close with the configured orientation block.\n`
    : full;
  const extra = target === 'omp' ? `\n${OMP_TODO_SECTION}\n\n${OMP_ASK_SECTION}\n` : '';
  const block = `${MARK_START}\n${body}${extra}\n${UPDATE_NOTE}\n${MARK_END}`;
  let doc = existsSync(paths.hookTarget) ? readFileSync(paths.hookTarget, 'utf8') : '';
  if (doc.includes(MARK_START)) {
    doc = doc.replace(new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`), block);
  } else {
    // Append with a fixed seam, and record nothing else. unwireHook removes exactly this
    // seam and this block, which is what lets the file come back byte-identical.
    doc += `${SEAM}${block}\n`;
  }
  mkdirSync(dirname(paths.hookTarget), { recursive: true });
  writeFileSync(paths.hookTarget, doc);

  // This file may BE the root AGENTS.md, which Claude Code 2.1.277+ reads as project instructions
  // when no CLAUDE.md exists — doubling an always-on body the SessionStart hook already prints.
  // No-op unless the Claude Code target is also wired here. Called from both adapters so the fix
  // holds whichever assistant the user installs second. See targets/agents-md-shadow.js.
  const shadow = ensureShadowClaudeMd(paths.projectRoot);
  return shadow ? [paths.hookTarget, shadow] : [paths.hookTarget];
}

// Inverse of wireHook: remove the marked rsc-suggest block from the shared
// instructions file, leaving the user's own content intact. No-op when absent.
export function unwireHook(paths) {
  if (!existsSync(paths.hookTarget)) return [];
  const doc = readFileSync(paths.hookTarget, 'utf8');
  if (!doc.includes(MARK_START)) return [];
  // Remove the block and the seam that introduced it — nothing more.
  //
  // This used to end with a document-wide `\n{3,}` -> `\n\n` pass, which tidied blank
  // lines the author had put hundreds of lines away from anything of ours. In #249 that
  // file was the project's hand-written constitution: it had already received 95 lines it
  // never asked for, and giving it back reformatted is the second half of the same damage.
  // A slightly larger gap is cosmetic; rewriting someone's document is not.
  const cleaned = doc.replace(
    new RegExp(`${SEAM.replace(/\n/g, '\\n')}?${MARK_START}[\\s\\S]*?${MARK_END}\\n?`),
    '',
  );
  writeFileSync(paths.hookTarget, cleaned);
  return [paths.hookTarget];
}

function stripFrontmatter(md) {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '');
}
