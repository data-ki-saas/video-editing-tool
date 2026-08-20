const http = require("http");
const crypto = require("crypto");
const { S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3001;

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const TRANSFER_MAX_ATTEMPTS = 3;
const TRANSFER_RETRY_DELAY_MS = 3000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Streams a finished render from Creatomate's (temporary) hosted URL into
 * R2, then flips the owning project to 'completed' with the permanent,
 * Cloudflare-fronted URL. The download and upload are both streamed --
 * never buffered whole in memory -- since these are video files, not JSON. */
async function transferRenderToR2({ projectId, renderId, sourceUrl }) {
  const key = `renders/${projectId}/${renderId}.mp4`;

  const sourceResponse = await fetch(sourceUrl);
  if (!sourceResponse.ok || !sourceResponse.body) {
    throw new Error(`Failed to download render from Creatomate: HTTP ${sourceResponse.status}`);
  }

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: process.env.R2_RENDERS_BUCKET_NAME,
      Key: key,
      Body: sourceResponse.body,
      ContentType: "video/mp4",
    },
    queueSize: 4,
    partSize: 10 * 1024 * 1024, // 10 MiB parts -- required minimum for multipart uploads
  });

  await upload.done();

  const finalUrl = `${process.env.R2_RENDERS_PUBLIC_URL.replace(/\/$/, "")}/${key}`;

  // Matched by (id, render_id) together -- same reasoning as the webhook
  // route: render_id alone would already be enough, but this stays correct
  // even if render_id were ever reused or forged.
  const { data, error } = await supabase
    .from("projects")
    .update({ render_status: "completed", render_url: finalUrl })
    .eq("id", projectId)
    .eq("render_id", renderId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to save final render URL: ${error.message}`);
  }
  if (!data) {
    throw new Error(`No project matched id=${projectId} render_id=${renderId} after upload`);
  }

  return finalUrl;
}

/** Retries transient failures (a network blip downloading from Creatomate, a
 * momentary R2 hiccup) a few times before giving up -- each attempt redoes
 * the whole download+upload from scratch, which is fine for the render sizes
 * this app deals with. This does NOT cover the process crashing/redeploying
 * mid-transfer (there's no request left to retry from at that point) -- see
 * the "known limitation" comment on the 202 ack below for that gap. */
async function transferRenderToR2WithRetry(job) {
  let lastError;
  for (let attempt = 1; attempt <= TRANSFER_MAX_ATTEMPTS; attempt++) {
    try {
      return await transferRenderToR2(job);
    } catch (err) {
      lastError = err;
      console.error(`[worker] transfer attempt ${attempt}/${TRANSFER_MAX_ATTEMPTS} failed for render ${job.renderId}`, err);
      if (attempt < TRANSFER_MAX_ATTEMPTS) await delay(TRANSFER_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

/** Marks a render 'failed' with a specific, elaborated reason once retries
 * are exhausted -- without this, a persistent failure (bad R2 token, renders
 * bucket misconfigured, Creatomate's temporary URL already expired) left
 * render_status stuck at 'succeeded' forever: a terminal-looking status per
 * the frontend's TERMINAL_RENDER_STATUSES, but never actually reached, so
 * the UI just polled in place with no explanation. */
async function markRenderFailed(projectId, renderId, err) {
  const reason = err instanceof Error ? err.message : String(err);
  const message = `Failed to move the finished render into permanent storage after ${TRANSFER_MAX_ATTEMPTS} attempts: ${reason}`;
  console.error(`[worker] marking render ${renderId} failed:`, message);

  const { error } = await supabase
    .from("projects")
    .update({ render_status: "failed", render_error: message })
    .eq("id", projectId)
    .eq("render_id", renderId);
  if (error) {
    console.error(`[worker] failed to record transfer failure for render ${renderId}`, error);
  }
}

function isAuthorized(req) {
  const expected = process.env.WORKER_INTERNAL_SECRET;
  const provided = req.headers["x-internal-secret"];
  if (!expected || typeof provided !== "string") return false;

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }

  if (req.method !== "POST" || req.url !== "/transfer") {
    res.writeHead(404).end();
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401).end();
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    res.writeHead(400).end("invalid JSON body");
    return;
  }

  const { projectId, renderId, sourceUrl } = payload || {};
  if (!projectId || !renderId || !sourceUrl) {
    res.writeHead(400).end("projectId, renderId, and sourceUrl are required");
    return;
  }

  // Acknowledge immediately -- the transfer can take a while for a large
  // video, and the caller (the webhook route) already isn't waiting on this
  // response either. Known limitation of this "basic" version: a crash or
  // deploy between acknowledging and finishing loses the transfer silently,
  // with no retry -- transferRenderToR2WithRetry only covers failures within
  // a single still-running request. A production version should use a
  // durable queue instead of a single in-memory HTTP request.
  res.writeHead(202).end();

  try {
    const finalUrl = await transferRenderToR2WithRetry({ projectId, renderId, sourceUrl });
    console.log(`[worker] transferred render ${renderId} -> ${finalUrl}`);
  } catch (err) {
    console.error(`[worker] transfer failed for render ${renderId} after ${TRANSFER_MAX_ATTEMPTS} attempts`, err);
    await markRenderFailed(projectId, renderId, err);
  }
});

server.listen(PORT, () => console.log(`[worker] listening on :${PORT}`));
