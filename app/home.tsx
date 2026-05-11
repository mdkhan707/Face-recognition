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
  useFaceDetector
} from "react-native-vision-camera-face-detector";
import { useSharedValue, Worklets } from "react-native-worklets-core";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SERVER_URL = "http://192.168.4.132:3000";
const TARGET_BOX_SIZE = 320;
const TARGET_BOX_X = (SCREEN_WIDTH - TARGET_BOX_SIZE) / 2;
const TARGET_BOX_Y = (SCREEN_HEIGHT - TARGET_BOX_SIZE) / 2 - 50;

// ─────────────────────────────────────────────────────────────────────────────
// DISTANCE RANGES PER ANGLE
//
// Why different ranges per angle?
//   • front / left / right: standard range — face stays roughly same size
//   • up / down: when you tilt your head, your chin/forehead comes closer
//     to the camera. The face bounding box gets larger even without moving
//     your body. So we allow a wider max scale for these two poses.
//     If we kept 0.65 max, the user would have to step back while tilting
//     which is unnatural and confusing.
//
// Scale = face bounding box width / TARGET_BOX_SIZE (320px)
// ─────────────────────────────────────────────────────────────────────────────
const SCALE: Record<string, { min: number; max: number }> = {
  front: { min: 0.50, max: 0.65 },
  left: { min: 0.45, max: 0.70 }, // wider — profile view makes face appear narrower
  right: { min: 0.45, max: 0.70 },
  up: { min: 0.48, max: 0.75 }, // wider max — chin comes forward when tilting up
  down: { min: 0.48, max: 0.75 }, // wider max — forehead comes forward when tilting down
  auth: { min: 0.50, max: 0.65 }, // strict for authentication
};

// ─────────────────────────────────────────────────────────────────────────────
// TRAFFIC LIGHT STATES
// Each state maps to a border color AND a user message.
// This replaces the old boolean isFaceInBox + distanceStatus pair with a
// single unified state that covers all failure reasons precisely.
//
//   GREEN  (#34C759) — everything valid, countdown running
//   ORANGE (#FF8800) — face found but one condition failing
//   RED    (#FF3B30) — no face or face outside box entirely
// ─────────────────────────────────────────────────────────────────────────────
type TrafficState = 'green' | 'orange' | 'red';

type ViewState = 'menu' | 'enrolling' | 'authenticating';
type EnrollStep = 'front' | 'left' | 'right' | 'up' | 'down' | 'idle';

const phaseMessages: Record<string, string> = {
  front: 'STEP 1/5: LOOK STRAIGHT',
  left: 'STEP 2/5: TURN LEFT',
  right: 'STEP 3/5: TURN RIGHT',
  up: 'STEP 4/5: TILT HEAD UP',
  down: 'STEP 5/5: TILT HEAD DOWN',
  idle: '',
};

export default function HomeScreen() {
  const camera = useRef<Camera>(null);
  const device = useCameraDevice("front");

  const [hasPermission, setHasPermission] = useState(false);
  const [authStatus, setAuthStatus] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [view, setView] = useState<ViewState>('menu');
  const [employeeName, setEmployeeName] = useState("");
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [showSnackbar, setShowSnackbar] = useState(false);
  const [snackbarType, setSnackbarType] = useState<'success' | 'error'>('success');
  const [canCapture, setCanCapture] = useState(false);
  const [enrollStep, setEnrollStep] = useState<EnrollStep>('idle');
  const [enrollImages, setEnrollImages] = useState<string[]>([]);
  const [uiProgress, setUiProgress] = useState(0);

  // ── Traffic light state (replaces old isFaceInBox + distanceStatus) ───────
  // Single value drives both border color AND status message
  const [trafficColor, setTrafficColor] = useState<TrafficState>('red');
  const [trafficMessage, setTrafficMessage] = useState("");

  const poseProgress = useSharedValue(0);
  const lastPoseValid = useSharedValue(Date.now());
  const isCapturing = useSharedValue(false);
  const lastFaceX = useSharedValue(0);
  const lastFaceY = useSharedValue(0);

  const faceDetector = useFaceDetector({
    performanceMode: "fast",
    autoMode: true,
    windowWidth: SCREEN_WIDTH,
    windowHeight: SCREEN_HEIGHT,
  });

  // ─── CAPTURE & IDENTIFY ───────────────────────────────────────────────────
  const captureAndIdentify = async () => {
    if (isProcessing || !camera.current) return;
    setIsProcessing(true);
    setAuthStatus("HOLD STEADY...");

    try {
      const photo = await camera.current.takeSnapshot({ quality: 85 });
      console.log("📸 [SCAN] Captured");

      if (view === 'enrolling') {
        const newImages = [...enrollImages, photo.path];
        setEnrollImages(newImages);

        const nextStep = (step: EnrollStep, msg: string, next: EnrollStep) => {
          console.log(`✅ [ENROLL] ${step} captured`);
          setEnrollStep(next);
          setAuthStatus(msg);
          setCanCapture(false);
          setIsProcessing(false);
          lastPoseValid.value = Date.now();
          poseProgress.value = 0;
          updateUiProgress(0);
          setTimeout(() => setCanCapture(true), 2000);
          isCapturing.value = false;
        };

        if (enrollStep === 'front') { nextStep('front', 'GREAT! NOW TURN Right SLOWLY', 'left'); return; }
        else if (enrollStep === 'left') { nextStep('left', 'EXCELLENT! TURN LEFT SLOWLY', 'right'); return; }
        else if (enrollStep === 'right') { nextStep('right', 'GOOD! NOW TILT HEAD UP', 'up'); return; }
        else if (enrollStep === 'up') { nextStep('up', 'ALMOST DONE! TILT HEAD DOWN', 'down'); return; }
        else if (enrollStep === 'down') {
          console.log("✅ [ENROLL] All 5 done. Uploading...");
          setIsCameraOpen(false);
          setEnrollStep('idle');
          setAuthStatus("UPLOADING ALL 5 ANGLES...");

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
            setTimeout(() => {
              setView('menu'); setEmployeeName(""); setAuthStatus("");
              setIsProcessing(false); setShowSnackbar(false); isCapturing.value = false;
            }, 3000);
          } else {
            setAuthStatus("ENROLL FAILED ❌");
            setSnackbarType('error');
            setShowSnackbar(true);
            setIsProcessing(false);
            setTimeout(() => setShowSnackbar(false), 3000);
            isCapturing.value = false;
          }
          return;
        }
      }

      // ─── AUTHENTICATION ────────────────────────────────────────────────
      setIsCameraOpen(false);
      setAuthStatus("SENDING TO SERVER...");
      const formData = new FormData();
      formData.append('image', {
        uri: Platform.OS === 'android' ? `file://${photo.path}` : photo.path,
        type: 'image/jpeg',
        name: 'face_scan.jpg',
      } as any);

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

      if (data.success) {
        setAuthStatus(`WELCOME: ${data.name} ✅`);
        setSnackbarType('success');
        setShowSnackbar(true);
        setTimeout(() => {
          setView('menu'); setEmployeeName(""); setAuthStatus("");
          setIsProcessing(false); setIsCameraOpen(false);
          setShowSnackbar(false); isCapturing.value = false;
        }, 3000);
      } else {
        setAuthStatus("Your Data is not available, Please Enroll First ❌");
        setSnackbarType('error');
        setShowSnackbar(true);
        setIsProcessing(false);
        setIsCameraOpen(false);
        setTimeout(() => setShowSnackbar(false), 3000);
        isCapturing.value = false;
      }
    } catch (error) {
      console.error("❌ Error:", error);
      setAuthStatus("Camera/Network Error");
      setIsProcessing(false);
      isCapturing.value = false;
    }
  };

  const triggerCapture = Worklets.createRunOnJS(captureAndIdentify);
  const updateUiProgress = Worklets.createRunOnJS((val: number) => setUiProgress(val));

  // ── Single worklet→JS bridge for all traffic state ────────────────────────
  const updateTraffic = Worklets.createRunOnJS(
    (color: TrafficState, message: string) => {
      setTrafficColor(color);
      setTrafficMessage(message);
    }
  );

  // ─── FRAME PROCESSOR ──────────────────────────────────────────────────────
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    runAsync(frame, () => {
      'worklet';

      const scannedFaces = faceDetector.detectFaces(frame);

      // ── No face at all → RED ──────────────────────────────────────────
      if (scannedFaces.length === 0) {
        updateTraffic('red', 'LOOK AT CAMERA');
        poseProgress.value = 0;
        updateUiProgress(0);
        return;
      }

      const face = scannedFaces[0];
      const { x: faceX, y: faceY, width: faceW, height: faceH } = face.bounds;

      // ── Box check — only for front and auth ────────────────────────
      // For left/right/up/down the face naturally shifts sideways as the
      // person turns — enforcing the box check blocks the turn before
      // the angle check even runs, causing a red border immediately.
      // Only front and auth need the face to be centered in the box.
      const isSideAngle = view === 'enrolling' &&
        (enrollStep === 'left' || enrollStep === 'right' ||
          enrollStep === 'up' || enrollStep === 'down');

      if (!isSideAngle) {
        const H_MARGIN = 60;
        const faceLeft = faceX;
        const faceRight = faceX + faceW;
        const boxLeft = TARGET_BOX_X + H_MARGIN;
        const boxRight = TARGET_BOX_X + TARGET_BOX_SIZE - H_MARGIN;

        const tooFarLeft = faceLeft < boxLeft;
        const tooFarRight = faceRight > boxRight;

        if (tooFarLeft || tooFarRight) {
          const msg = tooFarLeft ? 'MOVE FACE RIGHT' : 'MOVE FACE LEFT';
          updateTraffic('red', msg);
          poseProgress.value = 0;
          updateUiProgress(0);
          lastPoseValid.value = Date.now();
          return;
        }
      }



      // ── Pick the correct scale range for current step ─────────────────
      // We read enrollStep from closure — this is JS state but acceptable
      // here because it only changes between captures, not frame-to-frame.
      let scaleKey = 'auth';
      if (view === 'enrolling') {
        if (enrollStep === 'front') scaleKey = 'front';
        else if (enrollStep === 'left') scaleKey = 'left';
        else if (enrollStep === 'right') scaleKey = 'right';
        else if (enrollStep === 'up') scaleKey = 'up';
        else if (enrollStep === 'down') scaleKey = 'down';
      }

      // ── Distance check using per-angle range ─────────────────────────
      const faceScale = faceW / TARGET_BOX_SIZE;
      let scaleMin = 0.50;
      let scaleMax = 0.65;
      if (scaleKey === 'left' || scaleKey === 'right') { scaleMin = 0.45; scaleMax = 0.70; }
      else if (scaleKey === 'up' || scaleKey === 'down') { scaleMin = 0.48; scaleMax = 0.75; }

      if (faceScale < scaleMin) {
        updateTraffic('orange', 'MOVE CLOSER');
        poseProgress.value = 0;
        updateUiProgress(0);
        lastPoseValid.value = Date.now();
        return;
      }
      if (faceScale > scaleMax) {
        updateTraffic('orange', 'MOVE BACK');
        poseProgress.value = 0;
        updateUiProgress(0);
        lastPoseValid.value = Date.now();
        return;
      }

      // ── Angle check ───────────────────────────────────────────────────
      const yaw = face.yawAngle || 0;
      const pitch = face.pitchAngle || 0;
      let isAligned = false;
      let angleMessage = 'HOLD STILL...';

      if (view === 'enrolling') {
        if (enrollStep === 'front') {
          isAligned = Math.abs(yaw) < 12 && Math.abs(pitch) < 12;
          angleMessage = 'LOOK STRAIGHT AT CAMERA';
        } else if (enrollStep === 'left') {
          isAligned = yaw > 15 && yaw < 50;  // device: LEFT = POSITIVE yaw
          // Give specific guidance based on how far they've turned
          if (yaw <= 15) angleMessage = 'TURN YOUR HEAD LEFT MORE';
          else if (yaw >= 50) angleMessage = 'TOO FAR LEFT, COME BACK';
          else angleMessage = 'HOLD STILL...';
        } else if (enrollStep === 'right') {
          isAligned = yaw < -15 && yaw > -50;  // device: RIGHT = NEGATIVE yaw
          if (yaw >= -15) angleMessage = 'TURN YOUR HEAD RIGHT MORE';
          else if (yaw <= -50) angleMessage = 'TOO FAR RIGHT, COME BACK';
          else angleMessage = 'HOLD STILL...';
        } else if (enrollStep === 'up') {
          // Android inverted: looking UP = POSITIVE pitch
          isAligned = pitch > 15 && pitch < 35 && Math.abs(yaw) < 20;
          if (pitch <= 15) angleMessage = 'TILT HEAD UP MORE';
          else if (pitch >= 35) angleMessage = 'TOO FAR UP, COME BACK';
          else if (Math.abs(yaw) >= 20) angleMessage = 'FACE THE CAMERA MORE';
          else angleMessage = 'HOLD STILL...';
        } else if (enrollStep === 'down') {
          // Android inverted: looking DOWN = NEGATIVE pitch
          isAligned = pitch < -15 && pitch > -35 && Math.abs(yaw) < 20;
          if (pitch >= -15) angleMessage = 'TILT HEAD DOWN MORE';
          else if (pitch <= -35) angleMessage = 'TOO FAR DOWN, COME BACK';
          else if (Math.abs(yaw) >= 20) angleMessage = 'FACE THE CAMERA MORE';
          else angleMessage = 'HOLD STILL...';
        }
      } else {
        // Auth — strict frontal
        isAligned = Math.abs(yaw) < 15 && Math.abs(pitch) < 15;
        angleMessage = 'LOOK STRAIGHT AT CAMERA';
      }

      if (!isAligned) {
        updateTraffic('orange', angleMessage);
        poseProgress.value = 0;
        updateUiProgress(0);
        lastPoseValid.value = Date.now();
        return;
      }

      // ── Stillness check ───────────────────────────────────────────────
      const movement = Math.abs(faceX - lastFaceX.value) + Math.abs(faceY - lastFaceY.value);
      const isStill = movement < 18;
      lastFaceX.value = faceX;
      lastFaceY.value = faceY;

      if (!isStill) {
        updateTraffic('orange', 'HOLD STILL...');
        // Do NOT reset lastPoseValid here — stillness is transient,
        // resetting the timer every tiny movement makes the countdown
        // almost impossible to complete. Only reset on real misalignment.
        poseProgress.value = 0;
        updateUiProgress(0);
        return;
      }

      // ── All checks passed → GREEN, run countdown ──────────────────────
      if (isCapturing.value) return;

      if (!isProcessing && canCapture && view !== 'menu' && isCameraOpen) {
        const elapsed = Date.now() - lastPoseValid.value;
        const requiredTime = 2000; // 2.0s — slightly faster than before

        poseProgress.value = Math.min(elapsed / requiredTime, 1);
        updateUiProgress(poseProgress.value);
        updateTraffic('green', 'HOLD STILL...');

        if (poseProgress.value >= 1) {
          isCapturing.value = true;
          poseProgress.value = 0;
          updateUiProgress(0);
          triggerCapture();
        }
      }
    });
  }, [view, isProcessing, isCameraOpen, canCapture, enrollStep]);

  useEffect(() => {
    (async () => {
      await Camera.requestCameraPermission();
      setHasPermission(true);
    })();
  }, []);

  // ─── BORDER COLOR ─────────────────────────────────────────────────────────
  const borderColor =
    uiProgress > 0 ? '#34C759' :  // GREEN  — countdown running
      trafficColor === 'green' ? '#34C759' :
        trafficColor === 'orange' ? '#FF8800' :
          '#FF3B30';  // RED

  // ─── UI ───────────────────────────────────────────────────────────────────
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
        <TouchableOpacity
          style={[styles.bigButton, { backgroundColor: '#007AFF', opacity: isProcessing ? 0.5 : 1 }]}
          disabled={isProcessing}
          onPress={() => {
            setView('authenticating');
            setIsCameraOpen(true);
            setCanCapture(false);
            setAuthStatus("");
            setTimeout(() => setCanCapture(true), 1500);
          }}
        >
          <Text style={styles.bigButtonText}>AUTHENTICATE</Text>
          <Text style={styles.buttonDesc}>Scan to verify identity</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.bigButton, { backgroundColor: '#34C759' }]}
          onPress={() => { setView('enrolling'); setIsCameraOpen(false); setAuthStatus(""); }}
        >
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
        <TextInput
          style={styles.input}
          placeholder="e.g. Daniyal Khan"
          placeholderTextColor="#555"
          value={employeeName}
          onChangeText={setEmployeeName}
          autoFocus={true}
          editable={!isProcessing}
        />
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
        style={[styles.bigButton, {
          backgroundColor: '#007AFF',
          opacity: (employeeName && !isProcessing) ? 1 : 0.5,
          marginTop: 20,
        }]}
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

      <TouchableOpacity
        onPress={() => { setView('menu'); setEmployeeName(""); setAuthStatus(""); }}
        disabled={isProcessing}
      >
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
          <Camera
            ref={camera}
            device={device}
            isActive={true}
            style={StyleSheet.absoluteFill}
            frameProcessor={frameProcessor}
          />

          <TouchableOpacity
            style={styles.closeButton}
            onPress={() => {
              setView('menu'); setAuthStatus(""); setIsProcessing(false);
              setIsCameraOpen(false); setEnrollStep('idle');
            }}
          >
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>

          {/* ── TARGET BOX — border driven by unified traffic state ─────── */}
          <View style={[styles.targetBox, { borderColor }]}>
            {uiProgress > 0 && (
              <View style={[styles.progressBar, { width: `${uiProgress * 100}%` }]} />
            )}
          </View>

          {/* ── STATUS OVERLAY ────────────────────────────────────────────── */}
          <View style={styles.uiOverlay}>
            <Text style={styles.phaseLabel}>
              {view === 'enrolling' ? phaseMessages[enrollStep] : 'AUTHENTICATING'}
            </Text>
            {isProcessing && <ActivityIndicator color="#007AFF" style={{ marginBottom: 10 }} />}
            <Text style={[
              styles.statusText,
              {
                color: authStatus.includes("✅") ? "#00FF00"
                  : trafficColor === 'green' ? "#34C759"
                    : trafficColor === 'orange' ? "#FF8800"
                      : "white"
              }
            ]}>
              {authStatus || (!canCapture ? "READYING CAMERA..." : trafficMessage)}
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
  uiOverlay: { position: "absolute", bottom: 80, backgroundColor: "rgba(0,0,0,0.95)", paddingVertical: 25, paddingHorizontal: 40, borderRadius: 40, alignSelf: "center", alignItems: "center", minWidth: SCREEN_WIDTH * 0.8, borderWidth: 1, borderColor: '#333' },
  statusText: { color: "white", fontSize: 22, fontWeight: '900', textAlign: "center", letterSpacing: 1 },
  closeButton: { position: 'absolute', top: 60, right: 30, width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', zIndex: 100, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  closeText: { color: 'white', fontSize: 28, fontWeight: '300' },
  text: { color: 'white', fontSize: 18, textAlign: 'center' },
  processingStatus: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 20, gap: 10 },
  processingText: { color: '#007AFF', fontSize: 16, fontWeight: '600' },
  inlineStatus: { textAlign: 'center', fontSize: 18, fontWeight: 'bold', marginBottom: 20 },
  snackbar: { position: 'absolute', bottom: 40, left: 20, right: 20, padding: 20, borderRadius: 15, elevation: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10 },
  snackbarText: { color: 'white', fontSize: 16, fontWeight: 'bold', textAlign: 'center' },
  targetBox: { position: 'absolute', left: TARGET_BOX_X, top: TARGET_BOX_Y, width: TARGET_BOX_SIZE, height: TARGET_BOX_SIZE, borderWidth: 2, borderRadius: 30, backgroundColor: 'rgba(0,0,0,0.1)', justifyContent: 'flex-end' },
  progressBar: { position: 'absolute', bottom: -25, height: 8, backgroundColor: '#34C759', borderRadius: 4 },
  phaseLabel: { color: '#007AFF', fontWeight: 'bold', fontSize: 14, marginBottom: 5, letterSpacing: 2 },
  faceBox: { position: "absolute", borderWidth: 3, borderRadius: 20, borderStyle: "dashed" },
});