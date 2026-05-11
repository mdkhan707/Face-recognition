import os
import sys
import json
import cv2
import numpy as np

print("📥 [PYTHON] Initializing AI Engine...", file=sys.stderr)

# Suppress TF logs
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'

from deepface import DeepFace

# ─────────────────────────────────────────────────────────────────────────────
# MODEL CHOICE: Facenet512
#
# Test results on real faces:
#   Same person  : 0.1074  (was 0.52 with old tflite model)
#   Different    : 0.7854  (was 0.58 with old tflite model)
#   Gap          : 0.68    (was 0.065 — 10x improvement)
#
# Preprocessing pipeline (same as old model, adapted for DeepFace):
#   1. EXIF rotation correction  — fixes sideways mobile photos
#   2. CLAHE lighting            — handles dark/uneven lighting
#   3. Sharpening                — helps blurry webcam/mobile frames
#   4. DeepFace.represent()      — detection + alignment + embedding (internal)
#   5. L2 normalization          — required for pgvector cosine distance
#
# NOT ported from old code (DeepFace handles these internally):
#   • Haar cascade detection
#   • Manual eye alignment
#   • Center crop fallback
#   • Rotation brute-force loop
#   • Manual resize & pixel normalization
# ─────────────────────────────────────────────────────────────────────────────

MODEL_NAME    = "Facenet512"
DETECTOR      = "opencv"   # fast, reliable — swap to "retinaface" for max accuracy
EMBEDDING_DIM = 512        # Facenet512 outputs 512-d vectors

# ── DEBUG MODE ────────────────────────────────────────────────────────────────
# Set DEBUG_SAVE = True to save the preprocessed image fed to DeepFace into /tmp/
# Useful to visually confirm preprocessing is working correctly.
DEBUG_SAVE = False
DEBUG_DIR  = "/tmp/facedebug"
if DEBUG_SAVE:
    os.makedirs(DEBUG_DIR, exist_ok=True)
# ─────────────────────────────────────────────────────────────────────────────


# ── PREPROCESSING HELPERS ─────────────────────────────────────────────────────

def exif_rotate(image_path):
    """
    Read image and apply EXIF orientation correction.
    Android/iOS front cameras often save JPEGs rotated 90° in the file.
    PIL's exif_transpose fixes this automatically.
    Falls back to raw cv2 read if PIL fails.
    """
    try:
        from PIL import Image, ImageOps
        pil_img = Image.open(image_path)
        pil_img = ImageOps.exif_transpose(pil_img)   # auto-rotate per EXIF tag
        img_bgr = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        print("✅ [PYTHON] EXIF rotation applied", file=sys.stderr)
        return img_bgr
    except Exception as e:
        print(f"⚠️  [PYTHON] PIL EXIF failed ({e}), using raw cv2 read", file=sys.stderr)
        return cv2.imread(image_path)


def apply_clahe(img_bgr):
    """
    CLAHE (Contrast Limited Adaptive Histogram Equalization) on the L channel.
    Improves faces in dark rooms, back-lit scenes, or uneven lighting.
    Operates in LAB colour space so only luminance is changed — colours stay natural.
    """
    lab        = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l, a, b    = cv2.split(lab)
    clahe      = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_eq       = clahe.apply(l)
    lab_merged = cv2.merge((l_eq, a, b))
    return cv2.cvtColor(lab_merged, cv2.COLOR_LAB2BGR)


def sharpen(img_bgr):
    """
    Unsharp-mask style sharpening kernel.
    Helps with blurry webcam frames or low-resolution mobile selfies.
    """
    kernel = np.array([
        [ 0, -1,  0],
        [-1,  5, -1],
        [ 0, -1,  0]
    ], dtype=np.float32)
    return cv2.filter2D(img_bgr, -1, kernel)


def preprocess(image_path):
    """
    Full preprocessing pipeline. Returns path to a temp file that
    DeepFace will read, so we don't touch DeepFace's internals.
    """
    # Step 1 — EXIF-aware read
    img = exif_rotate(image_path)
    if img is None:
        raise ValueError(f"Could not read image: {image_path}")

    # Step 2 — CLAHE lighting normalisation
    img = apply_clahe(img)

    # Step 3 — Sharpening
    img = sharpen(img)

    # Write preprocessed image to a temp path for DeepFace
    # Force .jpg extension — Multer saves files without extensions and
    # cv2.imwrite picks the encoder from the extension, so no extension = crash.
    base = os.path.splitext(os.path.basename(image_path))[0]
    tmp_path = f"/tmp/_preprocessed_{base}.jpg"
    cv2.imwrite(tmp_path, img)

    # DEBUG — save what DeepFace will receive
    if DEBUG_SAVE:
        import time
        ts         = int(time.time() * 1000)
        debug_path = os.path.join(DEBUG_DIR, f"{ts}_{os.path.basename(image_path)}_preprocessed.jpg")
        cv2.imwrite(debug_path, img)
        print(f"🔍 [DEBUG] Saved preprocessed input → {debug_path}", file=sys.stderr)

    return tmp_path


# ─────────────────────────────────────────────────────────────────────────────

# Warm up the model on startup so first real request isn't slow
print("🔥 [PYTHON] Warming up Facenet512...", file=sys.stderr)
try:
    _dummy      = np.zeros((160, 160, 3), dtype=np.uint8)
    _dummy_path = "/tmp/_warmup_face.jpg"
    cv2.imwrite(_dummy_path, _dummy)
    DeepFace.represent(
        img_path        = _dummy_path,
        model_name      = MODEL_NAME,
        detector_backend= DETECTOR,
        enforce_detection= False,
        align           = True,
    )
    os.remove(_dummy_path)
    print("✅ [PYTHON] AI Engine Ready", file=sys.stderr)
except Exception as e:
    print(f"⚠️  [PYTHON] Warmup warning (non-fatal): {e}", file=sys.stderr)
    print("✅ [PYTHON] AI Engine Ready", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────────────────

def get_embedding(image_path):
    tmp_path = None
    try:
        # ── Step 1–3: EXIF fix + CLAHE + Sharpen ─────────────────────────
        tmp_path = preprocess(image_path)

        # ── Step 4: DeepFace — detection + alignment + embedding ──────────
        # enforce_detection=False: if face detection fails, embeds full
        # image rather than crashing (same intent as old center-crop fallback)
        result = DeepFace.represent(
            img_path         = tmp_path,
            model_name       = MODEL_NAME,
            detector_backend = DETECTOR,
            enforce_detection= False,
            align            = True,
        )

        if not result:
            return {"error": "No face detected"}

        # Take the first (largest) detected face
        embedding = np.array(result[0]["embedding"], dtype=np.float32)

        # ── Step 5: L2-normalize for pgvector cosine distance ─────────────
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm

        return embedding.tolist()

    except Exception as e:
        return {"error": str(e)}

    finally:
        # Clean up temp preprocessed file
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("READY", flush=True)
    for line in sys.stdin:
        image_path = line.strip()
        if not image_path:
            continue
        if image_path == "EXIT":
            break
        result = get_embedding(image_path)
        print(json.dumps(result), flush=True)