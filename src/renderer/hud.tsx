import { useEffect, useState } from "react";
import type { RecordingCommand, RecordingHudState } from "../shared/contracts";
import { formatDuration } from "./format.util";

/** Floating always-on-top recording controls, shown in their own window. */
export function RecordingHud() {
  const [state, setState] = useState<RecordingHudState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => window.zapture.onRecordingHud(setState), []);

  useEffect(() => {
    if (state?.status !== "recording") return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [state]);

  if (!state) return null;

  const send = (command: RecordingCommand) => void window.zapture.sendRecordingCommand(command);
  const elapsedMs = state.status === "recording"
    ? state.elapsedMs + Math.max(0, now - state.updatedAt)
    : state.elapsedMs;

  if (state.status === "countdown") {
    return (
      <div className="hud" data-status="countdown">
        <div className="hud-readout">
          <span className="hud-countdown">{state.countdown}</span>
          <span className="hud-label">Recording starts…</span>
        </div>
        <button type="button" className="hud-button" onClick={() => send("cancel")}>Cancel</button>
      </div>
    );
  }

  const paused = state.status === "paused";
  return (
    <div className="hud" data-status={state.status}>
      <div className="hud-readout">
        <span className="hud-dot" aria-hidden="true" />
        <span className="hud-time" aria-live="off">{formatDuration(elapsedMs)}</span>
        {paused ? <span className="hud-label">Paused</span> : null}
      </div>
      <button
        type="button"
        className="hud-button hud-icon"
        onClick={() => send(paused ? "resume" : "pause")}
        aria-label={paused ? "Resume recording" : "Pause recording"}
        title={paused ? "Resume" : "Pause"}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </button>
      <button type="button" className="hud-button hud-stop" onClick={() => send("stop")} title="Stop and save">
        <StopIcon /> Stop
      </button>
    </div>
  );
}

function PauseIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="1" /><rect x="9" y="3" width="3" height="10" rx="1" /></svg>;
}

function PlayIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 5 3.5Z" /></svg>;
}

function StopIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>;
}
