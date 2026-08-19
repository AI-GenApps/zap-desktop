import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MAX_RECORDING_DURATION_MS,
  MAX_UPLOAD_SIZE_BYTES,
  RECORDING_TIMESLICE_MS,
  pickRecorderMimeType,
  type CameraCorner,
  type CameraSize,
  type RecordingManifest,
  type RecordingOptions,
} from "@zapture/recorder-core";
import type { AuthState, CaptureSource, MediaDeviceOption, UploadProgress } from "../shared/contracts";
import "./styles.css";

const CAMERA_SIZES: CameraSize[] = ["off", "small", "medium", "large"];
const CORNERS: CameraCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

function formatBytes(bytes: number) {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function SourceCard({ source, selected, onSelect }: { source: CaptureSource; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`source-card ${selected ? "selected" : ""}`} onClick={onSelect} type="button">
      <img src={source.thumbnail} alt="" />
      <span>{source.name}</span>
      <small>{source.kind}</small>
    </button>
  );
}

function RecordingRow({ recording, onUpload, onEdit, onDelete }: {
  recording: RecordingManifest;
  onUpload: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="recording-row">
      <div className="recording-index">{new Date(recording.startedAt).toLocaleDateString(undefined, { month: "short", day: "2-digit" })}</div>
      <div>
        <strong>{recording.options.sourceName}</strong>
        <p>{formatDuration(recording.durationMs)} · {formatBytes(recording.totalSize)} · {recording.status}</p>
      </div>
      <div className="row-actions">
        {recording.status === "uploaded" && recording.videoId ? <button onClick={onEdit}>Edit</button> : null}
        {["ready", "failed"].includes(recording.status) ? <button className="accent" onClick={onUpload}>Upload</button> : null}
        <button className="quiet" onClick={onDelete}>Delete</button>
      </div>
    </article>
  );
}

function App() {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selectedSource, setSelectedSource] = useState<CaptureSource>();
  const [microphones, setMicrophones] = useState<MediaDeviceOption[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceOption[]>([]);
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState("");
  const [cameraDeviceId, setCameraDeviceId] = useState("");
  const [cameraSize, setCameraSize] = useState<CameraSize>("medium");
  const [cameraCorner, setCameraCorner] = useState<CameraCorner>("bottom-left");
  const [includeSystemAudio, setIncludeSystemAudio] = useState(true);
  const [recordings, setRecordings] = useState<RecordingManifest[]>([]);
  const [activeRecording, setActiveRecording] = useState<RecordingManifest>();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [auth, setAuth] = useState<AuthState>({ authenticated: false, canUpload: false });
  const [status, setStatus] = useState("Choose a screen or window to begin.");
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const activeRecordingRef = useRef<RecordingManifest | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);
  const stoppingRef = useRef(false);
  const writeChainRef = useRef<Promise<void> | null>(null);
  const transportRef = useRef<HTMLElement | null>(null);
  const startButtonRef = useRef<HTMLButtonElement | null>(null);

  const refreshRecordings = useCallback(async () => setRecordings(await window.zapture.listRecordings()), []);

  const refreshSources = useCallback(async () => {
    setBusy(true);
    try {
      const next = await window.zapture.getSources();
      setSources(next);
      setSelectedSource((current) => next.find((source) => source.id === current?.id) ?? next[0]);
      setStatus(next.length ? "Source list refreshed." : "No recordable sources were found.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load capture sources.");
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      probe.getTracks().forEach((track) => track.stop());
    } catch {
      setStatus("Camera or microphone permission was not granted. You can still record the screen.");
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    setMicrophones(devices.filter((device) => device.kind === "audioinput").map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` })));
    setCameras(devices.filter((device) => device.kind === "videoinput").map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Camera ${index + 1}` })));
  }, []);

  useEffect(() => {
    void Promise.all([refreshSources(), refreshRecordings(), window.zapture.getAuthState().then(setAuth)]);
    const unsubscribeUpload = window.zapture.onUploadProgress(setUploadProgress);
    const unsubscribePrepare = window.zapture.onPrepareRecording(() => {
      void refreshSources();
      transportRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      startButtonRef.current?.focus();
    });
    return () => {
      unsubscribeUpload();
      unsubscribePrepare();
    };
  }, [refreshRecordings, refreshSources]);

  useEffect(() => {
    if (!activeRecording || !["recording", "paused"].includes(activeRecording.status)) return;
    const interval = window.setInterval(() => setElapsedMs(Date.now() - activeRecording.startedAt), 250);
    return () => window.clearInterval(interval);
  }, [activeRecording]);

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
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }, []);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    const recording = activeRecordingRef.current;
    if (!recorder || !recording || recorder.state === "inactive" || stoppingRef.current) return;
    stoppingRef.current = true;
    setBusy(true);
    setStatus("Finalizing local recording…");
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
      setStatus("Recording saved. Upload it when you are ready.");
      await refreshRecordings();
      return finalized;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not finalize the recording.");
      return undefined;
    } finally {
      stoppingRef.current = false;
      setBusy(false);
    }
  }, [cleanupCapture, refreshRecordings]);

  const startRecording = async () => {
    if (!selectedSource) return;
    setBusy(true);
    setStatus("Opening capture devices…");
    try {
      const displayConstraints = {
        audio: includeSystemAudio ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: selectedSource.id } } : false,
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: selectedSource.id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
      } as unknown as MediaStreamConstraints;
      const displayStream = await navigator.mediaDevices.getUserMedia(displayConstraints);
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
        animationRef.current = requestAnimationFrame(draw);
      };
      draw();

      const output = canvas.captureStream(30);
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
      const options: RecordingOptions = {
        sourceId: selectedSource.id,
        sourceName: selectedSource.name,
        captureMode: selectedSource.kind,
        includeSystemAudio,
        microphoneDeviceId: microphoneDeviceId || undefined,
        cameraDeviceId: cameraDeviceId || undefined,
        cameraSize,
        cameraCorner,
      };
      const manifest = await window.zapture.beginRecording(options, mimeType);
      const recorder = new MediaRecorder(output, { mimeType, videoBitsPerSecond: 3_500_000, audioBitsPerSecond: 128_000 });
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
      const displayTrack = displayStream.getVideoTracks()[0];
      if (displayTrack) displayTrack.onended = () => void stopRecording();
      recorder.start(RECORDING_TIMESLICE_MS);
      recorderRef.current = recorder;
      activeRecordingRef.current = manifest;
      setActiveRecording(manifest);
      setElapsedMs(0);
      setStatus("Recording is live. Your media is being saved locally.");
    } catch (error) {
      cleanupCapture();
      setStatus(error instanceof Error ? error.message : "Could not start recording.");
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async () => {
    const recorder = recorderRef.current;
    if (!recorder || !activeRecording) return;
    if (recorder.state === "recording") recorder.pause();
    else recorder.resume();
    const status = recorder.state === "paused" ? "paused" : "recording";
    const updated = await window.zapture.setRecordingStatus(activeRecording.id, status);
    activeRecordingRef.current = updated;
    setActiveRecording(updated);
  };

  const runUpload = async (recording: RecordingManifest) => {
    if (!auth.authenticated) {
      const next = await window.zapture.signIn();
      setAuth(next);
      if (!next.authenticated) return;
    }
    const title = `Zapture ${new Date(recording.startedAt).toLocaleString()}`;
    try {
      setBusy(true);
      await window.zapture.uploadRecording(recording.id, title, "Recorded with Zapture desktop");
      await refreshRecordings();
      setStatus("Upload verified. Open the editor to finish your video.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed.");
      await refreshRecordings();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="masthead">
        <div className="brand"><span className="brand-mark">Z</span><span>Zapture</span></div>
        <div className="live-status"><i className={activeRecording?.status === "recording" ? "live" : ""} />{activeRecording ? activeRecording.status : "standby"}</div>
        <div className="auth-slot">
          {auth.authenticated ? <><span>{auth.user?.name || auth.user?.email}</span><button className="quiet" onClick={async () => { await window.zapture.signOut(); setAuth({ authenticated: false, canUpload: false }); }}>Sign out</button></> : <button onClick={async () => setAuth(await window.zapture.signIn())}>Sign in</button>}
        </div>
      </header>

      <section className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">DESKTOP CAPTURE / 01</p>
          <h1>Record the work.<br /><em>Keep the context.</em></h1>
          <p className="dek">A resilient recorder for walkthroughs, decisions, and the details that disappear in a meeting.</p>
        </div>
        <aside className="meter-panel">
          <span>SESSION</span><strong>{formatDuration(elapsedMs)}</strong>
          <div className="meter"><b style={{ width: `${Math.min(100, elapsedMs / MAX_RECORDING_DURATION_MS * 100)}%` }} /></div>
          <small>60 minute local safety limit</small>
        </aside>
      </section>

      <section className="control-grid">
        <div className="source-panel panel">
          <div className="panel-heading"><div><span>01</span><h2>Capture source</h2></div><button onClick={refreshSources} disabled={busy}>Refresh</button></div>
          <div className="source-grid">
            {sources.map((source) => <SourceCard key={source.id} source={source} selected={source.id === selectedSource?.id} onSelect={() => setSelectedSource(source)} />)}
          </div>
        </div>

        <div className="setup-panel panel">
          <div className="panel-heading"><div><span>02</span><h2>Signal setup</h2></div><button onClick={refreshDevices}>Detect devices</button></div>
          <label>Microphone<select value={microphoneDeviceId} onChange={(event) => setMicrophoneDeviceId(event.target.value)}><option value="">Default microphone</option>{microphones.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label>
          <label>Camera<select value={cameraDeviceId} onChange={(event) => setCameraDeviceId(event.target.value)} disabled={cameraSize === "off"}><option value="">Default camera</option>{cameras.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label>
          <div className="segmented" aria-label="Camera size">{CAMERA_SIZES.map((size) => <button className={size === cameraSize ? "active" : ""} key={size} onClick={() => setCameraSize(size)}>{size}</button>)}</div>
          <div className="segmented corners" aria-label="Camera corner">{CORNERS.map((corner) => <button className={corner === cameraCorner ? "active" : ""} key={corner} onClick={() => setCameraCorner(corner)}>{corner.replaceAll("-", " ")}</button>)}</div>
          <label className="toggle"><input type="checkbox" checked={includeSystemAudio} onChange={(event) => setIncludeSystemAudio(event.target.checked)} /><span />Include system audio</label>
          <p className="device-summary">{deviceSummary}</p>
        </div>
      </section>

      <section className="transport" ref={transportRef}>
        <p>{status}</p>
        <div>
          {activeRecording ? <><button onClick={togglePause}>{activeRecording.status === "paused" ? "Resume" : "Pause"}</button><button className="record stop" onClick={() => void stopRecording()} disabled={busy}>Stop & save</button></> : <button className="record" ref={startButtonRef} onClick={() => void startRecording()} disabled={busy || !selectedSource}><span />Start recording</button>}
        </div>
      </section>

      {uploadProgress ? <section className="upload-strip"><span>{uploadProgress.message}</span><div><b style={{ width: `${uploadProgress.totalBytes ? uploadProgress.uploadedBytes / uploadProgress.totalBytes * 100 : 0}%` }} /></div></section> : null}

      <section className="library panel">
        <div className="panel-heading"><div><span>03</span><h2>Local recordings</h2></div><button onClick={() => void window.zapture.checkForUpdates().then((result) => setStatus(result.message))}>Check for updates</button></div>
        {recordings.length ? recordings.map((recording) => <RecordingRow key={recording.id} recording={recording} onUpload={() => void runUpload(recording)} onEdit={() => recording.videoId && void window.zapture.openEditor(recording.videoId)} onDelete={async () => { await window.zapture.deleteRecording(recording.id); await refreshRecordings(); }} />) : <div className="empty">No local takes yet. Your first recording will appear here.</div>}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
