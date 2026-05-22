import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { complete } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

type Repo = {
  path: string;
  name: string;
  changedFiles: number;
};

type Args = {
  help: boolean;
  rebase: boolean;
  rebaseOnly: boolean;
  noForce: boolean;
};

type PrDraft = {
  title: string;
  body: string;
};

const CHEAP_PROVIDER = process.env.PI_PR_CHEAP_PROVIDER || "openai-codex";
const CHEAP_MODEL = process.env.PI_PR_CHEAP_MODEL || "gpt-5.4-mini";
const SCAN_DEPTH = Number(process.env.PI_PR_SCAN_DEPTH || "2");

function parseArgs(args: string): Args {
  const parts = args.split(/\s+/).filter(Boolean);
  return {
    help: parts.includes("--help") || parts.includes("-h"),
    rebase: parts.includes("--rebase") || parts.includes("--rebase-only"),
    rebaseOnly: parts.includes("--rebase-only"),
    noForce: parts.includes("--no-force"),
  };
}

function helpText() {
  return `Usage:
  /pr                 Commit dirty repo(s), push branch(es), create/show PR(s)
  /pr --rebase        Commit, fetch, rebase on base, force-with-lease, create/show PR(s)
  /pr --rebase-only   Commit, fetch, rebase on base, force-with-lease, no PR(s)
  /pr --no-force      With --rebase, stop after rebase; do not force-push
  /pr --help          Show this help

Behavior:
  - Scans cwd and child git repos for dirty repos.
  - Processes all dirty repos found, with a confirmation when multiple repos are dirty.
  - Refuses base branches: detected base, main, master.
  - Rebase flow asks before rebase and before force-with-lease.
  - Rebase conflicts stop and print continue/abort commands.

Env:
  PI_PR_SCAN_DEPTH=${SCAN_DEPTH}
  PI_PR_CHEAP_PROVIDER=${CHEAP_PROVIDER}
  PI_PR_CHEAP_MODEL=${CHEAP_MODEL}`;
}

function sh(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function exec(pi: ExtensionAPI, command: string, timeout = 60_000) {
  const result = await pi.exec("bash", ["-lc", command], { timeout });
  return {
    code: result.code ?? 1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

async function git(
  pi: ExtensionAPI,
  repo: string,
  command: string,
  timeout = 60_000,
) {
  return exec(pi, `git -C ${sh(repo)} ${command}`, timeout);
}

async function currentRepo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const result = await exec(
    pi,
    `git -C ${sh(ctx.cwd)} rev-parse --show-toplevel`,
  );
  return result.code === 0 ? result.stdout : undefined;
}

async function scanRepos(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<Repo[]> {
  const direct = await currentRepo(pi, ctx);
  const discovered = (
    await exec(
      pi,
      `find ${sh(ctx.cwd)} -maxdepth ${SCAN_DEPTH} -name .git \\( -type d -o -type f \\) -prune -exec dirname {} \\;`,
      20_000,
    )
  ).stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const candidates = direct ? [direct, ...discovered] : discovered;

  const seen = new Set<string>();
  const repos: Repo[] = [];
  for (const path of candidates) {
    const abs = resolve(path);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const status = await git(pi, abs, "status --porcelain");
    if (status.code !== 0 || !status.stdout) continue;
    repos.push({
      path: abs,
      name: basename(abs),
      changedFiles: status.stdout.split("\n").filter(Boolean).length,
    });
  }
  return repos;
}

async function chooseRepos(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<Repo[]> {
  const repos = await scanRepos(pi, ctx);
  if (repos.length === 0) {
    ctx.ui.notify("/pr: no changed git repo found", "info");
    return [];
  }
  if (repos.length === 1) return repos;
  const summary = repos
    .map((r) => `- ${r.name}: ${r.changedFiles} changed files — ${r.path}`)
    .join("\n");
  const ok = await ctx.ui.confirm("Create PRs for all dirty repos?", summary);
  return ok ? repos : [];
}

async function detectBase(pi: ExtensionAPI, repo: string): Promise<string> {
  const gh = await exec(
    pi,
    `cd ${sh(repo)} && gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'`,
    20_000,
  );
  if (gh.code === 0 && gh.stdout) return gh.stdout;
  const originHead = await git(
    pi,
    repo,
    "symbolic-ref --short refs/remotes/origin/HEAD",
  );
  if (originHead.code === 0 && originHead.stdout.startsWith("origin/"))
    return originHead.stdout.slice("origin/".length);
  for (const branch of ["main", "master"]) {
    const exists = await git(pi, repo, `rev-parse --verify origin/${branch}`);
    if (exists.code === 0) return branch;
  }
  return "main";
}

async function ensureBranchSafe(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repo: string,
  base: string,
): Promise<string | undefined> {
  const branch = await git(pi, repo, "branch --show-current");
  if (branch.code !== 0 || !branch.stdout) {
    ctx.ui.notify("/pr: detached HEAD or unable to detect branch", "error");
    return undefined;
  }
  if (
    branch.stdout === base ||
    branch.stdout === "main" ||
    branch.stdout === "master"
  ) {
    ctx.ui.notify(
      `/pr: refusing to run on base branch ${branch.stdout}`,
      "error",
    );
    return undefined;
  }
  return branch.stdout;
}

function latestPlanContext(ctx: ExtensionCommandContext): string[] {
  const entry = ctx.sessionManager
    .getEntries()
    .filter(
      (e: { type: string; customType?: string }) =>
        e.type === "custom" && e.customType === "plan-mode",
    )
    .pop() as
    | { data?: { todos?: { text?: string }[]; lastPlanText?: string } }
    | undefined;
  const todos =
    entry?.data?.todos
      ?.map((todo) => todo.text)
      .filter((text): text is string => Boolean(text?.trim())) || [];
  if (todos.length > 0) return todos.slice(0, 3);
  const lines = entry?.data?.lastPlanText
    ?.split("\n")
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
    .filter(Boolean);
  return lines?.slice(0, 3) || [];
}

function deterministicDraft(
  repo: string,
  changedFiles: string[],
  stat: string,
  branch: string,
  planContext: string[],
): PrDraft {
  return {
    title: `Update ${basename(repo)}: ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} changed`,
    body: [
      "What:",
      ...changedFiles.slice(0, 8).map((file) => `- ${file}`),
      changedFiles.length > 8
        ? `- ...and ${changedFiles.length - 8} more`
        : undefined,
      "",
      "Why:",
      planContext.length > 0
        ? planContext.map((line) => `- ${line}`).join("\n")
        : `- Implements the current work on ${branch || "this branch"}.`,
      "",
      "How:",
      stat || "- See diff for implementation details.",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  };
}

function parseDraft(text: string): PrDraft | undefined {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return undefined;
  const parsed = JSON.parse(json) as Partial<PrDraft>;
  if (!parsed.title?.trim() || !parsed.body?.trim()) return undefined;
  return { title: parsed.title.trim().slice(0, 140), body: parsed.body.trim() };
}

async function generateDraftWithCheapModel(
  ctx: ExtensionCommandContext,
  repo: string,
  changedFiles: string[],
  stat: string,
  branch: string,
  planContext: string[],
): Promise<PrDraft | undefined> {
  const model = ctx.modelRegistry.find(CHEAP_PROVIDER, CHEAP_MODEL);
  if (!model) {
    ctx.ui.notify(
      `/pr: cheap model ${CHEAP_PROVIDER}/${CHEAP_MODEL} not found; using fallback draft`,
      "warning",
    );
    return undefined;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify(
      `/pr: no auth for ${CHEAP_PROVIDER}/${CHEAP_MODEL}; using fallback draft`,
      "warning",
    );
    return undefined;
  }
  ctx.ui.notify(
    `/pr: drafting title/body with ${CHEAP_PROVIDER}/${CHEAP_MODEL}`,
    "info",
  );
  const prompt = [
    "Write a concise Git commit/PR title and body for a reviewer.",
    'Return ONLY JSON: {"title": string, "body": string}.',
    "Body format must be short, with sections: What, Why, How.",
    "Use 1-3 bullets per section. Do not write an article. Do not invent details not supported by input.",
    "",
    `Repo: ${basename(repo)}`,
    `Branch: ${branch || "unknown"}`,
    "",
    "Plan context:",
    planContext.length > 0
      ? planContext.map((line) => `- ${line}`).join("\n")
      : "- none recorded",
    "",
    "Changed files:",
    changedFiles
      .slice(0, 30)
      .map((file) => `- ${file}`)
      .join("\n"),
    "",
    "Diffstat:",
    stat || "none",
  ].join("\n");
  const response = await complete(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "minimal" },
  );
  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  try {
    return parseDraft(text);
  } catch {
    ctx.ui.notify(
      "/pr: cheap model returned invalid draft JSON; using fallback draft",
      "warning",
    );
    return undefined;
  }
}

async function commitIfDirty(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repo: string,
) {
  const dirty = await git(pi, repo, "status --porcelain");
  if (!dirty.stdout) return true;
  const changedFiles = dirty.stdout.split("\n").filter(Boolean);
  const ok = await ctx.ui.confirm(
    "Commit changes?",
    `Commit ${changedFiles.length} changed files in ${repo}?`,
  );
  if (!ok) return false;
  const stat = await git(pi, repo, "diff --stat");
  const branch = await git(pi, repo, "branch --show-current");
  const planContext = latestPlanContext(ctx);
  const fallback = deterministicDraft(
    repo,
    changedFiles,
    stat.stdout,
    branch.stdout,
    planContext,
  );
  const draft =
    (await generateDraftWithCheapModel(
      ctx,
      repo,
      changedFiles,
      stat.stdout,
      branch.stdout,
      planContext,
    )) || fallback;
  await git(pi, repo, "add -A");
  const commit = await git(
    pi,
    repo,
    `commit -m ${sh(draft.title)} -m ${sh(draft.body)}`,
    120_000,
  );
  if (commit.code !== 0) {
    ctx.ui.notify(`/pr: commit failed\n${commit.output}`, "error");
    return false;
  }
  return true;
}

async function rebaseFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repo: string,
  branch: string,
  base: string,
  args: Args,
) {
  const fetch = await git(pi, repo, "fetch --prune", 120_000);
  if (fetch.code !== 0) throw new Error(`fetch failed\n${fetch.output}`);
  const counts = await git(
    pi,
    repo,
    `rev-list --left-right --count origin/${base}...HEAD`,
  );
  const oldPr = await exec(
    pi,
    `cd ${sh(repo)} && gh pr list --head ${sh(branch)} --state merged --json number,url,state --jq '.[0] | select(.) | "#" + (.number|tostring) + " " + .state + " " + .url'`,
    20_000,
  );
  const summary = `Repo: ${repo}\nBranch: ${branch}\nBase: origin/${base}\nDivergence base...HEAD: ${counts.stdout || "unknown"}\nMerged PR: ${oldPr.stdout || "none detected"}\n\nWill run: git rebase origin/${base}`;
  const ok = await ctx.ui.confirm("Rebase branch?", summary);
  if (!ok) return false;
  const rebase = await git(pi, repo, `rebase origin/${base}`, 300_000);
  if (rebase.code !== 0) {
    const status = await git(pi, repo, "status --porcelain");
    ctx.ui.notify(
      `/pr: rebase stopped/conflicted in ${repo}\n${status.stdout}\nResolve then: git -C ${repo} rebase --continue\nOr abort: git -C ${repo} rebase --abort`,
      "error",
    );
    return false;
  }
  if (args.noForce) {
    ctx.ui.notify(
      "/pr: rebase complete; --no-force set, not pushing",
      "success",
    );
    return true;
  }
  const pushOk = await ctx.ui.confirm(
    "Force push?",
    `Will run safe force push:\ngit -C ${repo} push --force-with-lease`,
  );
  if (!pushOk) return false;
  const push = await git(pi, repo, "push --force-with-lease", 120_000);
  if (push.code !== 0)
    throw new Error(`force-with-lease failed\n${push.output}`);
  return true;
}

async function createOrShowPr(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repo: string,
  branch: string,
  base: string,
) {
  const open = await exec(
    pi,
    `cd ${sh(repo)} && gh pr view --json url,state --jq 'select(.state == "OPEN") | .url'`,
    20_000,
  );
  if (open.code === 0 && open.stdout) {
    ctx.ui.notify(`/pr: open PR exists: ${open.stdout}`, "success");
    return;
  }
  const push = await git(pi, repo, "push -u origin HEAD", 120_000);
  if (push.code !== 0) throw new Error(`push failed\n${push.output}`);
  const pr = await exec(
    pi,
    `cd ${sh(repo)} && gh pr create --base ${sh(base)} --head ${sh(branch)} --fill`,
    60_000,
  );
  if (pr.code !== 0) throw new Error(`PR create failed\n${pr.output}`);
  ctx.ui.notify(`/pr: created PR ${pr.stdout}`, "success");
}

export default function prExtension(pi: ExtensionAPI) {
  pi.registerCommand("pr", {
    description:
      "Commit, optionally rebase safely, push, and create/show GitHub PRs for changed repo(s)",
    handler: async (rawArgs, ctx) => {
      await ctx.waitForIdle();
      const args = parseArgs(rawArgs || "");
      if (args.help) {
        ctx.ui.notify(helpText(), "info");
        return;
      }
      const repos = await chooseRepos(pi, ctx);
      if (repos.length === 0) return;
      let succeeded = 0;
      const failed: string[] = [];
      for (const repo of repos) {
        ctx.ui.notify(`/pr: processing ${repo.name}`, "info");
        try {
          const base = await detectBase(pi, repo.path);
          const branch = await ensureBranchSafe(pi, ctx, repo.path, base);
          if (!branch) {
            failed.push(repo.name);
            continue;
          }
          if (!(await commitIfDirty(pi, ctx, repo.path))) {
            failed.push(repo.name);
            continue;
          }
          if (args.rebase) {
            const ok = await rebaseFlow(pi, ctx, repo.path, branch, base, args);
            if (!ok) {
              failed.push(repo.name);
              continue;
            }
          }
          if (!args.rebaseOnly)
            await createOrShowPr(pi, ctx, repo.path, branch, base);
          succeeded += 1;
        } catch (error) {
          failed.push(repo.name);
          ctx.ui.notify(
            `/pr failed for ${repo.name}: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      }
      ctx.ui.notify(
        `/pr: completed ${succeeded}/${repos.length} repo(s)${failed.length > 0 ? `; failed/skipped: ${failed.join(", ")}` : ""}`,
        failed.length > 0 ? "warning" : "success",
      );
    },
  });
}
