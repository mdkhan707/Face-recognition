const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
require("dotenv").config();

const app = express();
const port = 3000;

const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "auth",
  password: "Daniyal@2004",
  port: 5432,
});

pool.query("SELECT NOW()", (err, res) => {
  if (err) {
    console.error("❌ [DB] Connection Error:", err);
  } else {
    console.log("✅ [DB] Connected to PostgreSQL");
  }
});

let pythonProcess = null;
let requestQueue = [];
let isProcessingAI = false;

// ─────────────────────────────────────────────────────────────────────────────
// PYTHON AI ENGINE
// ─────────────────────────────────────────────────────────────────────────────

const AI_TIMEOUT_MS = 30000; // 30s — if Python hangs, reject and unblock queue

function startPythonAI() {
  const pythonPath = path.join(__dirname, "venv", "bin", "python3");
  const scriptPath = path.join(__dirname, "recognize.py");

  console.log("📥 [AI] Starting Python Brain (Facenet512 + DeepFace)...");

  pythonProcess = spawn(pythonPath, [scriptPath], {
    env: { ...process.env, TF_CPP_MIN_LOG_LEVEL: "3" },
  });

  pythonProcess.stdout.on("data", (data) => {
    const output = data.toString().trim();

    if (output === "READY") {
      console.log("🚀 [AI] Python Brain is Warm & Ready! (Facenet512 512-dim)");
      processNextInQueue();
      return;
    }

    if (requestQueue.length > 0) {
      const { resolve, reject, startTime, timeoutId } = requestQueue.shift();

      // Clear the safety timeout — we got a response
      if (timeoutId) clearTimeout(timeoutId);

      const duration = Date.now() - startTime;

      try {
        const result = JSON.parse(output);

        if (result.error) {
          // ── Python returned a face/processing error ──────────────────
          console.warn(`⚠️  [AI] Embedding failed after ${duration}ms: ${result.error}`);
          reject(new Error(result.error));
        } else {
          // ── Success — got a 512-dim embedding ────────────────────────
          console.log(`🧬 [AI] 512-dim embedding generated in ${duration}ms`);
          resolve(result);
        }
      } catch (e) {
        // ── JSON parse failed — log the raw output to help debug ──────
        console.error(`❌ [AI] Failed to parse Python output after ${duration}ms`);
        console.error(`❌ [AI] Raw output was: "${output}"`);
        reject(new Error(`AI output parse error: ${e.message}`));
      }
    } else {
      console.warn("⚠️  [AI] Got output but no pending request in queue — ignoring");
    }

    isProcessingAI = false;
    processNextInQueue();
  });

  pythonProcess.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    // Filter out noisy TF/hardware logs
    if (
      msg.includes("I tensorflow") ||
      msg.includes("delegate") ||
      msg.includes("AVX") ||
      msg.includes("FMA")
    ) return;

    // Classify the message for cleaner logs
    if (msg.startsWith("✅")) {
      console.log(`[PYTHON] ${msg}`);
    } else if (msg.startsWith("⚠️")) {
      console.warn(`[PYTHON] ${msg}`);
    } else if (msg.startsWith("🔍")) {
      console.log(`[PYTHON] ${msg}`);           // debug saves
    } else if (msg.startsWith("🔥")) {
      console.log(`[PYTHON] ${msg}`);           // warmup
    } else if (msg.startsWith("📥")) {
      console.log(`[PYTHON] ${msg}`);           // init
    } else {
      console.warn(`[PYTHON] ${msg}`);
    }
  });

  pythonProcess.on("close", (code) => {
    console.error(`💀 [AI] Python Brain exited (code: ${code}). Restarting in 2s...`);

    // Reject all pending requests so clients don't hang
    while (requestQueue.length > 0) {
      const { reject, timeoutId } = requestQueue.shift();
      if (timeoutId) clearTimeout(timeoutId);
      reject(new Error("AI engine restarting — please retry"));
    }

    isProcessingAI = false;
    pythonProcess = null;
    setTimeout(startPythonAI, 2000);
  });
}

function processNextInQueue() {
  if (isProcessingAI || requestQueue.length === 0 || !pythonProcess) return;

  isProcessingAI = true;
  const { imagePath } = requestQueue[0];
  console.log(`📤 [AI] Sending image to Python: ${path.basename(imagePath)}`);
  pythonProcess.stdin.write(imagePath + "\n");
}

startPythonAI();

// ─────────────────────────────────────────────────────────────────────────────
// EMBEDDING BRIDGE — with timeout safety
// ─────────────────────────────────────────────────────────────────────────────

async function getEmbeddingFromImage(imagePath) {
  return new Promise((resolve, reject) => {
    // Safety timeout — if Python doesn't respond, unblock the queue
    const timeoutId = setTimeout(() => {
      // Remove this request from the front of the queue if it's still there
      const idx = requestQueue.findIndex(r => r.imagePath === imagePath);
      if (idx !== -1) requestQueue.splice(idx, 1);
      isProcessingAI = false;
      processNextInQueue();
      console.error(`❌ [AI] Timeout after ${AI_TIMEOUT_MS}ms for: ${path.basename(imagePath)}`);
      reject(new Error("AI engine timeout — face processing took too long"));
    }, AI_TIMEOUT_MS);

    requestQueue.push({ imagePath, resolve, reject, startTime: Date.now(), timeoutId });
    processNextInQueue();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — safe file cleanup
// ─────────────────────────────────────────────────────────────────────────────

function cleanupFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.warn(`⚠️  [CLEANUP] Could not delete temp file: ${filePath}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1 — ENROLL
// ─────────────────────────────────────────────────────────────────────────────

app.post("/enroll", upload.array("images", 5), async (req, res) => {
  const files = req.files || [];
  try {
    const { name } = req.body;

    if (!name || files.length === 0) {
      files.forEach(f => cleanupFile(f.path));
      return res.status(400).json({ success: false, message: "Missing name or images" });
    }

    console.log(`\n📸 [ENROLL] Starting enrollment for: "${name}" (${files.length} angles)`);

    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      console.log(`📐 [ENROLL] Processing angle ${idx + 1}/${files.length}...`);

      let embedding;
      try {
        embedding = await getEmbeddingFromImage(file.path);
      } catch (aiErr) {
        // AI engine error — clean up all remaining files and abort
        files.forEach(f => cleanupFile(f.path));
        console.error(`❌ [ENROLL] AI error on angle ${idx + 1}: ${aiErr.message}`);
        return res.status(500).json({
          success: false,
          message: `AI engine error on angle ${idx + 1}: ${aiErr.message}`
        });
      }

      // embedding is already the parsed array (resolve was called with result directly)
      // But if Python returned {error: ...}, getEmbeddingFromImage rejects — caught above.

      const vectorStr = `[${embedding.join(",")}]`;
      await pool.query("INSERT INTO emp (name, embedding) VALUES ($1, $2)", [name, vectorStr]);
      console.log(`✅ [ENROLL] Angle ${idx + 1} saved to DB for "${name}"`);

      cleanupFile(file.path);
    }

    console.log(`🎉 [ENROLL] "${name}" enrolled successfully with ${files.length} angles\n`);
    res.json({
      success: true,
      message: `Employee ${name} enrolled with ${files.length} angles!`,
    });

  } catch (error) {
    files.forEach(f => cleanupFile(f.path));
    console.error("❌ [ENROLL] Unexpected error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2 — AUTHENTICATE
// ─────────────────────────────────────────────────────────────────────────────

app.post("/authenticate", upload.single("image"), async (req, res) => {
  const imagePath = req.file?.path;
  try {
    if (!imagePath) {
      return res.status(400).json({ success: false, message: "No image received" });
    }

    console.log("\n🔍 [AUTH] Authentication request received");

    let embedding;
    try {
      embedding = await getEmbeddingFromImage(imagePath);
    } catch (aiErr) {
      cleanupFile(imagePath);
      console.warn(`⚠️  [AUTH] AI engine error: ${aiErr.message}`);
      return res.json({ success: false, message: aiErr.message });
    }

    const vectorStr = `[${embedding.join(",")}]`;
    const COSINE_THRESHOLD = 0.28; // Facenet512: same~0.10, diff~0.78, threshold midpoint

    const query = `
      SELECT name, MIN(embedding <=> $1::vector) AS best_distance
      FROM emp
      GROUP BY name
      ORDER BY best_distance ASC
      LIMIT 1
    `;
    const result = await pool.query(query, [vectorStr]);
    cleanupFile(imagePath);

    if (result.rows.length === 0) {
      console.warn("⚠️  [AUTH] No users enrolled in database");
      return res.json({
        success: false,
        message: "No users enrolled — please register first."
      });
    }

    const match = result.rows[0];
    const dist = parseFloat(match.best_distance).toFixed(4);
    const passed = match.best_distance < COSINE_THRESHOLD;

    if (passed) {
      console.log(`✅ [AUTH] GRANTED  — "${match.name}"  dist: ${dist}`);
      res.json({
        success: true,
        name: match.name,
        distance: match.best_distance,
        message: "Access Granted",
      });
    } else {
      console.log(`❌ [AUTH] DENIED   — best: "${match.name}"  dist: ${dist}`);
      res.json({
        success: false,
        message: `Access Denied (distance: ${dist},)`,
      });
    }

  } catch (error) {
    cleanupFile(imagePath);
    console.error("❌ [AUTH] Unexpected error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3 — DEBUG (shows distances to ALL enrolled users)
// ─────────────────────────────────────────────────────────────────────────────

app.post("/debug-distances", upload.single("image"), async (req, res) => {
  const imagePath = req.file?.path;
  try {
    if (!imagePath) {
      return res.status(400).json({ success: false, message: "No image received" });
    }

    console.log("\n🔬 [DEBUG] Running distance check against all users...");

    let embedding;
    try {
      embedding = await getEmbeddingFromImage(imagePath);
    } catch (aiErr) {
      cleanupFile(imagePath);
      return res.json({ success: false, message: aiErr.message });
    }

    const vectorStr = `[${embedding.join(",")}]`;

    const query = `
      SELECT name, MIN(embedding <=> $1::vector) AS best_distance
      FROM emp
      GROUP BY name
      ORDER BY best_distance ASC
    `;
    const result = await pool.query(query, [vectorStr]);
    cleanupFile(imagePath);

    console.log(`🔬 [DEBUG] Distances (threshold = 0.40):`);
    result.rows.forEach(row => {
      const dist = parseFloat(row.best_distance).toFixed(4);
      const verdict = row.best_distance < 0.40 ? "✅ MATCH" : "❌ NO MATCH";
      console.log(`       ${verdict}  "${row.name}"  →  ${dist}`);
    });

    res.json(result.rows);

  } catch (error) {
    cleanupFile(imagePath);
    console.error("❌ [DEBUG] Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(port, "0.0.0.0", () => {
  console.log(`\n🚀 AI Face Server running at http://localhost:${port}`);
  console.log(`   Model     : Facenet512 (512-dim)`);
  console.log(`   Threshold : 0.40  (same~0.10, diff~0.78)`);
  console.log(`   Database  : PostgreSQL / pgvector\n`);
});