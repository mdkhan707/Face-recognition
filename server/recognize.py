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

input_details = interpreter.get_input_details()
output_details = interpreter.get_output_details()
print("✅ [PYTHON] AI Engine Ready", file=sys.stderr)

def get_embedding(image_path):
    try:
        img = cv2.imread(image_path)
        if img is None:
            return {"error": "Could not read image file"}
        
        # Standard MobileFaceNet Pre-processing
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        img = cv2.resize(img, (112, 112))

        # Standard MobileFaceNet Pre-processing (-1 to 1)
        img = (img.astype(np.float32) - 127.5) / 127.5

        input_data = np.expand_dims(img, axis=0)

        interpreter.set_tensor(input_details[0]['index'], input_data)
        interpreter.invoke()

        embedding = interpreter.get_tensor(output_details[0]['index'])[0]
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
