import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import {
  Camera,
  runAsync,
  useCameraDevice,
  useFrameProcessor,
} from "react-native-vision-camera";
import {
  Face,
  useFaceDetector,
} from "react-native-vision-camera-face-detector";
import { useSharedValue, Worklets } from "react-native-worklets-core";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SERVER_URL = "http://192.168.4.69:3000";
const TARGET_BOX_SIZE = 320;
const TARGET_BOX_X = (SCREEN_WIDTH - TARGET_BOX_SIZE) / 2;
const TARGET_BOX_Y = (SCREEN_HEIGHT - TARGET_BOX_SIZE) / 2 - 50;

type ViewState = 'menu' | 'enrolling' | 'authenticating';

// --- SERVER-SIDE AI ARCHITECTURE ---
// The tablet now only handles "Detection" (Finding the face) and "Capture".
// "Recognition" (Identifying who it is) is offloaded to the server for 100% stability.

export default function HomeScreen() {
  const camera = useRef<Camera>(null);
  const device = useCameraDevice("front");

  const [hasPermission, setHasPermission] = useState(false);
  const [faces, setFaces] = useState<Face[]>([]);
  const [isFaceInBox, setIsFaceInBox] = useState(false);
  const [distanceStatus, setDistanceStatus] = useState<'ok' | 'far' | 'close'>('ok');
  const [authStatus, setAuthStatus] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  const [view, setView] = useState<ViewState>('menu');
  const [employeeName, setEmployeeName] = useState("");
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [showSnackbar, setShowSnackbar] = useState(false);
  const [snackbarType, setSnackbarType] = useState<'success' | 'error'>('success');
  const [canCapture, setCanCapture] = useState(false);

  const [enrollStep, setEnrollStep] = useState<'front' | 'left' | 'right' | 'idle'>('idle');
  const [enrollImages, setEnrollImages] = useState<string[]>([]);
  const [uiProgress, setUiProgress] = useState(0);
  const poseProgress = useSharedValue(0);
  const lastPoseValid = useSharedValue(Date.now());

  // --- STABILITY LOCKS ---
  const isCapturing = useSharedValue(false);
  const lastFaceX = useSharedValue(0);
  const lastFaceY = useSharedValue(0);

  const faceDetector = useFaceDetector({
    performanceMode: "fast",
    autoMode: true,
    windowWidth: SCREEN_WIDTH,
    windowHeight: SCREEN_HEIGHT,
  });

  // 3. Identification Workflow (Snapshot -> Server)
  const captureAndIdentify = async () => {
    if (isProcessing || !camera.current) return;

    setIsProcessing(true);
    setAuthStatus("HOLD STEADY...");

    try {
      // A) Take a high-quality snapshot
      console.log("📸 [SCAN] Capturing face image...");
      const photo = await camera.current.takeSnapshot({
        quality: 85,
      });

      if (view === 'enrolling') {
        const newImages = [...enrollImages, photo.path];
        setEnrollImages(newImages);

        if (enrollStep === 'front') {
          console.log("✅ [ENROLL] Front angle captured successfully!");
          setEnrollStep('left');
          setAuthStatus("GREAT! NOW TURN LEFT SLOWLY");
          setCanCapture(false);
          setIsProcessing(false); // Enable next phase
          lastPoseValid.value = Date.now(); // RESET TIMER FOR NEXT PHASE
          poseProgress.value = 0;
          updateUiProgress(0);
          setTimeout(() => setCanCapture(true), 2000);
          isCapturing.value = false;
          return;
        } else if (enrollStep === 'left') {
          console.log("✅ [ENROLL] Left angle captured successfully!");
          setEnrollStep('right');
          setAuthStatus("EXCELLENT! NOW TURN RIGHT SLOWLY");
          setCanCapture(false);
          setIsProcessing(false); // Enable next phase
          lastPoseValid.value = Date.now(); // RESET TIMER FOR NEXT PHASE
          poseProgress.value = 0;
          updateUiProgress(0);
          setTimeout(() => setCanCapture(true), 2000);
          isCapturing.value = false;
          return;
        } else {
          // Finished all 3
          console.log("✅ [ENROLL] Right angle captured. Finalizing enrollment...");
          setIsCameraOpen(false);
          setEnrollStep('idle');
          setAuthStatus("UPLOADING ALL ANGLES...");

          const formData = new FormData();
          formData.append('name', employeeName);
          newImages.forEach((path, idx) => {
            formData.append('images', {
              uri: Platform.OS === 'android' ? `file://${path}` : path,
              type: 'image/jpeg',
              name: `face_${idx}.jpg`,
            } as any);
          });

          const response = await fetch(`${SERVER_URL}/enroll`, {
            method: 'POST',
            body: formData,
            headers: { 'Accept': 'application/json', 'Content-Type': 'multipart/form-data' },
          });

          const data = await response.json();
          if (data.success) {
            setAuthStatus(`ENROLLED SUCCESSFULLY! ✅`);
            setSnackbarType('success');
            setShowSnackbar(true);
            setTimeout(() => { setView('menu'); setEmployeeName(""); setAuthStatus(""); setIsProcessing(false); setShowSnackbar(false); isCapturing.value = false; }, 3000);
          } else {
            setAuthStatus(data.message || "ENROLL FAILED ❌");
            setSnackbarType('error');
            setShowSnackbar(true);
            setIsProcessing(false);
            setTimeout(() => setShowSnackbar(false), 3000);
            isCapturing.value = false;
          }
          return;
        }
      }

      // --- AUTHENTICATION FLOW ---
      setIsCameraOpen(false);
      setAuthStatus("SENDING TO SERVER...");
      const formData = new FormData();
      formData.append('image', {
        uri: Platform.OS === 'android' ? `file://${photo.path}` : photo.path,
        type: 'image/jpeg',
        name: 'face_scan.jpg',
      } as any);

      console.log(`🌐 [SERVER] Uploading to /authenticate...`);
      let response;
      let attempts = 0;
      while (attempts < 3) {
        try {
          response = await fetch(`${SERVER_URL}/authenticate`, {
            method: 'POST',
            body: formData,
            headers: { 'Accept': 'application/json', 'Content-Type': 'multipart/form-data' },
          });
          if (response.ok) break;
        } catch (err) {
          attempts++;
          if (attempts >= 3) throw err;
          setAuthStatus(`RETRYING (${attempts})...`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (!response) return;
      const data = await response.json();
      console.log(`✅ [SERVER] Response: ${data.message}`);

      if (data.success) {
        setAuthStatus(`WELCOME: ${data.name} ✅`);
        setSnackbarType('success');
        setShowSnackbar(true);
        setTimeout(() => {
          setView('menu');
          setEmployeeName("");
          setAuthStatus("");
          setIsProcessing(false);
          setIsCameraOpen(false);
          setShowSnackbar(false);
          isCapturing.value = false; // UNLOCK
        }, 3000);
      } else {
        setAuthStatus(data.message || "SCAN FAILED ❌");
        setSnackbarType('error');
        setShowSnackbar(true);
        setIsProcessing(false);
        setIsCameraOpen(false);
        setTimeout(() => setShowSnackbar(false), 3000);
        isCapturing.value = false; // UNLOCK
      }
    } catch (error) {
      console.error("❌ [CAMERA] Error:", error);
      setAuthStatus("Camera/Network Error");
      setIsProcessing(false);
      isCapturing.value = false; // UNLOCK
    }
  };

  const triggerCapture = Worklets.createRunOnJS(captureAndIdentify);

  const updateUiProgress = Worklets.createRunOnJS((val: number) => {
    setUiProgress(val);
  });

  const onFacesDetected = Worklets.createRunOnJS((detectedFaces: Face[], inBox: boolean, dist: 'ok' | 'far' | 'close') => {
    setFaces(detectedFaces);
    setIsFaceInBox(inBox);
    setDistanceStatus(dist);
  });

  // 4. Real-time Frame Processing (Detection Only)
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    runAsync(frame, () => {
      'worklet';
      const scannedFaces = faceDetector.detectFaces(frame);

      // --- INITIAL BOX & DISTANCE CHECK ---
      let currentFaceInBox = false;
      let currentDist: 'ok' | 'far' | 'close' = 'ok';

      if (scannedFaces.length > 0) {
        const face = scannedFaces[0];
        const { x, y, width: w, height: h } = face.bounds;

        const centerX = x + w / 2;
        const centerY = y + h / 2;
        currentFaceInBox = centerX > TARGET_BOX_X && centerX < (TARGET_BOX_X + TARGET_BOX_SIZE) &&
          centerY > TARGET_BOX_Y && centerY < (TARGET_BOX_Y + TARGET_BOX_SIZE);

        const faceScale = w / TARGET_BOX_SIZE;
        if (faceScale < 0.45) currentDist = 'far';
        else if (faceScale > 0.80) currentDist = 'close';
        else currentDist = 'ok';
      }

      onFacesDetected(scannedFaces, currentFaceInBox, currentDist);

      // 1. Check if we are already capturing (The "Digital Lock")
      if (isCapturing.value) return;

      // 2. Only trigger if a face is present and we are in a scanning view
      if (
        scannedFaces.length > 0 &&
        !isProcessing &&
        canCapture &&
        view !== 'menu' &&
        isCameraOpen
      ) {
        const face = scannedFaces[0];
        const { x: faceX, y: faceY, width: faceW, height: faceH } = face.bounds;

        // 🛡️ A) Stillness Check (Prevents Blur)
        const movement = Math.abs(faceX - lastFaceX.value) + Math.abs(faceY - lastFaceY.value);
        const isStill = movement < 18; // Threshold for "Stillness" (More lenient)
        lastFaceX.value = faceX;
        lastFaceY.value = faceY;

        // 🛡️ B) Alignment Check (Looking Straight)
        const faceCenterX = faceX + faceW / 2;
        const faceCenterY = faceY + faceH / 2;
        const isInBox = faceCenterX > TARGET_BOX_X && faceCenterX < (TARGET_BOX_X + TARGET_BOX_SIZE) &&
          faceCenterY > TARGET_BOX_Y && faceCenterY < (TARGET_BOX_Y + TARGET_BOX_SIZE);

        let isAligned = false;
        if (view === 'enrolling') {
          if (enrollStep === 'front') isAligned = Math.abs(face.yawAngle || 0) < 15;
          else isAligned = Math.abs(face.yawAngle || 0) > 10;
        } else {
          isAligned = Math.abs(face.yawAngle || 0) < 15;
        }

        // 🛡️ C) Distance Check (Scale)
        const faceScale = faceW / TARGET_BOX_SIZE;
        const isDistanceValid = faceScale > 0.45 && faceScale < 0.80;

        // 🛡️ D) Final Security Gate
        const isPoseValid = isInBox && isAligned && isStill && isDistanceValid;

        if (isPoseValid) {
          const now = Date.now();
          const elapsed = now - lastPoseValid.value;
          const requiredTime = 2500; // 2.5s of perfect "Statue" pose

          poseProgress.value = Math.min(elapsed / requiredTime, 1);
          updateUiProgress(poseProgress.value);

          if (poseProgress.value >= 1) {
            isCapturing.value = true;
            poseProgress.value = 0;
            updateUiProgress(0);
            triggerCapture();
          }
        } else {
          // Reset timer if they move or look away
          lastPoseValid.value = Date.now();
          poseProgress.value = 0;
          updateUiProgress(0);
        }
      } else {
        poseProgress.value = 0;
        updateUiProgress(0);
      }
    });
  }, [view, isProcessing, isCameraOpen, canCapture, enrollStep]);

  useEffect(() => {
    (async () => {
      await Camera.requestCameraPermission();
      setHasPermission(true);
      console.log("✅ Camera System Ready");
    })();
  }, []);

  // --- UI ---
  const renderMainMenu = () => (
    <View style={styles.menuContainer}>
      <View style={styles.logoCircle}><Text style={styles.logoText}>👤</Text></View>
      <Text style={styles.title}>AI KIOSK</Text>
      <Text style={styles.subtitle}>Biometric Security System</Text>

      {view === 'authenticating' && isProcessing && (
        <View style={styles.processingStatus}>
          <ActivityIndicator color="#007AFF" />
          <Text style={styles.processingText}>Verifying Identity...</Text>
        </View>
      )}

      <View style={styles.buttonGroup}>
        <TouchableOpacity style={[styles.bigButton, { backgroundColor: '#007AFF', opacity: isProcessing ? 0.5 : 1 }]} disabled={isProcessing} onPress={() => {
          setView('authenticating');
          setIsCameraOpen(true);
          setCanCapture(false);
          setAuthStatus("");
          setTimeout(() => setCanCapture(true), 1500);
        }}>
          <Text style={styles.bigButtonText}>AUTHENTICATE</Text>
          <Text style={styles.buttonDesc}>Scan to verify identity</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.bigButton, { backgroundColor: '#34C759' }]} onPress={() => { setView('enrolling'); setIsCameraOpen(false); setAuthStatus(""); }}>
          <Text style={styles.bigButtonText}>ENROLL EMPLOYEE</Text>
          <Text style={styles.buttonDesc}>Register new face</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderEnrollForm = () => (
    <View style={styles.formContainer}>
      <Text style={styles.formTitle}>New Enrollment</Text>
      <View style={styles.inputWrapper}>
        <Text style={styles.inputLabel}>FULL NAME</Text>
        <TextInput style={styles.input} placeholder="e.g. Daniyal Khan" placeholderTextColor="#555" value={employeeName} onChangeText={setEmployeeName} autoFocus={true} editable={!isProcessing} />
      </View>

      {isProcessing && (
        <View style={styles.processingStatus}>
          <ActivityIndicator color="#007AFF" />
          <Text style={styles.processingText}>Processing Face...</Text>
        </View>
      )}

      {authStatus && !isCameraOpen && (
        <Text style={[styles.inlineStatus, { color: authStatus.includes("✅") ? "#34C759" : "#FF3B30" }]}>
          {authStatus}
        </Text>
      )}

      <TouchableOpacity
        style={[styles.bigButton, { backgroundColor: '#007AFF', opacity: (employeeName && !isProcessing) ? 1 : 0.5, marginTop: 20 }]}
        disabled={!employeeName || isProcessing}
        onPress={() => {
          setIsCameraOpen(true);
          setAuthStatus("");
          setEnrollStep('front');
          setEnrollImages([]);
          lastPoseValid.value = Date.now();
          poseProgress.value = 0;
          setUiProgress(0);
          setCanCapture(false);
          setTimeout(() => setCanCapture(true), 2000);
        }}
      >
        <Text style={styles.bigButtonText}>{isProcessing ? "PROCESSING..." : "START SCAN"}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => { setView('menu'); setEmployeeName(""); setAuthStatus(""); }} disabled={isProcessing}>
        <Text style={styles.backLink}>CANCEL</Text>
      </TouchableOpacity>
    </View>
  );


  if (!hasPermission) return <View style={styles.container}><Text style={styles.text}>No Permission</Text></View>;
  if (!device) return <View style={styles.container}><Text style={styles.text}>No Camera</Text></View>;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.container}>
      {view === 'menu' && renderMainMenu()}
      {view === 'authenticating' && !isCameraOpen && renderMainMenu()}
      {view === 'enrolling' && !isCameraOpen && renderEnrollForm()}
      {isCameraOpen && view !== 'menu' && (
        <>
          <Camera ref={camera} device={device} isActive={true} style={StyleSheet.absoluteFill} frameProcessor={frameProcessor} />
          <TouchableOpacity style={styles.closeButton} onPress={() => { setView('menu'); setAuthStatus(""); setIsProcessing(false); setIsCameraOpen(false); setEnrollStep('idle'); }}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>

          {/* TARGET BOX GUIDE */}
          <View style={[
            styles.targetBox,
            {
              borderColor: uiProgress > 0
                ? '#34C759' // GREEN: All good!
                : (faces.length > 0 && isFaceInBox)
                  ? '#FF8800' // ORANGE: Inside box but moving/misaligned
                  : '#FF3B30' // RED: No face OR outside box
            }
          ]}>
            {uiProgress > 0 && (
              <View style={[styles.progressBar, { width: `${uiProgress * 100}%` }]} />
            )}
          </View>

          <View style={styles.uiOverlay}>
            <Text style={styles.phaseLabel}>
              {view === 'enrolling' ? `PHASE: ${enrollStep.toUpperCase()}` : 'AUTHENTICATING'}
            </Text>
            {isProcessing && <ActivityIndicator color="#007AFF" style={{ marginBottom: 10 }} />}
            <Text style={[styles.statusText, { color: authStatus.includes("✅") ? "#00FF00" : "white" }]}>
              {authStatus || (
                !canCapture ? "READYING CAMERA..." :
                  faces.length === 0 ? "LOOK AT CAMERA" :
                    !isFaceInBox ? "CENTER YOUR FACE" :
                      distanceStatus === 'far' ? "PLEASE MOVE CLOSER" :
                        distanceStatus === 'close' ? "PLEASE MOVE BACK" :
                          "HOLD STILL..."
              )}
            </Text>
          </View>
        </>
      )}

      {showSnackbar && (
        <View style={[styles.snackbar, { backgroundColor: snackbarType === 'success' ? '#34C759' : '#FF3B30' }]}>
          <Text style={styles.snackbarText}>{authStatus}</Text>
        </View>
      )}
    </KeyboardAvoidingView>


  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0A0A" },
  menuContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  logoCircle: { width: 100, height: 100, borderRadius: 50, backgroundColor: '#1A1A1A', justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  logoText: { fontSize: 50 },
  title: { fontSize: 36, fontWeight: '900', color: 'white', letterSpacing: 4 },
  subtitle: { fontSize: 14, color: '#666', marginTop: 5, letterSpacing: 2, marginBottom: 60, textTransform: 'uppercase' },
  buttonGroup: { width: '100%', gap: 20 },
  bigButton: { width: '100%', paddingVertical: 25, borderRadius: 20, alignItems: 'center', elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10 },
  bigButtonText: { color: 'white', fontSize: 20, fontWeight: '800', letterSpacing: 1 },
  buttonDesc: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 4 },
  formContainer: { flex: 1, justifyContent: 'center', padding: 40 },
  formTitle: { fontSize: 28, fontWeight: 'bold', color: 'white', marginBottom: 40, textAlign: 'center' },
  inputWrapper: { marginBottom: 20 },
  inputLabel: { color: '#007AFF', fontSize: 12, fontWeight: 'bold', marginBottom: 8, marginLeft: 5 },
  input: { backgroundColor: '#1A1A1A', borderRadius: 15, padding: 20, color: 'white', fontSize: 20, borderWidth: 1, borderColor: '#333' },
  backLink: { color: '#666', textAlign: 'center', marginTop: 30, fontSize: 14, fontWeight: '600' },
  faceBox: { position: "absolute", borderWidth: 3, borderRadius: 20, borderStyle: "dashed" },
  uiOverlay: { position: "absolute", bottom: 80, backgroundColor: "rgba(0,0,0,0.95)", paddingVertical: 25, paddingHorizontal: 40, borderRadius: 40, alignSelf: "center", alignItems: "center", minWidth: SCREEN_WIDTH * 0.8, borderWidth: 1, borderColor: '#333' },
  statusText: { color: "white", fontSize: 22, fontWeight: '900', textAlign: "center", letterSpacing: 1 },
  closeButton: { position: 'absolute', top: 60, right: 30, width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', zIndex: 100, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  closeText: { color: 'white', fontSize: 28, fontWeight: '300' },
  text: { color: 'white', fontSize: 18, textAlign: 'center' },
  processingStatus: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 20, gap: 10 },
  processingText: { color: '#007AFF', fontSize: 16, fontWeight: '600' },
  inlineStatus: { textAlign: 'center', fontSize: 18, fontWeight: 'bold', marginBottom: 20 },
  snackbar: { position: 'absolute', bottom: 40, left: 20, right: 20, backgroundColor: '#34C759', padding: 20, borderRadius: 15, elevation: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10 },
  snackbarText: { color: 'white', fontSize: 16, fontWeight: 'bold', textAlign: 'center' },
  targetBox: { position: 'absolute', left: TARGET_BOX_X, top: TARGET_BOX_Y, width: TARGET_BOX_SIZE, height: TARGET_BOX_SIZE, borderWidth: 2, borderRadius: 30, backgroundColor: 'rgba(0,0,0,0.1)', justifyContent: 'flex-end' },
  progressBar: { position: 'absolute', bottom: -25, height: 8, backgroundColor: '#34C759', borderRadius: 4 },
  phaseLabel: { color: '#007AFF', fontWeight: 'bold', fontSize: 14, marginBottom: 5, letterSpacing: 2 }
});