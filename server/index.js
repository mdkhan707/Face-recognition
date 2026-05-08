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

// Configure Multer to save uploaded photos temporarily
const upload = multer({ dest: "uploads/" });

// Middleware
app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "auth",
  password: "Daniyal@2004",
  port: 5432,
});

// Test DB Connection
pool.query("SELECT NOW()", (err, res) => {
  if (err) {
    console.error("❌ Database Connection Error:", err);
  } else {
    console.log("✅ Connected to PostgreSQL");
  }
});

let pythonProcess = null;
let requestQueue = [];
let isProcessingAI = false;

/**
 * Starts the Persistent Python AI Engine
 */
function startPythonAI() {
  const pythonPath = path.join(__dirname, "venv", "bin", "python3");
  const scriptPath = path.join(__dirname, "recognize.py");

  console.log("📥 [AI] Waking up the Python Brain...");

  pythonProcess = spawn(pythonPath, [scriptPath], {
    env: { ...process.env, TF_CPP_MIN_LOG_LEVEL: "3" },
  });

  pythonProcess.stdout.on("data", (data) => {
    const output = data.toString().trim();
    
    if (output === "READY") {
      console.log("🚀 [AI] Python Brain is Warm & Ready!");
      processNextInQueue();
      return;
    }

    // Hand the result to the waiting request
    if (requestQueue.length > 0) {
      const { resolve, reject, startTime } = requestQueue.shift();
      const duration = Date.now() - startTime;
      console.log(`⏱️ [AI] Python finished in ${duration}ms`);

      try {
        const embedding = JSON.parse(output);
        if (embedding.error) {
          reject(new Error(embedding.error));
        } else {
          // 🛡️ Print the real Face DNA (128 numbers)
          console.log(`🧬 [BIOMETRIC DNA] Generated 128-dim vector:`);
          console.log(JSON.stringify(embedding)); 
          resolve(embedding);
        }
      } catch (e) {
        reject(new Error("AI output parse error"));
      }
    }
    
    isProcessingAI = false;
    processNextInQueue();
  });

  pythonProcess.stderr.on("data", (data) => {
    const msg = data.toString();
    if (!msg.includes("I tensorflow") && !msg.includes("delegate")) {
      console.warn(`⚠️ [PYTHON] ${msg}`);
    }
  });

  pythonProcess.on("close", (code) => {
    console.error(`💀 [AI] Python Brain died (Code: ${code}). Restarting...`);
    pythonProcess = null;
    setTimeout(startPythonAI, 2000);
  });
}

function processNextInQueue() {
  if (isProcessingAI || requestQueue.length === 0 || !pythonProcess) return;
  
  isProcessingAI = true;
  const { imagePath } = requestQueue[0];
  pythonProcess.stdin.write(imagePath + "\n");
}

startPythonAI();

/**
 * The New High-Speed Python Bridge
 */
async function getEmbeddingFromImage(imagePath) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ imagePath, resolve, reject, startTime: Date.now() });
    processNextInQueue();
  });
}

// 1. ENROLL Endpoint: Receives Name and 3 Photos (Front, Left, Right)
app.post("/enroll", upload.array("images", 3), async (req, res) => {
  try {
    const { name } = req.body;
    const files = req.files;

    if (!name || !files || files.length === 0) {
      return res.status(400).json({ success: false, message: "Missing name or images" });
    }

    console.log(`📸 [ENROLL] Processing ${files.length} angles for: ${name}`);

    for (const file of files) {
      const imagePath = file.path;
      // A) Get 128-D embedding from each angle
      const embedding = await getEmbeddingFromImage(imagePath);
      const vectorStr = `[${embedding.join(",")}]`;

      // B) Save to DB (Multiple rows for the same name)
      await pool.query("INSERT INTO emp (name, embedding) VALUES ($1, $2)", [name, vectorStr]);

      // C) Clean up the temp file
      fs.unlinkSync(imagePath);
    }

    res.json({
      success: true,
      message: `Employee ${name} enrolled with ${files.length} angles!`,
    });
  } catch (error) {
    console.error("❌ Enrollment Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. AUTHENTICATE Endpoint: Receives a Photo, returns Name
app.post("/authenticate", upload.single("image"), async (req, res) => {
  try {
    const imagePath = req.file.path;

    if (!imagePath) {
      return res.status(400).json({ success: false, message: "No image received" });
    }

    console.log("📸 [AUTH] Identifying face from scan...");

    // A) Get 128-D embedding from the image file
    const embedding = await getEmbeddingFromImage(imagePath);
    const vectorStr = `[${embedding.join(",")}]`;

    // B) Search DB for closest match
    const query = `
      SELECT name, embedding <-> $1 as distance 
      FROM emp x
      ORDER BY distance ASC 
      LIMIT 1
    `;
    const result = await pool.query(query, [vectorStr]);

    // C) Clean up temp file
    fs.unlinkSync(imagePath);

    if (result.rows.length > 0) {
      const match = result.rows[0];
      const threshold = 0.60;

      console.log(`🎯 [AUTH] Best match: ${match.name} (Distance: ${match.distance.toFixed(4)})`);
      console.log(`🔍 [AUTH] Attempt distance: ${match.distance.toFixed(4)}`);

      if (match.distance < threshold) {
        res.json({
          success: true,
          name: match.name,
          distance: match.distance,
          message: "Access Granted",
        });
      } else {
        res.json({ success: false, message: `Access Denied: Match too far (${match.distance.toFixed(4)})` });
      }
    } else {
      res.json({ success: false, message: "No employees in database" });
    }
  } catch (error) {
    console.error("❌ Auth Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 AI Face Server running at http://localhost:${port}`);
});
