#!/usr/bin/env node
/**
 * Remove stale GitHub policy.json (+ optional policy.svg) that never completed purchase.
 * Matches dashboard logic: PENDING / PENDING_CONFIRMATION without purchased_at / nft_asset_id.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_... node scripts/cleanup-pending-policies.mjs           # dry-run (default)
 *   GITHUB_TOKEN=ghp_... node scripts/cleanup-pending-policies.mjs --execute
 *
 * Env:
 *   GITHUB_TOKEN     — required (repo contents read/write)
 *   GITHUB_REPO      — default: alienx5499/Zyura-Algorand-HackSeries3-MetaData
 *   GITHUB_BRANCH    — default: main
 *   NFT_METADATA_PREFIX — default: NFT/metadata
 *   MIN_AGE_MINUTES  — only delete drafts older than this (default: 1440 = 24h). Uses last git commit touching the file.
 */

const DRY_RUN = !process.argv.includes("--execute");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
const GITHUB_REPO =
  process.env.GITHUB_REPO?.trim() ||
  "alienx5499/Zyura-Algorand-HackSeries3-MetaData";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH?.trim() || "main";
const NFT_PREFIX = (
  process.env.NFT_METADATA_PREFIX || "NFT/metadata"
).replace(/\/$/, "");
const MIN_AGE_MS =
  (Number(process.env.MIN_AGE_MINUTES) || 1440) * 60 * 1000;

const headers = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

function norm(s) {
  return String(s)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

/** Same idea as frontend isUnconfirmedPolicyDraftMetadata */
function isUnconfirmedDraft(metadata) {
  if (!metadata || typeof metadata !== "object") return false;
  if (metadata.purchased_at != null || metadata.purchased_at_unix != null)
    return false;
  const nftId = metadata.nft_asset_id;
  if (nftId != null && String(nftId).trim() !== "") return false;

  const top = metadata.status;
  if (typeof top === "string") {
    const n = norm(top);
    if (n === "PENDING_CONFIRMATION" || n === "PENDING") return true;
  }
  const attrs = Array.isArray(metadata.attributes) ? metadata.attributes : [];
  for (const a of attrs) {
    if (a?.trait_type !== "Status" || typeof a.value !== "string") continue;
    const v = norm(a.value);
    if (v.includes("PENDING") && !v.includes("ACTIVE")) return true;
  }
  return false;
}

async function getJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${url} ${t}`);
  }
  return res.json();
}

async function listPolicyJsonPaths() {
  const data = await getJson(
    `https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`,
  );
  const tree = data.tree || [];
  return tree
    .filter(
      (t) =>
        t.type === "blob" &&
        t.path.startsWith(`${NFT_PREFIX}/`) &&
        t.path.endsWith("/policy.json"),
    )
    .map((t) => t.path);
}

function contentsUrl(path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodedPath}`;
}

async function getFileContent(path) {
  const url = `${contentsUrl(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const res = await fetch(url, {
    headers,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${path} ${t}`);
  }
  const j = await res.json();
  if (!j.content || j.encoding !== "base64") return null;
  const text = Buffer.from(j.content, "base64").toString("utf8");
  return { sha: j.sha, text };
}

async function lastCommitDateMs(path) {
  const u = new URL(
    `https://api.github.com/repos/${GITHUB_REPO}/commits`,
  );
  u.searchParams.set("path", path);
  u.searchParams.set("sha", GITHUB_BRANCH);
  u.searchParams.set("per_page", "1");
  const res = await fetch(u.toString(), { headers });
  if (!res.ok) return null;
  const arr = await res.json();
  const d = arr[0]?.commit?.committer?.date || arr[0]?.commit?.author?.date;
  if (!d) return null;
  return new Date(d).getTime();
}

async function deletePath(path, sha) {
  const url = contentsUrl(path);
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `chore: remove stale draft policy metadata (${path})`,
      sha,
      branch: GITHUB_BRANCH,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DELETE ${path}: ${res.status} ${t}`);
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!GITHUB_TOKEN) {
    console.error("Set GITHUB_TOKEN (fine-grained or classic with repo contents).");
    process.exit(1);
  }

  console.log(`Repo: ${GITHUB_REPO} @ ${GITHUB_BRANCH}`);
  console.log(`Prefix: ${NFT_PREFIX}/`);
  console.log(`Min age: ${MIN_AGE_MS / 60000} minutes since last commit to file`);
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN (pass --execute to delete)" : "DELETE"}\n`);

  const paths = await listPolicyJsonPaths();
  console.log(`Found ${paths.length} policy.json files under ${NFT_PREFIX}/\n`);

  let draftRows = 0;
  let eligible = 0;
  let deleted = 0;
  let skippedYoung = 0;
  let skippedNotDraft = 0;

  for (const jsonPath of paths) {
    await sleep(80);
    let content;
    try {
      content = await getFileContent(jsonPath);
    } catch (e) {
      console.warn(`  Skip (read error): ${jsonPath}`, e.message);
      continue;
    }
    if (!content) continue;

    let meta;
    try {
      meta = JSON.parse(content.text);
    } catch {
      console.warn(`  Skip (invalid JSON): ${jsonPath}`);
      continue;
    }

    if (!isUnconfirmedDraft(meta)) {
      skippedNotDraft++;
      continue;
    }

    draftRows++;
    const lastMs = await lastCommitDateMs(jsonPath);
    await sleep(80);
    if (lastMs == null) {
      console.warn(`  Skip (no commit date): ${jsonPath}`);
      continue;
    }
    const ageMs = Date.now() - lastMs;
    if (ageMs < MIN_AGE_MS) {
      skippedYoung++;
      console.log(
        `  Too new (${Math.round(ageMs / 60000)}m < ${MIN_AGE_MS / 60000}m): ${jsonPath}`,
      );
      continue;
    }

    eligible++;
    const svgPath = jsonPath.replace(/\/policy\.json$/, "/policy.svg");
    const svgFile = await getFileContent(svgPath).catch(() => null);
    await sleep(80);

    console.log(
      `  ${DRY_RUN ? "[dry-run] would delete" : "Deleting"} draft ${jsonPath} (policy_id=${meta.policy_id ?? "?"})`,
    );

    if (!DRY_RUN) {
      await deletePath(jsonPath, content.sha);
      await sleep(120);
      if (svgFile?.sha) {
        await deletePath(svgPath, svgFile.sha);
        await sleep(120);
      }
      deleted++;
    } else {
      deleted++;
    }
  }

  console.log(`\nDone. Unconfirmed drafts seen: ${draftRows}, past min-age: ${eligible}`);
  console.log(`  Not draft: ${skippedNotDraft}, Too new: ${skippedYoung}`);
  if (DRY_RUN) {
    console.log(`  Would remove (count): ${deleted} (re-run with --execute)`);
  } else {
    console.log(`  Removed policy pairs: ${deleted}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
