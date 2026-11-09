import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { monitoringFixture } from "../backend/test-support/monitoring-fixture.mjs";

// Local browser test server only; no CDP/browser automation here.
const root = resolve(import.meta.dirname, "..");
const channelCount = Number(process.env.MONITORING_QA_CHANNELS || 128);
const allOnline = process.env.MONITORING_QA_ALL_ONLINE === "1";
const ttlMinutes = Number(process.env.MONITORING_QA_TTL_MINUTES || 15);
if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 480) throw Error("QA lifetime must be 1–480 minutes");
const output = join(root, allOnline ? ".tmp/monitoring-online-qa" : ".tmp/monitoring-qa");
await mkdir(output, { recursive: true });
const controlFile = join(output, "control.json"),
  statsFile = join(output, "stats.json");
await writeFile(controlFile, JSON.stringify({ channels: 0 }));
const delay = { channels: 0 };
function formalPlanSnapshot() {
  const db = new DatabaseSync(join(root, "data/platform.db"), {
    readOnly: true,
  });
  try {
    const plans = db.prepare("SELECT * FROM recording_plans ORDER BY id").all();
    return {
      count: plans.length,
      hash: createHash("sha256").update(JSON.stringify(plans)).digest("hex"),
    };
  } finally {
    db.close();
  }
}
const formalBefore = formalPlanSnapshot();
const samplePath = process.env.MONITORING_QA_SAMPLE;
const frontendDirectory = process.env.MONITORING_QA_FRONTEND;
if (frontendDirectory && !resolve(frontendDirectory).startsWith(join(root,".tmp") + "\\")) throw Error("QA frontend must be inside workspace .tmp");
if (samplePath && !resolve(samplePath).startsWith(join(root, ".tmp") + "\\"))
  throw Error("QA sample must be inside workspace .tmp");
const f = await monitoringFixture({
  port: 18091,
  delay,
  archiveSample: samplePath ? await readFile(samplePath) : null,
  frontendDirectory,
  channelCount,
  allOnline,
});
let stopping = false,
  ticking = false;
async function finish() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearTimeout(deadline);
  const report = {
    ...f.stats(),
    formalBefore,
    formalAfter: formalPlanSnapshot(),
    finished: true,
  };
  await writeFile(statsFile, JSON.stringify(report, null, 2));
  await f.close();
}
const timer = setInterval(async () => {
  if (ticking || stopping) return;
  ticking = true;
  try {
    const control = JSON.parse(await readFile(controlFile, "utf8"));
    delay.channels = Number(control.channels) || 0;
    if (control.stop) {
      await finish();
      return;
    }
    await writeFile(
      statsFile,
      JSON.stringify({ ...f.stats(), formalBefore, finished: false }, null, 2),
    );
  } finally {
    ticking = false;
  }
}, 500);
const deadline = setTimeout(() => void finish(), ttlMinutes * 60000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void finish());
console.log(
  JSON.stringify({
    base: f.base,
    username: "qa-monitor",
    simulated: true,
    channelCount,
    allOnline,
    ttlMinutes,
    formalPlanCount: formalBefore.count,
  }),
);
