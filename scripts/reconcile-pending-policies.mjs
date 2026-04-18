#!/usr/bin/env node
/**
 * If policy.json is still PENDING but the Zyura app already has pol_nft for that policy id,
 * update GitHub to ACTIVE + nft_asset_id (+ optional flight.json PNR row) — mirrors finalizePurchasedMetadata.
 *
 * Run before cleanup in CI so purchases that succeeded on-chain but missed the second upload self-heal.
 *
 * Usage:
 *   GITHUB_TOKEN=... ZYURA_APP_ID=... node scripts/reconcile-pending-policies.mjs
 *   ... --execute   # required to write (default is dry-run)
 *
 * Env: same token/repo/branch/prefix as cleanup; plus:
 *   FLIGHT_METADATA_PREFIX — default Flight/Metadata/flights (set empty to skip flight updates)
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
const FLIGHT_PREFIX_RAW = process.env.FLIGHT_METADATA_PREFIX;
const FLIGHT_PREFIX =
  FLIGHT_PREFIX_RAW === ""
    ? ""
    : (FLIGHT_PREFIX_RAW || "Flight/Metadata/flights").replace(/\/$/, "");

const ZYURA_APP_ID_RAW = (
  process.env.ZYURA_APP_ID ||
  process.env.NEXT_PUBLIC_ZYURA_APP_ID ||
  ""
).trim();
const ZYURA_APP_ID = ZYURA_APP_ID_RAW ? parseInt(ZYURA_APP_ID_RAW, 10) : 0;

const ALGOD_URL = (
  process.env.ALGOD_URL ||
  process.env.NEXT_PUBLIC_ALGOD_URL ||
  "https://testnet-api.algonode.cloud"
)
  .trim()
  .replace(/\/$/, "");

const ALGOD_TOKEN = (
  process.env.ALGOD_TOKEN ||
  process.env.NEXT_PUBLIC_ALGOD_TOKEN ||
  ""
).trim();

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

function encodeUint64BE(n) {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

function policyBoxName(prefix, policyIdStr) {
  const id = String(policyIdStr).trim();
  if (!/^\d+$/.test(id)) return null;
  return Buffer.concat([Buffer.from(prefix, "utf8"), encodeUint64BE(id)]);
}

/** @returns {Promise<number|null>} null = algod/box error */
async function fetchPolNftAssetId(appId, policyIdStr) {
  const name = policyBoxName("pol_nft", policyIdStr);
  if (!name) return null;
  const u = new URL(`${ALGOD_URL}/v2/applications/${appId}/box`);
  u.searchParams.set("name", `b64:${name.toString("base64")}`);
  try {
    const res = await fetch(u.toString(), {
      headers: ALGOD_TOKEN ? { "X-Algo-API-Token": ALGOD_TOKEN } : {},
    });
    if (res.status === 404) return 0;
    if (!res.ok) return null;
    const json = await res.json();
    const vb = json?.value;
    if (typeof vb !== "string" || !vb) return 0;
    const buf = Buffer.from(vb, "base64");
    if (buf.length < 8) return 0;
    const assetId = buf.readBigUInt64BE(0);
    return assetId > 0n ? Number(assetId) : 0;
  } catch {
    return null;
  }
}

function resolvePolicyId(meta, jsonPath) {
  const fromMeta = meta?.policy_id;
  if (fromMeta != null && String(fromMeta).trim() !== "") {
    return String(fromMeta).trim();
  }
  const m = jsonPath.match(/\/(\d+)\/policy\.json$/);
  return m ? m[1] : "";
}

function walletFromMetadataPath(jsonPath) {
  const prefix = `${NFT_PREFIX}/`;
  if (!jsonPath.startsWith(prefix) || !jsonPath.endsWith("/policy.json")) {
    return "";
  }
  const rest = jsonPath.slice(prefix.length, -"/policy.json".length);
  const parts = rest.split("/");
  if (parts.length !== 2) return "";
  const [wallet] = parts;
  if (!/^[A-Z2-7]{58}$/.test(wallet)) return "";
  return wallet;
}

function formatUsd(n) {
  const x = typeof n === "number" ? n : parseFloat(String(n)) || 0;
  return x.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function buildFinalizedMetadata(meta, nftAssetId, policyIdStr) {
  const purchasedIso = new Date().toISOString();
  const purchasedUnix = Math.floor(Date.now() / 1000);
  const productId = String(meta.product_id ?? "");
  const flightNumber = String(meta.flight ?? "");
  const departureIso = String(meta.departure ?? "");
  const premiumUsd = formatUsd(meta.premium_usd);
  const coverageUsd = formatUsd(meta.coverage_usd);
  const zyuraAppIdStr = String(
    meta.zyura_app_id || ZYURA_APP_ID_RAW || "",
  ).trim();
  const attrs = Array.isArray(meta.attributes)
    ? meta.attributes.map((a) =>
        a?.trait_type === "Status"
          ? { ...a, value: "ACTIVE" }
          : a,
      )
    : meta.attributes;

  return {
    ...meta,
    zyura_app_id: zyuraAppIdStr,
    status: "ACTIVE",
    nft_asset_id: nftAssetId,
    purchased_at: purchasedIso,
    purchased_at_unix: purchasedUnix,
    attributes: attrs,
    description: [
      `Flight delay cover - ${flightNumber}, departs ${departureIso}. Premium ${premiumUsd}, coverage ${coverageUsd}.`,
      `Policy ${policyIdStr} is ACTIVE; policy NFT ASA ${nftAssetId}. Purchased ${purchasedIso} (metadata reconciled from chain).`,
      `Policy id ${policyIdStr} (product ${productId}).`,
      "One wallet approval confirmed premium, policy registration, NFT delivery, link, and freeze in one atomic group.",
      `Authoritative status and payout flags live on-chain (Zyura app ${zyuraAppIdStr}, policy id ${policyIdStr}); this file mirrors that for display.`,
    ].join(" "),
  };
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
  const res = await fetch(url, { headers });
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

async function putFile(path, text, message) {
  const existing = await getFileContent(path);
  const body = {
    message,
    content: Buffer.from(text, "utf8").toString("base64"),
    branch: GITHUB_BRANCH,
  };
  if (existing?.sha) body.sha = existing.sha;
  const res = await fetch(contentsUrl(path), {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`PUT ${path}: ${res.status} ${t}`);
  }
}

async function maybeSyncFlightPnr({
  flightNumber,
  pnr,
  wallet,
  policyIdStr,
  rawPolicyJsonUrl,
}) {
  if (!FLIGHT_PREFIX || !flightNumber || !pnr || pnr === "N/A") return;
  const pnrU = String(pnr).trim().toUpperCase();
  const flightPath = `${FLIGHT_PREFIX}/${flightNumber}/flight.json`;
  let file;
  try {
    file = await getFileContent(flightPath);
  } catch {
    return;
  }
  if (!file) return;
  let data;
  try {
    data = JSON.parse(file.text);
  } catch {
    return;
  }
  const pnrs = Array.isArray(data.pnrs) ? data.pnrs : [];
  let changed = false;
  const next = pnrs.map((row) => {
    const rowPnr = String(row?.pnr ?? "").trim().toUpperCase();
    if (rowPnr !== pnrU) return row;

    const nextRow = { ...row };
    if (wallet && (nextRow.wallet === "NA" || !nextRow.wallet)) {
      nextRow.wallet = wallet;
      changed = true;
    }
    if (wallet && (nextRow.policyholder === "NA" || !nextRow.policyholder)) {
      nextRow.policyholder = wallet;
      changed = true;
    }
    const prevPid = nextRow.policyId;
    if (
      prevPid === "NA" ||
      prevPid === undefined ||
      (String(prevPid) !== policyIdStr && prevPid !== Number(policyIdStr))
    ) {
      nextRow.policyId = Number(policyIdStr);
      changed = true;
    }
    if (
      rawPolicyJsonUrl &&
      (nextRow.nft_metadata_url === "NA" || !nextRow.nft_metadata_url)
    ) {
      nextRow.nft_metadata_url = rawPolicyJsonUrl;
      changed = true;
    }
    nextRow.updated_at = Math.floor(Date.now() / 1000);
    return nextRow;
  });

  if (!changed) return;
  const out = { ...data, pnrs: next };
   const msg = `chore: sync flight PNR ${pnrU} with reconciled policy ${policyIdStr}`;
  if (DRY_RUN) {
    console.log(`  [dry-run] would update ${flightPath}`);
    return;
  }
  await putFile(flightPath, JSON.stringify(out, null, 2), msg);
  console.log(`  Updated flight record ${flightPath}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!GITHUB_TOKEN) {
    console.error("Set GITHUB_TOKEN.");
    process.exit(1);
  }
  if (!ZYURA_APP_ID || Number.isNaN(ZYURA_APP_ID)) {
    console.error("Set ZYURA_APP_ID or NEXT_PUBLIC_ZYURA_APP_ID.");
    process.exit(1);
  }

  console.log(`Repo: ${GITHUB_REPO} @ ${GITHUB_BRANCH}`);
  console.log(`Algod: ${ALGOD_URL} | App: ${ZYURA_APP_ID}`);
  console.log(`Flight prefix: ${FLIGHT_PREFIX || "(disabled)"}`);
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN" : "WRITE"}\n`);

  const paths = await listPolicyJsonPaths();
  let draftSeen = 0;
  let updated = 0;
  let skipped = 0;
  let chainErr = 0;

  for (const jsonPath of paths) {
    await sleep(60);
    let content;
    try {
      content = await getFileContent(jsonPath);
    } catch (e) {
      console.warn(`  Skip read ${jsonPath}:`, e.message);
      continue;
    }
    if (!content) continue;
    let meta;
    try {
      meta = JSON.parse(content.text);
    } catch {
      continue;
    }
    if (!isUnconfirmedDraft(meta)) {
      continue;
    }
    draftSeen++;
    const policyId = resolvePolicyId(meta, jsonPath);
    if (!policyId) {
      skipped++;
      continue;
    }
    await sleep(60);
    const nftId = await fetchPolNftAssetId(ZYURA_APP_ID, policyId);
    if (nftId === null) {
      chainErr++;
      console.warn(`  Algod error pol_nft policy_id=${policyId}`);
      continue;
    }
    if (!nftId) {
      skipped++;
      continue;
    }

    const finalized = buildFinalizedMetadata(meta, nftId, policyId);
    const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${jsonPath}`;
    const wallet = walletFromMetadataPath(jsonPath);

    console.log(
      `  ${DRY_RUN ? "[dry-run] would finalize" : "Finalizing"} ${jsonPath} → ACTIVE nft=${nftId}`,
    );

    if (!DRY_RUN) {
      await putFile(
        jsonPath,
        JSON.stringify(finalized, null, 2),
        `chore: reconcile policy ${policyId} metadata from chain (nft ${nftId})`,
      );
      await sleep(80);
    }

    await maybeSyncFlightPnr({
      flightNumber: String(meta.flight ?? "").trim(),
      pnr: String(meta.pnr ?? "").trim(),
      wallet,
      policyIdStr: policyId,
      rawPolicyJsonUrl: rawUrl,
    });

    updated++;
  }

  console.log(
    `\nDone. Pending drafts scanned: ${draftSeen}, reconciled: ${updated}, skipped (no pol_nft yet): ${skipped}, algod errors: ${chainErr}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
