import cv2
import numpy as np
import tensorflow as tf
import os
import sys
import json

# --- 1. INITIALIZE ONCE ---
print("📥 [PYTHON] Initializing AI Engine...", file=sys.stderr)
MODEL_PATH = os.path.join(os.path.dirname(__file__), "output_model.tflite")
interpreter = tf.lite.Interpreter(model_path=MODEL_PATH)
interpreter.allocate_tensors()

# Load Face Detector (for cropping)
face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

input_details = interpreter.get_input_details()
output_details = interpreter.get_output_details()
print("✅ [PYTHON] AI Engine Ready", file=sys.stderr)

def get_embedding(image_path):
    try:
        img = cv2.imread(image_path)
        if img is None:
            return {"error": "Could not read image file"}
        
        # 🛡️ FIX 1: Detect and Crop Face (Remove Background)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(gray, 1.1, 4)
        
        if len(faces) > 0:
            # Sort by size and take the largest face
            faces = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)
            (x, y, w, h) = faces[0]
            # Add a small 10% margin around the face for better MobileFaceNet accuracy
            margin = int(w * 0.1)
            img = img[max(0, y-margin):min(img.shape[0], y+h+margin), 
                      max(0, x-margin):min(img.shape[1], x+w+margin)]
        else:
            return {"error": "No face detected in photo"}

        # 🛡️ FIX 2: Lighting Normalization (CLAHE)
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        cl = clahe.apply(l)
        limg = cv2.merge((cl, a, b))
        img = cv2.cvtColor(limg, cv2.COLOR_LAB2RGB) 
        
        img = cv2.resize(img, (112, 112))

        # Standard MobileFaceNet Pre-processing (-1 to 1)
        img = (img.astype(np.float32) - 127.5) / 127.5
        input_data = np.expand_dims(img, axis=0)

        interpreter.set_tensor(input_details[0]['index'], input_data)
        interpreter.invoke()

        embedding = interpreter.get_tensor(output_details[0]['index'])[0]
        
        # 🛡️ FIX 3: L2 Normalization (Make vector length = 1)
        norm = np.linalg.norm(embedding)
        if norm > 1e-6:
            embedding = embedding / norm
            
        return embedding.tolist()
    except Exception as e:
        return {"error": str(e)}

# --- 2. THE LIVE LOOP ---
# This keeps the script running so we don't have to reload the AI engine
if __name__ == "__main__":
    print("READY", flush=True) # Tell Node.js we are awake
    
    for line in sys.stdin:
        image_path = line.strip()
        if not image_path:
            continue
        
        if image_path == "EXIT":
            break

        result = get_embedding(image_path)
        print(json.dumps(result), flush=True)
