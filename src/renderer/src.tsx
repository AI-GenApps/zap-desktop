import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MAX_RECORDING_DURATION_MS,
  MAX_UPLOAD_SIZE_BYTES,
  RECORDING_TIMESLICE_MS,
  pickRecorderMimeType,
  recordingDuration,
  type CameraCorner,
  type CameraSize,
  type RecordingManifest,
  type RecordingOptions,
} from "@zapture/recorder-core";
import type { AuthMode, AuthState, CaptureSource, MediaDeviceOption, RecordingCommand, UploadProgress } from "../shared/contracts";
import { requestDisplayStream } from "./display-capture.util";
import { formatBytes, formatDuration } from "./format.util";
import { RecordingHud } from "./hud";
import { Onboarding } from "./onboarding";
import "./styles.css";

const CAMERA_SIZES: { value: CameraSize; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "small", label: "S" },
  { value: "medium", label: "M" },
  { value: "large", label: "L" },
];
const CORNERS: CameraCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const COUNTDOWN_SECONDS = 3;
const COMPOSITOR_FPS = 30;

interface PreparedCapture {
  output: MediaStream;
  mimeType: string;
  options: RecordingOptions;
}

function SourceCard({ source, selected, onSelect }: { source: CaptureSource; selected: boolean; onSelect: () => void }) {
  return (
    <button className="source-card" aria-pressed={selected} onClick={onSelect} type="button" title={source.name}>
      <span className="source-thumb"><img src={source.thumbnail} alt="" draggable={false} /></span>
      <span className="source-name">{source.name}</span>
    </button>
  );
}

function RecordingRow({ recording, uploadProgress, busy, onUpload, onEdit, onDelete }: {
  recording: RecordingManifest;
  uploadProgress?: UploadProgress;
  busy: boolean;
  onUpload: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const started = new Date(recording.startedAt);
  const uploading = recording.status === "uploading" && uploadProgress;
  return (
    <li className="recording-row">
      <span className="recording-icon" aria-hidden="true"><FilmIcon /></span>
      <div className="recording-meta">
        <strong>{recording.options.sourceName}</strong>
        <span>
          {started.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, {started.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          {" · "}{formatDuration(recording.durationMs)} · {formatBytes(recording.totalSize)}
        </span>
        {uploading ? (
          <span className="row-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(uploadProgress.uploadedBytes / Math.max(1, uploadProgress.totalBytes) * 100)}>
            <b style={{ width: `${uploadProgress.totalBytes ? uploadProgress.uploadedBytes / uploadProgress.totalBytes * 100 : 0}%` }} />
          </span>
        ) : null}
        {recording.status === "failed" && recording.error ? <span className="row-error">{recording.error}</span> : null}
      </div>
      <span className={`badge badge-${recording.status}`}>{recording.status}</span>
      <div className="row-actions">
        {recording.status === "uploaded" && recording.videoId ? <button className="btn" onClick={onEdit}>Edit</button> : null}
        {["ready", "failed"].includes(recording.status) ? <button className="btn btn-primary" onClick={onUpload} disabled={busy}>Upload</button> : null}
        <button className="btn btn-plain" onClick={onDelete} disabled={recording.status === "uploading"} aria-label="Delete recording" title="Delete"><TrashIcon /></button>
      </div>
    </li>
  );
}

function App() {
  const [view, setView] = useState<"loading" | "onboarding" | "recorder">("loading");
  const [tab, setTab] = useState<"record" | "library">("record");
  const [sourceKind, setSourceKind] = useState<CaptureSource["kind"]>("screen");
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selectedSource, setSelectedSource] = useState<CaptureSource>();
  const [microphones, setMicrophones] = useState<MediaDeviceOption[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceOption[]>([]);
  const [devicesNeedAccess, setDevicesNeedAccess] = useState(false);
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState("");
  const [cameraDeviceId, setCameraDeviceId] = useState("");
  const [cameraSize, setCameraSize] = useState<CameraSize>("medium");
  const [cameraCorner, setCameraCorner] = useState<CameraCorner>("bottom-left");
  const [includeSystemAudio, setIncludeSystemAudio] = useState(true);
  const [recordings, setRecordings] = useState<RecordingManifest[]>([]);
  const [activeRecording, setActiveRecording] = useState<RecordingManifest>();
  const [countdown, setCountdown] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [auth, setAuth] = useState<AuthState>({ authenticated: false, canUpload: false });
  const [status, setStatus] = useState("Choose a screen or window to record.");
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>();
  const [authError, setAuthError] = useState<string>();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const activeRecordingRef = useRef<RecordingManifest | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const compositorRef = useRef<number | null>(null);
  const stoppingRef = useRef(false);
  const writeChainRef = useRef<Promise<void> | null>(null);
  const cancelCountdownRef = useRef<(() => void) | null>(null);
  const startButtonRef = useRef<HTMLButtonElement | null>(null);
  const commandsRef = useRef<Record<RecordingCommand | "stop-recording", () => void>>(null!);

  const refreshRecordings = useCallback(async () => setRecordings(await window.zapture.listRecordings()), []);

  const refreshSources = useCallback(async () => {
    setBusy(true);
    try {
      const next = await window.zapture.getSources();
      setSources(next);
      setSelectedSource((current) => next.find((source) => source.id === current?.id) ?? next.find((source) => source.kind === "screen") ?? next[0]);
      if (!next.length) setStatus("No recordable screens or windows were found.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load capture sources.");
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshDevices = useCallback(async (requestAccess: boolean) => {
    if (requestAccess) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        probe.getTracks().forEach((track) => track.stop());
      } catch {
        setStatus("Camera or microphone access was not granted. You can still record the screen.");
      }
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput" || device.kind === "videoinput");
    setDevicesNeedAccess(inputs.some((device) => !device.label));
    setMicrophones(devices.filter((device) => device.kind === "audioinput").map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` })));
    setCameras(devices.filter((device) => device.kind === "videoinput").map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Camera ${index + 1}` })));
  }, []);

  useEffect(() => {
    let disposed = false;
    void window.zapture.getAuthState().then((state) => {
      if (disposed) return;
      setAuth(state);
      setView(state.authenticated ? "recorder" : "onboarding");
    });
    const unsubscribers = [
      window.zapture.onUploadProgress(setUploadProgress),
      window.zapture.onAuthStateChanged((state) => {
        setAuth(state);
        if (state.authenticated) {
          setAuthError(undefined);
          setView("recorder");
        } else {
          setAuthError(state.error);
          setView("onboarding");
        }
      }),
      window.zapture.onPrepareRecording(() => {
        setView("recorder");
        setTab("record");
        void refreshSources();
        startButtonRef.current?.focus();
      }),
      window.zapture.onRecordingCommand((command) => commandsRef.current[command]()),
      window.zapture.onMenuCommand((command) => {
        if (command === "show-library") setTab("library");
        else commandsRef.current["stop-recording"]();
      }),
    ];
    return () => {
      disposed = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [refreshSources]);

  useEffect(() => {
    if (view !== "recorder") return;
    void Promise.all([refreshSources(), refreshRecordings(), refreshDevices(false)]);
  }, [refreshDevices, refreshRecordings, refreshSources, view]);

  const isLive = activeRecording?.status === "recording" || activeRecording?.status === "paused";

  useEffect(() => {
    if (!activeRecording || !isLive) return;
    const tick = () => setElapsedMs(recordingDuration(activeRecording));
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [activeRecording, isLive]);

  // Mirror recorder state into the floating HUD; `null` hides it and brings this window back.
  useEffect(() => {
    if (stopping) void window.zapture.setRecordingHud(null);
    else if (countdown !== null) void window.zapture.setRecordingHud({ status: "countdown", countdown, elapsedMs: 0, updatedAt: Date.now() });
    else if (activeRecording && isLive) {
      void window.zapture.setRecordingHud({
        status: activeRecording.status === "paused" ? "paused" : "recording",
        elapsedMs: recordingDuration(activeRecording),
        updatedAt: Date.now(),
      });
    } else void window.zapture.setRecordingHud(null);
  }, [activeRecording, countdown, isLive, stopping]);

  const deviceSummary = useMemo(() => {
    const microphone = microphones.find((device) => device.deviceId === microphoneDeviceId)?.label || "Default microphone";
    const camera = cameraSize === "off" ? "Camera off" : cameras.find((device) => device.deviceId === cameraDeviceId)?.label || "Default camera";
    return `${microphone} · ${camera}`;
  }, [cameraDeviceId, cameraSize, cameras, microphoneDeviceId, microphones]);

  const cleanupCapture = useCallback(() => {
    streamsRef.current.forEach((stream) => stream.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    }));
    streamsRef.current = [];
    if (compositorRef.current !== null) window.clearInterval(compositorRef.current);
    compositorRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }, []);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    const recording = activeRecordingRef.current;
    if (!recorder || !recording || recorder.state === "inactive" || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    setBusy(true);
    setStatus("Saving recording…");
    try {
      const stopped = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
      recorder.stop();
      await stopped;
      recorder.ondataavailable = null;
      await (writeChainRef.current ?? Promise.resolve());
      cleanupCapture();
      const finalized = await window.zapture.finalizeRecording(recording.id);
      recorderRef.current = null;
      activeRecordingRef.current = null;
      setActiveRecording(undefined);
      setElapsedMs(0);
      setStatus(auth.authenticated ? "Recording saved. Upload it to share or edit." : "Recording saved on this computer.");
      await refreshRecordings();
      setTab("library");
      return finalized;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the recording.");
      return undefined;
    } finally {
      stoppingRef.current = false;
      setStopping(false);
      setBusy(false);
    }
  }, [auth.authenticated, cleanupCapture, refreshRecordings]);

  /** Opens devices and starts compositing so the countdown ends in an instant start. */
  const prepareCapture = async (source: CaptureSource): Promise<PreparedCapture> => {
    const { stream: displayStream, systemAudioIncluded } = await requestDisplayStream(
      (requestSystemAudio) => navigator.mediaDevices.getUserMedia({
        audio: requestSystemAudio ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: source.id } } : false,
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: source.id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
      } as unknown as MediaStreamConstraints),
      includeSystemAudio,
    );
    streamsRef.current = [displayStream];
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: microphoneDeviceId ? { exact: microphoneDeviceId } : undefined, echoCancellation: true, noiseSuppression: true },
    }).catch(() => null);
    const cameraStream = cameraSize === "off" ? null : await navigator.mediaDevices.getUserMedia({
      video: { deviceId: cameraDeviceId ? { exact: cameraDeviceId } : undefined, width: { ideal: 960 }, height: { ideal: 540 } },
    }).catch(() => null);
    streamsRef.current = [displayStream, micStream, cameraStream].filter((stream): stream is MediaStream => Boolean(stream));

    const screenVideo = document.createElement("video");
    screenVideo.srcObject = displayStream;
    screenVideo.muted = true;
    await screenVideo.play();
    const cameraVideo = document.createElement("video");
    if (cameraStream) {
      cameraVideo.srcObject = cameraStream;
      cameraVideo.muted = true;
      await cameraVideo.play();
    }
    const canvas = document.createElement("canvas");
    canvas.width = screenVideo.videoWidth || 1920;
    canvas.height = screenVideo.videoHeight || 1080;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Could not initialize the video compositor");

    const draw = () => {
      context.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
      if (cameraStream && cameraSize !== "off") {
        const ratios = { small: 0.14, medium: 0.2, large: 0.27 } as const;
        const size = Math.round(canvas.width * ratios[cameraSize]);
        const margin = Math.round(canvas.width * 0.025);
        const x = cameraCorner.endsWith("right") ? canvas.width - size - margin : margin;
        const y = cameraCorner.startsWith("bottom") ? canvas.height - size - margin : margin;
        context.save();
        context.beginPath();
        context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
        context.clip();
        context.drawImage(cameraVideo, x, y, size, size);
        context.restore();
        context.strokeStyle = "#f2efdf";
        context.lineWidth = Math.max(4, Math.round(size * 0.025));
        context.beginPath();
        context.arc(x + size / 2, y + size / 2, size / 2 - context.lineWidth / 2, 0, Math.PI * 2);
        context.stroke();
      }
    };
    draw();
    // A timer rather than requestAnimationFrame: rAF stops while the window is
    // hidden, which would freeze the recording behind the HUD.
    compositorRef.current = window.setInterval(draw, 1_000 / COMPOSITOR_FPS);

    const output = canvas.captureStream(COMPOSITOR_FPS);
    const audioStreams = [displayStream, micStream].filter((stream): stream is MediaStream => Boolean(stream?.getAudioTracks().length));
    if (audioStreams.length) {
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const destination = audioContext.createMediaStreamDestination();
      for (const stream of audioStreams) audioContext.createMediaStreamSource(stream).connect(destination);
      destination.stream.getAudioTracks().forEach((track) => output.addTrack(track));
    }

    const mimeType = pickRecorderMimeType((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) throw new Error("This system has no supported recording format");
    const displayTrack = displayStream.getVideoTracks()[0];
    if (displayTrack) displayTrack.onended = () => void stopRecording();
    return {
      output,
      mimeType,
      options: {
        sourceId: source.id,
        sourceName: source.name,
        captureMode: source.kind,
        includeSystemAudio: systemAudioIncluded,
        microphoneDeviceId: microphoneDeviceId || undefined,
        cameraDeviceId: cameraDeviceId || undefined,
        cameraSize,
        cameraCorner,
      },
    };
  };

  /** Resolves true when the countdown completes, false when cancelled. */
  const runCountdown = () => new Promise<boolean>((resolve) => {
    let remaining = COUNTDOWN_SECONDS;
    setCountdown(remaining);
    const interval = window.setInterval(() => {
      remaining -= 1;
      if (remaining > 0) setCountdown(remaining);
      else finish(true);
    }, 1_000);
    const finish = (completed: boolean) => {
      window.clearInterval(interval);
      cancelCountdownRef.current = null;
      setCountdown(null);
      resolve(completed);
    };
    cancelCountdownRef.current = () => finish(false);
  });

  const startRecording = async () => {
    if (!selectedSource || busy || activeRecordingRef.current) return;
    setBusy(true);
    setStatus("Opening capture devices…");
    try {
      const prepared = await prepareCapture(selectedSource);
      setStatus("Recording starts in a moment. Press Esc to cancel.");
      if (!(await runCountdown())) {
        cleanupCapture();
        setStatus("Recording cancelled.");
        return;
      }

      const manifest = await window.zapture.beginRecording(prepared.options, prepared.mimeType);
      const recorder = new MediaRecorder(prepared.output, { mimeType: prepared.mimeType, videoBitsPerSecond: 3_500_000, audioBitsPerSecond: 128_000 });
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        writeChainRef.current = (writeChainRef.current ?? Promise.resolve()).then(async () => {
          const data = await event.data.arrayBuffer();
          const updated = await window.zapture.appendChunk(manifest.id, data);
          activeRecordingRef.current = updated;
          setActiveRecording(updated);
          if (updated.totalSize >= MAX_UPLOAD_SIZE_BYTES || updated.durationMs >= MAX_RECORDING_DURATION_MS) await stopRecording();
        });
      };
      recorder.start(RECORDING_TIMESLICE_MS);
      recorderRef.current = recorder;
      activeRecordingRef.current = manifest;
      setActiveRecording(manifest);
      setElapsedMs(0);
      setStatus(prepared.options.includeSystemAudio || !includeSystemAudio
        ? "Recording. Media is saved locally as you go."
        : "Recording without system audio. Media is saved locally as you go.");
    } catch (error) {
      cleanupCapture();
      setStatus(error instanceof Error ? error.message : "Could not start recording.");
    } finally {
      setBusy(false);
    }
  };

  const setPaused = async (paused: boolean) => {
    const recorder = recorderRef.current;
    const recording = activeRecordingRef.current;
    if (!recorder || !recording || stoppingRef.current) return;
    if (paused && recorder.state === "recording") recorder.pause();
    else if (!paused && recorder.state === "paused") recorder.resume();
    else return;
    const updated = await window.zapture.setRecordingStatus(recording.id, paused ? "paused" : "recording");
    activeRecordingRef.current = updated;
    setActiveRecording(updated);
  };

  commandsRef.current = {
    pause: () => void setPaused(true),
    resume: () => void setPaused(false),
    stop: () => void stopRecording(),
    "stop-recording": () => {
      if (cancelCountdownRef.current) cancelCountdownRef.current();
      else void stopRecording();
    },
    cancel: () => cancelCountdownRef.current?.(),
  };

  useEffect(() => {
    if (countdown === null) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelCountdownRef.current?.();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [countdown]);

  const runAuthentication = async (mode: AuthMode) => {
    setBusy(true);
    setAuthError(undefined);
    try {
      const next = await window.zapture.authenticate(mode);
      setAuth(next);
      if (next.authenticated) setView("recorder");
      else {
        setAuthError(next.error || "Zapture could not verify your account. Please try again.");
        setView("onboarding");
      }
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Zapture could not complete sign-in.";
      setAuth({ authenticated: false, canUpload: false, error: message });
      setAuthError(message);
      setView("onboarding");
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const continueLocally = async () => {
    await window.zapture.continueLocally();
    setAuthError(undefined);
    setView("recorder");
  };

  const runUpload = async (recording: RecordingManifest) => {
    if (!auth.authenticated) {
      const next = await runAuthentication("sign-in");
      if (!next?.authenticated) return;
    }
    const title = `Zapture ${new Date(recording.startedAt).toLocaleString()}`;
    try {
      setBusy(true);
      await window.zapture.uploadRecording(recording.id, title, "Recorded with Zapture desktop");
      await refreshRecordings();
      setStatus("Upload verified. Choose Edit to finish your video.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed.");
      await refreshRecordings();
    } finally {
      setBusy(false);
      setUploadProgress(undefined);
    }
  };

  const deleteRecording = async (recording: RecordingManifest) => {
    if (!window.confirm(`Delete the recording of “${recording.options.sourceName}”? This cannot be undone.`)) return;
    await window.zapture.deleteRecording(recording.id);
    await refreshRecordings();
  };

  if (view === "loading") return <main className="onboarding-shell onboarding-loading"><div className="onboarding-mark" aria-hidden="true"><span>Z</span></div></main>;
  if (view === "onboarding") return (
    <Onboarding
      busy={busy}
      error={authError}
      onAuthenticate={(mode) => void runAuthentication(mode)}
      onContinueLocally={() => void continueLocally()}
    />
  );

  const visibleSources = sources.filter((source) => source.kind === sourceKind);
  const recording = isLive || countdown !== null || stopping;

  return (
    <div className="app-window">
      <header className="toolbar">
        <div className="toolbar-title"><span className="app-mark" aria-hidden="true">Z</span>Zapture</div>
        <div className="tabs" role="tablist" aria-label="Sections">
          <button type="button" role="tab" aria-selected={tab === "record"} onClick={() => setTab("record")}>Record</button>
          <button type="button" role="tab" aria-selected={tab === "library"} onClick={() => setTab("library")}>
            Library{recordings.length ? <span className="tab-count">{recordings.length}</span> : null}
          </button>
        </div>
        <div className="toolbar-end">
          {auth.authenticated ? (
            <>
              <span className="account" title={auth.user?.email}>{auth.user?.name || auth.user?.email}</span>
              <button className="btn btn-plain" disabled={recording} onClick={async () => { await window.zapture.signOut(); setAuth({ authenticated: false, canUpload: false }); setView("onboarding"); }}>Sign Out</button>
            </>
          ) : <button className="btn" onClick={() => void runAuthentication("sign-in")} disabled={busy}>Sign In</button>}
        </div>
      </header>

      {tab === "record" ? (
        <div className="record-layout">
          <section className="sources" aria-label="Capture source">
            <div className="pane-bar">
              <div className="segmented" role="radiogroup" aria-label="Source type">
                <button type="button" role="radio" aria-checked={sourceKind === "screen"} onClick={() => setSourceKind("screen")}>Screens</button>
                <button type="button" role="radio" aria-checked={sourceKind === "window"} onClick={() => setSourceKind("window")}>Windows</button>
              </div>
              <button type="button" className="btn btn-plain" onClick={() => void refreshSources()} disabled={busy || recording} title="Refresh sources"><RefreshIcon /> Refresh</button>
            </div>
            <div className="source-grid" data-kind={sourceKind}>
              {visibleSources.map((source) => (
                <SourceCard key={source.id} source={source} selected={source.id === selectedSource?.id} onSelect={() => !recording && setSelectedSource(source)} />
              ))}
              {!visibleSources.length ? <p className="empty">{sourceKind === "screen" ? "No screens found." : "No windows found."}</p> : null}
            </div>
          </section>

          <aside className="inspector" aria-label="Recording settings">
            <fieldset className="group" disabled={recording}>
              <legend>Audio</legend>
              <label className="field">
                <span>Microphone</span>
                <select value={microphoneDeviceId} onChange={(event) => setMicrophoneDeviceId(event.target.value)}>
                  <option value="">Default microphone</option>
                  {microphones.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
                </select>
              </label>
              <label className="switch-row">
                <span>System audio</span>
                <input type="checkbox" role="switch" checked={includeSystemAudio} onChange={(event) => setIncludeSystemAudio(event.target.checked)} />
              </label>
            </fieldset>

            <fieldset className="group" disabled={recording}>
              <legend>Camera</legend>
              <label className="field">
                <span>Device</span>
                <select value={cameraDeviceId} onChange={(event) => setCameraDeviceId(event.target.value)} disabled={cameraSize === "off"}>
                  <option value="">Default camera</option>
                  {cameras.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
                </select>
              </label>
              <div className="field">
                <span id="camera-size-label">Size</span>
                <div className="segmented segmented-fill" role="radiogroup" aria-labelledby="camera-size-label">
                  {CAMERA_SIZES.map((size) => (
                    <button type="button" role="radio" aria-checked={size.value === cameraSize} key={size.value} onClick={() => setCameraSize(size.value)}>{size.label}</button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span id="camera-corner-label">Position</span>
                <div className="corner-picker" role="radiogroup" aria-labelledby="camera-corner-label">
                  {CORNERS.map((corner) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={corner === cameraCorner}
                      aria-label={corner.replace("-", " ")}
                      key={corner}
                      disabled={cameraSize === "off"}
                      onClick={() => setCameraCorner(corner)}
                    ><i /></button>
                  ))}
                </div>
              </div>
            </fieldset>

            {devicesNeedAccess ? (
              <button type="button" className="link-button" onClick={() => void refreshDevices(true)}>Show device names…</button>
            ) : null}
            <p className="hint">{deviceSummary}</p>
          </aside>
        </div>
      ) : (
        <section className="library" aria-label="Recordings">
          {recordings.length ? (
            <ul className="recording-list">
              {recordings.map((item) => (
                <RecordingRow
                  key={item.id}
                  recording={item}
                  uploadProgress={uploadProgress}
                  busy={busy}
                  onUpload={() => void runUpload(item)}
                  onEdit={() => item.videoId && void window.zapture.openEditor(item.videoId)}
                  onDelete={() => void deleteRecording(item)}
                />
              ))}
            </ul>
          ) : (
            <div className="empty-state">
              <FilmIcon />
              <p>No recordings yet</p>
              <button className="btn" onClick={() => setTab("record")}>New Recording</button>
            </div>
          )}
        </section>
      )}

      <footer className="transport">
        <p className="status" role="status">{uploadProgress && busy ? uploadProgress.message : status}</p>
        <div className="transport-controls">
          {recording ? <span className={`timer ${activeRecording?.status === "paused" ? "timer-paused" : ""}`}>{formatDuration(elapsedMs)}</span> : null}
          {countdown !== null ? null : isLive ? (
            <>
              <button className="btn" onClick={() => void setPaused(activeRecording?.status !== "paused")} disabled={stopping}>
                {activeRecording?.status === "paused" ? "Resume" : "Pause"}
              </button>
              <button className="btn btn-stop" onClick={() => void stopRecording()} disabled={stopping}><span className="stop-glyph" aria-hidden="true" />Stop</button>
            </>
          ) : (
            <button className="btn btn-record" ref={startButtonRef} onClick={() => void startRecording()} disabled={busy || !selectedSource}>
              <span className="record-glyph" aria-hidden="true" />Start Recording
            </button>
          )}
        </div>
      </footer>

      {countdown !== null ? (
        <div className="countdown-overlay" role="alert" aria-live="assertive">
          <span className="countdown-number">{countdown}</span>
          <button type="button" className="btn" onClick={() => cancelCountdownRef.current?.()}>Cancel</button>
          <span className="countdown-hint">or press Esc</span>
        </div>
      ) : null}
    </div>
  );
}

function RefreshIcon() {
  return <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function TrashIcon() {
  return <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function FilmIcon() {
  return <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="m11 7 3-1.8v5.6L11 9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>;
}

const isHud = window.location.hash === "#hud";
document.documentElement.dataset.platform = window.zapture.platform;
document.documentElement.dataset.surface = isHud ? "hud" : "app";
createRoot(document.getElementById("root")!).render(<StrictMode>{isHud ? <RecordingHud /> : <App />}</StrictMode>);
