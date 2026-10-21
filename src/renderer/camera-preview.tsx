import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { CameraCorner, CameraShape, CameraSize } from "@zapture/recorder-core";
import { cameraShapeBox, thumbnailBubbleRect } from "./camera-geometry.util";

export interface CameraPreviewState {
  stream: MediaStream | null;
  error?: string;
}

function describeCameraError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera access was not granted. Allow it in System Settings > Privacy & Security > Camera.";
  if (name === "NotReadableError" || name === "AbortError") return "This camera is in use by another app.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "This camera is not available.";
  return "The camera preview could not start.";
}

/** True while the window is on screen, so the camera is released when it is hidden. */
function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * Opens a camera stream only while `enabled` (and the window is visible) and always stops its tracks
 * when it is not, the device changes, or the component unmounts. Results of superseded requests are
 * stopped on arrival so rapid device switches cannot leak a stream.
 */
export function useCameraPreview(enabled: boolean, deviceId: string): CameraPreviewState {
  const visible = usePageVisible();
  const active = enabled && visible;
  const [state, setState] = useState<CameraPreviewState>({ stream: null });

  useEffect(() => {
    if (!active) {
      setState((current) => (current.stream || current.error ? { stream: null } : current));
      return;
    }
    let cancelled = false;
    let opened: MediaStream | null = null;
    setState({ stream: null });
    navigator.mediaDevices.getUserMedia({
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
    }).then((stream) => {
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      opened = stream;
      // A camera unplugged or taken over mid-preview ends its track: drop the frozen frame and say so.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (!cancelled) setState({ stream: null, error: "The camera was disconnected." });
      }, { once: true });
      setState({ stream });
    }, (error: unknown) => {
      if (!cancelled) setState({ stream: null, error: describeCameraError(error) });
    });
    return () => {
      cancelled = true;
      opened?.getTracks().forEach((track) => track.stop());
    };
  }, [active, deviceId]);

  return state;
}

/** A muted, mirrored (selfie view) live video. The recording itself is not mirrored. */
export function CameraVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [stream]);
  return <video ref={ref} className="camera-video" muted playsInline autoPlay aria-hidden="true" />;
}

const PREVIEW_HEIGHT = 84;

/** The inspector preview, masked to the chosen shape. */
export function CameraPreviewBox({ preview, shape }: { preview: CameraPreviewState; shape: CameraShape }) {
  const box = cameraShapeBox(PREVIEW_HEIGHT, shape);
  const style: CSSProperties = { width: box.width, height: box.height, borderRadius: box.radius };
  return (
    <div className="camera-preview">
      <div className="camera-preview-mask" style={style} role="img" aria-label={preview.stream ? "Live camera preview" : "Camera preview"} data-live={preview.stream ? "true" : "false"}>
        {preview.stream ? <CameraVideo stream={preview.stream} /> : null}
      </div>
      {preview.error ? <p className="camera-preview-error" role="status">{preview.error}</p> : null}
    </div>
  );
}

/** Draws the camera bubble over a thumbnail, against the displayed (letterboxed) image box. */
export function PlacementOverlay({ image, stream, size, corner, shape }: {
  image: { width: number; height: number } | null;
  stream: MediaStream | null;
  size: Exclude<CameraSize, "off">;
  corner: CameraCorner;
  shape: CameraShape;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const bubble = box && image ? thumbnailBubbleRect(box, image, size, corner, shape) : null;
  return (
    <div className="placement-overlay" ref={ref} aria-hidden="true">
      {bubble ? (
        <div
          className="placement-bubble"
          data-live={stream ? "true" : "false"}
          style={{ left: bubble.x, top: bubble.y, width: bubble.width, height: bubble.height, borderRadius: bubble.radius }}
        >
          {stream ? <CameraVideo stream={stream} /> : null}
        </div>
      ) : null}
    </div>
  );
}
