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
  // with no retry. A production version should use a durable queue instead
  // of a single in-memory HTTP request.
  res.writeHead(202).end();

  try {
    const finalUrl = await transferRenderToR2({ projectId, renderId, sourceUrl });
    console.log(`[worker] transferred render ${renderId} -> ${finalUrl}`);
  } catch (err) {
    console.error(`[worker] transfer failed for render ${renderId}`, err);
  }
});

server.listen(PORT, () => console.log(`[worker] listening on :${PORT}`));
