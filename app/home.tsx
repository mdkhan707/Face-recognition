import * as Haptics from "expo-haptics";
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import Svg, { Defs, Ellipse, Mask, Rect } from 'react-native-svg';
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
import EnrollForm from '../components/EnrollForm';
import MainMenu from '../components/MainMenu';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SERVER_URL = "http://192.168.0.104:3000";


const TARGET_BOX_SIZE = 320;
const OVAL_RX = TARGET_BOX_SIZE / 2;
const OVAL_RY = TARGET_BOX_SIZE * 0.65; // Makes it 30% taller than it is wide
const OVAL_CX = SCREEN_WIDTH / 2;
const OVAL_CY = (SCREEN_HEIGHT / 2) - 60; // Push oval slightly up

const TARGET_BOX_X = OVAL_CX - OVAL_RX;
const TARGET_BOX_Y = OVAL_CY - OVAL_RY;

// Exact perimeter of an ellipse (Ramanujan's formula) for perfect progress bar matching
const H_VAL = Math.pow(OVAL_RX - OVAL_RY, 2) / Math.pow(OVAL_RX + OVAL_RY, 2);
const OVAL_PERIMETER = Math.PI * (OVAL_RX + OVAL_RY) * (1 + (3 * H_VAL) / (10 + Math.sqrt(4 - 3 * H_VAL)));

// ─────────────────────────────────────────────────────────────────────────────
// DISTANCE RANGES PER ANGLE
//
// Why different ranges per angle?
//   • front / left / right: standard range — face stays roughly same size
//   • up / down: when you tilt your head, your chin/forehead comes closer
//     to the camera. The face bounding bought x gets larger even without moving
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
  left: 'STEP 2/5: LOOK SLIGHTLY RIGHT',
  right: 'STEP 3/5: LOOK SLIGHTLY LEFT',
  up: 'STEP 4/5: LOOK SLIGHTLY UP',
  down: 'STEP 5/5: LOOK SLIGHTLY DOWN',
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

    // 📳 Buzz the tablet to confirm capture
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

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

        if (enrollStep === 'front') { nextStep('front', 'GREAT! NOW LOOK SLIGHTLY RIGHT', 'left'); return; }
        else if (enrollStep === 'left') { nextStep('left', 'EXCELLENT! NOW LOOK SLIGHTLY LEFT', 'right'); return; }
        else if (enrollStep === 'right') { nextStep('right', 'GOOD! NOW LOOK SLIGHTLY UP', 'up'); return; }
        else if (enrollStep === 'up') { nextStep('up', 'ALMOST DONE! LOOK SLIGHTLY DOWN', 'down'); return; }
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
            setIsProcessing(false);
            setAuthStatus(`ENROLLED SUCCESSFULLY! ✅`);
            setSnackbarType('success');
            setShowSnackbar(true);
            setTimeout(() => {
              setView('menu'); setEmployeeName(""); setAuthStatus("");
              setShowSnackbar(false); isCapturing.value = false;
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
        setIsProcessing(false);
        setAuthStatus(`WELCOME: ${data.name} ✅`);
        setSnackbarType('success');
        setShowSnackbar(true);
        setTimeout(() => {
          setView('menu'); setEmployeeName(""); setAuthStatus("");
          setIsCameraOpen(false);
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
          updateTraffic('red', 'CENTER YOUR FACE IN THE OVAL');
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
        updateTraffic('orange', 'MOVE BACK SLIGHTLY');
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
          if (yaw <= 15) angleMessage = 'LOOK MORE TO YOUR LEFT';
          else if (yaw >= 50) angleMessage = 'TOO FAR LEFT, LOOK BACK A BIT';
          else angleMessage = 'HOLD STILL...';
        } else if (enrollStep === 'right') {
          isAligned = yaw < -15 && yaw > -50;  // device: RIGHT = NEGATIVE yaw
          if (yaw >= -15) angleMessage = 'LOOK MORE TO YOUR RIGHT';
          else if (yaw <= -50) angleMessage = 'TOO FAR RIGHT, LOOK BACK A BIT';
          else angleMessage = 'HOLD STILL...';
        } else if (enrollStep === 'up') {
          // Android inverted: looking UP = POSITIVE pitch
          isAligned = pitch > 15 && pitch < 35 && Math.abs(yaw) < 20;
          if (pitch <= 15) angleMessage = 'LOOK UP A BIT MORE';
          else if (pitch >= 35) angleMessage = 'TOO FAR UP, LOOK BACK A BIT';
          else if (Math.abs(yaw) >= 20) angleMessage = 'FACE THE CAMERA MORE';
          else angleMessage = 'HOLD STILL...';
        } else if (enrollStep === 'down') {
          // Android inverted: looking DOWN = NEGATIVE pitch
          isAligned = pitch < -15 && pitch > -35 && Math.abs(yaw) < 20;
          if (pitch >= -15) angleMessage = 'LOOK DOWN A BIT MORE';
          else if (pitch <= -35) angleMessage = 'TOO FAR DOWN, LOOK BACK A BIT';
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
        const requiredTime = 1500; // 1.0s — slightly faster than before

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
    uiProgress > 0 ? '#1B6E4B' :  // GREEN  — countdown running
      trafficColor === 'green' ? '#1B6E4B' :
        trafficColor === 'orange' ? '#FF8800' :
          '#FF3B30';  // RED

  // ─── UI ───────────────────────────────────────────────────────────────────

  if (!hasPermission) return <View style={styles.container}><Text style={styles.text}>No Permission</Text></View>;
  if (!device) return <View style={styles.container}><Text style={styles.text}>No Camera</Text></View>;

  const isWhiteTheme = view === 'menu' || (view === 'enrolling' && !isCameraOpen) || (view === 'authenticating' && !isCameraOpen);
  return (
    <>
      <StatusBar style={isWhiteTheme ? "dark" : "light"} backgroundColor={isWhiteTheme ? '#FFFFFF' : '#0A0A0A'} />
      <KeyboardAvoidingView behavior="padding" style={[styles.container, { backgroundColor: isWhiteTheme ? '#FFFFFF' : '#0A0A0A' }]}>
        {view === 'menu' && (
          <MainMenu
            isProcessing={isProcessing}
            onAuthenticatePress={() => {
              setView('authenticating');
              setIsCameraOpen(true);
              setCanCapture(false);
              setAuthStatus("");
              setTimeout(() => setCanCapture(true), 1500);
            }}
            onEnrollPress={() => {
              setView('enrolling');
              setIsCameraOpen(false);
              setAuthStatus("");
            }}
          />
        )}
        {view === 'authenticating' && !isCameraOpen && (
          <MainMenu
            isProcessing={isProcessing}
            onAuthenticatePress={() => { }}
            onEnrollPress={() => { }}
          />
        )}
        {view === 'enrolling' && !isCameraOpen && (
          <EnrollForm
            employeeName={employeeName}
            setEmployeeName={setEmployeeName}
            isProcessing={isProcessing}
            authStatus={authStatus}
            onStartScan={() => {
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
            onCancel={() => {
              setView('menu');
              setEmployeeName("");
              setAuthStatus("");
            }}
          />
        )}

        {isCameraOpen && view !== 'menu' && (
          <View style={styles.cameraScreenContainer}>
            {/* ── HEADER ────────────────────────────────────────────────────── */}
            <View style={styles.header}>
              <View style={styles.headerTextContainer}>
                <Text style={styles.headerTitle}>
                  {view === 'enrolling' ? 'Face Enrollment' : 'Face Authentication'}
                </Text>
                <Text style={styles.headerSubtitle}>
                  {view === 'enrolling'
                    ? 'Please follow the guidelines to capture your face from all angles'
                    : 'Please position your face within the circle to verify your identity'}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.closeIconBtn}
                onPress={() => {
                  setView('menu'); setAuthStatus(""); setIsProcessing(false);
                  setIsCameraOpen(false); setEnrollStep('idle');
                }}
              >
                <Text style={styles.closeIconText}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* ── CAMERA & CIRCULAR MASK ────────────────────────────────────── */}
            <View style={styles.cameraWrapper}>
              <Camera
                ref={camera}
                device={device}
                isActive={true}
                style={StyleSheet.absoluteFill}
                frameProcessor={frameProcessor}
              />

              <Svg height={SCREEN_HEIGHT} width={SCREEN_WIDTH} style={StyleSheet.absoluteFill}>
                <Defs>
                  <Mask id="mask" x="0" y="0" height={SCREEN_HEIGHT} width={SCREEN_WIDTH}>
                    <Rect height={SCREEN_HEIGHT} width={SCREEN_WIDTH} fill="#fff" />
                    <Ellipse
                      rx={OVAL_RX}
                      ry={OVAL_RY}
                      cx={OVAL_CX}
                      cy={OVAL_CY}
                      fill="black"
                    />
                  </Mask>
                </Defs>
                {/* White background over everything except the circle */}
                <Rect height={SCREEN_HEIGHT} width={SCREEN_WIDTH} fill="#FAFAFA" mask="url(#mask)" />

                {/* Circular Progress & Traffic Light */}
                <Ellipse
                  rx={OVAL_RY} // Swapped for the rotation fix
                  ry={OVAL_RX} // Swapped for the rotation fix
                  cx={OVAL_CX}
                  cy={OVAL_CY}
                  fill="transparent"
                  stroke={trafficColor === 'green' ? '#1B6E4B' : trafficColor === 'orange' ? '#FF8800' : '#FF3B30'}
                  strokeWidth={8}
                  strokeDasharray={OVAL_PERIMETER}
                  strokeDashoffset={OVAL_PERIMETER * (1 - uiProgress)}
                  strokeLinecap="round"
                  rotation="-90"
                  originX={OVAL_CX}
                  originY={OVAL_CY}
                />
              </Svg>
            </View>

            {/* ── GUIDELINES CARD ───────────────────────────────────────────── */}
            <View style={styles.guidelinesCard}>
              <Text style={styles.guidelinesTitle}>Guidelines</Text>

              <View style={styles.guidelineItem}>
                <View style={[styles.guidelineDot, { backgroundColor: trafficColor === 'green' ? '#1B6E4B' : trafficColor === 'orange' ? '#FF8800' : '#FF3B30' }]} />
                <Text style={[
                  styles.guidelineText,
                  { color: trafficColor === 'green' ? '#1B6E4B' : trafficColor === 'orange' ? '#FF8800' : '#333' }
                ]}>
                  {authStatus || (!canCapture ? "Readying camera..." : trafficMessage)}
                </Text>
              </View>

              {isProcessing && (
                <View style={styles.processingStatus}>
                  <ActivityIndicator color="#1B6E4B" />
                  <Text style={styles.processingText}>Processing...</Text>
                </View>
              )}
            </View>
          </View>
        )}

        {showSnackbar && (
          <View style={[styles.snackbar, { backgroundColor: snackbarType === 'success' ? '#1B6E4B' : '#FF3B30' }]}>
            <Text style={styles.snackbarText}>{authStatus}</Text>
          </View>
        )}
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0A0A" },
  uiOverlay: { position: "absolute", bottom: 80, backgroundColor: "rgba(0,0,0,0.95)", paddingVertical: 25, paddingHorizontal: 40, borderRadius: 40, alignSelf: "center", alignItems: "center", minWidth: SCREEN_WIDTH * 0.8, borderWidth: 1, borderColor: '#333' },
  statusText: { color: "white", fontSize: 22, fontWeight: '900', textAlign: "center", letterSpacing: 1 },
  closeButton: { position: 'absolute', top: 60, right: 30, width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', zIndex: 100, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  closeText: { color: 'white', fontSize: 28, fontWeight: '300' },
  text: { color: 'white', fontSize: 18, textAlign: 'center' },
  processingStatus: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 20, gap: 10 },
  processingText: { color: '#1B6E4B', fontSize: 16, fontWeight: '600' },
  inlineStatus: { textAlign: 'center', fontSize: 18, fontWeight: 'bold', marginBottom: 20 },
  snackbar: { position: 'absolute', top: 70, left: 20, right: 20, padding: 20, borderRadius: 15, elevation: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10, zIndex: 1000 },
  snackbarText: { color: 'white', fontSize: 16, fontWeight: 'bold', textAlign: 'center' },
  targetBox: { position: 'absolute', left: TARGET_BOX_X, top: TARGET_BOX_Y, width: TARGET_BOX_SIZE, height: TARGET_BOX_SIZE, borderWidth: 2, borderRadius: 30, backgroundColor: 'rgba(0,0,0,0.1)', justifyContent: 'flex-end' },
  progressBar: { position: 'absolute', bottom: -25, height: 8, backgroundColor: '#1B6E4B', borderRadius: 4 },
  phaseLabel: { color: '#007AFF', fontWeight: 'bold', fontSize: 14, marginBottom: 5, letterSpacing: 2 },
  faceBox: { position: "absolute", borderWidth: 3, borderRadius: 20, borderStyle: "dashed" },

  // ── NEW UI DESIGN STYLES ──────────────────────────────────────────────
  cameraScreenContainer: { flex: 1, backgroundColor: '#FAFAFA' },
  header: { paddingTop: 60, paddingHorizontal: 30, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', zIndex: 10 },
  headerTextContainer: { flex: 1, paddingRight: 20 },
  headerTitle: { fontSize: 32, fontWeight: '900', color: '#1B6E4B', letterSpacing: 0.5 },
  headerSubtitle: { fontSize: 15, color: '#555', marginTop: 10, lineHeight: 22 },
  closeIconBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#E5E5E5', justifyContent: 'center', alignItems: 'center' },
  closeIconText: { fontSize: 20, color: '#333', fontWeight: 'bold' },
  cameraWrapper: { ...StyleSheet.absoluteFillObject, zIndex: 1 },
  // Card positioned using 'top' instead of 'bottom' to prevent the keyboard from squishing it upwards
  guidelinesCard: { position: 'absolute', top: (SCREEN_HEIGHT / 2) + 180, left: 25, right: 25, backgroundColor: 'white', borderRadius: 24, padding: 30, shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.085, shadowRadius: 20, elevation: 1, zIndex: 10 },
  guidelinesTitle: { fontSize: 22, fontWeight: '800', color: '#111', marginBottom: 25 },
  guidelineItem: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  guidelineDot: { width: 10, height: 10, borderRadius: 5, marginRight: 15 },
  guidelineText: { fontSize: 17, fontWeight: '600', flex: 1, textTransform: 'uppercase', letterSpacing: 1 },
});