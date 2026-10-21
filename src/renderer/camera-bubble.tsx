import { useEffect, useState } from "react";
import type { CameraBubbleState } from "../shared/contracts";
import { CameraVideo, useCameraPreview } from "./camera-preview";
import { cameraShapeBox } from "./camera-geometry.util";

/** Floating, draggable camera bubble shown in its own window while recording. */
export function CameraBubble() {
  const [state, setState] = useState<CameraBubbleState | null>(null);
  const [height, setHeight] = useState(() => window.innerHeight);

  useEffect(() => window.zapture.onCameraBubble(setState), []);

  useEffect(() => {
    const update = () => setHeight(window.innerHeight);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Opens its own camera while shown and releases it when hidden or closed.
  const { stream, error } = useCameraPreview(Boolean(state), state?.deviceId ?? "");

  // The bubble must never get in the way of the recording: on failure, ask main to close it.
  useEffect(() => {
    if (error) void window.zapture.reportCameraBubbleFailure(error).catch(() => undefined);
  }, [error]);

  if (!state || !stream) return null;
  const box = cameraShapeBox(height, state.shape);
  return (
    <div className="camera-bubble" style={{ borderRadius: box.radius }}>
      <CameraVideo stream={stream} />
    </div>
  );
}
